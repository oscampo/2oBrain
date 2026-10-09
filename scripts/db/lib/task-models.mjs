// Selección explícita de modelo de Ollama Cloud por grupo de tarea, para
// poder comparar calidad entre modelos sin tocar código -- 4 grupos,
// discutidos con Oscar el 2026-09-08 a partir de una tabla comparativa de
// los modelos disponibles (gpt-oss, gemma4, nemotron-3):
//
//   - classifiers: clasificación binaria/enum + una oración de razonamiento,
//     alto volumen (corre en cada remember.mjs/remember-batch.mjs).
//     classify-duplicate.mjs, classify-memory.mjs,
//     classify-commitment-resolution.mjs, classify-aliases.mjs,
//     classify-mention-relation.mjs, suggest-category-name.mjs.
//   - extraction: extracción sobre transcripciones/páginas largas y
//     desordenadas (extract-records.mjs, extract-page-records.mjs,
//     proveedor ollama -- Gemini sigue siendo el default real, ver esos
//     scripts, esto solo cubre el camino ollama).
//   - synthesis: redacción de la respuesta sintetizada en search.mjs
//     (lib/synthesize.mjs).
//   - deepSweep: barrido profundo de candidatos a relación entre recuerdos
//     (list-link-candidates-deep.mjs vía lib/classify-relation.mjs).
//
// Editable desde el dashboard (Opciones avanzadas -> "Modelos por tarea") o
// a mano en config/task-models.json. Sin ese archivo, o con una clave
// faltante/vacía, cada grupo cae a su propio default razonable (el mismo
// que ya corría hardcodeado antes de esto).
//
// Proveedor elegible por tarea (2026-09-15, portado desde D:\MyBrain): el
// valor de cada grupo puede llevar el prefijo "proveedor::" (ej.
// "openrouter::openai/gpt-oss-20b"). Sin ese prefijo, se asume "ollama" --
// así ningún config/task-models.json existente necesita migrarse, sigue
// leyéndose igual que antes. "::" y no ":" solo, porque los nombres de
// modelo de Ollama ya usan ":" (ej. "gemma4:31b-cloud") y un separador de
// un solo carácter sería ambiguo.
//
// Fuente única en la base (desde v0.10.9): la elección vive en la tabla
// `settings` (clave 'task_models', ver schema.sql), la misma que lee el
// servidor MCP, para que todas las máquinas de una instalación y el MCP usen
// siempre el mismo modelo. Este módulo la sincroniza UNA vez al cargarse (top-level await)
// hacia un caché local de máquina (state/task-models.cache.local.json, fuera
// de git) y después todo sigue siendo síncrono, como antes, porque los
// clasificadores resuelven su modelo al importarse. Orden de lectura: caché
// sincronizado desde la base (aunque esté vencido) > config/task-models.json
// > DEFAULTS. La sincronización se salta en la nube (CLAUDE_CODE_REMOTE=true,
// donde el proxy no deja pasar la conexión directa a Postgres) y nunca bloquea más de SYNC_TIMEOUT_MS.
// config/task-models.json ya no se escribe desde el dashboard: solo es el
// respaldo si la base no responde y nunca hubo caché.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import pg from 'pg';
import { AVAILABLE_OPENROUTER_MODELS } from './openrouter.mjs';
import { loadGeminiFallbackOrder } from './gemini-fallback.mjs';

const CONFIG_PATH = new URL('../config/task-models.json', import.meta.url);
const ENV_PATH = new URL('../../../.env', import.meta.url);
const CACHE_DIR = new URL('../../../state/', import.meta.url);
const CACHE_PATH = new URL('../../../state/task-models.cache.local.json', import.meta.url);
const CACHE_TTL_MS = 10 * 60 * 1000;
const SYNC_TIMEOUT_MS = 3000;

const DEFAULTS = {
  classifiers: 'gpt-oss:20b-cloud',
  extraction: 'gpt-oss:120b-cloud',
  synthesis: 'gpt-oss:20b-cloud',
  deepSweep: 'gemma4:31b-cloud',
  // Segunda opinión del clasificador de menciones (classifyMentionRelationHybrid):
  // antes escalaba a Gemini hardcodeado, invisible para el usuario.
  mentionSecondOpinion: 'gemini::gemini-flash-latest',
};

