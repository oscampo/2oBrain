// MCP propio (Fase 4 del plan original), alojado como Supabase Edge
// Function. Expone search/remember contra la misma base que
// scripts/db/, alcanzable por HTTPS desde cualquier cliente (Chat, Cowork,
// cualquier máquina), sin depender de Ollama ni de un proceso local que
// pueda competir consigo mismo. La lógica de embeddings/rerank/gate de
// contradicciones es la misma que scripts/db/lib/embed.mjs y remember.mjs,
// portada a Deno + supabase-js en vez de Node + pg crudo.
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SIMILARITY_THRESHOLD = 0.6;
// Bitácora de construcción del dashboard (28-ago-2026): registros meta que citan
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
  if (!res.ok) throw new Error(`Voyage embed falló: ${res.status} ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Voyage rerank falló: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  return data;
}

// Router de recuerdos (hallazgo 2026-08-31, ver PLAN-recuerdos.md): si la pregunta
// nombra literalmente un recuerdo por su nombre o alias (ej. "estado del
// proyecto COIL"), trae TODOS sus registros vigentes en vez de confiar en que
// RRF/rerank adivinen la relación: no la adivinan cuando ningún registro
// individual repite el nombre del proyecto/recuerdo, solo habla de su
// contenido. Mismo criterio y misma función SQL (memory_match_records) que
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
function resolveLiveMemory(name: string, byName: Map<string, { name: string; merged_into: string | null }>): string | null {
  let current = name;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) return null; // ciclo: no debería pasar
    seen.add(current);
    const n = byName.get(current);
    if (!n) return null;
    if (!n.merged_into) return n.name;
    current = n.merged_into;
  }
}

// Tiering del gate de contradicciones (ver registro #149/#152 en segundo-cerebro):
// primera pasada barata vía Ollama Cloud antes de bloquear. Portado desde
// scripts/db/lib/classify-duplicate.mjs: misma lógica, mismo modelo, mismo
// umbral. Nunca trata un error de red o una respuesta inválida como
// "distinct": fallar hacia el lado seguro es bloquear, no insertar.
async function classifyDuplicate(
  newClaim: string,
  candidates: { id: number; claim: string; similarity: number }[],
): Promise<{ verdict: 'distinct' | 'supersedes'; supersedesIds: number[]; confidence: number; reasoning: string } | null> {
  if (!OLLAMA_API_KEY) return null;

  const candidateList = candidates
    .map((c) => `  #${c.id} (similitud ${c.similarity.toFixed(2)}): "${c.claim}"`)
    .join('\n');
  const prompt = `Eres un clasificador que decide si un registro nuevo, comparado con registros ya \
registrados y parecidos por embedding, es genuinamente distinto o si reemplaza \
(supersede) a alguno de ellos por describir el mismo estado de cosas actualizado.

registro nuevo: "${newClaim}"

registros vigentes parecidos:
${candidateList}

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"verdict": "distinct" | "supersedes", "supersedes_ids": [ids numéricos de los registros que reemplaza, vacío si verdict es "distinct"], "confidence": número entre 0 y 1, "reasoning": "una oración breve en español"}

"supersedes" solo si el registro nuevo describe el mismo asunto en un estado más \
reciente o corrige al anterior. "distinct" si es temáticamente parecido pero es \
información genuinamente distinta (otro aspecto, otro momento no contradictorio, \
otro sujeto). Si no estás seguro, baja la confidence en vez de adivinar.`;

  let res: Response;
  try {
    res = await fetch('https://ollama.com/api/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OLLAMA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: CLASSIFIER_MODEL, prompt, format: 'json', stream: false }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null; // red caída o timeout: cae a bloqueo manual
  }

  if (!res.ok) return null;

  let parsed: any;
  try {
    const { response } = await res.json();
    // format:"json" fuerza JSON válido en `response`, pero el modelo a veces
    // igual lo envuelve en fences de markdown (```json ... ```).
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch {
    return null; // respuesta no es JSON válido: cae a bloqueo manual
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
    return null; // forma inesperada: cae a bloqueo manual
  }

  return {
    verdict: parsed.verdict,
    supersedesIds,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

// Etapa 2 (PLAN-recuerdos.md, 2026-08-29): desambiguación de recuerdos. Mismo patrón
// que classifyDuplicate: Ollama Cloud, gpt-oss:20b-cloud, fail-closed en
// cualquier fallo (red, cuota, JSON inválido, recuerdo "existing" inventado que
// no está entre los candidatos). Ver scripts/db/lib/classify-memory.mjs para
// el diseño completo; esta es la misma lógica portada a Deno.
const NODE_CLASSIFIER_MODEL = 'gpt-oss:20b-cloud';
const NODE_CLASSIFIER_CONFIDENCE_THRESHOLD = 0.85;

async function classifyNode(
  newClaim: string,
  candidates: { memory_name: string; examples: string[]; similarity: number; aliases?: string[] }[],
): Promise<{ verdict: 'existing' | 'new'; node: string; confidence: number; reasoning: string } | null> {
  if (!OLLAMA_API_KEY) return null;
  if (candidates.length === 0) return null;

  const candidateList = candidates
    .map((c) => {
      const aliasLine = c.aliases?.length ? `, alias: ${c.aliases.join(', ')}` : '';
      return `  "${c.memory_name}"${aliasLine} (similitud ${c.similarity.toFixed(2)}), ejemplos:\n${c.examples.map((ex) => `      - "${ex}"`).join('\n')}`;
    })
    .join('\n');
  const prompt = `Eres un clasificador que decide a qué recuerdo (tema/entidad) pertenece un registro \
nuevo dentro de un segundo cerebro personal. Cada recuerdo agrupa registros sobre el mismo \
asunto (un proyecto, una persona, un curso, una colaboración). Te doy los recuerdos \
existentes más parecidos por embedding, cada uno con sus registros más cercanos como \
ejemplo y, si los tiene, sus alias (otros nombres con los que se lo menciona).

registro nuevo: "${newClaim}"

recuerdos existentes parecidos:
${candidateList}

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"verdict": "existing" | "new", "node": "nombre exacto de uno de los recuerdos de arriba si verdict es existing, o un nombre propuesto en kebab-case si verdict es new", "confidence": número entre 0 y 1, "reasoning": "una oración breve en español"}

"existing" solo si el registro nuevo es genuinamente sobre el mismo asunto que ese recuerdo \
(mismo proyecto/persona/curso/colaboración, no solo un tema parecido en abstracto, \
ej. dos cursos distintos que comparten infraestructura de GitHub NO son el mismo recuerdo). \
"new" si ningún recuerdo de la lista es realmente el mismo asunto. \
PRIORIDAD: si el registro nuevo menciona literalmente (aunque sea parcialmente, ignorando \
mayúsculas/tildes) el nombre o un alias de alguno de los recuerdos, esa coincidencia léxica \
pesa más que el parecido temático de los ejemplos, el nombre explícito es una señal \
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

  const validNodeNames = new Set(candidates.map((c) => c.memory_name));
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
    'Busca registros vigentes en el segundo cerebro por una pregunta en lenguaje natural. Devuelve los registros más relevantes, con su fuente.',
  inputSchema: z.object({ query: z.string().describe('La pregunta o tema a buscar') }),
  handler: async ({ query }: { query: string }) => {
    const queryEmbedding = await embed(query, 'query');
    const queryNorm = normalizeText(query);

    const { data: allNodes } = await supabase.from('memories').select('name, aliases, merged_into');
    const byName = new Map<string, any>((allNodes ?? []).map((n: any) => [n.name, n]));
    const matchedLiveNodes = new Set<string>();
    for (const n of allNodes ?? []) {
      if (!nodeIsMatched(n, queryNorm)) continue;
      const live = resolveLiveMemory(n.name, byName);
      if (live && live !== DASHBOARD_LOG_NODE) matchedLiveNodes.add(live);
    }

    const [{ data: factCandidates }, { data: nodeMatchRows }] = await Promise.all([
      supabase.rpc('records_search', { query_embedding: queryEmbedding, query_text: query, match_count: 10, exclude_memory: DASHBOARD_LOG_NODE }),
      matchedLiveNodes.size > 0
        ? supabase.rpc('memory_match_records', { node_names: [...matchedLiveNodes], match_count: MAX_NODE_MATCH_FACTS })
        : Promise.resolve({ data: [] as any[] }),
    ]);

    async function rerankTop(candidates: any[], toDoc: (c: any) => string, topN: number) {
      if (!candidates || candidates.length === 0) return [];
      const ranked = await rerank(query, candidates.map(toDoc));
      return ranked.slice(0, topN).map((r) => ({ ...candidates[r.index], score: r.relevance_score }));
    }

    // Incluye el/los recuerdo(s) en el texto que ve el reranker: sin esto, un
    // registro cuyo contenido nunca menciona el nombre del proyecto/recuerdo queda
    // mal puntuado frente a una pregunta que sí lo nombra (mismo hallazgo
    // 2026-08-31 que motivó el router de arriba).
    const rerankedFacts = await rerankTop(factCandidates ?? [], (f) => (f.memories ? `[${f.memories}] ${f.claim}` : f.claim), 5);

    const nodeMatchFacts = nodeMatchRows ?? [];
    const nodeMatchTotal = nodeMatchFacts.length > 0 ? Number(nodeMatchFacts[0].total_count) : 0;
    const nodeMatchTruncated = nodeMatchTotal > nodeMatchFacts.length;
    const nodeMatchIds = new Set(nodeMatchFacts.map((f: any) => f.id));
    // Los registros del router de recuerdos van primero (garantizados completos
    // para el/los recuerdo(s) nombrados), seguidos de los de la búsqueda
    // híbrida general que no se repitan.
    const records = [
      ...nodeMatchFacts.map((f: any) => ({ ...f, score: null as number | null })),
      ...rerankedFacts.filter((f: any) => !nodeMatchIds.has(f.id)),
    ];

    let text = '--- registros vigentes ---\n';
    if (matchedLiveNodes.size > 0) {
      const suffix = nodeMatchTruncated
        ? ` (mostrando ${MAX_NODE_MATCH_FACTS} de ${nodeMatchTotal}, pide "estado del recuerdo X" para el resto)`
        : '';
      text += `(recuerdo(s) detectado(s) en la pregunta: ${[...matchedLiveNodes].join(', ')}${suffix})\n`;
    }

    if (records.length === 0) text += 'Sin resultados.\n';
    else
      for (const f of records) {
        const scoreLabel = f.score == null ? '[recuerdo]' : `[${f.score.toFixed(4)}]`;
        text += `\n${scoreLabel} #${f.id} [${f.date}] ${f.claim}\n  fuente: ${f.source} · tipo: ${f.kind}${f.memories ? ` · recuerdos: ${f.memories}` : ''}\n`;
      }

    return { content: [{ type: 'text', text }] };
  },
});

mcp.tool('remember', {
  description:
    'Registra un registro atómico con fecha y fuente obligatorias en el segundo cerebro. Antes de insertar, busca registros vigentes parecidos por embedding; si encuentra candidatos, se niega a insertar salvo que se pase supersedes o distinct explícito. El recuerdo (o recuerdos) debe existir de antemano en la tabla memories salvo que se pase createNode.',
  inputSchema: z.object({
    claim: z.string().describe('Texto claro y autocontenido del registro'),
    date: z.string().describe('Fecha YYYY-MM-DD, nunca inferida de texto libre'),
    source: z.string().describe('De dónde salió el registro'),
    kind: z.enum(['fact', 'event', 'preference', 'commitment']).default('fact'),
    node: z.union([z.string(), z.array(z.string())]).optional().describe('recuerdo(s) existente(s) a los que se liga el registro (string separado por comas, o array)'),
    createNode: z.boolean().optional().describe('Crea el/los recuerdo(s) si no existen todavía, en vez de fallar'),
    supersedes: z.array(z.number()).optional().describe('IDs de registros vigentes que este reemplaza'),
    distinct: z.boolean().optional().describe('Confirma que es distinto pese al parecido con candidatos'),
    confirmDate: z.boolean().optional().describe('Obligatorio si date no es la fecha real de hoy (America/Bogota) -- confirma que un registro con fecha distinta es intencional (histórico, backfill), no un error de no verificar la fecha antes de llamar'),
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
        content: [{ type: 'text', text: `Fecha inválida: "${args.date}". Debe ser YYYY-MM-DD, no se infiere.` }],
        isError: true,
      };
    }

    // Mismo criterio que remember.mjs/remember-batch.mjs (2026-09-03, registros
    // #528/#530): bloquea por defecto si date no es hoy, salvo confirmDate
    // explícito: evita el error real que motivó esto (registro #525, grabado
    // con fecha vieja por no verificar antes de llamar).
    const todayBogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    if (args.date !== todayBogota && !args.confirmDate) {
      return {
        content: [{
          type: 'text',
          text: `date ${args.date} es distinto de hoy (${todayBogota} en America/Bogota). Si es un registro histórico o backfill intencional, pasa confirmDate: true. Si fue sin querer, corrige date y vuelve a intentar.`,
        }],
        isError: true,
      };
    }

    const embedding = await embed(args.claim, 'document');

    const { data: candidates } = await supabase.rpc('records_similar', {
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
        autoResolved = null; // confianza insuficiente o clasificador no disponible: no se usa
      }
    }

    if (similar.length > 0 && supersedesIds.length === 0 && !distinct) {
      let text = `Hay ${similar.length} registro(s) vivo(s) parecido(s), resuélvelo antes de insertar:\n`;
      for (const c of similar) {
        text += `\n#${c.id} [${c.date}] (similitud ${c.similarity.toFixed(2)}) ${c.claim}\n  fuente: ${c.source}${c.memories ? ` · recuerdos: ${c.memories}` : ''}\n`;
      }
      text +=
        '\nSi este registro reemplaza a alguno, vuelve a llamar con supersedes: [ids]. Si es genuinamente distinto, llama con distinct: true.';
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

    // Etapa 2 (PLAN-recuerdos.md, 2026-08-29): desambiguación automática. Corre
    // SIEMPRE, incluso con node explícito (Etapa 0), pero solo bloquea
    // cuando node no vino: con node explícito es solo un aviso en el texto
    // de respuesta, nunca sobreescribe la elección del llamador.
    const { data: nodeCandidateRows } = await supabase.rpc('memories_similar', {
      query_embedding: embedding,
      match_count: 5,
    });
    const nodeCandidates = (nodeCandidateRows ?? []).map((r: any) => ({
      memory_name: r.memory_name,
      examples: r.examples,
      similarity: r.similarity,
      aliases: r.aliases,
    }));
    const nodeVerdict = nodeCandidates.length > 0 ? await classifyNode(args.claim, nodeCandidates) : null;

    let requestedNodes = args.memory == null ? [] : Array.isArray(args.memory) ? args.memory : args.memory.split(',').map((s) => s.trim()).filter(Boolean);
    let nodeAdvisory = '';

    if (requestedNodes.length === 0) {
      if (!nodeVerdict || nodeVerdict.confidence < NODE_CLASSIFIER_CONFIDENCE_THRESHOLD) {
        let text = 'No se pasó node y la desambiguación automática no alcanzó confianza suficiente.\n';
        if (nodeCandidates.length > 0) {
          text += '\nrecuerdos existentes más parecidos:\n';
          for (const c of nodeCandidates) {
            text += `  "${c.memory_name}" (similitud ${c.similarity.toFixed(2)}):\n${c.examples.map((ex: string) => `      - ${ex}`).join('\n')}\n`;
          }
        } else {
          text += '\n(no hay registros con embedding en ningún recuerdo todavía para comparar)\n';
        }
        text += '\nPasa node (nombre existente), o node + createNode: true si es genuinamente uno nuevo.';
        return { content: [{ type: 'text', text }], isError: true };
      }
      if (nodeVerdict.verdict === 'new') {
        return {
          content: [{
            type: 'text',
            text: `El clasificador (${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}) propone un recuerdo NUEVO: "${nodeVerdict.node}" (${nodeVerdict.reasoning})\nSi es correcto, vuelve a llamar con node: "${nodeVerdict.node}", createNode: true.`,
          }],
          isError: true,
        };
      }
      requestedNodes = [nodeVerdict.node];
      nodeAdvisory = `(recuerdo auto-resuelto por ${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}: ${nodeVerdict.reasoning})`;
    } else if (
      nodeVerdict &&
      nodeVerdict.confidence >= NODE_CLASSIFIER_CONFIDENCE_THRESHOLD &&
      (nodeVerdict.verdict === 'new' || !requestedNodes.includes(nodeVerdict.node))
    ) {
      nodeAdvisory =
        `(aviso: la desambiguación (confianza ${nodeVerdict.confidence.toFixed(2)}) sugiere ` +
        `${nodeVerdict.verdict === 'new' ? `un recuerdo nuevo distinto: "${nodeVerdict.node}"` : `el recuerdo existente "${nodeVerdict.node}"`}` +
        ` en vez de ${requestedNodes.map((n) => `"${n}"`).join(', ')}, se respeta tu elección explícita.)`;
    }

    // Resuelve node: cada nombre debe existir en `memories` (fail-closed contra
    // typos que crearían un recuerdo fantasma), salvo createNode explícito. Si un
    // recuerdo fue fusionado a otro (merged_into), sigue la cadena al vigente,
    // mismo criterio que remember.mjs/remember-batch.mjs.
    const resolvedNodes: string[] = [];
    for (const name of requestedNodes) {
      let current = name;
      const seen = new Set<string>();
      let row: { name: string; merged_into: string | null } | null = null;
      while (true) {
        if (seen.has(current)) {
          return { content: [{ type: 'text', text: `Ciclo de merged_into detectado en recuerdos empezando por "${name}".` }], isError: true };
        }
        seen.add(current);
        const { data: found } = await supabase.from('memories').select('name, merged_into').eq('name', current).maybeSingle();
        if (!found) { row = null; break; }
        row = found;
        if (!row.merged_into) break;
        current = row.merged_into;
      }
      if (row) {
        resolvedNodes.push(row.name);
      } else if (args.createNode) {
        await supabase.from('memories').upsert({ name }, { onConflict: 'name', ignoreDuplicates: true });
        resolvedNodes.push(name);
      } else {
        return {
          content: [{ type: 'text', text: `recuerdo "${name}" no existe en la tabla memories. Pasa createNode: true si es genuinamente uno nuevo.` }],
          isError: true,
        };
      }
    }

    const { data: inserted, error } = await supabase
      .from('records')
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
        .from('record_memories')
        .upsert(resolvedNodes.map((memory_name) => ({ record_id: inserted.id, memory_name })), { onConflict: 'record_id,memory_name', ignoreDuplicates: true });
    }

    if (supersedesIds.length > 0) {
      await supabase
        .from('records')
        .update({ valid_until: new Date().toISOString(), superseded_by: inserted.id })
        .in('id', supersedesIds);
    }

    let text = `Registrado #${inserted.id}: [${inserted.date}] ${inserted.claim}`;
    if (resolvedNodes.length > 0) text += `\nrecuerdo(s): ${resolvedNodes.join(', ')}`;
    if (nodeAdvisory) text += `\n${nodeAdvisory}`;
    if (supersedesIds.length > 0) text += `\nReemplazó a #${supersedesIds.join(', #')}.`;
    else if (similar.length > 0 && distinct) text += `\nConfirmado como distinto pese al parecido.`;

    return { content: [{ type: 'text', text }] };
  },
});

