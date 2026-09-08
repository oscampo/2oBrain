// Decide si un registro nuevo resuelve, total o parcialmente, un compromiso
// abierto (kind='commitment') del mismo recuerdo -- mismo patrón de tiering
// que classify-duplicate.mjs (Ollama Cloud, gpt-oss:20b-cloud, fail-closed en
// cualquier fallo), pero NO usa el umbral de similitud de embedding como
// filtro previo: nace de un caso real donde la confirmación de que un
// trámite ya quedó radicado no es textualmente parecida al compromiso
// original ("tengo pendiente gestionar el trámite") pese a resolver
// exactamente eso, así que cualquier compromiso abierto del recuerdo se
// manda a juicio del clasificador sin filtrar antes por similitud (rara vez
// hay más de 1-2 compromisos abiertos por recuerdo, es barato).
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

function buildPrompt(newClaim, commitmentClaim) {
  return `Eres un clasificador que decide si un registro nuevo resuelve un \
compromiso pendiente ya registrado, en un segundo cerebro personal.

compromiso pendiente: "${commitmentClaim}"

registro nuevo: "${newClaim}"

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"verdict": "full" | "partial" | "none", "confidence": número entre 0 y 1, "reasoning": "una oración breve en español"}

"full": el registro nuevo deja claro que TODO lo que describía el compromiso \
ya se cumplió o dejó de estar pendiente. "partial": el compromiso describe \
más de una cosa pendiente (ej. "hacer X y presentar Y") y el registro nuevo \
solo resuelve una parte, el resto sigue pendiente. "none": el registro nuevo \
no aporta evidencia de que el compromiso se haya resuelto, así sean del mismo \
tema. Una mención de pasada no basta para "full" ni "partial", tiene que \
describir la acción o su resultado real. Si no estás seguro, baja la \
confidence en vez de adivinar.`;
}

/**
 * @param {string} newClaim
 * @param {string} commitmentClaim
 * @returns {Promise<{verdict: 'full'|'partial'|'none', confidence: number, reasoning: string} | null>}
 *   null si el clasificador está deshabilitado, o si falla por cualquier
 *   motivo (red, timeout, JSON inválido), el llamador debe tratar null
 *   exactamente igual que si nunca se hubiera intentado clasificar (no
 *   actuar, seguir en silencio).
 */
export async function classifyCommitmentResolution(newClaim, commitmentClaim) {
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
        prompt: buildPrompt(newClaim, commitmentClaim),
        format: 'json',
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(`  (clasificador de compromisos no disponible: ${err.message}, se ignora)`);
    return null;
  }

  if (!res.ok) {
    console.error(`  (clasificador de compromisos falló: ${res.status}, se ignora)`);
    return null;
  }

  let parsed;
  try {
    const { response } = await res.json();
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del clasificador de compromisos no es JSON válido: ${err.message}, se ignora)`);
    return null;
  }

  const confidence = Number(parsed.confidence);
  if (
    !['full', 'partial', 'none'].includes(parsed.verdict) ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    console.error(`  (respuesta del clasificador de compromisos con forma inesperada: ${JSON.stringify(parsed)}, se ignora)`);
    return null;
  }

  return {
    verdict: parsed.verdict,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

export const CLASSIFIER_CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
export const CLASSIFIER_MODEL = MODEL;
