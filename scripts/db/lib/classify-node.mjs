// Etapa 2 (PLAN-nodos.md, 2026-08-29): desambiguación de nodos. Recibe un
// hecho nuevo y los ~5 nodos más parecidos (via nodes_similar(), búsqueda
// vectorial sobre hechos existentes agrupados por nodo — ver schema.sql), y
// decide a cuál pertenece o si es genuinamente uno nuevo. Mismo patrón y
// mismo modelo que lib/classify-duplicate.mjs (Ollama Cloud, gpt-oss:20b-cloud,
// tiering barato). Fail-closed por diseño de la Etapa 0: cualquier fallo (red,
// cuota, JSON inválido, nombre de nodo inventado que no está entre los
// candidatos) devuelve null — el llamador (remember.mjs) nunca inserta con
// nodo nulo o placeholder, bloquea y deja que un humano decida.
import { readFileSync } from 'node:fs';

const MODEL = 'gpt-oss:20b-cloud';
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

export const classifierEnabled = Boolean(env.OLLAMA_API_KEY);

function buildPrompt(newClaim, candidates) {
  const candidateList = candidates
    .map((c) => {
      const examples = c.examples.map((ex) => `      - "${ex}"`).join('\n');
      const aliasLine = c.aliases?.length ? ` — alias: ${c.aliases.join(', ')}` : '';
      return `  "${c.node_name}"${aliasLine} (similitud ${c.similarity.toFixed(2)}), ejemplos:\n${examples}`;
    })
    .join('\n');
  return `Eres un clasificador que decide a qué nodo (tema/entidad) pertenece un hecho \
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
}

/**
 * @param {string} newClaim
 * @param {{node_name: string, examples: string[], similarity: number, aliases?: string[]}[]} candidates
 * @returns {Promise<{verdict: 'existing'|'new', node: string, confidence: number, reasoning: string} | null>}
 *   null si el clasificador está deshabilitado, o si falla por cualquier motivo
 *   (red, timeout, JSON inválido, nodo "existing" que no está entre los
 *   candidatos) — el llamador debe tratar null exactamente igual que si nunca
 *   se hubiera intentado clasificar.
 */
export async function classifyNode(newClaim, candidates) {
  if (!classifierEnabled) return null;
  if (candidates.length === 0) return null; // nada que comparar: no hay decisión que tomar aquí

  let res;
  try {
    res = await fetch('https://ollama.com/api/generate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OLLAMA_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: buildPrompt(newClaim, candidates),
        format: 'json',
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(`  (clasificador de nodos Ollama Cloud no disponible: ${err.message} — cae a bloqueo manual)`);
    return null;
  }

  if (!res.ok) {
    console.error(`  (clasificador de nodos Ollama Cloud falló: ${res.status} — cae a bloqueo manual)`);
    return null;
  }

  let parsed;
  try {
    const { response } = await res.json();
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del clasificador de nodos no es JSON válido: ${err.message} — cae a bloqueo manual)`);
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
    console.error(`  (respuesta del clasificador de nodos con forma inesperada: ${JSON.stringify(parsed)} — cae a bloqueo manual)`);
    return null;
  }

  return {
    verdict: parsed.verdict,
    node,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

export const CLASSIFIER_CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
export const CLASSIFIER_MODEL = MODEL;
