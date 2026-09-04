// Fusiona un nodo en otro: nunca borra, dead-record vía `merged_into` (mismo
// principio que `forget.mjs` con `facts.valid_until`). Reasigna las filas de
// `fact_nodes` del nodo viejo al nuevo (evitando duplicados si un hecho ya
// tenía ambos), y pliega el nombre del nodo viejo como alias del nuevo —
// para que una mención literal del nombre viejo en un claim futuro siga
// ayudando a la desambiguación (ver PLAN-nodos.md, Etapa 2, fix de aliases).
// Uso:
//   node merge-nodes.mjs --from jane-doe --to atlas-2026 --reason "es la colaboración del proyecto Atlas, no solo hechos sobre la persona"
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

if (!args.from || !args.to || !args.reason) {
  console.error('Uso: node merge-nodes.mjs --from nodo-viejo --to nodo-nuevo --reason "..."');
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

// Resuelve un nombre a su nodo vigente siguiendo la cadena de merged_into,
// con detección de ciclos — mismo patrón que remember.mjs.
async function resolveLive(name) {
  let current = name;
  const seen = new Set();
  while (true) {
    if (seen.has(current)) {
      console.error(`Ciclo de merged_into detectado empezando por "${name}".`);
      await client.end();
      process.exit(1);
    }
    seen.add(current);
    const { rows } = await client.query(`select name, merged_into from nodes where name = $1`, [current]);
    if (rows.length === 0) {
      console.error(`Nodo "${current}" no existe. Revisa el nombre con list-nodes.mjs.`);
      await client.end();
      process.exit(1);
    }
    if (!rows[0].merged_into) return rows[0].name;
    current = rows[0].merged_into;
  }
}

const fromNode = args.from;
const { rows: fromRows } = await client.query(`select name, merged_into, aliases from nodes where name = $1`, [fromNode]);
if (fromRows.length === 0) {
  console.error(`Nodo origen "${fromNode}" no existe. Revisa el nombre con list-nodes.mjs.`);
  await client.end();
  process.exit(1);
}
if (fromRows[0].merged_into) {
  console.error(`Nodo origen "${fromNode}" ya está fusionado en "${fromRows[0].merged_into}" — no se puede volver a fusionar. Fusiona desde el nodo vigente si quieres moverlo otra vez.`);
  await client.end();
  process.exit(1);
}

const toLive = await resolveLive(args.to);

if (toLive === fromNode) {
  console.error(`"${fromNode}" ya resuelve al mismo nodo vigente ("${toLive}") — nada que fusionar.`);
  await client.end();
  process.exit(1);
}

// Reasigna fact_nodes: inserta las filas del destino primero (evita colisión
// de PK si un hecho ya tenía ambos nodos), luego borra las del origen.
const { rowCount: reassigned } = await client.query(
  `insert into fact_nodes (fact_id, node_name)
   select fact_id, $2 from fact_nodes where node_name = $1
   on conflict do nothing`,
  [fromNode, toLive],
);
await client.query(`delete from fact_nodes where node_name = $1`, [fromNode]);

// Pliega el nombre viejo (y sus alias, si tenía) como alias del nuevo, para
// que una mención literal futura del nombre viejo siga ayudando al
// clasificador de nodos a desambiguar correctamente.
const foldedAliases = Array.from(new Set([fromNode, ...(fromRows[0].aliases ?? [])]));
await client.query(
  `update nodes set aliases = (
     select array_agg(distinct a) from unnest(coalesce(aliases, '{}') || $2::text[]) as a
   ) where name = $1`,
  [toLive, foldedAliases],
);

// Dead-record: el nodo origen nunca se borra, solo queda marcado.
await client.query(`update nodes set merged_into = $2 where name = $1`, [fromNode, toLive]);

console.log(`Fusionado "${fromNode}" -> "${toLive}".`);
console.log(`  ${reassigned} fila(s) de fact_nodes reasignadas.`);
console.log(`  Alias plegados en "${toLive}": ${foldedAliases.join(', ')}`);
console.log(`  Motivo: ${args.reason}`);

await client.end();
