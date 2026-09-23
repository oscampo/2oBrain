// Búsqueda híbrida (vector + texto completo) contra Supabase, sobre pages
// y records a la vez. Uso: node search.mjs "tu pregunta" [--include-dashboard-log]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral, rerank } from './lib/embed.mjs';

// Excluye por defecto projects/segundo-cerebro-dashboard-log (bitácora de
// construcción del dashboard, 28-ago-2026): registros meta que citan preguntas
// de prueba textuales pueden rankear más alto que el contenido real sobre
// ese tema (hallazgo en vivo, ver registro #264 en esa misma bitácora).
// --include-dashboard-log la trae de vuelta, para cuando de verdad se
// quiere consultar la bitácora de construcción. `pages` sigue usando el
// slug (no migrado todavía, ver PLAN-recuerdos.md Etapa 4); `records` ya usa el
// nombre de recuerdo (record_memories, sin el prefijo de carpeta que sí tiene el slug).
const EXCLUDE_SLUG = 'projects/segundo-cerebro-dashboard-log';
const EXCLUDE_NODE = 'segundo-cerebro-dashboard-log';

const includeDashboardLog = process.argv.includes('--include-dashboard-log');
const excludeSlug = includeDashboardLog ? null : EXCLUDE_SLUG;
const excludeMemory = includeDashboardLog ? null : EXCLUDE_NODE;

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

// Router de recuerdos (hallazgo 2026-08-31, ver PLAN-recuerdos.md): si la pregunta
// nombra literalmente un recuerdo por su nombre o alias (ej. "estado del
// proyecto Atlas"), trae TODOS sus registros vigentes en vez de confiar en que
// RRF/rerank adivinen la relación: no la adivinan cuando ningún registro
// individual repite el nombre del proyecto/recuerdo, solo hablan de su
// contenido (atlas-2026 nunca dice "Atlas", solo habla de Jane
// Doe/la universidad socia). Para preguntas que cruzan varios recuerdos o no nombran ninguno,
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
// Un recuerdo "matchea" si algún alias aparece completo en la pregunta, o si
// algún segmento significativo de su nombre kebab-case aparece como
// palabra completa (segmentos cortos o puramente numéricos, ej. "2026",
// se ignoran por poco específicos).
function nodeIsMatched(n) {
  if ((n.aliases ?? []).some((a) => wordMatch(a))) return true;
  const segments = n.name.split(/[-_]/).filter((s) => s.length >= 4 && !/^\d+$/.test(s));
  return segments.some((s) => wordMatch(s));
}

const { rows: allNodes } = await client.query(`select name, aliases, merged_into from memories`);
const byName = new Map(allNodes.map((n) => [n.name, n]));
function resolveLiveMemory(name) {
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
  const live = resolveLiveMemory(n.name);
  if (live && live !== excludeMemory) matchedLiveNodes.add(live);
}

// Pool más grande que lo mostrado (2026-09-14, portado desde D:\UAObrain,
// hallazgo real ahí): antes se traían los MAX_NODE_MATCH_FACTS más
// recientes sin ranking (order by fecha desc, adentro de
// memory_match_records) -- un recuerdo "paraguas" que agrupa temas sin
// relación entre sí podía llenar el cupo con ruido reciente en vez de lo
// realmente relevante a la pregunta. Mismo patrón que
// records_search/search_pages: pool amplio, reordenado por relevancia real
// (rerankTop), cortado al final. nodeMatchTotal sigue siendo el total real,
// la función SQL lo calcula antes de aplicar su propio limit, independiente
// del tamaño del pool que se le pida.
const NODE_MATCH_POOL = 50;
let nodeMatchFacts = [];
let nodeMatchTotal = 0;
let nodeMatchRows = [];
if (matchedLiveNodes.size > 0) {
  const { rows } = await client.query(`select * from memory_match_records($1, $2)`, [[...matchedLiveNodes], NODE_MATCH_POOL]);
  nodeMatchRows = rows;
  nodeMatchTotal = rows.length > 0 ? Number(rows[0].total_count) : 0;
  // Solo el claim, sin prefijo [memories]: el recuerdo ya está garantizado
  // por el router, el prefijo solo sesga hacia registros cuyo tag comparte
  // vocabulario con la pregunta, no cuyo contenido responde (hallazgo en
  // vivo en D:\UAObrain).
  nodeMatchFacts = await rerankTop(rows, (f) => f.claim, MAX_NODE_MATCH_FACTS);
}
const nodeMatchTruncated = nodeMatchTotal > nodeMatchFacts.length;

