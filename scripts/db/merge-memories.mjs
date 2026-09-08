// Fusiona un recuerdo en otro: nunca borra, dead-record vía `merged_into` (mismo
// principio que `forget.mjs` con `records.valid_until`). Reasigna las filas de
// `record_memories` del recuerdo viejo al nuevo (evitando duplicados si un registro ya
// tenía ambos), y pliega el nombre del recuerdo viejo como alias del nuevo,
// para que una mención literal del nombre viejo en un claim futuro siga
// ayudando a la desambiguación (ver PLAN-recuerdos.md, Etapa 2, fix de aliases).
// Uso:
//   node merge-memories.mjs --from jane-doe --to atlas-2026 --reason "es la colaboración del proyecto Atlas, no solo registros sobre la persona"
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
  console.error('Uso: node merge-memories.mjs --from recuerdo-viejo --to recuerdo-nuevo --reason "..."');
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

// Resuelve un nombre a su recuerdo vigente siguiendo la cadena de merged_into,
// con detección de ciclos: mismo patrón que remember.mjs.
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
    const { rows } = await client.query(`select name, merged_into from memories where name = $1`, [current]);
    if (rows.length === 0) {
      console.error(`recuerdo "${current}" no existe. Revisa el nombre con list-memories.mjs.`);
      await client.end();
      process.exit(1);
    }
    if (!rows[0].merged_into) return rows[0].name;
    current = rows[0].merged_into;
  }
}

const fromMemory = args.from;
const { rows: fromRows } = await client.query(`select name, merged_into, aliases from memories where name = $1`, [fromMemory]);
if (fromRows.length === 0) {
  console.error(`recuerdo origen "${fromMemory}" no existe. Revisa el nombre con list-memories.mjs.`);
  await client.end();
  process.exit(1);
}
if (fromRows[0].merged_into) {
  console.error(`recuerdo origen "${fromMemory}" ya está fusionado en "${fromRows[0].merged_into}", no se puede volver a fusionar. Fusiona desde el recuerdo vigente si quieres moverlo otra vez.`);
  await client.end();
  process.exit(1);
}

const toLive = await resolveLive(args.to);

if (toLive === fromMemory) {
  console.error(`"${fromMemory}" ya resuelve al mismo recuerdo vigente ("${toLive}"), nada que fusionar.`);
  await client.end();
  process.exit(1);
}

// Reasigna record_memories: inserta las filas del destino primero (evita colisión
// de PK si un registro ya tenía ambos recuerdos), luego borra las del origen.
const { rowCount: reassigned } = await client.query(
  `insert into record_memories (record_id, memory_name)
   select record_id, $2 from record_memories where memory_name = $1
   on conflict do nothing`,
  [fromMemory, toLive],
);
await client.query(`delete from record_memories where memory_name = $1`, [fromMemory]);

// Pliega el nombre viejo (y sus alias, si tenía) como alias del nuevo, para
// que una mención literal futura del nombre viejo siga ayudando al
// clasificador de recuerdos a desambiguar correctamente.
const foldedAliases = Array.from(new Set([fromMemory, ...(fromRows[0].aliases ?? [])]));
await client.query(
  `update memories set aliases = (
     select array_agg(distinct a) from unnest(coalesce(aliases, '{}') || $2::text[]) as a
   ) where name = $1`,
  [toLive, foldedAliases],
);

// Redirige memory_links: mismo patrón que record_memories arriba (insertar
// en el destino primero, evitando choques de PK/auto-loops, luego borrar el
// origen). Sin esto, una arista que apuntaba al recuerdo fusionado queda
// huérfana (el nodo desaparece de /api/graph por tener merged_into, pero la
// arista sigue apuntándole), lo que hace tronar el grafo interactivo con
// "node not found" en d3-force (hallazgo real, 2026-09-08, instalación de
// una usuaria). graph.mjs también resuelve esto en lectura por si queda
// algo viejo sin migrar, pero la fuente debe quedar limpia desde el merge
// mismo.
const { rows: outgoing } = await client.query(`select to_memory, relation, source, date from memory_links where from_memory = $1`, [fromMemory]);
for (const row of outgoing) {
  if (row.to_memory === toLive) continue; // se volvería auto-loop, se descarta
  await client.query(
    `insert into memory_links (from_memory, to_memory, relation, source, date)
     values ($1, $2, $3, $4, $5) on conflict (from_memory, to_memory, relation) do nothing`,
    [toLive, row.to_memory, row.relation, row.source, row.date],
  );
}
const { rows: incoming } = await client.query(`select from_memory, relation, source, date from memory_links where to_memory = $1`, [fromMemory]);
for (const row of incoming) {
  if (row.from_memory === toLive) continue;
  await client.query(
    `insert into memory_links (from_memory, to_memory, relation, source, date)
     values ($1, $2, $3, $4, $5) on conflict (from_memory, to_memory, relation) do nothing`,
    [row.from_memory, toLive, row.relation, row.source, row.date],
  );
}
await client.query(`delete from memory_links where from_memory = $1 or to_memory = $1`, [fromMemory]);

// Dead-record: el recuerdo origen nunca se borra, solo queda marcado.
await client.query(`update memories set merged_into = $2 where name = $1`, [fromMemory, toLive]);

console.log(`Fusionado "${fromMemory}" -> "${toLive}".`);
console.log(`  ${reassigned} fila(s) de record_memories reasignadas.`);
console.log(`  Alias plegados en "${toLive}": ${foldedAliases.join(', ')}`);
console.log(`  Motivo: ${args.reason}`);

await client.end();
