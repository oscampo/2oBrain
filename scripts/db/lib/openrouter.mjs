// Cliente compartido para OpenRouter (2026-09-16, a pedido de Oscar: darle
// al usuario posibilidad de elegir proveedor/modelo más allá de Ollama Cloud
// y Gemini). Un solo lugar para el fetch + manejo de error, mismo criterio
// que gemini-fallback.mjs ya aplica para Gemini -- evita repetir esto en
// cada classify-*.mjs que quiera ofrecer OpenRouter como proveedor.
//
// API OpenAI-compatible (chat/completions), response_format json_object
// para que el llamador reciba JSON directo sin tener que limpiar fences de
// markdown (mismo contrato que Ollama con format:'json'). Verificado en
// vivo contra openai/gpt-oss-20b antes de conectarlo a los clasificadores
// reales.
import { readFileSync } from 'node:fs';

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

export const OPENROUTER_ENABLED = Boolean(env.OPENROUTER_API_KEY);

// Curada a mano, mismo criterio que AVAILABLE_OLLAMA_MODELS en
// task-models.mjs (no hay forma de descubrir automáticamente cuáles valen
// la pena para clasificación barata de entre los 445+ modelos de texto del
// catálogo). Los 4 son gratis o casi gratis a este volumen, y son las
// mismas familias (gpt-oss, Nemotron) que el sistema ya usa vía Ollama
// Cloud, por una infraestructura distinta -- útil como respaldo cuando
// Ollama Cloud aborta bajo carga (ver #747: nemotron-3-ultra/gpt-oss:20b
// abortando consistentemente a los 120s).
export const AVAILABLE_OPENROUTER_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
];

/**
 * @param {string} prompt
 * @param {string} model ej. "openai/gpt-oss-20b"
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<string>} texto crudo de la respuesta (se espera JSON, sin limpiar fences)
 */
export async function callOpenRouter(prompt, model, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (!env.OPENROUTER_API_KEY) throw new Error('Falta OPENROUTER_API_KEY.');

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`OpenRouter no disponible: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`OpenRouter falló: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter no devolvió texto.');
  return text.trim();
}