const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

const app = new Hono();
const mcpApp = new Hono();

// CORS (2026-09-01, handoff de la sesión de obsidian-neural-composer): ver
// justificación completa en deno-deploy/mcp-server/main.ts: un cliente MCP
// en contexto navegador (Electron/Obsidian Desktop, o web) dispara preflight
// OPTIONS por el Content-Type: application/json del POST; sin responderlo
// con Access-Control-*, el navegador aborta la petición (net::ERR_FAILED)
// antes de que llegue a este código. origin: '*' es seguro porque la
// autenticación es por header/query param (x-mcp-key), no por cookies.
mcpApp.use(
  '/mcp',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'x-mcp-key'],
  }),
);

mcpApp.get('/', (c) =>
  c.json({ message: 'MCP del segundo cerebro', endpoints: { mcp: '/mcp', health: '/health' } }),
);

mcpApp.get('/health', (c) => c.json({ ok: true }));

mcpApp.all('/mcp', async (c) => {
  // Autenticación propia, no la de Supabase (verify_jwt=false en el deploy).
  // Header para clientes que lo soportan (Code, curl); query param como
  // alternativa porque el diálogo de "conector personalizado" de Claude.ai
  // solo pide una URL, sin campo de header custom (confirmado en vivo,
  // 2026-08-22), la key embebida en la URL es lo único que ese formulario
  // puede transportar sin implementar un flujo OAuth completo.
  const key = c.req.header('x-mcp-key') ?? c.req.query('key');
  if (key !== MCP_ACCESS_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return await httpHandler(c.req.raw);
});

app.route('/mcp-server', mcpApp);

Deno.serve(app.fetch);