// Lista de respaldo de modelos de Ollama Cloud (los seis comparados en la
// tabla del 2026-09-08). La lista vigente vive en settings.available_models;
// esta solo se usa si la base nunca respondió en esta máquina.
const FALLBACK_OLLAMA_MODELS = [
  'gpt-oss:20b-cloud',
  'gpt-oss:120b-cloud',
  'gemma4:31b-cloud',
  'nemotron-3-nano:30b-cloud',
  'nemotron-3-super:cloud',
  'nemotron-3-ultra:cloud',
];

export const TASK_GROUPS = Object.keys(DEFAULTS);
export const KNOWN_PROVIDERS = ['ollama', 'openrouter', 'gemini'];

// Proveedores que cada grupo sabe llamar. Los clasificadores pasan por
// lib/llm-call.mjs (una sola ramificación por proveedor), por eso todos los
// grupos aceptan los tres.
export const GROUP_PROVIDERS = {
  classifiers: ['ollama', 'openrouter', 'gemini'],
  extraction: ['ollama', 'openrouter', 'gemini'],
  synthesis: ['ollama', 'openrouter', 'gemini'],
  deepSweep: ['ollama', 'openrouter', 'gemini'],
  mentionSecondOpinion: ['ollama', 'openrouter', 'gemini'],
};

