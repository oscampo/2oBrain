// Exporta el timeline completo de cada nodo vigente a un .md por nodo, en
// una carpeta local -- pensado para experimentos manuales (ej. pasarle los
// archivos a un LLM directamente, sin depender de la disponibilidad de una
// API externa como Gemini/Ollama Cloud). Mismo formato de texto que ya usa
// list-edge-candidates-deep.mjs (lib/format-facts.mjs), para que cualquier
// comparación manual sea equivalente a la automática.
// Uso: node export-node-timelines.mjs [--dir ../../experimento] [--all-nodes]
//   --all-nodes incluye nodos is_meta (excluidos por defecto, mismo criterio
//   que list-edge-candidates-deep.mjs -- se relacionan tautológicamente con
//   todo por registrar el propio sistema).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { formatFactsBlock } from './lib/format-facts.mjs';

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

const { rows: nodes } = await client.query(
  `select n.name, count(fn.fact_id)::int as fact_count
   from nodes n
   left join fact_nodes fn on fn.node_name = n.name
   join facts f on f.id = fn.fact_id and f.valid_until is null
   where n.merged_into is null ${args['all-nodes'] ? '' : 'and not n.is_meta'}
   group by n.name
   having count(fn.fact_id) > 0
   order by count(fn.fact_id) desc`,
);

mkdirSync(outDir, { recursive: true });

for (const n of nodes) {
  const { rows } = await client.query(`select * from facts_timeline($1, $2, false)`, [n.name, 1000]);
  const body = `# ${n.name} (${n.fact_count} hecho(s))\n${formatFactsBlock(rows)}\n`;
  writeFileSync(join(outDir, `${n.name}.md`), body, 'utf8');
}

await client.end();

console.log(`${nodes.length} nodo(s) exportado(s) a ${outDir} (orden: más hechos primero).`);
for (const n of nodes) console.log(`  ${n.name} (${n.fact_count})`);
