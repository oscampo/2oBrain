// Etapa 5 (PLAN-nodos.md, 2026-08-30): "estado actual del nodo X" generado
// al momento de la consulta desde los hechos vigentes reales, no una página
// mantenida a mano que se congela el día que se escribe (ver la motivación
// completa del rediseño en PLAN-nodos.md). Trae TODOS los hechos vigentes
// del nodo (match_count alto, no los 20 de timeline.mjs) y le pide a un LLM
// que resuma en prosa — mismo principio de fuente obligatoria que el resto
// del sistema: el prompt (ver lib/synthesize.mjs) prohíbe completar con
// conocimiento general.
// Uso: node node-status.mjs <nombre-de-nodo> [--provider ollama|gemini] [--model ...]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { synthesizeNodeStatus } from './lib/synthesize.mjs';

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

const rawArgs = process.argv.slice(2);
const node = rawArgs.find((a) => !a.startsWith('--'));
const args = parseArgs(rawArgs);
const provider = args.provider ?? 'ollama';

if (!node) {
  console.error('Uso: node node-status.mjs <nombre-de-nodo> [--provider ollama|gemini] [--model ...]');
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

// Resuelve merged_into como el resto del sistema: pedir el estado de un
// nombre viejo debe funcionar igual que pedirlo del vigente.
let current = node;
const seen = new Set();
let live = null;
while (true) {
  if (seen.has(current)) {
    console.error(`Ciclo de merged_into detectado empezando por "${node}".`);
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
  if (!rows[0].merged_into) { live = rows[0].name; break; }
  current = rows[0].merged_into;
}

const { rows: facts } = await client.query('select * from facts_timeline($1, $2, $3)', [live, 500, false]);
await client.end();

if (facts.length === 0) {
  console.log(`Sin hechos vigentes para el nodo "${live}".`);
  process.exit(0);
}

const rawFacts = facts
  .map((f) => `#${f.id} [${f.date.toISOString().slice(0, 10)}] ${f.claim}\n  fuente: ${f.source} · tipo: ${f.kind}`)
  .join('\n\n');

console.error(`(${facts.length} hecho(s) vigente(s) de "${live}", sintetizando con ${provider}${args.model ? ` (${args.model})` : ''}...)`);

const narrative = await synthesizeNodeStatus(live, rawFacts, provider, args.model);
console.log(narrative);
