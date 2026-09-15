// Sintetiza una respuesta en prosa a partir de los resultados crudos de
// search.mjs, vía un LLM externo. Separado a propósito de search.mjs: la
// búsqueda sigue siendo determinista y gratis (RRF + rerank, sin LLM), esto
// es un paso opcional aparte que el llamador pide explícitamente.
//
// Tres proveedores, todos ya usados en el resto del sistema (mismas keys
// que classify-duplicate.mjs y extract-records.mjs, nada nuevo que
// configurar): Ollama Cloud (gpt-oss:20b-cloud), Gemini
// (gemini-flash-latest) y OpenRouter (posibilidad real de elegir
// proveedor también acá, no solo en clasificadores/extracción/rerank).
// "Claude" quedó fuera a propósito (decisión del usuario, 2026-08-28): requeriría
// ANTHROPIC_API_KEY, facturada aparte de la suscripción de Claude Code, no
// configurada. Si se agrega después, va aquí mismo como un cuarto 'case'.
import { readFileSync } from 'node:fs';
import { generateWithGeminiFallback } from './gemini-fallback.mjs';
import { getTaskModel } from './task-models.mjs';
import { callOpenRouter, AVAILABLE_OPENROUTER_MODELS } from './openrouter.mjs';

const MODELS = { ollama: getTaskModel('synthesis'), openrouter: AVAILABLE_OPENROUTER_MODELS[0] };
const SYNTHESIS_PROVIDER_LIST = ['ollama', 'gemini', 'openrouter'];

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

export const SYNTHESIS_PROVIDERS = SYNTHESIS_PROVIDER_LIST;

function buildPrompt(query, rawResults) {
  return `Eres un asistente que responde preguntas usando SOLO la información \
en los resultados de búsqueda de abajo, extraídos del segundo cerebro \
personal del usuario. No inventes nada que no esté en esos resultados. Si no \
alcanzan para contestar la pregunta, dilo explícitamente en vez de adivinar \
o completar con conocimiento general. Cita la fuente de cada afirmación \
(slug de página o número de registro #N, con su recuerdo si aparece) tal como \
aparece en los resultados.

Pregunta: "${query}"

Resultados de búsqueda:
${rawResults}

Responde en español, en prosa, conciso.`;
}

// Etapa 5 (PLAN-recuerdos.md, 2026-08-30): a diferencia de buildPrompt (responde
// una pregunta puntual sobre resultados ya filtrados por relevancia), esto
// resume TODOS los registros vigentes de un recuerdo: el objetivo es reemplazar el
// rol de una página narrativa mantenida a mano ("estado actual del proyecto
// X"), generada al momento de la consulta desde registros reales, nunca
// congelada. Mismo principio de fuente obligatoria: solo usa lo que está en
// los registros, nunca completa con conocimiento general.
function buildNodeStatusPrompt(node, rawFacts) {
  return `Eres un asistente que resume el estado actual de un recuerdo (proyecto, \
persona, curso o colaboración) del segundo cerebro personal del usuario, usando \
SOLO los registros vigentes listados abajo. No inventes nada que no esté en \
esos registros. Si hay información contradictoria o un vacío evidente \
(ej. un registro antiguo sin actualización reciente sobre el mismo asunto), \
dilo explícitamente en vez de resolverlo por tu cuenta. Cita el número de \
registro #N de cada afirmación tal como aparece en la lista. Cuando señales \
algo pendiente o sin resolver, cita también la fecha del registro que lo dejó \
pendiente (formato "pendiente desde YYYY-MM-DD, #N"), no solo el número,
la fecha es lo que le dice al lector qué tan viejo es el pendiente.

recuerdo: "${node}"

registros vigentes de este recuerdo, en orden cronológico:
${rawFacts}

Responde en español, en prosa, organizada por tema si hay varios, conciso \
pero completa, el objetivo es que esto reemplace tener que leer una página \
narrativa mantenida a mano.`;
}

async function callOllama(prompt, model) {
  const res = await fetch('https://ollama.com/api/generate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Ollama Cloud respondió ${res.status}: ${await res.text()}`);
  const { response } = await res.json();
  return response.trim();
}

async function generate(prompt, provider, model) {
  if (!SYNTHESIS_PROVIDERS.includes(provider)) {
    throw new Error(`Proveedor de síntesis desconocido: "${provider}". Válidos: ${SYNTHESIS_PROVIDERS.join(', ')}.`);
  }
  const apiKeyVar = provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OLLAMA_API_KEY';
  if (!env[apiKeyVar]) throw new Error(`Falta ${apiKeyVar} en .env, no se puede sintetizar con ${provider}.`);

  if (provider === 'gemini') {
    // Sin `model` explícito, prueba en orden config/gemini-models.json (el
    // mismo mecanismo de extract-records.mjs): reintenta el siguiente modelo
    // solo en fallos transitorios (503/UNAVAILABLE, timeout/red).
    return generateWithGeminiFallback(env.GEMINI_API_KEY, prompt, { model });
  }
  if (provider === 'openrouter') {
    // Sin fallback automático entre modelos de OpenRouter acá (a diferencia
    // de extract-records.mjs): es una síntesis interactiva desde "Buscar",
    // el usuario ve el error y puede reintentar con otro modelo del
    // selector, no vale la pena la complejidad de un fallback en cadena
    // para una llamada puntual.
    return callOpenRouter(prompt, model || MODELS.openrouter, { json: false });
  }
  return callOllama(prompt, model || MODELS.ollama);
}

/**
 * @param {string} query
 * @param {string} rawResults salida de texto de search.mjs
 * @param {'ollama'|'gemini'} provider
 * @param {string} [model] override, default per-provider
 * @returns {Promise<string>}
 */
export async function synthesize(query, rawResults, provider, model) {
  return generate(buildPrompt(query, rawResults), provider, model);
}

/**
 * @param {string} node
 * @param {string} rawFacts salida de texto de records_timeline() (ver memory-status.mjs)
 * @param {'ollama'|'gemini'} provider
 * @param {string} [model] override, default per-provider
 * @returns {Promise<string>}
 */
export async function synthesizeNodeStatus(node, rawFacts, provider, model) {
  return generate(buildNodeStatusPrompt(node, rawFacts), provider, model);
}
