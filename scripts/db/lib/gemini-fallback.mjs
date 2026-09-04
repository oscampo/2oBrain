// Llamada a Gemini con reintento sobre una lista de modelos de respaldo
// (config/gemini-models.json: mismo archivo que ya usa extract-facts.mjs,
// no se duplica la config, solo el mecanismo de reintento). Google renombra
// o sobrecarga modelos con frecuencia (razón de fondo por la que el default
// ya usa el alias "-latest" en vez de fijar versión); reintentar con el
// siguiente candidato solo tiene sentido para fallos transitorios
// (503/UNAVAILABLE, timeout, error de red): cuota agotada o api key
// inválida no cambian probando otro modelo, ahí hay que rendirse de una vez.
import { readFileSync } from 'node:fs';

const GEMINI_MODELS_CONFIG_PATH = new URL('../config/gemini-models.json', import.meta.url);

export function loadGeminiFallbackOrder() {
  try {
    const config = JSON.parse(readFileSync(GEMINI_MODELS_CONFIG_PATH, 'utf8'));
    if (Array.isArray(config.fallbackOrder) && config.fallbackOrder.length > 0) return config.fallbackOrder;
  } catch {
    // archivo ausente o inválido: cae a un solo modelo
  }
  return ['gemini-flash-latest'];
}

async function callOnce(apiKey, model, prompt, { systemPrompt, timeoutMs = 30_000 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(systemPrompt ? { system_instruction: { parts: [{ text: systemPrompt }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, retryable: true, error: `red/timeout: ${err.message}` };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const status = body?.error?.status ?? 'DESCONOCIDO';
    return {
      ok: false,
      retryable: status === 'UNAVAILABLE',
      error: `${res.status} (${status}): ${body?.error?.message ?? '(sin detalle)'}`,
    };
  }

  const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) return { ok: false, retryable: false, error: 'Gemini no devolvió texto.' };
  return { ok: true, text: text.trim() };
}

/**
 * @param {string} apiKey
 * @param {string} prompt
 * @param {{model?: string, systemPrompt?: string, timeoutMs?: number}} [opts]
 *   `model` explícito = un solo intento, sin fallback (el llamador ya eligió).
 *   Sin `model` = prueba en orden loadGeminiFallbackOrder().
 * @returns {Promise<string>}
 */
export async function generateWithGeminiFallback(apiKey, prompt, opts = {}) {
  if (!apiKey) throw new Error('Falta GEMINI_API_KEY.');
  const candidates = opts.model ? [opts.model] : loadGeminiFallbackOrder();

  let lastError = '(sin intentos)';
  for (let i = 0; i < candidates.length; i++) {
    const result = await callOnce(apiKey, candidates[i], prompt, opts);
    if (result.ok) return result.text;
    lastError = `${candidates[i]}: ${result.error}`;
    if (!result.retryable) break;
  }
  throw new Error(`Gemini falló en todos los modelos probados (${candidates.join(' -> ')}). Último error: ${lastError}`);
}
