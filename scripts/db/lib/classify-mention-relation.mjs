// Etapa 6 (2026-09-02, decisión del usuario: "lo haremos automático"). Juzga UN
// candidato concreto que ya encontró detect-node-mentions.mjs (un hecho
// nuevo de A menciona por nombre/alias a B) -- distinto de
// classify-relation.mjs, que compara los DOS historiales completos de A y B
// para descubrir todas las relaciones posibles entre ellos (el barrido
// O(n²), con poda de redundancia en 2 fases). Acá el disparador ya es
// puntual (una mención real, no todos los pares), así que el costo es
// lineal con hechos nuevos, no cuadrático -- por eso puede reintroducirse
// una llamada a LLM sin repetir el problema de costo que forzó abandonar el
// barrido como mecanismo principal (ver PLAN-nodos.md, Etapa 6, hecho #487).
//
// Mismo patrón de confianza que classify-duplicate.mjs/classify-node.mjs:
// null = clasificador no disponible o falló -- el llamador debe caer al
// candidato de revisión manual de siempre (mismo criterio fail-closed: un
// fallo de red NUNCA se trata como "no hay relación", eso perdería la señal
// gratis que ya encontró detect-node-mentions.mjs). verdict "no_relation" sí
// es una respuesta válida del clasificador (no un fallo) -- ahí el llamador
// puede descartar el candidato sin mostrarlo, es la reducción de ruido que
// pidió el usuario.
//
// Soporta ambos proveedores (igual que classify-relation.mjs) porque el
// modelo correcto para ESTE juicio más fino (una mención puntual, no un
// diff completo de historiales) todavía no está validado empíricamente --
// classify-relation.mjs necesitó Gemini por el patrón espurio "ambos
// hechos mencionan al usuario", pero eso se probó en el contexto del barrido
// completo, no en este.
import { readFileSync } from 'node:fs';
import { generateWithGeminiFallback } from './gemini-fallback.mjs';

const MODELS = { ollama: 'gpt-oss:20b-cloud', gemini: 'gemini-flash-latest' };
const DEFAULT_PROVIDER = 'ollama';
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

export const classifierEnabled = Boolean(env.OLLAMA_API_KEY || env.GEMINI_API_KEY);

function buildPrompt(claim, nodeA, nodeB, factsTextB) {
  return `Eres un clasificador que decide si la mención de un nodo dentro de un hecho \
nuevo representa una relación genuina entre dos nodos (entidad: persona, proyecto, \
curso o colaboración) de un segundo cerebro personal, o si es una mención incidental \
sin valor como relación (ej. ambos comparten un tema genérico, o el nombre aparece de \
paso sin que el hecho trate realmente sobre esa conexión).

Nodo A: "${nodeA}"
Hecho nuevo de A: "${claim}"

Nodo B: "${nodeB}" (mencionado dentro del hecho nuevo)
Hechos ya conocidos de B:
${factsTextB}

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"verdict": "relation" | "no_relation", "relation": "tipo_de_relacion_especifica en snake_case si verdict es relation, vacío si no_relation", "confidence": número entre 0 y 1, "reasoning": "una oración breve en español"}

"relation" solo si el hecho nuevo describe una conexión funcional, de dependencia, de \
colaboración o de interacción real entre A y B -- no basta con que ambos compartan un \
rasgo genérico (mismo dueño, mismo contexto amplio, mismo periodo de tiempo) si eso es \
lo único en común. "no_relation" si la mención es incidental, o si la relación es tan \
genérica que no aporta valor como arista del grafo. Si no estás seguro, baja la \
confidence en vez de adivinar -- confidence baja con verdict "relation" cae a revisión \
humana, no se descarta.`;
}

