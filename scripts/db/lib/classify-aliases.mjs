// Backfill guiado de Etapa 6 (2026-09-02, decisión del usuario): propone alias
// naturales para un nodo a partir de sus propios hechos -- 24 de 26 nodos de
// dominio tienen aliases vacío, lo que le impide a detect-node-mentions.mjs
// reconocer menciones en prosa normal (el name de un nodo es un slug
// kebab-case, casi nunca aparece literal en un hecho escrito a mano; ver
// hecho #493, caso John/Jane no detectado por esta causa exacta).
//
// Mismo tiering barato que classify-node.mjs (Ollama Cloud, gpt-oss:20b-cloud)
// -- a diferencia de classify-relation.mjs (que sí necesitó Gemini por
// calidad), esta es una tarea de extracción, no de juicio: el riesgo de
// alucinación se cierra pidiendo copia LITERAL (mismo principio que el
// hallazgo del hecho #480 -- exigir texto exacto generaliza, pedir un
// resumen o interpretación alucina) y, además, verificando en código que
// cada alias propuesto aparece de verdad como substring en el texto de los
// hechos antes de mostrarlo como candidato -- el llamador nunca confía en
// la respuesta cruda del modelo.
import { readFileSync } from 'node:fs';

const MODEL = 'gpt-oss:20b-cloud';

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

function buildPrompt(nodeName, factsText) {
  return `Eres un extractor de alias para un nodo (entidad: persona, proyecto, curso o \
colaboración) dentro de un segundo cerebro personal. El nodo se identifica internamente \
con un slug técnico ("${nodeName}"), pero la gente lo menciona en prosa normal con \
nombres naturales: nombre de pila, nombre completo, sigla, apodo, nombre de repositorio, \
variante con/sin tildes.

Hechos registrados sobre este nodo:
${factsText}

Tarea: proponer formas alternativas (alias) con las que este nodo aparece mencionado \
DENTRO del texto de estos hechos. Copia las formas TAL COMO aparecen en el texto, \
literal -- no traduzcas, no normalices, no inventes ninguna forma que no esté escrita \
ahí. Si el texto no contiene ninguna forma natural distinta del slug, responde con \
lista vacía.

Responde SOLO con JSON, sin texto adicional:
{"aliases": ["forma tal como aparece en el texto", ...]}`;
}

/**
 * @param {string} nodeName
 * @param {string} factsText texto concatenado de los hechos propios del nodo
 * @returns {Promise<string[] | null>} alias propuestos y verificados contra el texto
 *   real (substring, insensible a mayúsculas) -- null si el clasificador está
 *   deshabilitado o falla, nunca `[]` como sinónimo de "no se pudo evaluar".
 */
export async function classifyAliases(nodeName, factsText) {
  if (!classifierEnabled) return null;
  if (!factsText.trim()) return null;

  let res;
  try {
    res = await fetch('https://ollama.com/api/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: buildPrompt(nodeName, factsText), format: 'json', stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(`  (extractor de alias Ollama Cloud no disponible: ${err.message})`);
    return null;
  }
  if (!res.ok) {
    console.error(`  (extractor de alias Ollama Cloud falló: ${res.status})`);
    return null;
  }

  let parsed;
  try {
    const { response } = await res.json();
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del extractor de alias no es JSON válido: ${err.message})`);
    return null;
  }

  if (!Array.isArray(parsed.aliases)) {
    console.error(`  (respuesta del extractor de alias con forma inesperada: ${JSON.stringify(parsed).slice(0, 200)})`);
    return null;
  }

  const normalizedFacts = factsText.toLowerCase();
  return parsed.aliases
    .filter((a) => typeof a === 'string' && a.trim() !== '')
    .map((a) => a.trim())
    .filter((a) => normalizedFacts.includes(a.toLowerCase())); // descarta lo no verificable contra el texto real
}

export const CLASSIFIER_MODEL = MODEL;
