// Tiering de la Etapa 4: primera pasada barata sobre el
// gate de contradicciones de remember.mjs, vía Ollama Cloud (free tier,
// gpt-oss:20b-cloud = nivel 1, el más barato). Objetivo puntual: que Claude
// no tenga que releer el texto completo de los candidatos parecidos en el
// caso común de alta confianza (causa de costo documentada). No reemplaza la garantía de la Etapa 4 ("ninguna contradicción
// coexiste sin que alguien la haya visto"): por debajo del umbral de
// confianza, o si Ollama Cloud falla por cualquier motivo, cae al
// comportamiento de bloqueo manual de siempre. Nunca trata un error de red
// o una respuesta inválida como "distinct": fallar hacia el lado seguro es
// bloquear, no insertar.
import { readFileSync } from 'node:fs';
import { getTaskLlm } from './llm-call.mjs';

// Proveedor elegible (2026-09-15): "ollama" (default,
// gratis, sin prefijo en config/task-models.json) u "openrouter" (mismas
// familias de modelo -- gpt-oss, Nemotron -- por infraestructura distinta,
// útil de respaldo cuando Ollama Cloud aborta bajo carga).
const LLM = getTaskLlm('classifiers');
const { provider: PROVIDER, model: MODEL } = LLM;
const CONFIDENCE_THRESHOLD = 0.85;

// 2026-09-21: un candidato generado por extract-records.mjs --auto (extracción
// automática de una sesión, sin que nadie lo haya mirado) NUNCA debe poder
// superar (supersede) a un candidato cuya fuente es una captura directa (el
// usuario vía chat/MCP en otra sesión, confirmación directa, etc.) -- el
// candidato directo puede venir de un canal con visibilidad real de un evento
// (ej. un correo, una confirmación en el momento) que la ventana local de ESTA
// sesión simplemente no vio. Caso real: una extracción automática superó por
// error a un registro capturado desde el móvil justo cuando ocurrió la
// confirmación, porque el clasificador nunca vio la procedencia de ninguno de
// los dos, solo el texto. Esto es un candado determinístico en código, no solo
// una instrucción de prompt: un LLM puede ignorar una instrucción, un `if` no.
function isUnreviewedAutoExtraction(source) {
  return typeof source === 'string' && source.includes('sin revisión humana');
}

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

export const classifierEnabled = LLM.enabled;

