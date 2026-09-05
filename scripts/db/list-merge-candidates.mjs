// Herramienta de revisión, no de automatización: compara por embedding los
// nombres (+ alias) de los recuerdos vigentes entre sí y superficie los pares
// por encima de un umbral para que un humano decida si vale la pena
// fusionarlos con merge-memories.mjs. Nunca fusiona nada solo: a diferencia
// de memories_similar() (que compara contra registros existentes para clasificar
// UN registro nuevo), esto compara recuerdos contra recuerdos, sin tocar `records`.
// Sin columna memories.embedding que mantener (mismo criterio "cero
// mantenimiento nuevo" de la Etapa 2): los embeddings se calculan al vuelo
// en cada corrida, no se guardan.
// Uso: node list-merge-candidates.mjs [--threshold 0.85]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed } from './lib/embed.mjs';

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
const threshold = args.threshold ? Number(args.threshold) : 0.85;

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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

const { rows: memories } = await client.query(
  `select n.name, n.aliases, count(fn.record_id) as fact_count
   from memories n
   left join record_memories fn on fn.memory_name = n.name
   where n.merged_into is null
   group by n.name, n.aliases
   order by n.name`,
);
await client.end();

if (memories.length < 2) {
  console.log('Menos de 2 recuerdos vigentes, nada que comparar.');
  process.exit(0);
}

console.error(`Calculando embeddings de ${memories.length} recuerdo(s)...`);
const withEmbedding = [];
for (const n of memories) {
  const text = [n.name, ...(n.aliases ?? [])].join(' / ');
  const embedding = await embed(text, 'document');
  withEmbedding.push({ ...n, embedding });
}

const pairs = [];
for (let i = 0; i < withEmbedding.length; i++) {
  for (let j = i + 1; j < withEmbedding.length; j++) {
    const similarity = cosineSimilarity(withEmbedding[i].embedding, withEmbedding[j].embedding);
    if (similarity >= threshold) {
      pairs.push({ a: withEmbedding[i], b: withEmbedding[j], similarity });
    }
  }
}

pairs.sort((x, y) => y.similarity - x.similarity);

if (pairs.length === 0) {
  console.log(`Sin pares por encima de ${threshold} entre los ${memories.length} recuerdos vigentes.`);
} else {
  console.log(`${pairs.length} par(es) candidato(s) a revisión (umbral ${threshold}):\n`);
  for (const p of pairs) {
    console.log(
      `  (${p.similarity.toFixed(3)}) "${p.a.name}" (${p.a.fact_count} registros) <-> "${p.b.name}" (${p.b.fact_count} registros)`,
    );
  }
  console.log('\nRevisión humana obligatoria, ninguno se fusiona solo. Si aplica:');
  console.log('  node merge-memories.mjs --from <nombre-a-retirar> --to <nombre-vigente> --reason "..."');
}
