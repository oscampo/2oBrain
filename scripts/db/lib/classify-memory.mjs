// Etapa 2 (PLAN-recuerdos.md, 2026-08-29): desambiguación de recuerdos. Recibe un
// registro nuevo y los ~5 recuerdos más parecidos (via memories_similar(), búsqueda
// vectorial sobre registros existentes agrupados por recuerdo: ver schema.sql), y
// decide a cuál pertenece o si es genuinamente uno nuevo. Mismo patrón y
// mismo modelo que lib/classify-duplicate.mjs (Ollama Cloud, gpt-oss:20b-cloud,
// tiering barato). Fail-closed por diseño de la Etapa 0: cualquier fallo (red,
// cuota, JSON inválido, nombre de recuerdo inventado que no está entre los
// candidatos) devuelve null: el llamador (remember.mjs) nunca inserta con
// recuerdo nulo o placeholder, bloquea y deja que un humano decida.
import { readFileSync } from 'node:fs';
import { getTaskProviderModel } from './task-models.mjs';
import { callOpenRouter, OPENROUTER_ENABLED } from './openrouter.mjs';

const { provider: PROVIDER, model: MODEL } = getTaskProviderModel('classifiers');
const CONFIDENCE_THRESHOLD = 0.85;

function loadEnv() {
  const envPath = new URL('../../../.env', import.meta.url);
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

const env = loadEnv();

export const classifierEnabled = PROVIDER === 'openrouter' ? OPENROUTER_ENABLED : Boolean(env.OLLAMA_API_KEY);

function buildPrompt(newClaim, candidates) {
  const candidateList = candidates
    .map((c) => {
      const examples = c.examples.map((ex) => `      - "${ex}"`).join('\n');
      const aliasLine = c.aliases?.length ? `, alias: ${c.aliases.join(', ')}` : '';
      return `  "${c.memory_name}"${aliasLine} (similitud ${c.similarity.toFixed(2)}), ejemplos:\n${examples}`;
    })
    .join('\n');
  return `Eres un clasificador que decide a qué recuerdo (tema/entidad) pertenece un registro \
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
}

/**
 * @param {string} newClaim
 * @param {{memory_name: string, examples: string[], similarity: number, aliases?: string[]}[]} candidates
 * @returns {Promise<{verdict: 'existing'|'new', node: string, confidence: number, reasoning: string} | null>}
 *   null si el clasificador está deshabilitado, o si falla por cualquier motivo
 *   (red, timeout, JSON inválido, recuerdo "existing" que no está entre los
 *   candidatos), el llamador debe tratar null exactamente igual que si nunca
 *   se hubiera intentado clasificar.
 */
export async function classifyNode(newClaim, candidates) {
  if (!classifierEnabled) return null;
  if (candidates.length === 0) return null; // nada que comparar: no hay decisión que tomar aquí

  const prompt = buildPrompt(newClaim, candidates);
  let responseText;
  try {
    if (PROVIDER === 'openrouter') {
      responseText = await callOpenRouter(prompt, MODEL, { timeoutMs: 20_000 });
    } else {
      const res = await fetch('https://ollama.com/api/generate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OLLAMA_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, prompt, format: 'json', stream: false }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Ollama Cloud falló: ${res.status}`);
      responseText = (await res.json()).response;
    }
  } catch (err) {
    console.error(`  (clasificador de recuerdos ${PROVIDER} no disponible: ${err.message}, cae a bloqueo manual)`);
    return null;
  }

  let parsed;
  try {
    const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del clasificador de recuerdos no es JSON válido: ${err.message}, cae a bloqueo manual)`);
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
    console.error(`  (respuesta del clasificador de recuerdos con forma inesperada: ${JSON.stringify(parsed)}, cae a bloqueo manual)`);
    return null;
  }

  return {
    verdict: parsed.verdict,
    node,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

function buildAdditionalPrompt(newClaim, primaryNodes, candidates) {
  const candidateList = candidates
    .map((c) => {
      const examples = c.examples.map((ex) => `      - "${ex}"`).join('\n');
      const aliasLine = c.aliases?.length ? `, alias: ${c.aliases.join(', ')}` : '';
      // Dos vías de candidato (portado desde D:\MyBrain, cierre de #1056/#872):
      // por similitud de embedding (memories_similar) o por mención LITERAL del
      // nombre/alias en el texto (memories_similar puede no traerlo si su
      // contenido existente es temáticamente lejano, aunque el texto SÍ lo
      // nombre explícito) -- se le dice honestamente al clasificador cuál de
      // las dos señales trajo a cada candidato, es información real, no
      // ruido a ocultar.
      const signal = c.matchedOn
        ? `mencionado literalmente en el texto como "${c.matchedOn}"`
        : `similitud ${c.similarity.toFixed(2)}`;
      return `  "${c.memory_name}"${aliasLine} (${signal}), ejemplos:\n${examples}`;
    })
    .join('\n');
  return `Eres un clasificador que decide si un registro nuevo, dentro de un segundo cerebro \
