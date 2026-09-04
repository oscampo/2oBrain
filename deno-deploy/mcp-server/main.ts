// MCP propio (Fase 4 del plan original), version Deno Deploy. Migrado desde
// supabase/functions/mcp-server/ porque el conector de Claude.ai hace
// descubrimiento OAuth (GET /.well-known/oauth-protected-resource) antes de
// llamar al servidor, y esa ruta cae en la raiz del dominio, no en
// /functions/v1/<nombre>/ — en Supabase esa raiz la controla su propio
// gateway (401 generico, no llega a nuestro codigo). Aqui controlamos toda
// la raiz del dominio, asi que esa ruta simplemente no matchea ninguna
// route y cae en un 404 normal nuestro, que un cliente MCP interpreta como
// "no hay metadata de recurso protegido, no requiere OAuth", no como un
// fallo de autenticacion.
//
// Misma logica que supabase/functions/mcp-server/index.ts (search/remember,
// gate de contradicciones via facts_similar()), solo cambia el hosting y las
// rutas (aqui a nivel raiz, no bajo /mcp-server/*).
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { McpServer, StreamableHttpTransport } from 'mcp-lite';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VOYAGE_API_KEY = Deno.env.get('VOYAGE_API_KEY')!;
const MCP_ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY')!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const OLLAMA_API_KEY = Deno.env.get('OLLAMA_API_KEY');

// OAuth 2.1 de un solo usuario (2026-08-31): MCP_ACCESS_KEY viajando en la
// URL (?key=...) es la unica forma que el conector personalizado de claude.ai
// permite (sin campo de header), pero cualquier cliente que la copie/guarde
// la expone. Esto agrega el flujo de autorizacion que la propia spec de MCP
// define para este problema (Authorization Code + PKCE, RFC 8414/9728/7591),
// simplificado para un solo usuario reconocido: sin pantalla de login real,
// sin registro de clientes con vetting, solo la clave de acceso existente
// pedida UNA vez en el navegador durante /authorize. De ahi en adelante el
// cliente guarda un access/refresh token, nunca la clave maestra. x-mcp-key
// y ?key= se mantienen funcionando (no rompe el conector ya configurado).
const kv = await Deno.openKv();
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SIMILARITY_THRESHOLD = 0.6;
// Bitácora de construcción del dashboard (28-ago-2026): hechos meta que citan
// preguntas de prueba textuales pueden rankear más alto que contenido real
// sobre ese tema. Mismo criterio que scripts/db/search.mjs.
const DASHBOARD_LOG_NODE = 'segundo-cerebro-dashboard-log';
const CLASSIFIER_MODEL = 'gpt-oss:20b-cloud';
const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.85;

async function embed(text: string, inputType: 'query' | 'document'): Promise<number[]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, model: 'voyage-4-lite', input_type: inputType, output_dimension: 1024 }),
  });
  if (!res.ok) throw new Error(`Voyage embed fallo: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  return data[0].embedding;
}

async function rerank(query: string, documents: string[]): Promise<{ index: number; relevance_score: number }[]> {
  if (documents.length === 0) return [];
  const res = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, documents, model: 'rerank-2.5-lite' }),
  });
  if (!res.ok) throw new Error(`Voyage rerank fallo: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  return data;
}

// Router de nodos (hallazgo 2026-08-31, ver PLAN-nodos.md): si la pregunta
// nombra literalmente un nodo por su nombre o alias (ej. "estado del
// proyecto COIL"), trae TODOS sus hechos vigentes en vez de confiar en que
// RRF/rerank adivinen la relacion - no la adivinan cuando ningun hecho
// individual repite el nombre del proyecto/nodo, solo habla de su
// contenido. Mismo criterio y misma funcion SQL (node_match_facts) que
// scripts/db/search.mjs.
const MAX_NODE_MATCH_FACTS = 15;

function normalizeText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function wordMatch(term: string, queryNorm: string): boolean {
  const t = normalizeText(term).trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(queryNorm);
}
function nodeIsMatched(n: { name: string; aliases: string[] | null }, queryNorm: string): boolean {
  if ((n.aliases ?? []).some((a) => wordMatch(a, queryNorm))) return true;
  const segments = n.name.split(/[-_]/).filter((s) => s.length >= 4 && !/^\d+$/.test(s));
  return segments.some((s) => wordMatch(s, queryNorm));
}
function resolveLiveNode(name: string, byName: Map<string, { name: string; merged_into: string | null }>): string | null {
  let current = name;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) return null; // ciclo: no deberia pasar
    seen.add(current);
    const n = byName.get(current);
    if (!n) return null;
    if (!n.merged_into) return n.name;
    current = n.merged_into;
  }
}