function readJson(url) {
  try {
    const parsed = JSON.parse(readFileSync(url, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readEnv() {
  try {
    return Object.fromEntries(
      readFileSync(ENV_PATH, 'utf8')
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

async function withClient(fn) {
  const env = readEnv();
  if (!env.SUPABASE_DB_URL) throw new Error('falta SUPABASE_DB_URL en .env');
  const client = new pg.Client({
    connectionString: env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: SYNC_TIMEOUT_MS,
    statement_timeout: SYNC_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function writeCache(taskModels, availableModels) {
  const cache = { syncedAt: new Date().toISOString(), taskModels, availableModels };
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  } catch {
    // Sin caché en disco solo se pierde la ventana de 10 min, no la lectura.
  }
  return cache;
}

let cache = readJson(CACHE_PATH);

async function syncFromDb() {
  const rows = await withClient(async (client) => {
    const { rows } = await client.query(`select key, value from settings where key in ('task_models', 'available_models')`);
    return rows;
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!byKey.task_models) throw new Error("la base no tiene settings.task_models (¿falta aplicar schema.sql?)");
  cache = writeCache(byKey.task_models, byKey.available_models ?? null);
}

const cacheAge = cache?.syncedAt ? Date.now() - Date.parse(cache.syncedAt) : Infinity;
if (process.env.CLAUDE_CODE_REMOTE !== 'true' && !(cacheAge < CACHE_TTL_MS)) {
  try {
    await Promise.race([
      syncFromDb(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`sin respuesta en ${SYNC_TIMEOUT_MS} ms`)), SYNC_TIMEOUT_MS + 500).unref()),
    ]);
  } catch (err) {
    console.error(`  (modelos por tarea: no se pudo leer la base, ${err.message}; uso ${cache ? 'el caché local anterior' : 'config/task-models.json'})`);
  }
}

function currentTaskModels() {
  if (cache?.taskModels && typeof cache.taskModels === 'object') return cache.taskModels;
  return readJson(CONFIG_PATH) ?? {};
}

function cleanValue(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Modelos reales disponibles hoy por proveedor (de la base si se sincronizó,
// si no la lista de respaldo). No vienen de ninguna API, se editan a mano.
export const AVAILABLE_OLLAMA_MODELS = Array.isArray(cache?.availableModels?.ollama) ? cache.availableModels.ollama : FALLBACK_OLLAMA_MODELS;
const AVAILABLE_BY_PROVIDER = {
  ollama: AVAILABLE_OLLAMA_MODELS,
  openrouter: Array.isArray(cache?.availableModels?.openrouter) ? cache.availableModels.openrouter : AVAILABLE_OPENROUTER_MODELS,
  // Gemini: los mismos modelos de config/gemini-models.json (lista editable en
  // el dashboard, sección "Modelos"). El elegido va primero; el resto de esa
  // lista queda de respaldo para fallos transitorios (ver gemini-fallback.mjs).
  gemini: Array.isArray(cache?.availableModels?.gemini) ? cache.availableModels.gemini : loadGeminiFallbackOrder(),
};

export function getTaskModel(group) {
  if (!(group in DEFAULTS)) {
    throw new Error(`Grupo de tarea desconocido: "${group}". Válidos: ${TASK_GROUPS.join(', ')}.`);
  }
  return cleanValue(currentTaskModels()[group]) ?? DEFAULTS[group];
}

export function getAllTaskModels() {
  const config = currentTaskModels();
  return Object.fromEntries(TASK_GROUPS.map((g) => [g, cleanValue(config[g]) ?? DEFAULTS[g]]));
}

/**
 * @param {string} value ej. "openrouter::openai/gpt-oss-20b" o "gemma4:31b-cloud" (sin prefijo = ollama)
 * @returns {{provider: string, model: string}}
 */
export function parseProviderModel(value) {
  const idx = value.indexOf('::');
  if (idx === -1) return { provider: 'ollama', model: value };
  const provider = value.slice(0, idx);
  if (!KNOWN_PROVIDERS.includes(provider)) return { provider: 'ollama', model: value };
  return { provider, model: value.slice(idx + 2) };
}

/** Mismo valor que getTaskModel(group), ya separado en {provider, model}. */
export function getTaskProviderModel(group) {
  return parseProviderModel(getTaskModel(group));
}

// Modelos disponibles por proveedor, para el selector del dashboard -- un
// solo <select> por grupo, con valores "proveedor::modelo" (o el modelo
// pelado para ollama, que sigue siendo el default sin prefijo).
export function getAvailableModelsByProvider(group) {
  const all = {
    ollama: AVAILABLE_OLLAMA_MODELS,
    openrouter: AVAILABLE_BY_PROVIDER.openrouter.map((m) => `openrouter::${m}`),
    gemini: AVAILABLE_BY_PROVIDER.gemini.map((m) => `gemini::${m}`),
  };
  if (!group) return all;
  return Object.fromEntries(Object.entries(all).filter(([p]) => (GROUP_PROVIDERS[group] ?? []).includes(p)));
}

export const TASK_MODEL_DEFAULTS = DEFAULTS;

/**
 * Cambia el modelo de un grupo en la base (fuente única) y deja el cambio en
 * settings_history. Valida grupo, proveedor y que el modelo esté en la lista
 * de disponibles de ese proveedor: un nombre mal escrito rompería los
 * clasificadores de todas las máquinas y del servidor MCP a la vez.
 * @param {string} group
 * @param {string} value ej. "gemma4:31b-cloud" u "openrouter::openai/gpt-oss-20b"
 * @param {{by: string, reason?: string}} meta
 * @returns {Promise<Record<string,string>>} los modelos por tarea ya actualizados
 */
export async function setTaskModel(group, value, { by, reason } = {}) {
  if (!TASK_GROUPS.includes(group)) {
    throw new Error(`Grupo de tarea desconocido: "${group}". Válidos: ${TASK_GROUPS.join(', ')}.`);
  }
  const clean = cleanValue(value);
  if (!clean) throw new Error('falta el modelo');
  const { provider, model } = parseProviderModel(clean);
  if (!(GROUP_PROVIDERS[group] ?? []).includes(provider)) {
    throw new Error(`El grupo "${group}" todavía no soporta el proveedor "${provider}". Soportados: ${GROUP_PROVIDERS[group].join(', ')}.`);
  }
  if (!(AVAILABLE_BY_PROVIDER[provider] ?? []).includes(model)) {
    throw new Error(`"${model}" no está en la lista de modelos disponibles de ${provider}: ${(AVAILABLE_BY_PROVIDER[provider] ?? []).join(', ')}`);
  }
  if (!by) throw new Error('falta quién hace el cambio (by)');
  const updated = await withClient(async (client) => {
    await client.query('begin');
    try {
      const { rows } = await client.query(`select value from settings where key = 'task_models' for update`);
      if (rows.length === 0) throw new Error("la base no tiene settings.task_models (¿falta aplicar schema.sql?)");
      const oldValue = rows[0].value;
      const newValue = { ...oldValue, [group]: clean };
      await client.query(`update settings set value = $1, updated_at = now(), updated_by = $2 where key = 'task_models'`, [newValue, by]);
      await client.query(
        `insert into settings_history (key, old_value, new_value, changed_by, reason) values ('task_models', $1, $2, $3, $4)`,
        [oldValue, newValue, by, reason ?? null],
      );
      await client.query('commit');
      return newValue;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
  });
  cache = writeCache(updated, cache?.availableModels ?? null);
  return getAllTaskModels();
}
