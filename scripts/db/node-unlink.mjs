// Borra una relación nodo-a-nodo de node_edges -- contraparte de node-link.mjs.
// A diferencia de merge-nodes.mjs (dead-record vía merged_into, nunca borra),
// aquí sí se borra la fila: una relación mal creada (ruido, colisión de
// alias, cambio de criterio) no necesita dejar rastro, no es un hecho
// histórico como un fact. Mismo principio fail-closed que el resto de
// Etapa 6: si el par tiene más de una relación registrada y no se especifica
// cuál, no se borra nada -- se listan las candidatas y se pide --relation
// exacto, para no borrar de más por ambigüedad.
// Uso:
//   node node-unlink.mjs --from DB1-gestion-github --to coil-2026-2 --relation "..." --reason "colisión de alias DB1, no relación real"
//   (si el par tiene una sola relación, --relation es opcional)
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

const USAGE =
  'Uso:\n' +
  '  node node-unlink.mjs --from <nodo> --to <nodo> [--relation "..."] --reason "..."\n' +
  '  Si el par tiene más de una relación registrada, --relation es obligatorio.';

if (!args.from || !args.to || !args.reason) {
  console.error(USAGE);
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

// Resuelve un nombre a su nodo vigente siguiendo merged_into, con detección
// de ciclos -- mismo patrón que node-link.mjs/merge-nodes.mjs.
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

const fromNode = await resolveLive(args.from);
const toNode = await resolveLive(args.to);

// Una relación es direccional al crearse, pero para borrar no obligamos al
// usuario a recordar el sentido exacto -- se busca en ambos.
const { rows: candidates } = await client.query(
  `select from_node, to_node, relation, date, source from node_edges
   where (from_node = $1 and to_node = $2) or (from_node = $2 and to_node = $1)`,
  [fromNode, toNode],
);

if (candidates.length === 0) {
  console.error(`No hay ninguna relación registrada entre "${fromNode}" y "${toNode}".`);
  await client.end();
  process.exit(1);
}

let toDelete = candidates;
if (args.relation) {
  toDelete = candidates.filter((r) => r.relation === args.relation);
  if (toDelete.length === 0) {
    console.error(`Ninguna relación "${args.relation}" entre "${fromNode}" y "${toNode}". Relaciones existentes:`);
    for (const r of candidates) console.error(`  ${r.from_node} -> ${r.to_node} (${r.relation})`);
    await client.end();
    process.exit(1);
  }
} else if (candidates.length > 1) {
  console.error(`"${fromNode}" y "${toNode}" tienen ${candidates.length} relaciones registradas -- especifica --relation para desambiguar:`);
  for (const r of candidates) console.error(`  ${r.from_node} -> ${r.to_node} (${r.relation})`);
  await client.end();
  process.exit(1);
}

for (const r of toDelete) {
  await client.query(
    `delete from node_edges where from_node = $1 and to_node = $2 and relation = $3`,
    [r.from_node, r.to_node, r.relation],
  );
  console.log(`Borrado: ${r.from_node} -> ${r.to_node} (${r.relation})`);
}
console.log(`Motivo: ${args.reason}`);

await client.end();
