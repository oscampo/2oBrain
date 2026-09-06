// Propone un nombre kebab-case para una categoría nueva, dado un cluster de
// recuerdos huérfanos que list-category-candidates.mjs ya agrupó por similitud
// de sus registros -- mismo patrón y mismo modelo que classify-memory.mjs
// (Ollama Cloud, gpt-oss:20b-cloud, tiering barato), pero esto NO es una
// decisión que bloquee nada: es una sugerencia editable, el humano decide el
// nombre final en el dashboard antes de crear el recuerdo. Fail-closed devuelve
// null (no bloquea, el llamador simplemente no muestra sugerencia, el campo
// queda vacío para que el usuario escriba a mano).
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

export const suggesterEnabled = Boolean(env.OLLAMA_API_KEY);

// Longitud (2026-09-06, feedback de Oscar): el modelo tendía a nombres
// descriptivos de más de 3 segmentos ("rutina-espiritual-de-cada-mañana" en
// vez de "rutina-espiritual") -- el prompt ahora pone un tope explícito de 2
// palabras (3 solo si es genuinamente necesario para no confundirse con otra
// categoría existente), con ejemplos concretos de la convención que Oscar ya
// usa para subcategorías: <tipo>-<contexto> (reuniones-trabajo,
// reuniones-iglesia, proyectos-uao), nunca una frase completa.
function buildPrompt(members) {
  const list = members
    .map((m) => `  - "${m.name}" (${m.factCount} registro(s)), ejemplo: "${m.example}"`)
    .join('\n');
  return `Eres un asistente que propone el nombre de un recuerdo "categoría" (agrupador) \
para un segundo cerebro personal. Te doy un grupo de recuerdos existentes que ya se \
detectaron como temáticamente parecidos entre sí, cada uno con un registro de ejemplo.

Recuerdos del grupo:
${list}

Propón UN nombre de categoría en kebab-case (minúsculas, guiones, sin acentos ni \
espacios) que describa lo que estos recuerdos tienen en común, lo bastante específico \
para no confundirse con otro grupo, y una razón breve.

Reglas de estilo para el nombre (obligatorias):
- Máximo 2 palabras/segmentos separados por guion, 3 solo si es genuinamente \
necesario para no confundirse con otra categoría existente. NUNCA una frase completa.
- Si el grupo describe una subcategoría dentro de un tema más amplio, sigue el \
patrón <tipo>-<contexto> que ya se usa en este sistema: "reuniones-trabajo", \
"reuniones-iglesia", "proyectos-uao", "habitos-personal" -- no "reunion-semanal-de-trabajo-los-lunes".
- Prefiere el sustantivo/tema central, no una descripción de la acción completa: \
"rutina-espiritual" en vez de "rutina-espiritual-de-cada-manana".

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"name": "nombre-en-kebab-case", "reasoning": "una oración breve en español"}`;
}

/**
 * @param {{name: string, factCount: number, example: string}[]} members
 * @returns {Promise<{name: string, reasoning: string} | null>}
 */
export async function suggestCategoryName(members) {
  if (!suggesterEnabled) return null;
  if (!members || members.length === 0) return null;

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
        prompt: buildPrompt(members),
        format: 'json',
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(`  (sugeridor de nombre de categoría no disponible: ${err.message})`);
    return null;
  }

  if (!res.ok) {
    console.error(`  (sugeridor de nombre de categoría falló: ${res.status})`);
    return null;
  }

  let parsed;
  try {
    const { response } = await res.json();
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del sugeridor de nombre no es JSON válido: ${err.message})`);
    return null;
  }

  const name = typeof parsed.name === 'string' ? parsed.name.trim().toLowerCase() : '';
  if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    console.error(`  (nombre propuesto con forma inesperada: ${JSON.stringify(parsed)})`);
    return null;
  }

  return { name, reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '' };
}

export const SUGGESTER_MODEL = MODEL;
