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
import { readFileSync } from 'node:fs';

const CONFIG_PATH = new URL('../config/task-models.json', import.meta.url);

const DEFAULTS = {
  classifiers: 'gpt-oss:20b-cloud',
  extraction: 'gpt-oss:120b-cloud',
  synthesis: 'gpt-oss:20b-cloud',
  deepSweep: 'gemma4:31b-cloud',
};

// Modelos reales disponibles hoy vía Ollama Cloud para este proyecto (los
// seis comparados en la tabla del 2026-09-08). Lista editable a mano si
// Ollama Cloud agrega/retira modelos -- no viene de ninguna API, no hay
// forma de descubrirlos automáticamente.
export const AVAILABLE_OLLAMA_MODELS = [
  'gpt-oss:20b-cloud',
  'gpt-oss:120b-cloud',
  'gemma4:31b-cloud',
  'nemotron-3-nano:30b-cloud',
  'nemotron-3-super:cloud',
  'nemotron-3-ultra:cloud',
];

export const TASK_GROUPS = Object.keys(DEFAULTS);

function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getTaskModel(group) {
  if (!(group in DEFAULTS)) {
    throw new Error(`Grupo de tarea desconocido: "${group}". Válidos: ${TASK_GROUPS.join(', ')}.`);
  }
  const config = loadConfig();
  const model = config[group];
  return typeof model === 'string' && model.trim() ? model.trim() : DEFAULTS[group];
}

export function getAllTaskModels() {
  const config = loadConfig();
  return Object.fromEntries(TASK_GROUPS.map((g) => [g, typeof config[g] === 'string' && config[g].trim() ? config[g].trim() : DEFAULTS[g]]));
}

export const TASK_MODEL_DEFAULTS = DEFAULTS;
