// Reasigna un hecho de un nodo a otro -- distinto de merge-nodes.mjs (que
// mueve TODOS los hechos de un nodo, para fusionar dos nodos que resultaron
// ser el mismo asunto). Este es el caso contrario: un solo hecho quedó
// etiquetado con el nodo equivocado (ej. classify-node.mjs se equivocó, o se
// guardó con --node a mano sin pensarlo), el resto de los hechos del nodo
// están bien. No borra ni retracta el hecho -- solo corrige su fact_nodes.
// Uso:
//   node recategorize-fact.mjs --fact 412 --from vault-overview --to cabd-2026-2 --reason "el hecho es sobre el curso CABD, no sobre el vault en general"
import { readFileSync } from 'node:fs';
import pg from 'pg';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.fact || !args.from || !args.to || !args.reason) {
  console.error('Uso: node recategorize-fact.mjs --fact <id> --from <nodo> --to <nodo> --reason "..."');
  process.exit(1);
}

const factId = Number(args.fact);
if (!Number.isInteger(factId)) {
  console.error(`--fact inválido: "${args.fact}"`);
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

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows: factRows } = await client.query(`select id, claim, valid_until from facts where id = $1`, [factId]);
if (factRows.length === 0) {
  console.error(`No existe ningún hecho #${factId}.`);
  await client.end();
  process.exit(1);
}

const { rows: linkRows } = await client.query(
  `select node_name from fact_nodes where fact_id = $1 and node_name = $2`,
  [factId, args.from],
);
if (linkRows.length === 0) {
  const { rows: actual } = await client.query(`select node_name from fact_nodes where fact_id = $1`, [factId]);
  console.error(`El hecho #${factId} no está ligado a "${args.from}". Nodos actuales: ${actual.map((r) => r.node_name).join(', ') || '(ninguno)'}`);
  await client.end();
  process.exit(1);
}

const { rows: toRows } = await client.query(`select name, merged_into from nodes where name = $1`, [args.to]);
if (toRows.length === 0) {
  console.error(`Nodo destino "${args.to}" no existe. Revisa el nombre con list-nodes.mjs.`);
  await client.end();
  process.exit(1);
}
if (toRows[0].merged_into) {
  console.error(`"${args.to}" está fusionado en "${toRows[0].merged_into}" -- reasigna al nodo vigente, no a este.`);
  await client.end();
  process.exit(1);
}

await client.query(`delete from fact_nodes where fact_id = $1 and node_name = $2`, [factId, args.from]);
await client.query(
  `insert into fact_nodes (fact_id, node_name) values ($1, $2) on conflict do nothing`,
  [factId, args.to],
);

console.log(`Hecho #${factId} reasignado: "${args.from}" -> "${args.to}"`);
console.log(`  ${factRows[0].claim}`);
console.log(`Motivo: ${args.reason}`);

await client.end();