function buildPrompt(newClaim, candidates, newSource, newSourceAt) {
  const candidateList = candidates
    .map((c) => `  #${c.id} (similitud ${c.similarity.toFixed(2)}, fuente: "${c.source}"${c.source_at ? `, instante: ${new Date(c.source_at).toISOString()}` : ''}): "${c.claim}"`)
    .join('\n');
  return `Eres un clasificador que decide si un registro nuevo, comparado con registros ya \
registrados y parecidos por embedding, es genuinamente distinto, si reemplaza \
(supersede) a alguno de ellos, si lo complementa sin reemplazarlo, o si ya está \
enteramente cubierto por uno de ellos (redundante).

registro nuevo (fuente: "${newSource ?? '(desconocida)'}"${newSourceAt ? `, instante: ${new Date(newSourceAt).toISOString()}` : ''}): "${newClaim}"

registros vigentes parecidos:
${candidateList}

La fuente de cada registro importa para decidir "supersedes": una fuente que \
dice "Extracción automática ... sin revisión humana" es una inferencia barata \
de una sesión, sin que nadie la haya verificado -- pesa MENOS que una fuente \
que describe una confirmación o reporte directo (del usuario, por chat, por \
correo, vía MCP desde cualquier otro canal/sesión, "revisado y aprobado", \
etc.). Si el registro NUEVO viene de una extracción automática sin revisión \
humana y el registro VIEJO viene de una fuente directa, sé especialmente \
conservador con "supersedes": ante cualquier duda de que el nuevo pueda estar \
basado en información incompleta o desactualizada (por ejemplo, una \
afirmación del propio asistente dentro de esa sesión, no un reporte directo \
del usuario), prefiere "distinct" en vez de "supersedes", y baja la \
confidence.

Cuando el "instante" esté disponible en ambos (nuevo y candidato), es la señal \
más confiable de cuál describe un estado más reciente: un registro que \
describe un instante ANTERIOR al de un candidato NUNCA lo reemplaza \
("supersedes"), sin importar cuál se insertó primero en la base -- lo que \
importa es cuándo ocurrió el hecho que describen, no cuándo se guardó.

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"verdict": "distinct" | "supersedes" | "complements" | "redundant", "supersedes_ids": [ids numéricos de los registros que reemplaza, vacío si verdict no es "supersedes"], "complements_id": id numérico del registro que complementa, o null si verdict no es "complements", "redundant_id": id numérico del registro que ya cubre por completo al nuevo, o null si verdict no es "redundant", "confidence": número entre 0 y 1, "reasoning": "una oración breve en español"}

"supersedes" solo si el registro nuevo describe el mismo asunto en un estado más \
reciente o corrige al anterior, Y el registro viejo no aporta ningún dato que el \
nuevo no repita (el viejo queda enteramente obsoleto). "complements" SOLO si \
puedes nombrar explícitamente un dato, matiz o detalle CONCRETO que el registro \
NUEVO aporta y que NINGÚN candidato ya tenía -- no basta con que el candidato \
tenga contexto o detalle adicional que el nuevo no repite, eso por sí solo NO \
convierte al nuevo en "complements", es la señal de "redundant". Dicho de otro \
modo: que el viejo sepa más que el nuevo es IRRELEVANTE para decidir entre \
"complements" y "redundant" -- lo único relevante es si el NUEVO sabe algo que \
el viejo no sabía. "redundant": el registro nuevo es una versión más delgada, \
parcial o repetida del MISMO hecho que ya cuenta UN candidato concreto, y no \
aporta NINGÚN dato, matiz o detalle propio que ese candidato no tenga ya -- \
aunque el candidato viejo sea más completo, más detallado, o cubra además otras \
cosas que el nuevo no menciona, eso no importa: si el nuevo no agrega nada \
PROPIO, es "redundant", nunca "complements". El candidato viejo no queda \
obsoleto (no es supersedes) ni se le suma nada real (no es complements), el \
nuevo simplemente sobra. Usa redundant_id con el id de ese candidato. "distinct" \
si es temáticamente parecido pero es información genuinamente distinta (otro \
aspecto, otro momento no contradictorio, otro sujeto), sin relación de \
actualización, complemento ni redundancia real.

Antes de responder "complements", complétalo explícitamente en tu razonamiento \
interno: "el nuevo aporta ___, que el candidato #___ no tenía". Si no puedes \
llenar ese espacio con un dato concreto (no una reformulación, no un subconjunto \
más corto), la respuesta correcta es "redundant", no "complements", sin importar \
cuánto más sepa el candidato viejo. Antes de responder "supersedes", pregúntate \
explícitamente: ¿el registro nuevo contiene TODO lo que el viejo decía? Si la \
respuesta es no, la respuesta correcta es "complements" (si además el nuevo \
aporta algo propio, nombrable) o "redundant" (si no), nunca "supersedes". Antes \
de responder "distinct" pese a un parecido temático fuerte, pregúntate lo mismo \
al revés: ¿el candidato ya dice todo lo que dice el nuevo, sin que el nuevo \
agregue algo propio nombrable? Si sí, la respuesta correcta es "redundant", no \
"distinct" -- "distinct" es para temas relacionados pero genuinamente separados, \
no para una repetición más corta del mismo hecho. Si no estás seguro, baja la \
confidence en vez de adivinar.`;
}

/**
 * @param {string} newClaim
 * @param {{id: number, claim: string, similarity: number, source: string, source_at: string|Date|null}[]} candidates
 * @param {string} [newSource] fuente del registro nuevo (args.source en remember.mjs, ANTES de
 *   anotarle el sufijo "[auto-resuelto por ...]"): determina si el candado de
 *   procedencia de más abajo aplica. Opcional para no romper otras llamadas,
 *   pero sin esto ese candado nunca puede activarse (se trata como fuente
 *   desconocida, nunca como "extracción automática sin revisión").
 * @param {string|Date|null} [newSourceAt] instante real (ISO 8601 o Date) del
 *   mensaje/evento fuente del registro nuevo (ver --source-at en remember.mjs):
 *   determina si el candado de CRONOLOGÍA de más
 *   abajo aplica. Sin esto (o sin source_at en el candidato), ese candado
 *   tampoco puede activarse para ese par -- no es un requisito, solo una
 *   defensa adicional cuando ambos instantes se conocen.
 * @returns {Promise<{verdict: 'distinct'|'supersedes'|'complements'|'redundant', supersedesIds: number[], complementsId: number|null, redundantId: number|null, confidence: number, reasoning: string} | null>}
 *   null si el clasificador está deshabilitado, o si falla por cualquier motivo
 *   (red, timeout, JSON inválido, ids inventados), el llamador debe tratar
 *   null exactamente igual que si nunca se hubiera intentado clasificar.
 */
