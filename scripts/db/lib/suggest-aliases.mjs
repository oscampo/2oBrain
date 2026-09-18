// Sugerencia de alias al CREAR un recuerdo (2026-09-17, portado desde
// D:\MyBrain, registro #887): remember.mjs/create-memory.mjs creaban un
// recuerdo nuevo con el alias que trajera la conversación -- a veces ninguno,
// a veces solo un apodo -- dejando ciego a remember.mjs (matching de
// substring en escritura) y a list-memory-mentions.mjs (mismo matching en
// lote) frente a cualquier otra forma en que la misma entidad ya apareciera o
// apareciera después en un registro (nombre completo, sigla, código, título,
// con/sin tilde). Genérico a propósito -- no asume tipo de entidad, aplica
// igual a una persona, un proyecto, un curso o un concepto.
//
// Distinto de lib/classify-aliases.mjs (backfill guiado, list-alias-
// candidates.mjs): ese extrae formas que YA aparecen literalmente en el texto
// de los registros propios del recuerdo (verificado por substring, cero
// riesgo de invención). Este GENERA variantes plausibles a partir del
// name/alias dados, sin texto de respaldo todavía (un recuerdo recién creado
// no tiene registros propios aún) -- el riesgo de invención se acota pidiendo
// solo formas derivables del nombre mismo, nunca información nueva (cargo,
// institución, apellido) que no esté ya sugerida por el nombre/alias.
//
// Fail-open y silencioso: cualquier fallo (red, cuota, JSON inválido) o
// sugeridor deshabilitado devuelve null, el llamador simplemente no agrega
// nada, nunca bloquea la creación del recuerdo (a diferencia de la colisión
// de alias, que sigue siendo fail-closed en el llamador).
import { readFileSync } from 'node:fs';
import { getTaskProviderModel } from './task-models.mjs';
import { callOpenRouter, OPENROUTER_ENABLED } from './openrouter.mjs';

const { provider: PROVIDER, model: MODEL } = getTaskProviderModel('classifiers');

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

export const suggesterEnabled = PROVIDER === 'openrouter' ? OPENROUTER_ENABLED : Boolean(env.OLLAMA_API_KEY);

function buildPrompt(name, existingAliases) {
  const aliasLine = existingAliases.length
    ? `Alias que ya tiene: ${existingAliases.join(', ')}.`
    : 'Todavía no tiene ningún alias.';
  return `Eres un generador de alias para un recuerdo (entidad de cualquier tipo -- persona, \
proyecto, curso, colaboración, evento, concepto) dentro de un segundo cerebro personal. Un \
recuerdo se identifica con un nombre técnico, a veces un slug en kebab-case y a veces ya un \
nombre legible; la gente lo menciona en texto normal con otras formas: nombre completo, \
sigla o código, forma abreviada, variante con/sin tilde, traducción, título si es una \
persona con rol conocido.

Nombre del recuerdo: "${name}"
${aliasLine}

Tarea: proponer otras formas plausibles con las que este MISMO recuerdo podría aparecer \
mencionado en un texto. Solo formas derivables razonablemente del nombre y los alias dados \
-- no inventes información nueva (no supongas un cargo, institución o apellido que no esté \
ya sugerido por el nombre). Si el nombre no da pie a ninguna variante razonable, responde \
con lista vacía.

Responde SOLO con JSON, sin texto adicional:
{"aliases": ["forma alternativa", ...]}`;
}

/**
 * @param {string} name
 * @param {string[]} [existingAliases]
 * @returns {Promise<string[] | null>} alias propuestos, ya filtrados contra
 *   name/existingAliases (insensible a mayúsculas) -- puede ser `[]` (el
 *   modelo respondió pero no vio ninguna variante razonable). `null` si el
 *   sugeridor está deshabilitado o falla por cualquier motivo; el llamador
 *   trata `null` igual que `[]` (no agrega nada), nunca como error fatal.
 */
export async function suggestAliases(name, existingAliases = []) {
  if (!suggesterEnabled) return null;

  const prompt = buildPrompt(name, existingAliases);
  let responseText;
  try {
    if (PROVIDER === 'openrouter') {
      responseText = await callOpenRouter(prompt, MODEL, { timeoutMs: 20_000 });
    } else {
      const res = await fetch('https://ollama.com/api/generate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt, format: 'json', stream: false }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Ollama Cloud falló: ${res.status}`);
      responseText = (await res.json()).response;
    }
  } catch (err) {
    console.error(`  (sugeridor de alias (${PROVIDER}) no disponible: ${err.message})`);
    return null;
  }

  let parsed;
  try {
    const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del sugeridor de alias no es JSON válido: ${err.message})`);
    return null;
  }

  if (!Array.isArray(parsed.aliases)) {
    console.error(`  (respuesta del sugeridor de alias con forma inesperada: ${JSON.stringify(parsed).slice(0, 200)})`);
    return null;
  }

  const existingLower = new Set([name.toLowerCase(), ...existingAliases.map((a) => a.toLowerCase())]);
  return parsed.aliases
    .filter((a) => typeof a === 'string' && a.trim() !== '')
    .map((a) => a.trim())
    .filter((a) => !existingLower.has(a.toLowerCase()));
}

export const SUGGESTER_MODEL = MODEL;
export const SUGGESTER_PROVIDER = PROVIDER;
