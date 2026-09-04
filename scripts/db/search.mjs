// Búsqueda híbrida (vector + texto completo) contra Supabase, sobre pages
// y facts a la vez. Uso: node search.mjs "tu pregunta" [--include-dashboard-log]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral, rerank } from './lib/embed.mjs';

// Excluye por defecto projects/segundo-cerebro-dashboard-log (bitácora de
// construcción del dashboard, 28-ago-2026): hechos meta que citan preguntas
// de prueba textuales pueden rankear más alto que el contenido real sobre
// ese tema (hallazgo en vivo, ver hecho #264 en esa misma bitácora).
// --include-dashboard-log la trae de vuelta, para cuando de verdad se
// quiere consultar la bitácora de construcción. `pages` sigue usando el
// slug (no migrado todavía, ver PLAN-nodos.md Etapa 4); `facts` ya usa el
// nombre de nodo (fact_nodes, sin el prefijo de carpeta que sí tiene el slug).
const EXCLUDE_SLUG = 'projects/segundo-cerebro-dashboard-log';
const EXCLUDE_NODE = 'segundo-cerebro-dashboard-log';

const includeDashboardLog = process.argv.includes('--include-dashboard-log');
const excludeSlug = includeDashboardLog ? null : EXCLUDE_SLUG;
const excludeNode = includeDashboardLog ? null : EXCLUDE_NODE;

