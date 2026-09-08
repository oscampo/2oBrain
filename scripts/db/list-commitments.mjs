// Lista los compromisos abiertos (records kind='commitment', valid_until is
// null), ordenados por fecha, con recuerdo. Reemplaza la sección "Open
// commitments" mantenida a mano en MEMORY.md (2026-09-05): esa prosa
// duplicaba lo que `records` ya guarda mejor estructurado (fecha, fuente,
// recuerdo, con la posibilidad real de retractar/reemplazar vía forget.mjs),
// herencia directa de la era gbrain donde MEMORY.md era la única memoria.
// El commitments-check de HEARTBEAT.md corre esto en vez de leer prosa.
//
// --memory <nombre> (2026-09-08): acota a los compromisos de un solo
// recuerdo -- nace de un caso real: un compromiso con dos partes quedó
// vigente sin cerrarse aunque una de las partes ya se había resuelto días
// antes, porque nadie cruzó el registro nuevo contra el compromiso viejo
// del mismo recuerdo. Barato de correr en el momento de guardar un
// registro nuevo en ese recuerdo (¿hay algo abierto acá que esto resuelva,
// total o parcialmente?), y como respaldo en commitments-check contra los
// recuerdos tocados recientemente.
// Uso:
//   node list-commitments.mjs [--all]  (--all incluye los ya resueltos/retractados)
//   node list-commitments.mjs --memory nombre-del-recuerdo
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { resolveLiveMemory } from './lib/create-link.mjs';

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
const showAll = Boolean(args.all);

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

let memoryFilter = null;
if (args.memory) {
  const result = await resolveLiveMemory(client, args.memory);
  if (!result.ok) {
    console.error(`${result.error} Revisa el nombre con list-memories.mjs.`);
    await client.end();
    process.exit(1);
  }
  memoryFilter = result.name;
}

const { rows } = await client.query(
  `select f.id, f.date, f.claim, f.source, f.valid_until,
          (select string_agg(memory_name, ', ' order by memory_name) from record_memories where record_id = f.id) as memories
   from records f
   where f.kind = 'commitment' ${showAll ? '' : 'and f.valid_until is null'}
     ${memoryFilter ? 'and exists (select 1 from record_memories rm where rm.record_id = f.id and rm.memory_name = $1)' : ''}
   order by f.date asc`,
  memoryFilter ? [memoryFilter] : [],
);

if (rows.length === 0) {
  console.log(
    memoryFilter
      ? `Sin compromisos${showAll ? '' : ' abiertos'} para "${memoryFilter}".`
      : showAll ? 'Sin compromisos registrados nunca.' : 'Sin compromisos abiertos.',
  );
} else {
  for (const r of rows) {
    const date = r.date.toISOString().slice(0, 10);
    const status = r.valid_until ? ' [resuelto/retractado]' : '';
    console.log(`\n#${r.id} [${date}]${status} ${r.claim}`);
    console.log(`  fuente: ${r.source}${r.memories ? ` · recuerdos: ${r.memories}` : ''}`);
  }
}

await client.end();