async function callOllama(prompt, model) {
  let res;
  try {
    res = await fetch('https://ollama.com/api/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model ?? MODELS.ollama, prompt, format: 'json', stream: false }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(`  (clasificador de menciones Ollama Cloud no disponible: ${err.message})`);
    return null;
  }
  if (!res.ok) {
    console.error(`  (clasificador de menciones Ollama Cloud falló: ${res.status})`);
    return null;
  }
  const { response } = await res.json();
  return response;
}

async function callGemini(prompt) {
  try {
    return await generateWithGeminiFallback(env.GEMINI_API_KEY, prompt);
  } catch (err) {
    console.error(`  (clasificador de menciones Gemini falló: ${err.message})`);
    return null;
  }
}

/**
 * @param {string} claim hecho nuevo de nodeA
 * @param {string} nodeA
 * @param {string} nodeB nodo mencionado dentro del claim
 * @param {string} factsTextB texto de los hechos existentes de nodeB (formato libre, mismo estilo que timeline.mjs)
 * @param {'ollama'|'gemini'} [provider] default 'ollama' -- sin validar empíricamente todavía, ver cabecera
 * @param {string} [model] override del modelo (solo aplica a provider 'ollama')
 * @returns {Promise<{verdict: 'relation'|'no_relation', relation: string, confidence: number, reasoning: string} | null>}
 *   null si el clasificador está deshabilitado o falla -- el llamador debe caer al
 *   candidato de revisión manual, nunca tratar null como "no_relation".
 */
export async function classifyMentionRelation(claim, nodeA, nodeB, factsTextB, provider = DEFAULT_PROVIDER, model) {
  if (!classifierEnabled) return null;

  const prompt = buildPrompt(claim, nodeA, nodeB, factsTextB);
  const rawResponse = provider === 'gemini' ? await callGemini(prompt) : await callOllama(prompt, model);
  if (rawResponse == null) return null;

  let parsed;
  try {
    const cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del clasificador de menciones no es JSON válido: ${err.message})`);
    return null;
  }

  const confidence = Number(parsed.confidence);
  const relation = typeof parsed.relation === 'string' ? parsed.relation.trim() : '';

  if (
    (parsed.verdict !== 'relation' && parsed.verdict !== 'no_relation') ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    (parsed.verdict === 'relation' && relation === '')
  ) {
    console.error(`  (respuesta del clasificador de menciones con forma inesperada: ${JSON.stringify(parsed).slice(0, 200)})`);
    return null;
  }

  return {
    verdict: parsed.verdict,
    relation,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    via: provider,
  };
}

// Modo híbrido (2026-09-02, decisión del usuario tras la comparación empírica
// en vivo): Ollama es rápido (4-14s) pero cae en el mismo patrón espurio que
// ya documentó classify-relation.mjs ("ambos comparten contexto genérico"),
// probado en este archivo contra el caso real coil-2026-2/DB1-gestion-github
// (hecho #486, ya sabíamos que era espurio): Ollama dijo "relation"
// (confianza 0.70, razón inventada), Gemini dijo "no_relation" (confianza
// 0.95, razón correcta) -- pero Gemini tardó 8-52s, demasiado para correrlo
// siempre. Solución: confía rápido en un "no_relation" de Ollama con
// confianza alta (su sesgo conocido es sobre-detectar relaciones, no
// pasarlas por alto -- un "no" seguro de Ollama es barato y confiable).
// Cualquier otro caso ("relation", inseguro, o falla) escala a Gemini como
// segunda opinión antes de decidir -- especialmente importante justo cuando
// se está por auto-crear un enlace.
export async function classifyMentionRelationHybrid(claim, nodeA, nodeB, factsTextB) {
  const ollamaResult = await classifyMentionRelation(claim, nodeA, nodeB, factsTextB, 'ollama');

  if (ollamaResult?.verdict === 'no_relation' && ollamaResult.confidence >= CONFIDENCE_THRESHOLD) {
    return ollamaResult;
  }

  const geminiResult = await classifyMentionRelation(claim, nodeA, nodeB, factsTextB, 'gemini');
  return geminiResult ?? ollamaResult;
}

export const CLASSIFIER_MODELS = MODELS;
export const CLASSIFIER_DEFAULT_PROVIDER = DEFAULT_PROVIDER;
export const CLASSIFIER_CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