// Trae un pool más grande (10) para que el reranker tenga sobre qué
// trabajar, luego se reordena y se muestran los 5 más relevantes de verdad.
const { rows: pageCandidates } = await client.query(`select * from search_pages($1, $2, $3, $4)`, [vectorLiteral, query, 10, excludeSlug]);
const { rows: factCandidates } = await client.query(`select * from records_search($1, $2, $3, $4)`, [vectorLiteral, query, 10, excludeMemory]);

async function rerankTop(candidates, toDoc, topN) {
  if (candidates.length === 0) return [];
  const ranked = await rerank(query, candidates.map(toDoc));
  return ranked.slice(0, topN).map((r) => ({ ...candidates[r.index], score: r.relevance_score }));
}

const pages = await rerankTop(pageCandidates, (p) => `${p.title}\n${p.content}`.slice(0, 4000), 5);
// Incluye el/los recuerdo(s) en el texto que ve el reranker: sin esto, un
// registro cuyo contenido nunca menciona el nombre del proyecto/recuerdo (ej.
// atlas-2026, cuyos registros hablan de "Jane Doe"/"la universidad socia" y
// nunca dicen "Atlas") queda mal puntuado frente a una pregunta que sí lo
// nombra, aunque records_search ya lo haya traído al pool correctamente
// (mismo hallazgo 2026-08-31 que motivó el fix en schema.sql).
const rerankedFacts = await rerankTop(factCandidates, (f) => (f.memories ? `[${f.memories}] ${f.claim}` : f.claim), 5);

// Los registros del router de recuerdos van primero (garantizados completos para
// el/los recuerdo(s) nombrados), seguidos de los de la búsqueda híbrida
// general que no se repitan. "Garantizado" (score null) significaba antes
// "no se sabe qué tan relevante es, pero entra igual" -- eso se imprimía
// literal como "[recuerdo]", que el grafo terminaba pintando como 100% de
// relevancia (2026-09-19, hallazgo real de Oscar en D:\MyBrain: preguntas
// sin match verdadero, ej. "quién es Cora?"/"cuál es el uso principal que
// le doy a GitHub?", disparaban el router semántico sobre 2-3 nodos apenas
// por encima del piso, y sus registros salían todos pintados igual de
// "seguro" en el grafo pese a ser matches débiles). El fix real: rerankTop
// (línea arriba) YA calcula un score de relevancia real para cada registro
// del router, solo se usaba para decidir cuáles 15 mostrar cuando hay más
// de 15 -- nunca se imprimía. Se deja de nulear acá, así que ahora sale el
// número real en vez de "[recuerdo]".
const nodeMatchIds = new Set(nodeMatchFacts.map((f) => f.id));
const records = [...nodeMatchFacts, ...rerankedFacts.filter((f) => !nodeMatchIds.has(f.id))];