// Tiering del gate de contradicciones (ver hecho #149/#152 en segundo-cerebro):
// primera pasada barata via Ollama Cloud antes de bloquear. Portado desde
// scripts/db/lib/classify-duplicate.mjs, misma logica que
// supabase/functions/mcp-server/index.ts. Nunca trata un error de red o una
// respuesta invalida como "distinct": fallar hacia el lado seguro es
// bloquear, no insertar.
async function classifyDuplicate(
  newClaim: string,
  candidates: { id: number; claim: string; similarity: number }[],
): Promise<{ verdict: 'distinct' | 'supersedes'; supersedesIds: number[]; confidence: number; reasoning: string } | null> {
  if (!OLLAMA_API_KEY) return null;

  const candidateList = candidates
    .map((c) => `  #${c.id} (similitud ${c.similarity.toFixed(2)}): "${c.claim}"`)
    .join('\n');
  const prompt = `Eres un clasificador que decide si un hecho nuevo, comparado con hechos ya \
registrados y parecidos por embedding, es genuinamente distinto o si reemplaza \
(supersede) a alguno de ellos por describir el mismo estado de cosas actualizado.

Hecho nuevo: "${newClaim}"

Hechos vigentes parecidos:
${candidateList}

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"verdict": "distinct" | "supersedes", "supersedes_ids": [ids numericos de los hechos que reemplaza, vacio si verdict es "distinct"], "confidence": numero entre 0 y 1, "reasoning": "una oracion breve en espanol"}

"supersedes" solo si el hecho nuevo describe el mismo asunto en un estado mas \
reciente o corrige al anterior. "distinct" si es tematicamente parecido pero es \
informacion genuinamente distinta (otro aspecto, otro momento no contradictorio, \
otro sujeto). Si no estas seguro, baja la confidence en vez de adivinar.`;

  let res: Response;
  try {
    res = await fetch('https://ollama.com/api/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: CLASSIFIER_MODEL, prompt, format: 'json', stream: false }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let parsed: any;
  try {
    const { response } = await res.json();
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  const validIds = new Set(candidates.map((c) => Number(c.id)));
  const supersedesIds = Array.isArray(parsed.supersedes_ids)
    ? parsed.supersedes_ids.map(Number).filter((id: number) => validIds.has(id))
    : [];
  const confidence = Number(parsed.confidence);

  if (
    (parsed.verdict !== 'distinct' && parsed.verdict !== 'supersedes') ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    (parsed.verdict === 'supersedes' && supersedesIds.length === 0)
  ) {
    return null;
  }

  return {
    verdict: parsed.verdict,
    supersedesIds,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

// Etapa 2 (PLAN-nodos.md, 2026-08-29): desambiguación de nodos. Mismo patrón
// que classifyDuplicate — Ollama Cloud, gpt-oss:20b-cloud, fail-closed en
// cualquier fallo (red, cuota, JSON inválido, nodo "existing" inventado que
// no está entre los candidatos). Ver scripts/db/lib/classify-node.mjs para
// el diseño completo; esta es la misma lógica portada a Deno.
const NODE_CLASSIFIER_MODEL = 'gpt-oss:20b-cloud';
const NODE_CLASSIFIER_CONFIDENCE_THRESHOLD = 0.85;

async function classifyNode(
  newClaim: string,
  candidates: { node_name: string; examples: string[]; similarity: number; aliases?: string[] }[],
): Promise<{ verdict: 'existing' | 'new'; node: string; confidence: number; reasoning: string } | null> {
  if (!OLLAMA_API_KEY) return null;
  if (candidates.length === 0) return null;

  const candidateList = candidates
    .map((c) => {
      const aliasLine = c.aliases?.length ? ` — alias: ${c.aliases.join(', ')}` : '';
      return `  "${c.node_name}"${aliasLine} (similitud ${c.similarity.toFixed(2)}), ejemplos:\n${c.examples.map((ex) => `      - "${ex}"`).join('\n')}`;
    })
    .join('\n');
  const prompt = `Eres un clasificador que decide a qué nodo (tema/entidad) pertenece un hecho \
nuevo dentro de un segundo cerebro personal. Cada nodo agrupa hechos sobre el mismo \
asunto (un proyecto, una persona, un curso, una colaboración). Te doy los nodos \
existentes más parecidos por embedding, cada uno con sus hechos más cercanos como \
ejemplo y, si los tiene, sus alias (otros nombres con los que se lo menciona).

Hecho nuevo: "${newClaim}"

Nodos existentes parecidos:
${candidateList}

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"verdict": "existing" | "new", "node": "nombre exacto de uno de los nodos de arriba si verdict es existing, o un nombre propuesto en kebab-case si verdict es new", "confidence": número entre 0 y 1, "reasoning": "una oración breve en español"}

"existing" solo si el hecho nuevo es genuinamente sobre el mismo asunto que ese nodo \
(mismo proyecto/persona/curso/colaboración, no solo un tema parecido en abstracto — \
ej. dos cursos distintos que comparten infraestructura de GitHub NO son el mismo nodo). \
"new" si ningún nodo de la lista es realmente el mismo asunto. \
PRIORIDAD: si el hecho nuevo menciona literalmente (aunque sea parcialmente, ignorando \
mayúsculas/tildes) el nombre o un alias de alguno de los nodos, esa coincidencia léxica \
pesa más que el parecido temático de los ejemplos — el nombre explícito es una señal \
más fuerte y más confiable que la similitud de contenido, úsala para desempatar. \
Si no estás seguro, baja la confidence en vez de adivinar.`;

  let res: Response;
  try {
    res = await fetch('https://ollama.com/api/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: NODE_CLASSIFIER_MODEL, prompt, format: 'json', stream: false }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let parsed: any;
  try {
    const { response } = await res.json();
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  const validNodeNames = new Set(candidates.map((c) => c.node_name));
  const confidence = Number(parsed.confidence);
  const node = typeof parsed.node === 'string' ? parsed.node.trim() : '';

  if (
    (parsed.verdict !== 'existing' && parsed.verdict !== 'new') ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    node === '' ||
    (parsed.verdict === 'existing' && !validNodeNames.has(node))
  ) {
    return null;
  }

  return {
    verdict: parsed.verdict,
    node,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

const mcp = new McpServer({
  name: 'segundo-cerebro-mcp',
  version: '1.0.0',
  schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
});

mcp.tool('search', {
  description:
    'Busca hechos vigentes en el segundo cerebro por una pregunta en lenguaje natural. Devuelve los hechos mas relevantes, con su fuente.',
  inputSchema: z.object({ query: z.string().describe('La pregunta o tema a buscar') }),
  handler: async ({ query }: { query: string }) => {
    const queryEmbedding = await embed(query, 'query');
    const queryNorm = normalizeText(query);

    const { data: allNodes } = await supabase.from('nodes').select('name, aliases, merged_into');
    const byName = new Map<string, any>((allNodes ?? []).map((n: any) => [n.name, n]));
    const matchedLiveNodes = new Set<string>();
    for (const n of allNodes ?? []) {
      if (!nodeIsMatched(n, queryNorm)) continue;
      const live = resolveLiveNode(n.name, byName);
      if (live && live !== DASHBOARD_LOG_NODE) matchedLiveNodes.add(live);
    }

    const [{ data: factCandidates }, { data: nodeMatchRows }] = await Promise.all([
      supabase.rpc('facts_search', { query_embedding: queryEmbedding, query_text: query, match_count: 10, exclude_node: DASHBOARD_LOG_NODE }),
      matchedLiveNodes.size > 0
        ? supabase.rpc('node_match_facts', { node_names: [...matchedLiveNodes], match_count: MAX_NODE_MATCH_FACTS })
        : Promise.resolve({ data: [] as any[] }),
    ]);

    async function rerankTop(candidates: any[], toDoc: (c: any) => string, topN: number) {
      if (!candidates || candidates.length === 0) return [];
      const ranked = await rerank(query, candidates.map(toDoc));
      return ranked.slice(0, topN).map((r) => ({ ...candidates[r.index], score: r.relevance_score }));
    }

    // Incluye el/los nodo(s) en el texto que ve el reranker - sin esto, un
    // hecho cuyo contenido nunca menciona el nombre del proyecto/nodo queda
    // mal puntuado frente a una pregunta que si lo nombra (mismo hallazgo
    // 2026-08-31 que motivo el router de arriba).
    const rerankedFacts = await rerankTop(factCandidates ?? [], (f) => (f.nodes ? `[${f.nodes}] ${f.claim}` : f.claim), 5);

    const nodeMatchFacts = nodeMatchRows ?? [];
    const nodeMatchTotal = nodeMatchFacts.length > 0 ? Number(nodeMatchFacts[0].total_count) : 0;
    const nodeMatchTruncated = nodeMatchTotal > nodeMatchFacts.length;
    const nodeMatchIds = new Set(nodeMatchFacts.map((f: any) => f.id));
    // Los hechos del router de nodos van primero (garantizados completos
    // para el/los nodo(s) nombrados), seguidos de los de la busqueda
    // hibrida general que no se repitan.
    const facts = [
      ...nodeMatchFacts.map((f: any) => ({ ...f, score: null as number | null })),
      ...rerankedFacts.filter((f: any) => !nodeMatchIds.has(f.id)),
    ];

    let text = '--- Hechos vigentes ---\n';
    if (matchedLiveNodes.size > 0) {
      const suffix = nodeMatchTruncated
        ? ` (mostrando ${MAX_NODE_MATCH_FACTS} de ${nodeMatchTotal}, pide "estado del nodo X" para el resto)`
        : '';
      text += `(nodo(s) detectado(s) en la pregunta: ${[...matchedLiveNodes].join(', ')}${suffix})\n`;
    }

    if (facts.length === 0) text += 'Sin resultados.\n';
    else
      for (const f of facts) {
        const scoreLabel = f.score == null ? '[nodo]' : `[${f.score.toFixed(4)}]`;
        text += `\n${scoreLabel} #${f.id} [${f.date}] ${f.claim}\n  fuente: ${f.source} - tipo: ${f.kind}${f.nodes ? ` - nodos: ${f.nodes}` : ''}\n`;
      }

    return { content: [{ type: 'text', text }] };
  },
});

mcp.tool('remember', {
  description:
    'Registra un hecho atomico con fecha y fuente obligatorias en el segundo cerebro. Antes de insertar, busca hechos vigentes parecidos por embedding; si encuentra candidatos, se niega a insertar salvo que se pase supersedes o distinct explicito. El nodo (o nodos) debe existir de antemano en la tabla nodes salvo que se pase createNode.',
  inputSchema: z.object({
    claim: z.string().describe('Texto claro y autocontenido del hecho'),
    date: z.string().describe('Fecha YYYY-MM-DD, nunca inferida de texto libre'),
    source: z.string().describe('De donde salio el hecho'),
    kind: z.enum(['fact', 'event', 'preference', 'commitment']).default('fact'),
    node: z.union([z.string(), z.array(z.string())]).optional().describe('Nodo(s) existente(s) a los que se liga el hecho (string separado por comas, o array)'),
    createNode: z.boolean().optional().describe('Crea el/los nodo(s) si no existen todavia, en vez de fallar'),
    supersedes: z.array(z.number()).optional().describe('IDs de hechos vigentes que este reemplaza'),
    distinct: z.boolean().optional().describe('Confirma que es distinto pese al parecido con candidatos'),
    confirmDate: z.boolean().optional().describe('Obligatorio si date no es la fecha real de hoy (America/Bogota) -- confirma que un hecho con fecha distinta es intencional (historico, backfill), no un error de no verificar la fecha antes de llamar'),
  }),
  handler: async (args: {
    claim: string;
    date: string;
    source: string;
    kind?: string;
    node?: string | string[];
    createNode?: boolean;
    supersedes?: number[];
    distinct?: boolean;
    confirmDate?: boolean;
  }) => {
    if (!DATE_RE.test(args.date)) {
      return {
        content: [{ type: 'text', text: `Fecha invalida: "${args.date}". Debe ser YYYY-MM-DD, no se infiere.` }],
        isError: true,
      };
    }

    // Mismo criterio que remember.mjs/remember-batch.mjs (2026-09-03, hechos
    // #528/#530): bloquea por defecto si date no es hoy, salvo confirmDate
    // explicito -- evita el error real que motivo esto (hecho #525, grabado
    // con fecha vieja por no verificar antes de llamar).
    const todayBogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    if (args.date !== todayBogota && !args.confirmDate) {
      return {
        content: [{
          type: 'text',
          text: `date ${args.date} es distinto de hoy (${todayBogota} en America/Bogota). Si es un hecho historico o backfill intencional, pasa confirmDate: true. Si fue sin querer, corrige date y vuelve a intentar.`,
        }],
        isError: true,
      };
    }

    const embedding = await embed(args.claim, 'document');

    const { data: candidates } = await supabase.rpc('facts_similar', {
      query_embedding: embedding,
      match_count: 5,
    });
    const similar = (candidates ?? []).filter((c: any) => c.similarity >= SIMILARITY_THRESHOLD);
    let supersedesIds = args.supersedes ?? [];
    let distinct = args.distinct ?? false;
    let autoResolved: Awaited<ReturnType<typeof classifyDuplicate>> = null;

    if (similar.length > 0 && supersedesIds.length === 0 && !distinct) {
      autoResolved = await classifyDuplicate(args.claim, similar);
      if (autoResolved && autoResolved.confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD) {
        if (autoResolved.verdict === 'supersedes') supersedesIds = autoResolved.supersedesIds;
        else distinct = true;
      } else {
        autoResolved = null;
      }
    }

    if (similar.length > 0 && supersedesIds.length === 0 && !distinct) {
      let text = `Hay ${similar.length} hecho(s) vivo(s) parecido(s), resuelvelo antes de insertar:\n`;
      for (const c of similar) {
        text += `\n#${c.id} [${c.date}] (similitud ${c.similarity.toFixed(2)}) ${c.claim}\n  fuente: ${c.source}${c.nodes ? ` - nodos: ${c.nodes}` : ''}\n`;
      }
      text +=
        '\nSi este hecho reemplaza a alguno, vuelve a llamar con supersedes: [ids]. Si es genuinamente distinto, llama con distinct: true.';
      return { content: [{ type: 'text', text }], isError: true };
    }

    if (autoResolved) {
      args.source = `${args.source} [auto-resuelto por Ollama Cloud (${CLASSIFIER_MODEL}), confianza ${autoResolved.confidence.toFixed(2)}: ${autoResolved.reasoning}]`;
    }

    if (supersedesIds.length > 0) {
      const invalid = supersedesIds.filter((id) => !(candidates ?? []).some((c: any) => c.id === id));
      if (invalid.length > 0) {
        return {
          content: [
            { type: 'text', text: `supersedes referencia id(s) que no aparecieron entre los parecidos vivos: ${invalid.join(', ')}.` },
          ],
          isError: true,
        };
      }
    }

    // Etapa 2 (PLAN-nodos.md, 2026-08-29): desambiguación automática. Corre
    // SIEMPRE, incluso con node explícito (Etapa 0), pero solo bloquea
    // cuando node no vino — con node explícito es solo un aviso en el texto
    // de respuesta, nunca sobreescribe la elección del llamador.
    const { data: nodeCandidateRows } = await supabase.rpc('nodes_similar', {
      query_embedding: embedding,
      match_count: 5,
    });
    const nodeCandidates = (nodeCandidateRows ?? []).map((r: any) => ({
      node_name: r.node_name,
      examples: r.examples,
      similarity: r.similarity,
      aliases: r.aliases,
    }));
    const nodeVerdict = nodeCandidates.length > 0 ? await classifyNode(args.claim, nodeCandidates) : null;

    let requestedNodes = args.node == null ? [] : Array.isArray(args.node) ? args.node : args.node.split(',').map((s) => s.trim()).filter(Boolean);
    let nodeAdvisory = '';

    if (requestedNodes.length === 0) {
      if (!nodeVerdict || nodeVerdict.confidence < NODE_CLASSIFIER_CONFIDENCE_THRESHOLD) {
        let text = 'No se pasó node y la desambiguación automática no alcanzó confianza suficiente.\n';
        if (nodeCandidates.length > 0) {
          text += '\nNodos existentes más parecidos:\n';
          for (const c of nodeCandidates) {
            text += `  "${c.node_name}" (similitud ${c.similarity.toFixed(2)}):\n${c.examples.map((ex: string) => `      - ${ex}`).join('\n')}\n`;
          }
        } else {
          text += '\n(no hay hechos con embedding en ningún nodo todavía para comparar)\n';
        }
        text += '\nPasa node (nombre existente), o node + createNode: true si es genuinamente uno nuevo.';
        return { content: [{ type: 'text', text }], isError: true };
      }
      if (nodeVerdict.verdict === 'new') {
        return {
          content: [{
            type: 'text',
            text: `El clasificador (${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}) propone un nodo NUEVO: "${nodeVerdict.node}" (${nodeVerdict.reasoning})\nSi es correcto, vuelve a llamar con node: "${nodeVerdict.node}", createNode: true.`,
          }],
          isError: true,
        };
      }
      requestedNodes = [nodeVerdict.node];
      nodeAdvisory = `(nodo auto-resuelto por ${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}: ${nodeVerdict.reasoning})`;
    } else if (
      nodeVerdict &&
      nodeVerdict.confidence >= NODE_CLASSIFIER_CONFIDENCE_THRESHOLD &&
      (nodeVerdict.verdict === 'new' || !requestedNodes.includes(nodeVerdict.node))
    ) {
      nodeAdvisory =
        `(aviso: la desambiguación (confianza ${nodeVerdict.confidence.toFixed(2)}) sugiere ` +
        `${nodeVerdict.verdict === 'new' ? `un nodo nuevo distinto: "${nodeVerdict.node}"` : `el nodo existente "${nodeVerdict.node}"`}` +
        ` en vez de ${requestedNodes.map((n) => `"${n}"`).join(', ')} — se respeta tu elección explícita.)`;
    }

    // Resuelve node: cada nombre debe existir en `nodes` (fail-closed contra
    // typos que crearian un nodo fantasma), salvo createNode explicito. Si un
    // nodo fue fusionado a otro (merged_into), sigue la cadena al vigente —
    // mismo criterio que remember.mjs/remember-batch.mjs.
    const resolvedNodes: string[] = [];
    for (const name of requestedNodes) {
      let current = name;
      const seen = new Set<string>();
      let row: { name: string; merged_into: string | null } | null = null;
      while (true) {
        if (seen.has(current)) {
          return { content: [{ type: 'text', text: `Ciclo de merged_into detectado en nodos empezando por "${name}".` }], isError: true };
        }
        seen.add(current);
        const { data: found } = await supabase.from('nodes').select('name, merged_into').eq('name', current).maybeSingle();
        if (!found) { row = null; break; }
        row = found;
        if (!row.merged_into) break;
        current = row.merged_into;
      }
      if (row) {
        resolvedNodes.push(row.name);
      } else if (args.createNode) {
        await supabase.from('nodes').upsert({ name }, { onConflict: 'name', ignoreDuplicates: true });
        resolvedNodes.push(name);
      } else {
        return {
          content: [{ type: 'text', text: `Nodo "${name}" no existe en la tabla nodes. Pasa createNode: true si es genuinamente uno nuevo.` }],
          isError: true,
        };
      }
    }

    const { data: inserted, error } = await supabase
      .from('facts')
      .insert({
        claim: args.claim,
        kind: args.kind ?? 'fact',
        date: args.date,
        source: args.source,
        embedding,
      })
      .select('id, date, claim')
      .single();

    if (error || !inserted) {
      return { content: [{ type: 'text', text: `Error al insertar: ${error?.message}` }], isError: true };
    }

    if (resolvedNodes.length > 0) {
      await supabase
        .from('fact_nodes')
        .upsert(resolvedNodes.map((node_name) => ({ fact_id: inserted.id, node_name })), { onConflict: 'fact_id,node_name', ignoreDuplicates: true });
    }

    if (supersedesIds.length > 0) {
      await supabase
        .from('facts')
        .update({ valid_until: new Date().toISOString(), superseded_by: inserted.id })
        .in('id', supersedesIds);
    }

    let text = `Registrado #${inserted.id}: [${inserted.date}] ${inserted.claim}`;
    if (resolvedNodes.length > 0) text += `\nNodo(s): ${resolvedNodes.join(', ')}`;
    if (nodeAdvisory) text += `\n${nodeAdvisory}`;
    if (supersedesIds.length > 0) text += `\nReemplazo a #${supersedesIds.join(', #')}.`;
    else if (similar.length > 0 && distinct) text += `\nConfirmado como distinto pese al parecido.`;

    return { content: [{ type: 'text', text }] };
  },
});

const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

const app = new Hono();

// CORS (2026-09-01, handoff de la sesión de obsidian-neural-composer): un
// cliente MCP corriendo en un contexto tipo navegador (Electron/Obsidian
// Desktop, o cualquier cliente web) hace preflight OPTIONS antes del POST a
// /mcp porque manda Content-Type: application/json, y eso nunca calificó
// como "simple request" en la spec de CORS. Sin esto el navegador aborta la
// petición entera (net::ERR_FAILED) sin que el request llegue a nuestro
// código — no es un 401, es un fallo de red anterior a cualquier respuesta.
// Nunca hizo falta hasta ahora porque los únicos clientes eran procesos
// Node.js/CLI (sesiones de Code, mcp-remote vía npx), donde CORS no aplica.
// origin: '*' es seguro aquí porque la autenticacion es por query
// param/header (?key= o Bearer), nunca por cookies/credentials — no hay
// nada que un origin ajeno pueda robar via CORS.
app.use(
  '/mcp',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'x-mcp-key'],
  }),
);

app.get('/', (c) => c.json({ message: 'MCP del segundo cerebro', endpoints: { mcp: '/mcp', health: '/health' } }));

app.get('/health', (c) => c.json({ ok: true }));

// --- OAuth 2.1 (Authorization Code + PKCE), un solo usuario ---

app.get('/.well-known/oauth-protected-resource', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
});

app.get('/.well-known/oauth-authorization-server', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// Registro dinamico de clientes (RFC 7591) — publico a proposito: registrarse
// no otorga nada por si solo, solo un client_id. El paso que realmente
// protege es /authorize (pide la clave de acceso).
app.post('/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u: unknown) => typeof u === 'string') : [];
  if (redirectUris.length === 0) {
    return c.json({ error: 'invalid_client_metadata', error_description: 'falta redirect_uris' }, 400);
  }
  const clientId = randomToken(16);
  await kv.set(['oauth_clients', clientId], { redirect_uris: redirectUris, client_name: body.client_name ?? null });
  return c.json({
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
});

function renderAuthorizeForm(hidden: Record<string, string>, error: string | null): string {
  const hiddenInputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('\n');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Segundo cerebro — autorizar</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:28px;width:320px}
h1{font-size:16px;margin:0 0 6px}
p{color:#8a8f99;font-size:13px;margin:0 0 18px}
input[type=password]{width:100%;background:#0a0c10;border:1px solid #2a2f3a;color:#e6e8eb;padding:8px;border-radius:6px;font-size:14px;box-sizing:border-box}
button{margin-top:14px;width:100%;background:#6ea8fe;color:#0f1115;border:none;padding:9px;border-radius:6px;font-weight:600;cursor:pointer}
.err{color:#e05561;font-size:12px;margin-top:8px}
</style></head><body>
<form method="post">
  <h1>Autorizar acceso al segundo cerebro</h1>
  <p>Un cliente MCP esta pidiendo acceso. Ingresa tu clave de acceso para autorizarlo.</p>
  ${hiddenInputs}
  <input type="password" name="access_key" placeholder="Clave de acceso" autofocus required>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <button type="submit">Autorizar</button>
</form></body></html>`;
}

app.get('/authorize', async (c) => {
  const q = c.req.query();
  if (q.response_type !== 'code' || !q.client_id || !q.redirect_uri || !q.code_challenge) {
    return c.text('Solicitud de autorizacion invalida (faltan parametros).', 400);
  }
  if (q.code_challenge_method && q.code_challenge_method !== 'S256') {
    return c.text('Solo se soporta code_challenge_method=S256.', 400);
  }
  const clientRecord = await kv.get(['oauth_clients', q.client_id]);
  const registeredUris = (clientRecord.value as { redirect_uris?: string[] } | null)?.redirect_uris;
  if (registeredUris && !registeredUris.includes(q.redirect_uri)) {
    return c.text('redirect_uri no coincide con el registrado para este client_id.', 400);
  }
  const hidden = {
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    code_challenge: q.code_challenge,
    code_challenge_method: q.code_challenge_method ?? 'S256',
    state: q.state ?? '',
  };
  return c.html(renderAuthorizeForm(hidden, null));
});

app.post('/authorize', async (c) => {
  const form = await c.req.parseBody();
  const hidden = {
    client_id: String(form.client_id ?? ''),
    redirect_uri: String(form.redirect_uri ?? ''),
    code_challenge: String(form.code_challenge ?? ''),
    code_challenge_method: String(form.code_challenge_method ?? 'S256'),
    state: String(form.state ?? ''),
  };
  const accessKey = String(form.access_key ?? '');
  if (accessKey !== MCP_ACCESS_KEY) {
    return c.html(renderAuthorizeForm(hidden, 'Clave incorrecta.'), 401);
  }

  const code = randomToken(24);
  await kv.set(
    ['oauth_codes', code],
    { client_id: hidden.client_id, redirect_uri: hidden.redirect_uri, code_challenge: hidden.code_challenge },
    { expireIn: AUTH_CODE_TTL_MS },
  );

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(hidden.redirect_uri);
  } catch {
    return c.text('redirect_uri invalido.', 400);
  }
  redirectUrl.searchParams.set('code', code);
  if (hidden.state) redirectUrl.searchParams.set('state', hidden.state);
  return c.redirect(redirectUrl.toString(), 302);
});

async function issueTokenPair(clientId: string) {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  await kv.set(['oauth_tokens', accessToken], { client_id: clientId }, { expireIn: ACCESS_TOKEN_TTL_MS });
  await kv.set(['oauth_refresh', refreshToken], { client_id: clientId }, { expireIn: REFRESH_TOKEN_TTL_MS });
  return { accessToken, refreshToken };
}

app.post('/token', async (c) => {
  const body = await c.req.parseBody();
  const grantType = String(body.grant_type ?? '');

  if (grantType === 'authorization_code') {
    const code = String(body.code ?? '');
    const redirectUri = String(body.redirect_uri ?? '');
    const clientId = String(body.client_id ?? '');
    const codeVerifier = String(body.code_verifier ?? '');

    const entry = await kv.get(['oauth_codes', code]);
    if (!entry.value) return c.json({ error: 'invalid_grant', error_description: 'codigo invalido o expirado' }, 400);
    const rec = entry.value as { client_id: string; redirect_uri: string; code_challenge: string };
    if (rec.client_id !== clientId || rec.redirect_uri !== redirectUri) {
      return c.json({ error: 'invalid_grant', error_description: 'client_id o redirect_uri no coinciden' }, 400);
    }
    if ((await sha256Base64Url(codeVerifier)) !== rec.code_challenge) {
      return c.json({ error: 'invalid_grant', error_description: 'code_verifier no coincide (PKCE)' }, 400);
    }
    await kv.delete(['oauth_codes', code]); // un solo uso

    const { accessToken, refreshToken } = await issueTokenPair(clientId);
    return c.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_MS / 1000, refresh_token: refreshToken });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = String(body.refresh_token ?? '');
    const entry = await kv.get(['oauth_refresh', refreshToken]);
    if (!entry.value) return c.json({ error: 'invalid_grant', error_description: 'refresh token invalido o expirado' }, 400);
    const rec = entry.value as { client_id: string };
    await kv.delete(['oauth_refresh', refreshToken]); // rota: uno nuevo por uso

    const { accessToken, refreshToken: newRefreshToken } = await issueTokenPair(rec.client_id);
    return c.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_MS / 1000, refresh_token: newRefreshToken });
  }

  return c.json({ error: 'unsupported_grant_type' }, 400);
});

function unauthorized(c: any) {
  const origin = new URL(c.req.url).origin;
  c.header('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
  return c.json({ error: 'unauthorized' }, 401);
}

app.all('/mcp', async (c) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const entry = await kv.get(['oauth_tokens', bearer]);
    if (!entry.value) return unauthorized(c);
    return await httpHandler(c.req.raw);
  }
  // Compatibilidad con el conector ya configurado (x-mcp-key / ?key=) — no se
  // retira, solo deja de ser la unica forma de conectar.
  const key = c.req.header('x-mcp-key') ?? c.req.query('key');
  if (key !== MCP_ACCESS_KEY) return unauthorized(c);
  return await httpHandler(c.req.raw);
});

Deno.serve(app.fetch);
