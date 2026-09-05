// Crea (o lista) una relación recuerdo-a-recuerdo persistente en memory_links,
// distinta de que un registro puntual mencione a dos recuerdos a la vez (record_memories
// many-to-many, ver schema.sql): esto conecta dos recuerdos que existen
// independientemente ("John colabora en Atlas", "Atlas está reportado en
// el plan 2026-2"), sin depender de que algún registro los mencione juntos.
// Siempre a mano, nunca inferida: mismo criterio fail-closed que
// merge-memories.mjs: una relación equivocada contamina cualquier consulta
// futura de "qué se conecta con X".
// Uso:
//   node memory-link.mjs --from john-smith --to atlas-2026 --relation "colabora_con" --date 2026-09-02 --reason "envió insumos para la presentación del viernes con Jane Doe"
//   node memory-link.mjs --list atlas-2026   (ambos sentidos: from y to)
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createLink, resolveLiveMemory } from './lib/create-link.mjs';

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
  '  node memory-link.mjs --from <recuerdo> --to <recuerdo> --relation "colabora_con" --date YYYY-MM-DD --reason "..."\n' +
  '  node memory-link.mjs --list <recuerdo>   (todas sus conexiones, en ambos sentidos)';

if (!args.list && (!args.from || !args.to || !args.relation || !args.date || !args.reason)) {
  console.error(USAGE);
  process.exit(1);
}
if (args.list && (args.from || args.to)) {
  console.error('--list no se combina con --from/--to.');
  process.exit(1);
}
if (!args.list && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
  console.error(`Fecha inválida: "${args.date}". Debe ser YYYY-MM-DD, no se infiere.`);
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

// Resuelve un nombre a su recuerdo vigente siguiendo merged_into, o termina el
// proceso con un mensaje claro -- resolveLiveMemory (lib/create-link.mjs) es
// la lógica compartida, esto solo la adapta al patrón CLI (exit 1 en vez de
// devolver {ok: false}).
async function resolveLiveOrExit(name) {
  const result = await resolveLiveMemory(client, name);
  if (!result.ok) {
    console.error(`${result.error} Revisa el nombre con list-memories.mjs.`);
    await client.end();
    process.exit(1);
  }
  return result.name;
}

if (args.list) {
  const node = await resolveLiveOrExit(args.list);
  const { rows } = await client.query(
    `select from_memory, to_memory, relation, date, source from memory_links
     where from_memory = $1 or to_memory = $1
     order by date desc`,
    [node],
  );
  if (rows.length === 0) {
    console.log(`"${node}" no tiene ninguna conexión registrada.`);
  } else {
    for (const r of rows) {
      const arrow = r.from_memory === node ? `-> ${r.to_memory}` : `<- ${r.from_memory}`;
      console.log(`[${r.date.toISOString().slice(0, 10)}] ${node} ${arrow} (${r.relation})`);
      console.log(`  fuente: ${r.source}`);
    }
  }
  await client.end();
  process.exit();
}

const result = await createLink(client, args.from, args.to, args.relation, args.reason, args.date);
if (!result.ok) {
  console.error(result.error);
  await client.end();
  process.exit(1);
}

console.log(`Conectado: ${result.fromMemory} -> ${result.toMemory} (${result.relation})`);

await client.end();