// 2026-09-15 (portado desde D:\MyBrain): records_search/memory_match_records
// ya garantizan que un complemento entra al POOL siempre que su registro
// complementado esté en el pool, pero el rerank de arriba (relevancia
// semántica a la pregunta, no al registro que complementa) puede igual
// dejarlo fuera del corte final -- un complemento suele ser poco relevante
// a la pregunta literal por diseño, esa no es la señal que lo justifica. Se
// reinserta cualquier complemento de lo que sí sobrevivió al corte,
// buscándolo en el pool crudo (pre-rerank) de ambas rutas, para que la
// garantía sea real de punta a punta, no solo hasta el SQL.
//
// Score heredado del registro que complementa, no null (2026-09-19,
// segundo hallazgo de Oscar sobre "garantizado" mostrando 100%: los
// nodeMatchFacts ya se arreglaron arriba, pero estos complementos seguían
// en null). Un complemento no tiene relevancia textual propia a la
// pregunta por diseño (ver arriba), pero SÍ hereda honestamente la de lo
// que complementa -- es la misma información continuada, no un hallazgo
// independiente. `r` siempre trae un score real a esta altura (todo lo que
// llega a `records` ya pasó por rerankTop), así que no hace falta null de
// respaldo.
const shownIds = new Set(records.map((r) => r.id));
const rawPool = [...nodeMatchRows, ...factCandidates];
for (const r of [...records]) {
  const missingComplements = rawPool.filter(
    (c) => c.complements != null && Number(c.complements) === Number(r.id) && !shownIds.has(c.id),
  );
  for (const c of missingComplements) {
    records.push({ ...c, score: r.score });
    shownIds.add(c.id);
  }
}

// Verificación de vigencia (2026-09-23, portado desde D:\MyBrain, ver
// segundo-cerebro #1149/#1151/#1152, caso real #699 vs #882): un resultado
// con buen score de similitud puede venir de un registro que YA fue
// superado por otro más reciente del mismo recuerdo que el ranking por
// similitud no trajo (vocabulario distinto, mismo hecho). Chequeo
// determinístico y barato, sin LLM: por cada recuerdo tocado por lo
// mostrado, ¿hay registros vigentes MÁS recientes de ese mismo recuerdo?
// records_newer_in_memory (schema.sql) es la misma función SQL que usa la
// tool 'search' del MCP server -- una sola fuente de verdad.
const shownMemoryMaxDate = new Map(); // memory_name -> fecha (string YYYY-MM-DD) más reciente ya mostrada
for (const r of records) {
  if (!r.memories) continue;
  const dateStr = r.date.toISOString().slice(0, 10);
  for (const m of r.memories.split(',').map((s) => s.trim()).filter(Boolean)) {
    const prev = shownMemoryMaxDate.get(m);
    if (!prev || dateStr > prev) shownMemoryMaxDate.set(m, dateStr);
  }
}
const staleWarnings = [];
for (const [memName, thresholdDate] of shownMemoryMaxDate) {
  const { rows } = await client.query(`select * from records_newer_in_memory($1, $2::date)`, [memName, thresholdDate]);
  for (const row of rows) {
    if (!shownIds.has(Number(row.id))) staleWarnings.push({ ...row, memory_name: memName });
  }
}

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
  const suffix = nodeMatchTruncated ? ` (mostrando ${MAX_NODE_MATCH_FACTS} de ${nodeMatchTotal}, ver Timeline/Estado de recuerdo para el resto)` : '';
  console.log(`\n(recuerdo(s) detectado(s) en la pregunta: ${[...matchedLiveNodes].join(', ')}${suffix})`);
}

console.log('\n--- registros vigentes ---');
if (records.length === 0) {
  console.log('Sin resultados.');
} else {
  for (const r of records) {
    const date = r.date.toISOString().slice(0, 10);
    const scoreLabel = r.score == null ? '[recuerdo]' : `[${r.score.toFixed(4)}]`;
    const complementsLabel = r.complements != null ? ` [complementa a #${r.complements}]` : '';
    console.log(`\n${scoreLabel} #${r.id} [${date}] ${r.claim}${complementsLabel}`);
    console.log(`  fuente: ${r.source} · tipo: ${r.kind}${r.memories ? ` · recuerdos: ${r.memories}` : ''}`);
  }
}

if (staleWarnings.length > 0) {
  console.log('\n--- ⚠ posible desactualización: hay registros vigentes MÁS RECIENTES de estos recuerdos, no mostrados arriba ---');
  for (const r of staleWarnings) {
    const date = r.date.toISOString().slice(0, 10);
    console.log(`\n#${r.id} [${date}] (${r.memory_name}) ${r.claim}`);
    console.log(`  fuente: ${r.source} · tipo: ${r.kind}`);
  }
}

await client.end();