const query = process.argv.slice(2).filter((a) => a !== '--include-dashboard-log').join(' ');
if (!query) {
  console.error('Uso: node search.mjs "tu pregunta" [--include-dashboard-log]');
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

const queryEmbedding = await embed(query, 'query');

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const vectorLiteral = toVectorLiteral(queryEmbedding);

// Router de nodos (hallazgo 2026-08-31, ver PLAN-nodos.md): si la pregunta
// nombra literalmente un nodo por su nombre o alias (ej. "estado del
// proyecto Atlas"), trae TODOS sus hechos vigentes en vez de confiar en que
// RRF/rerank adivinen la relación: no la adivinan cuando ningún hecho
// individual repite el nombre del proyecto/nodo, solo hablan de su
// contenido (atlas-2026 nunca dice "Atlas", solo habla de Jane
// Doe/la universidad socia). Para preguntas que cruzan varios nodos o no nombran ninguno,
// esto no aporta nada y la búsqueda híbrida de abajo sigue siendo el
// camino principal.
const MAX_NODE_MATCH_FACTS = 15;

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const queryNorm = normalize(query);
function wordMatch(term) {
  const t = normalize(term).trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(queryNorm);
}
// Un nodo "matchea" si algún alias aparece completo en la pregunta, o si
// algún segmento significativo de su nombre kebab-case aparece como
// palabra completa (segmentos cortos o puramente numéricos, ej. "2026",
// se ignoran por poco específicos).
function nodeIsMatched(n) {
  if ((n.aliases ?? []).some((a) => wordMatch(a))) return true;
  const segments = n.name.split(/[-_]/).filter((s) => s.length >= 4 && !/^\d+$/.test(s));
  return segments.some((s) => wordMatch(s));
}

const { rows: allNodes } = await client.query(`select name, aliases, merged_into from nodes`);
const byName = new Map(allNodes.map((n) => [n.name, n]));
function resolveLiveNode(name) {
  let current = name;
  const seen = new Set();
  while (true) {
    if (seen.has(current)) return null; // ciclo: no debería pasar
    seen.add(current);
    const n = byName.get(current);
    if (!n) return null;
    if (!n.merged_into) return n.name;
    current = n.merged_into;
  }
}

const matchedLiveNodes = new Set();
for (const n of allNodes) {
  if (!nodeIsMatched(n)) continue;
  const live = resolveLiveNode(n.name);
  if (live && live !== excludeNode) matchedLiveNodes.add(live);
}

let nodeMatchFacts = [];
let nodeMatchTotal = 0;
if (matchedLiveNodes.size > 0) {
  const { rows } = await client.query(`select * from node_match_facts($1, $2)`, [[...matchedLiveNodes], MAX_NODE_MATCH_FACTS]);
  nodeMatchFacts = rows;
  nodeMatchTotal = rows.length > 0 ? Number(rows[0].total_count) : 0;
}
const nodeMatchTruncated = nodeMatchTotal > nodeMatchFacts.length;

// Trae un pool más grande (10) para que el reranker tenga sobre qué
// trabajar, luego se reordena y se muestran los 5 más relevantes de verdad.
const { rows: pageCandidates } = await client.query(`select * from search_pages($1, $2, $3, $4)`, [vectorLiteral, query, 10, excludeSlug]);
const { rows: factCandidates } = await client.query(`select * from facts_search($1, $2, $3, $4)`, [vectorLiteral, query, 10, excludeNode]);

async function rerankTop(candidates, toDoc, topN) {
  if (candidates.length === 0) return [];
  const ranked = await rerank(query, candidates.map(toDoc));
  return ranked.slice(0, topN).map((r) => ({ ...candidates[r.index], score: r.relevance_score }));
}

const pages = await rerankTop(pageCandidates, (p) => `${p.title}\n${p.content}`.slice(0, 4000), 5);
// Incluye el/los nodo(s) en el texto que ve el reranker: sin esto, un
// hecho cuyo contenido nunca menciona el nombre del proyecto/nodo (ej.
// atlas-2026, cuyos hechos hablan de "Jane Doe"/"la universidad socia" y
// nunca dicen "Atlas") queda mal puntuado frente a una pregunta que sí lo
// nombra, aunque facts_search ya lo haya traído al pool correctamente
// (mismo hallazgo 2026-08-31 que motivó el fix en schema.sql).
const rerankedFacts = await rerankTop(factCandidates, (f) => (f.nodes ? `[${f.nodes}] ${f.claim}` : f.claim), 5);

// Los hechos del router de nodos van primero (garantizados completos para
// el/los nodo(s) nombrados), seguidos de los de la búsqueda híbrida
// general que no se repitan.
const nodeMatchIds = new Set(nodeMatchFacts.map((f) => f.id));
const facts = [...nodeMatchFacts.map((f) => ({ ...f, score: null })), ...rerankedFacts.filter((f) => !nodeMatchIds.has(f.id))];

console.log('--- Páginas ---');
if (pages.length === 0) {
  console.log('Sin resultados.');
} else {
  for (const r of pages) {
    console.log(`\n[${r.score.toFixed(4)}] ${r.slug} (${r.type}) - actualizado ${r.updated_at.toISOString().slice(0, 10)}`);
    console.log(`  ${r.title}`);
    console.log(`  fuente: ${r.source_path}`);
    console.log(`  ${r.content.replace(/\s+/g, ' ').slice(0, 200)}...`);
  }
}

if (matchedLiveNodes.size > 0) {
  const suffix = nodeMatchTruncated ? ` (mostrando ${MAX_NODE_MATCH_FACTS} de ${nodeMatchTotal}, ver Timeline/Estado de nodo para el resto)` : '';
  console.log(`\n(nodo(s) detectado(s) en la pregunta: ${[...matchedLiveNodes].join(', ')}${suffix})`);
}

console.log('\n--- Hechos vigentes ---');
if (facts.length === 0) {
  console.log('Sin resultados.');
} else {
  for (const r of facts) {
    const date = r.date.toISOString().slice(0, 10);
    const scoreLabel = r.score == null ? '[nodo]' : `[${r.score.toFixed(4)}]`;
    console.log(`\n${scoreLabel} #${r.id} [${date}] ${r.claim}`);
    console.log(`  fuente: ${r.source} · tipo: ${r.kind}${r.nodes ? ` · nodos: ${r.nodes}` : ''}`);
  }
}

await client.end();
