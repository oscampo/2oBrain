// Tiering de la Etapa 4 (ver hecho #149): primera pasada barata sobre el
// gate de contradicciones de remember.mjs, vía Ollama Cloud (free tier,
// gpt-oss:20b-cloud = nivel 1, el más barato). Objetivo puntual: que Claude
// no tenga que releer el texto completo de los candidatos parecidos en el
// caso común de alta confianza (causa de costo documentada en el hecho
// #148). No reemplaza la garantía de la Etapa 4 ("ninguna contradicción
// coexiste sin que alguien la haya visto"): por debajo del umbral de
// confianza, o si Ollama Cloud falla por cualquier motivo, cae al
// comportamiento de bloqueo manual de siempre. Nunca trata un error de red
// o una respuesta inválida como "distinct": fallar hacia el lado seguro es
// bloquear, no insertar.
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
    .map((c) => `  #${c.id} (similitud ${c.similarity.toFixed(2)}): "${c.claim}"`)
    .join('\n');
  return `Eres un clasificador que decide si un hecho nuevo, comparado con hechos ya \
registrados y parecidos por embedding, es genuinamente distinto o si reemplaza \
(supersede) a alguno de ellos por describir el mismo estado de cosas actualizado.

Hecho nuevo: "${newClaim}"

Hechos vigentes parecidos:
${candidateList}

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"verdict": "distinct" | "supersedes", "supersedes_ids": [ids numéricos de los hechos que reemplaza, vacío si verdict es "distinct"], "confidence": número entre 0 y 1, "reasoning": "una oración breve en español"}

"supersedes" solo si el hecho nuevo describe el mismo asunto en un estado más \
reciente o corrige al anterior. "distinct" si es temáticamente parecido pero es \
información genuinamente distinta (otro aspecto, otro momento no contradictorio, \
otro sujeto). Si no estás seguro, baja la confidence en vez de adivinar.`;
}

/**
 * @param {string} newClaim
 * @param {{id: number, claim: string, similarity: number}[]} candidates
 * @returns {Promise<{verdict: 'distinct'|'supersedes', supersedesIds: number[], confidence: number, reasoning: string} | null>}
 *   null si el clasificador está deshabilitado, o si falla por cualquier motivo
 *   (red, timeout, JSON inválido, ids inventados), el llamador debe tratar
 *   null exactamente igual que si nunca se hubiera intentado clasificar.
 */
export async function classifyDuplicate(newClaim, candidates) {
  if (!classifierEnabled) return null;

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
    console.error(`  (clasificador Ollama Cloud no disponible: ${err.message}, cae a bloqueo manual)`);
    return null;
  }

  if (!res.ok) {
    console.error(`  (clasificador Ollama Cloud falló: ${res.status}, cae a bloqueo manual)`);
    return null;
  }

  let parsed;
  try {
    const { response } = await res.json();
    // format:"json" fuerza JSON válido en el campo response, pero el modelo a
    // veces igual lo envuelve en fences de markdown (```json ... ```).
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del clasificador no es JSON válido: ${err.message}, cae a bloqueo manual)`);
    return null;
  }

  // pg devuelve columnas bigint (facts.id) como string, no number: hay que
  // normalizar antes de comparar contra los ids numéricos que devuelve el JSON.
  const validIds = new Set(candidates.map((c) => Number(c.id)));
  const supersedesIds = Array.isArray(parsed.supersedes_ids)
    ? parsed.supersedes_ids.map(Number).filter((id) => validIds.has(id))
    : [];
  const confidence = Number(parsed.confidence);

  if (
    (parsed.verdict !== 'distinct' && parsed.verdict !== 'supersedes') ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    (parsed.verdict === 'supersedes' && supersedesIds.length === 0)
  ) {
    console.error(`  (respuesta del clasificador con forma inesperada: ${JSON.stringify(parsed)}, cae a bloqueo manual)`);
    return null;
  }

  return {
    verdict: parsed.verdict,
    supersedesIds,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

export const CLASSIFIER_CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
export const CLASSIFIER_MODEL = MODEL;
