// Helper compartido de embeddings, Voyage AI (voyage-4-lite, 1024 dims,
// multilingue). Reemplaza a Ollama local: se llama por HTTPS, no depende de
// que esta maquina especifica tenga un servidor corriendo, y es lo mismo
// que va a usar la Fase 4 (MCP alojado en la nube) para no tener dos
// espacios vectoriales distintos conviviendo en la misma columna.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} text
 * @param {'query'|'document'} inputType
 * @returns {Promise<number[]>} vector de 1024 dimensiones
 */
export async function embed(text, inputType) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model: 'voyage-4-lite',
        input_type: inputType,
        output_dimension: 1024,
      }),
    });
    if (res.ok) {
      const { data } = await res.json();
      return data[0].embedding;
    }
    // Sin tarjeta en la cuenta de Voyage, el rate limit es 3 RPM/10K TPM (no
    // documentado en la tabla pública, solo en el texto del error 429). El
    // límite es de cuenta completa, no por script: llamadas concurrentes de
    // remember.mjs/search.mjs compiten por el mismo cupo que un batch en
    // curso. Red de seguridad para cualquier llamador: varios reintentos con
    // backoff creciente antes de rendirse.
    if (res.status === 429 && attempt <= 4) {
      const waitMs = 70_000 * attempt;
      console.error(`  (429 de Voyage, intento ${attempt}, esperando ${waitMs / 1000}s antes de reintentar)`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`Voyage embed falló: ${res.status} ${await res.text()}`);
  }
}

// Proveedor de reranking, elegible por el usuario (2026-09-15, portado
// desde D:\MyBrain): Voyage tiene 200M tokens gratis para rerank, con más
// de 2M ya consumidos en la cuenta de Oscar -- no es crítico todavía, pero
// no es infinito, y además exige tarjeta en la cuenta para el límite de
// tasa cómodo. Algunos usuarios de 2oBrain van a preferir no poner tarjeta
// en ningún lado. RERANK_PROVIDER en .env ('voyage' por defecto, o
// 'openrouter') deja elegir sin tocar código. openrouter usa
// nvidia/llama-nemotron-rerank-vl-1b-v2:free -- gratis, cross-encoder,
// acepta documentos de solo texto (el "VL" es opcional: también toma
// imágenes, pero no las necesitamos aquí). Mismo shape de retorno para
// ambos proveedores, para no tocar a los llamadores (rerankTop en
// search.mjs y quien más use esto).
const RERANK_PROVIDER = (env.RERANK_PROVIDER || 'voyage').trim().toLowerCase();

async function rerankVoyage(query, documents) {
  const res = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query,
      documents,
      model: 'rerank-2.5-lite',
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage rerank falló: ${res.status} ${await res.text()}`);
  }
  const { data } = await res.json();
  return data;
}

async function rerankOpenRouter(query, documents) {
  const res = await fetch('https://openrouter.ai/api/v1/rerank', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
      query,
      documents: documents.map((text) => ({ text })),
      top_n: documents.length,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter rerank falló: ${res.status} ${await res.text()}`);
  }
  const { results } = await res.json();
  // Normaliza al mismo shape que devuelve Voyage: [{index, relevance_score}].
  return results.map((r) => ({ index: r.index, relevance_score: r.relevance_score }));
}

/**
 * Reordena documentos por relevancia real a la query (cross-encoder), sobre
 * el candidate pool que ya trajo el RRF vector+texto. Proveedor elegido vía
 * RERANK_PROVIDER en .env ('voyage', default, o 'openrouter').
 * @param {string} query
 * @param {string[]} documents
 * @returns {Promise<{index: number, relevance_score: number}[]>} ordenado desc por relevancia
 */
export async function rerank(query, documents) {
  if (documents.length === 0) return [];
  if (RERANK_PROVIDER === 'openrouter') return rerankOpenRouter(query, documents);
  if (RERANK_PROVIDER !== 'voyage') {
    throw new Error(`RERANK_PROVIDER desconocido: "${RERANK_PROVIDER}". Usa "voyage" u "openrouter".`);
  }
  return rerankVoyage(query, documents);
}

export const RERANK_PROVIDER_NAME = RERANK_PROVIDER;

export function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}

export const BATCH_DELAY_MS = 500; // con tarjeta y Tier 1 (2000 RPM), ya no hace falta el margen de 25s
