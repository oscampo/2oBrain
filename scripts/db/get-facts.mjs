// Trae hecho(s) por id exacto, vigentes o ya retractados, sin importar
// estado — para inspeccionar un id puntual (ej. antes de retractarlo o
// purgarlo) sin tener que buscarlo en Timeline. No modifica nada.
// Uso: node get-facts.mjs --id 159,160
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

if (!args.id) {
  console.error('Uso: node get-facts.mjs --id <id>[,<id>...]');
  process.exit(1);
}

const ids = String(args.id)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n));

if (ids.length === 0) {
  console.error(`--id inválido: "${args.id}"`);
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

const { rows } = await client.query(
  `select f.id, f.date, f.claim, f.source, f.kind, f.valid_until, f.superseded_by,
          (select string_agg(node_name, ', ' order by node_name) from fact_nodes where fact_id = f.id) as nodes
   from facts f
   where f.id = any($1::bigint[])
   order by f.id`,
  [ids],
);

const found = new Set(rows.map((r) => Number(r.id)));
const missing = ids.filter((id) => !found.has(id));

if (rows.length === 0) {
  console.log('Ningún id existe.');
} else {
  for (const r of rows) {
    const date = r.date.toISOString().slice(0, 10);
    const status = r.valid_until ? ` [YA RETRACTADO/REEMPLAZADO${r.superseded_by ? ` por #${r.superseded_by}` : ''}]` : ' [vigente]';
    console.log(`\n#${r.id} [${date}]${status} ${r.claim}`);
    console.log(`  fuente: ${r.source} · tipo: ${r.kind}${r.nodes ? ` · nodos: ${r.nodes}` : ''}`);
  }
}
if (missing.length > 0) {
  console.log(`\nNo existe(n): ${missing.join(', ')}`);
}

await client.end();
