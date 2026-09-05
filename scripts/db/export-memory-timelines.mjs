// Exporta el timeline completo de cada recuerdo vigente a un .md por recuerdo, en
// una carpeta local -- pensado para experimentos manuales (ej. pasarle los
// archivos a un LLM directamente, sin depender de la disponibilidad de una
// API externa como Gemini/Ollama Cloud). Mismo formato de texto que ya usa
// list-link-candidates-deep.mjs (lib/format-records.mjs), para que cualquier
// comparación manual sea equivalente a la automática.
// Uso: node export-memory-timelines.mjs [--dir ../../experimento] [--all-memories]
//   --all-memories incluye recuerdos is_meta (excluidos por defecto, mismo criterio
//   que list-link-candidates-deep.mjs -- se relacionan tautológicamente con
//   todo por registrar el propio sistema).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { formatFactsBlock } from './lib/format-records.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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
const outDir = join(SCRIPT_DIR, args.dir ?? '../../experimento');

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

const { rows: memories } = await client.query(
  `select n.name, count(fn.record_id)::int as fact_count
   from memories n
   left join record_memories fn on fn.memory_name = n.name
   join records f on f.id = fn.record_id and f.valid_until is null
   where n.merged_into is null ${args['all-memories'] ? '' : 'and not n.is_meta'}
   group by n.name
   having count(fn.record_id) > 0
   order by count(fn.record_id) desc`,
);

mkdirSync(outDir, { recursive: true });

for (const n of memories) {
  const { rows } = await client.query(`select * from records_timeline($1, $2, false)`, [n.name, 1000]);
  const body = `# ${n.name} (${n.fact_count} registro(s))\n${formatFactsBlock(rows)}\n`;
  writeFileSync(join(outDir, `${n.name}.md`), body, 'utf8');
}

await client.end();

console.log(`${memories.length} recuerdo(s) exportado(s) a ${outDir} (orden: más registros primero).`);
for (const n of memories) console.log(`  ${n.name} (${n.fact_count})`);
