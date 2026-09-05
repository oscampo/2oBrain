// Lista los compromisos abiertos (records kind='commitment', valid_until is
// null), ordenados por fecha, con recuerdo. Reemplaza la sección "Open
// commitments" mantenida a mano en MEMORY.md (2026-09-05): esa prosa
// duplicaba lo que `records` ya guarda mejor estructurado (fecha, fuente,
// recuerdo, con la posibilidad real de retractar/reemplazar vía forget.mjs),
// herencia directa de la era gbrain donde MEMORY.md era la única memoria.
// El commitments-check de HEARTBEAT.md corre esto en vez de leer prosa.
// Uso: node list-commitments.mjs [--all]  (--all incluye los ya resueltos/retractados)
import { readFileSync } from 'node:fs';
import pg from 'pg';

const showAll = process.argv.includes('--all');

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
  `select f.id, f.date, f.claim, f.source, f.valid_until,
          (select string_agg(memory_name, ', ' order by memory_name) from record_memories where record_id = f.id) as memories
   from records f
   where f.kind = 'commitment' ${showAll ? '' : 'and f.valid_until is null'}
   order by f.date asc`,
);

if (rows.length === 0) {
  console.log(showAll ? 'Sin compromisos registrados nunca.' : 'Sin compromisos abiertos.');
} else {
  for (const r of rows) {
    const date = r.date.toISOString().slice(0, 10);
    const status = r.valid_until ? ' [resuelto/retractado]' : '';
    console.log(`\n#${r.id} [${date}]${status} ${r.claim}`);
    console.log(`  fuente: ${r.source}${r.memories ? ` · recuerdos: ${r.memories}` : ''}`);
  }
}

await client.end();