export async function classifyDuplicate(newClaim, candidates, newSource, newSourceAt) {
  if (!classifierEnabled) return null;

  const prompt = buildPrompt(newClaim, candidates, newSource, newSourceAt);
  let responseText;
  try {
    responseText = await LLM.call(prompt, { timeoutMs: 20_000 });
  } catch (err) {
    console.error(`  (clasificador ${PROVIDER} no disponible: ${err.message}, cae a bloqueo manual)`);
    return null;
  }

  let parsed;
  try {
    // format:"json"/response_format:json_object fuerza JSON válido, pero el
    // modelo a veces igual lo envuelve en fences de markdown (```json ... ```).
    const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del clasificador no es JSON válido: ${err.message}, cae a bloqueo manual)`);
    return null;
  }

  // pg devuelve columnas bigint (records.id) como string, no number: hay que
  // normalizar antes de comparar contra los ids numéricos que devuelve el JSON.
  const validIds = new Set(candidates.map((c) => Number(c.id)));
  const supersedesIds = Array.isArray(parsed.supersedes_ids)
    ? parsed.supersedes_ids.map(Number).filter((id) => validIds.has(id))
    : [];
  const complementsId = Number.isFinite(Number(parsed.complements_id)) && validIds.has(Number(parsed.complements_id))
    ? Number(parsed.complements_id)
    : null;
  const redundantId = Number.isFinite(Number(parsed.redundant_id)) && validIds.has(Number(parsed.redundant_id))
    ? Number(parsed.redundant_id)
    : null;
  const confidence = Number(parsed.confidence);

  if (
    (parsed.verdict !== 'distinct' && parsed.verdict !== 'supersedes' && parsed.verdict !== 'complements' && parsed.verdict !== 'redundant') ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    (parsed.verdict === 'supersedes' && supersedesIds.length === 0) ||
    (parsed.verdict === 'complements' && complementsId === null) ||
    (parsed.verdict === 'redundant' && redundantId === null)
  ) {
    console.error(`  (respuesta del clasificador con forma inesperada: ${JSON.stringify(parsed)}, cae a bloqueo manual)`);
    return null;
  }

  // Candado determinístico (2026-09-21): una extracción automática
  // sin revisión humana nunca puede superar, por sí sola, a un candidato de
  // fuente directa -- sin importar qué tan confiado esté el clasificador.
  // Esto no depende de que el prompt de arriba se respete: es un `if`, no una
  // instrucción que un LLM pueda ignorar bajo presión de similitud textual.
  if (parsed.verdict === 'supersedes' && isUnreviewedAutoExtraction(newSource)) {
    const directCandidates = supersedesIds
      .map((id) => candidates.find((c) => Number(c.id) === id))
      .filter((c) => c && !isUnreviewedAutoExtraction(c.source));
    if (directCandidates.length > 0) {
      console.error(
        `  (bloqueado: el registro nuevo es una extracción automática sin revisión humana y ` +
          `pretendía superar a #${directCandidates.map((c) => c.id).join(', #')}, de fuente directa -- cae a bloqueo manual, nunca se confía ese supersede)`,
      );
      return null;
    }
  }

  // Candado determinístico de CRONOLOGÍA (2026-09-22): un hecho más VIEJO nunca puede superar a uno más NUEVO, sin
  // importar el canal por el que llegó cada uno -- esto es más general y más
  // objetivo que el candado de procedencia de arriba (que depende de
  // reconocer un texto de fuente específico). Solo aplica cuando AMBOS
  // instantes se conocen (newSourceAt y candidate.source_at); si falta
  // cualquiera de los dos, este candado simplemente no tiene con qué operar
  // y se sigue confiando en el resto del gate (incluido el candado de
  // procedencia de arriba, que no depende de esto).
  if (parsed.verdict === 'supersedes' && newSourceAt) {
    const newInstant = new Date(newSourceAt).getTime();
    if (!Number.isNaN(newInstant)) {
      const olderCandidates = supersedesIds
        .map((id) => candidates.find((c) => Number(c.id) === id))
        .filter((c) => {
          if (!c || !c.source_at) return false;
          const candidateInstant = new Date(c.source_at).getTime();
          return !Number.isNaN(candidateInstant) && newInstant < candidateInstant;
        });
      if (olderCandidates.length > 0) {
        console.error(
          `  (bloqueado: el registro nuevo describe un estado de ${newSourceAt}, anterior al de ` +
            `#${olderCandidates.map((c) => c.id).join(', #')} (${olderCandidates.map((c) => c.source_at).join(', ')}) -- ` +
            `un hecho más viejo no puede superar a uno más nuevo, cae a bloqueo manual)`,
        );
        return null;
      }
    }
  }

  return {
    verdict: parsed.verdict,
    supersedesIds,
    complementsId,
    redundantId,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

export const CLASSIFIER_CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
export const CLASSIFIER_MODEL = MODEL;
export const CLASSIFIER_PROVIDER = PROVIDER;
