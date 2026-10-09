// Llamada unificada al modelo de un grupo de "Modelos por tarea" (dashboard).
// Antes cada classify-*.mjs/suggest-*.mjs repetía su propio if (openrouter) /
// else fetch(ollama), y por eso 'classifiers' no podía ofrecer Gemini: habría
// bastado un archivo olvidado para mandar un modelo de Gemini a Ollama. Aquí
// vive la única ramificación por proveedor de los clasificadores.
//
//   const LLM = getTaskLlm('classifiers');
//   LLM.provider, LLM.model, LLM.enabled   (la llave del proveedor existe en .env)
//   const text = await LLM.call(prompt, { timeoutMs: 20_000 });  // texto crudo, JSON esperado
//
// Contrato de errores: LLM.call lanza si el proveedor falla; el llamador sigue
// decidiendo qué hacer (cada clasificador ya tiene su propio "cae a bloqueo
// manual" / "se ignora"). Reintento de 429 de Ollama Cloud solo con
// { retry429: true } (propose-parent.mjs; los demás siempre fallaron rápido a
// propósito para no frenar remember.mjs).
import { readFileSync } from 'node:fs';
import { getTaskProviderModel } from './task-models.mjs';
import { callOpenRouter } from './openrouter.mjs';
import { generateWithGeminiFallback } from './gemini-fallback.mjs';

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const env = loadEnv();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY_VAR = { ollama: 'OLLAMA_API_KEY', openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY' };

async function callOllama(prompt, model, { timeoutMs, retry429 }) {
  for (let intento = 1; ; intento++) {
    const res = await fetch('https://ollama.com/api/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, format: 'json', stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429 && retry429 && intento < 5) {
      await sleep(4000 * intento);
      continue;
    }
    if (!res.ok) throw new Error(`Ollama Cloud falló: ${res.status}`);
    return (await res.json()).response;
  }
}

/** @param {string} group grupo de TASK_GROUPS (task-models.mjs) */
export function getTaskLlm(group) {
  const { provider, model } = getTaskProviderModel(group);
  return {
    group,
    provider,
    model,
    enabled: Boolean(env[KEY_VAR[provider]]),
    async call(prompt, { timeoutMs = 20_000, retry429 = false } = {}) {
      if (provider === 'openrouter') return callOpenRouter(prompt, model, { timeoutMs });
      if (provider === 'gemini') return generateWithGeminiFallback(env.GEMINI_API_KEY, prompt, { preferred: model, timeoutMs });
      return callOllama(prompt, model, { timeoutMs, retry429 });
    },
  };
}