personal, pertenece TAMBIÉN a recuerdos (tema/entidad) además del/de los que ya se le \
asignaron. Un registro puede ser genuinamente sobre más de un asunto a la vez (ej. un hecho \
que describe tanto a una persona como a la institución/lugar del que participa) -- eso NO es \
lo mismo que un tema vagamente relacionado o solo mencionado de pasada. Un candidato \
"mencionado literalmente" es una señal fuerte a favor (el texto lo nombra por su propio \
nombre o alias), pero igual debe cumplir el mismo criterio real de pertenencia -- nombrar a \
alguien de pasada no basta si el registro no es genuinamente también sobre esa persona/entidad.

registro nuevo: "${newClaim}"
recuerdo(s) ya asignado(s): ${primaryNodes}

Otros recuerdos existentes parecidos (candidatos a recuerdo ADICIONAL):
${candidateList}

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"additional": [{"node": "nombre exacto del candidato", "belongs": true o false, "confidence": número entre 0 y 1, "reasoning": "una oración breve"}, ...]}

Incluye una entrada por cada candidato de la lista de arriba, en el mismo orden. "belongs": \
true SOLO si el registro es genuina y directamente sobre ese segundo asunto/entidad también \
(no basta con que lo mencione de pasada, ni con que el tema esté relacionado en abstracto). \
RECHAZA explícitamente (belongs: false) cualquier candidato que sea un recuerdo "paraguas" \
amplio sobre la vida o identidad general de la persona (ej. "usuario", "vida-personal", o \
equivalente) -- casi cualquier hecho personal encaja ahí en abstracto, así que etiquetarlo \
como adicional cada vez lo diluiría hasta volverlo inútil; ese tipo de recuerdo paraguas solo \
debería ganar como recuerdo PRIMARIO, nunca como adicional. Reserva "belongs: true" para \
entidades específicas y acotadas (una persona, un lugar, una institución, un proyecto) que el \
registro trata de forma directa. Si no estás seguro, baja la confidence en vez de forzar true.`;
}

/**
 * Etapa de recuerdos adicionales (portado desde D:\MyBrain, pedido original de
 * Oscar): además del recuerdo primario que ya decidió classifyNode, un registro
 * puede pertenecer genuinamente a otro(s) de los MISMOS candidatos que
 * memories_similar() ya trajo (sin ninguna búsqueda nueva) -- caso real que lo
 * motivó: un registro sobre una persona mencionaba también una institución/lugar,
 * que ya rankeaba entre los candidatos por embedding, pero el pick de un solo
 * elemento nunca lo consideraba. Mismo patrón fail-open que el resto del
 * pipeline: cualquier fallo devuelve [], el llamador sigue con lo que ya tenía,
 * nunca bloquea el registro completo por esto.
 *
 * @param {string} newClaim
 * @param {string} primaryNodes - recuerdo(s) ya asignados, solo para darle contexto al prompt
 * @param {{memory_name: string, examples: string[], similarity: number, aliases?: string[]}[]} candidates
 *   candidatos restantes de memories_similar(), SIN los ya asignados como primaryNodes
 * @returns {Promise<{node: string, confidence: number, reasoning: string}[]>}
 *   solo los candidatos que el clasificador marcó belongs=true, el llamador
 *   sigue aplicando su propio umbral de confianza antes de usarlos
 */
export async function classifyAdditionalMemories(newClaim, primaryNodes, candidates) {
  if (!classifierEnabled) return [];
  if (candidates.length === 0) return [];

  const prompt = buildAdditionalPrompt(newClaim, primaryNodes, candidates);
  let responseText;
  try {
    if (PROVIDER === 'openrouter') {
      responseText = await callOpenRouter(prompt, MODEL, { timeoutMs: 20_000 });
    } else {
      const res = await fetch('https://ollama.com/api/generate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OLLAMA_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, prompt, format: 'json', stream: false }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Ollama Cloud falló: ${res.status}`);
      responseText = (await res.json()).response;
    }
  } catch (err) {
    console.error(`  (clasificador de recuerdos adicionales ${PROVIDER} no disponible: ${err.message}, se omite)`);
    return [];
  }

  let parsed;
  try {
    const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del clasificador de recuerdos adicionales no es JSON válido: ${err.message}, se omite)`);
    return [];
  }

  if (!Array.isArray(parsed.additional)) {
    console.error(`  (respuesta del clasificador de recuerdos adicionales con forma inesperada: ${JSON.stringify(parsed)}, se omite)`);
    return [];
  }

  const validNames = new Set(candidates.map((c) => c.memory_name));
  const result = [];
  for (const item of parsed.additional) {
    const node = typeof item?.node === 'string' ? item.node.trim() : '';
    const confidence = Number(item?.confidence);
    if (!validNames.has(node) || item?.belongs !== true || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    result.push({ node, confidence, reasoning: typeof item.reasoning === 'string' ? item.reasoning : '' });
  }
  return result;
}

export const CLASSIFIER_CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
export const CLASSIFIER_MODEL = MODEL;
export const CLASSIFIER_PROVIDER = PROVIDER;
