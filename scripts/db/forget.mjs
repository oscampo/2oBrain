// Retracta (invalida) un hecho vigente sin reemplazarlo por uno nuevo — para
// cuando algo se aprobó por error o dejó de ser relevante sin que haya un
// hecho nuevo que lo reemplace (si sí lo hay, usa remember.mjs --supersedes).
// Por defecto nunca borra la fila: mismo principio de siempre, el historial
// completo queda consultable con --all en timeline.mjs. El motivo queda
// anotado en source, no se pierde por qué se retractó.
//
// --purge (2026-09-02): escape hatch deliberadamente incómodo para basura
// real sin ningún valor histórico (pruebas de dashboard, duplicados de una
// sesión de debugging) — nunca para una corrección real, que siempre debe
// quedar auditable. Fail-closed en dos sentidos:
//   1. Solo borra hechos que YA estén retractados (valid_until no nulo) —
//      nunca borra un hecho vigente en un solo paso, tiene que pasar primero
//      por --reason. Si algún id de la lista sigue vigente, no se borra NADA
//      (todo o nada, nunca un purge parcial silencioso).
//   2. Un nodo solo se puede purgar si no tiene ningún hecho ligado (ni
//      vigente ni retractado) y ningún otro nodo lo tiene como merged_into —
//      la propia base de datos ya lo protege (fact_nodes.node_name referencia
//      nodes sin cascade), esto solo da un mensaje claro antes de intentarlo.
// Uso:
//   node forget.mjs --id 159,160 --reason "ruido de desarrollo interno, aprobado por error en revisión"
//   node forget.mjs --id 159,160 --purge
//   node forget.mjs --node prueba-nodo-dashboard --purge
import { readFileSync } from 'node:fs';
import pg from 'pg';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const USAGE =
  'Uso:\n' +
  '  node forget.mjs --id <id>[,<id>...] --reason "..."\n' +
  '  node forget.mjs --id <id>[,<id>...] --purge   (solo hechos ya retractados)\n' +
  '  node forget.mjs --node <nombre> --purge        (solo si no tiene hechos ligados)';

if (!args.purge && (!args.id || !args.reason)) {
  console.error(USAGE);
  process.exit(1);
}
if (args.purge && !args.id && !args.node) {
  console.error(USAGE);
  process.exit(1);
}
if (args.purge && args.id && args.node) {
  console.error('--purge acepta --id o --node, no ambos a la vez.');
  process.exit(1);
}

const envPath = new URL('../../.env', import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

if (args.purge && args.node) {
  const nodeName = String(args.node);
  const { rows: linked } = await client.query(
    `select count(*)::int as n from fact_nodes where node_name = $1`,
    [nodeName],
  );
  const { rows: mergedFrom } = await client.query(
    `select name from nodes where merged_into = $1`,
    [nodeName],
  );
  // node_edges y node_pair_checks (Etapa 6, añadidas después de que se
  // escribiera este chequeo) también referencian nodes(name) sin cascade --
  // sin este chequeo, el delete de abajo revienta con un stack trace crudo
  // de FK en vez de un mensaje claro (encontrado en vivo purgando
  // preferencias-jane, hecho #523 y siguientes).
  const { rows: edgeCount } = await client.query(
    `select count(*)::int as n from node_edges where from_node = $1 or to_node = $1`,
    [nodeName],
  );
  const { rows: pairCheckCount } = await client.query(
    `select count(*)::int as n from node_pair_checks where node_a = $1 or node_b = $1`,
    [nodeName],
  );
  if (linked[0].n > 0) {
    console.error(
      `No se puede purgar "${nodeName}": tiene ${linked[0].n} hecho(s) ligado(s) (vigente o retractado). Desligarlos o purgarlos primero.`,
    );
    process.exitCode = 1;
  } else if (mergedFrom.length > 0) {
    console.error(
      `No se puede purgar "${nodeName}": otro(s) nodo(s) apuntan a él con merged_into: ${mergedFrom.map((r) => r.name).join(', ')}.`,
    );
    process.exitCode = 1;
  } else if (edgeCount[0].n > 0) {
    console.error(
      `No se puede purgar "${nodeName}": tiene ${edgeCount[0].n} relación(es) en node_edges. Bórralas primero con node-unlink.mjs.`,
    );
    process.exitCode = 1;
  } else if (pairCheckCount[0].n > 0) {
    console.error(
      `No se puede purgar "${nodeName}": tiene ${pairCheckCount[0].n} fila(s) de memoización en node_pair_checks (barrido de minería de relaciones). Bórralas primero: delete from node_pair_checks where node_a = '${nodeName}' or node_b = '${nodeName}'.`,
    );
    process.exitCode = 1;
  } else {
    const { rowCount } = await client.query(`delete from nodes where name = $1`, [nodeName]);
    if (rowCount === 0) {
      console.error(`No existe ningún nodo "${nodeName}".`);
      process.exitCode = 1;
    } else {
      console.log(`Purgado el nodo "${nodeName}".`);
    }
  }
  await client.end();
  process.exit();
}

const ids = String(args.id)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n));

if (ids.length === 0) {
  console.error(`--id inválido: "${args.id}"`);
  await client.end();
  process.exit(1);
}

if (args.purge) {
  const { rows: targets } = await client.query(
    `select id, claim, valid_until from facts where id = any($1::bigint[])`,
    [ids],
  );
  const foundIds = new Set(targets.map((r) => Number(r.id)));
  const missing = ids.filter((id) => !foundIds.has(id));
  const stillLive = targets.filter((r) => r.valid_until === null);

  if (missing.length > 0) {
    console.error(`No existe(n) hecho(s) con id: ${missing.join(', ')}. No se purgó nada.`);
    process.exitCode = 1;
  } else if (stillLive.length > 0) {
    console.error(
      `${stillLive.length} de los ids siguen vigentes (retráctalos primero con --reason): ${stillLive.map((r) => `#${r.id}`).join(', ')}. No se purgó nada.`,
    );
    process.exitCode = 1;
  } else {
    const { rows: deleted } = await client.query(
      `delete from facts where id = any($1::bigint[]) returning id, claim`,
      [ids],
    );
    for (const r of deleted) {
      console.log(`Purgado #${r.id}: ${r.claim}`);
    }
  }
  await client.end();
  process.exit();
}

const { rows } = await client.query(
  `update facts
   set valid_until = now(),
       source = source || ' [RETRACTADO ' || to_char(now(), 'YYYY-MM-DD') || ': ' || $2 || ']'
   where id = any($1::bigint[]) and valid_until is null
   returning id, claim`,
  [ids, args.reason],
);

for (const r of rows) {
  console.log(`Retractado #${r.id}: ${r.claim}`);
}

const found = new Set(rows.map((r) => Number(r.id)));
const missing = ids.filter((id) => !found.has(id));
if (missing.length > 0) {
  console.error(`No encontrados como vigentes (ya retractados o id inexistente): ${missing.join(', ')}`);
}

await client.end();

if (rows.length === 0) process.exitCode = 1;
