// Extrae registros candidatos de un rango horario de una transcripción de
// Claude Code (.jsonl local) usando un LLM externo (Gemini por defecto).
//
// Dos modos:
//   - Sin --review (default): solo IMPRIME los candidatos, no toca la base.
//     Uso previsto: el usuario le pide esto a Claude en el chat; Claude corre el
//     script, muestra la lista, el usuario aprueba/edita/descarta por chat, y
//     Claude llama a remember.mjs a mano por cada registro aprobado: igual que
//     se ha venido haciendo manualmente, sin necesidad de más código aquí.
//   - Con --review: entra en un loop interactivo en la terminal (requiere
//     TTY real, no sirve invocado como subproceso no interactivo). Por cada
//     registro candidato: aprobar tal cual, editar (claim/fecha/tipo), o saltar.
//     Los aprobados se insertan de inmediato vía remember.mjs (subproceso).
//     Si remember.mjs no inserta (duplicado ambiguo, su propio clasificador
//     de Ollama Cloud no tuvo confianza suficiente), esa decisión NO se le
//     pasa al usuario aquí: es de remember.mjs, no de esta revisión. El registro
//     queda listado al final como pendiente de revisión manual.
//
// Costo: $0 en tokens de Claude (nunca llama a la API de Anthropic). Sí
// consume cuota del proveedor elegido (Gemini u Ollama Cloud) y, con
// --review, la de Voyage AI que ya gasta remember.mjs por cada inserción.
//
// Proveedor por defecto: el del grupo "extraction" en el dashboard (Modelos por
// tarea). Gemini sigue disponible con --provider gemini.
// Prompt por defecto: scripts/db/prompts/gemini-extractor-system-prompt.md
// (el que en pruebas retuvo más detalle específico: cifras, nombres, más
// que el prompt genérico embebido de respaldo).
//
// Uso:
//   node extract-records.mjs --date 2026-08-26 --from 08:00 --to 18:00 [opciones]
//
// --review                    Entra en revisión interactiva e inserta los
//                              registros aprobados vía remember.mjs.
// --provider gemini|ollama|openrouter    Default: el proveedor del grupo "extraction" en el dashboard.
// --model <id>                Override del modelo (un solo intento, sin
//                              fallback). Sin esto, prueba en orden la lista
//                              de config/gemini-models.json o
//                              config/ollama-models.json según --provider.
// --session <id>               Id de sesión (nombre del .jsonl sin extensión).
//                              Si se omite, usa el .jsonl modificado más
//                              recientemente en la carpeta de proyecto.
// --tz-offset <horas>          Horas a sumar a --from/--to para convertir a
//                              UTC (Bogotá = -5, sin horario de verano).
// --dump-prompt <archivo>      En vez de llamar al LLM, escribe el prompt
//                              completo (system + user) en el archivo y sale.
//                              $0 costo, no consume cuota de ningún proveedor.
// --system-prompt-file <ruta>  Usa ese archivo como system prompt en vez del
//                              default (prompts/gemini-extractor-system-prompt.md).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createInterface as createInterfaceAsync } from 'node:readline/promises';
import { createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listSessions, sessionFilePath } from './lib/session-files.mjs';
import { getTaskProviderModel } from './lib/task-models.mjs';

// Fuente de verdad: dashboard "Modelos por tarea" (grupo extraction). Gemini
// no es seleccionable allí, solo queda como --provider gemini explícito.
const TASK = getTaskProviderModel('extraction');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REMEMBER_SCRIPT = join(SCRIPT_DIR, 'remember.mjs');
const DEFAULT_SYSTEM_PROMPT_FILE = join(SCRIPT_DIR, 'prompts', 'gemini-extractor-system-prompt.md');
const GEMINI_MODELS_CONFIG_FILE = join(SCRIPT_DIR, 'config', 'gemini-models.json');
const OPENROUTER_MODELS_CONFIG_FILE = join(SCRIPT_DIR, 'config', 'openrouter-models.json');

const MODELS = { gemini: 'gemini-flash-latest', openrouter: 'nvidia/nemotron-3-super-120b-a12b:free' };

// Lista de modelos de Gemini a probar en orden cuando el primero falla de
// forma recuperable (503 UNAVAILABLE, "modelo sobrecargado": confirmado por
// el usuario 2026-08-28). Vive en un archivo editable, no en este código:
// el proveedor renombra/retira modelos con frecuencia (la razón de fondo
// por la que el default ya usa el alias "-latest" en vez de fijar
// versión), también editable desde el dashboard (ver /api/model-config).
// Ollama ya no usa este mecanismo de lista/respaldo: usa la selección
// explícita de config/task-models.json (grupo "extraction", ver
// lib/task-models.mjs), sin fallback -- decisión del usuario 2026-09-08 para
// poder comparar modelos entre sí en vez de solo tolerar caídas.
function loadFallbackOrder(configFile, fallbackDefault) {
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    if (Array.isArray(config.fallbackOrder) && config.fallbackOrder.length > 0) {
      return config.fallbackOrder;
    }
  } catch {
    // archivo ausente o inválido: cae al comportamiento de un solo modelo
  }
  return [fallbackDefault];
}
const loadGeminiFallbackOrder = () => loadFallbackOrder(GEMINI_MODELS_CONFIG_FILE, MODELS.gemini);
// OpenRouter (2026-09-15, portado desde D:\MyBrain): mismo mecanismo de
// lista de respaldo que Gemini, editable desde el dashboard ("Modelos").
// Solo los modelos gratuitos van en el default de
// config/openrouter-models.json -- no todos los usuarios de 2oBrain van a
// querer una cuenta de pago ahí.
const loadOpenRouterFallbackOrder = () => loadFallbackOrder(OPENROUTER_MODELS_CONFIG_FILE, MODELS.openrouter);
// Ventana de contexto: Ollama free tier es angosto (probado y confirmado
// insuficiente en calidad); Gemini declara ~1M tokens, se deja margen
// generoso sin acercarse al límite real. Nemotron 3 Super/Ultra gratis en
// OpenRouter declaran 262K/1M tokens de contexto, pero sin comparación de
// calidad propia todavía -- margen conservador, más grande que Ollama pero
// menor que Gemini.
const MAX_TRANSCRIPT_CHARS = { ollama: 20_000, gemini: 400_000, openrouter: 100_000 };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.date || !args.from || !args.to) {
  console.error(
    'Faltan campos. Uso:\n' +
      '  node extract-records.mjs --date YYYY-MM-DD --from HH:MM --to HH:MM [--review|--auto] [--provider gemini|ollama|openrouter] [--session id] [--tz-offset -5]',
  );
  process.exit(1);
}

const provider = args.provider ?? TASK.provider;
if (provider !== 'gemini' && provider !== 'ollama' && provider !== 'openrouter') {
  console.error(`--provider inválido: "${provider}". Debe ser "gemini", "ollama" u "openrouter".`);
  process.exit(1);
}

function loadEnv() {
  const envPath = new URL('../../.env', import.meta.url);
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

const apiKeyVar = provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OLLAMA_API_KEY';
if (!env[apiKeyVar] && !args['dump-prompt']) {
  console.error(`Falta ${apiKeyVar} en .env, no se puede llamar a ${provider}.`);
  process.exit(1);
}

if (args.review && !process.stdin.isTTY) {
  console.error(
    '--review requiere una terminal interactiva (stdin no es TTY). ' +
      'Corre esto directamente en tu propia terminal; si te lo pidel usuario por chat, ' +
      'corre sin --review, muestra la lista, y captura con remember.mjs lo que él apruebe.',
  );
  process.exit(1);
}

if (args.review && args.auto) {
  console.error('--review y --auto son excluyentes: elige uno.');
  process.exit(1);
}

// Con --model explícito, un solo intento sin fallback (el usuario ya eligió).
// Sin --model, se prueba en orden la lista de config/gemini-models.json o
// config/ollama-models.json según el proveedor.
const geminiCandidates = args.model ? [args.model] : provider === 'gemini' ? loadGeminiFallbackOrder() : [];
const ollamaCandidates = args.model ? [args.model] : provider === 'ollama' ? [TASK.provider === 'ollama' ? TASK.model : 'gemma4:31b-cloud'] : [];
const openrouterCandidates = args.model ? [args.model] : provider === 'openrouter' ? (TASK.provider === 'openrouter' ? [TASK.model] : loadOpenRouterFallbackOrder()) : [];
let model = provider === 'gemini' ? geminiCandidates[0] : provider === 'openrouter' ? openrouterCandidates[0] : ollamaCandidates[0];

const tzOffset = args['tz-offset'] ? Number(args['tz-offset']) : -5;

function localToUtcIso(dateStr, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const local = new Date(`${dateStr}T00:00:00Z`);
  local.setUTCHours(h - tzOffset, m, 0, 0);
  return local.toISOString();
}

const fromIso = localToUtcIso(args.date, args.from);
const toIso = localToUtcIso(args.date, args.to);

// Ancla la raíz del proyecto a la ubicación del propio script (scripts/db/),
// no a process.cwd(): si el usuario corre esto desde dentro de scripts/db en vez
// de la raíz del repo, cwd apunta a la carpeta equivocada y el encoding de
// Claude Code para el directorio de sesiones no coincide con ninguna real.
const projectRoot = join(SCRIPT_DIR, '..', '..');

let sessionFile;
if (args.session) {
  sessionFile = sessionFilePath(projectRoot, args.session);
} else {
  const sessions = listSessions(projectRoot);
  if (sessions.length === 0) {
    console.error(`No hay archivos .jsonl de sesión para este proyecto.`);
    process.exit(1);
  }
  sessionFile = sessionFilePath(projectRoot, sessions[0].id);
}

const candidatesForStatus = provider === 'gemini' ? geminiCandidates : provider === 'openrouter' ? openrouterCandidates : ollamaCandidates;
console.error(
  candidatesForStatus.length > 1
    ? `Proveedor: ${provider} (probará en orden: ${candidatesForStatus.join(' -> ')})`
    : `Proveedor: ${provider} (${model})`,
);
console.error(`Leyendo ${sessionFile}`);
console.error(`Rango: ${fromIso} .. ${toIso} (local ${args.from}-${args.to}, tz-offset ${tzOffset})`);

function extractText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// Líneas "Registrado #N: ..." dentro de un tool_result de remember.mjs:
// extractText() nunca incluía salidas de herramientas, solo texto de
// usuario/asistente. Eso dejaba al extractor ciego a lo que ya se había
// guardado a mano DENTRO de la misma ventana, y volvía a proponer el mismo
// hecho con menos detalle; el gate de duplicados de remember.mjs no lo atrapaba
// siempre. Con --auto insertando sin que nadie revise, eso producía registros
// redundantes reales en la base. No hace falta el tool_result completo (rompería
// el filtro de ruido para búsquedas o lecturas de archivo grandes), solo esta
// línea puntual.
function extractAlreadyRegisteredLines(message) {
  if (!Array.isArray(message?.content)) return [];
  const lines = [];
  for (const block of message.content) {
    if (block?.type !== 'tool_result') continue;
    const text = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        : '';
    for (const m of text.matchAll(/^Registrado #\d+:.*/gm)) lines.push(m[0]);
  }
  return lines;
}

const turns = [];
const alreadyRegistered = [];
const rl = createInterface({ input: createReadStream(sessionFile, 'utf8'), crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry.isSidechain) continue;
  if (entry.type !== 'user' && entry.type !== 'assistant') continue;
  if (!entry.timestamp || entry.timestamp < fromIso || entry.timestamp > toIso) continue;

  if (entry.type === 'user') alreadyRegistered.push(...extractAlreadyRegisteredLines(entry.message));

  const text = extractText(entry.message).trim();
  if (!text) continue; // descarta turnos que son solo tool_use/tool_result/thinking

  turns.push({ time: entry.timestamp, speaker: entry.type === 'user' ? 'el usuario' : 'Claude', text });
}

if (turns.length === 0 && alreadyRegistered.length === 0) {
  console.error('No se encontraron turnos de texto en ese rango. Nada que extraer.');
  process.exit(0);
}

const turnLines = turns.map((t) => `[${t.time.slice(11, 16)}] ${t.speaker}: ${t.text}`);

// Ventanas más largas que el límite del proveedor (2026-10-09): en vez de
// cortar el final (se perdían justo las decisiones más recientes, bug visto
// con gemma4), se parte en trozos de turnos completos, cada trozo se extrae
// por separado y los candidatos se unen al final. Un solo turno más largo que
// el límite sí se recorta: no hay forma de partirlo sin perder su sentido.
// El bloque "ya registrado" (2026-09-18) va completo en CADA trozo y nunca
// cuenta contra el límite: es la única defensa contra reinsertar lo ya guardado.
const maxChars = MAX_TRANSCRIPT_CHARS[provider];
const transcriptChunks = [];
{
  let current = [];
  let currentLen = 0;
  for (const line of turnLines) {
    const piece = line.length > maxChars ? line.slice(0, maxChars) : line;
    if (current.length > 0 && currentLen + piece.length + 2 > maxChars) {
      transcriptChunks.push(current.join('\n\n'));
      current = [];
      currentLen = 0;
    }
    current.push(piece);
    currentLen += piece.length + 2;
  }
  if (current.length > 0) transcriptChunks.push(current.join('\n\n'));
}
const registeredBlock = alreadyRegistered.length > 0
  ? `\n\n--- Ya registrado en esta ventana, NO lo vuelvas a proponer ---\n${alreadyRegistered.join('\n')}`
  : '';

console.error(
  `${turns.length} turnos de texto, ${transcriptChunks.reduce((n, c) => n + c.length, 0)} caracteres${transcriptChunks.length > 1 ? ` (partidos en ${transcriptChunks.length} trozos)` : ''}.`,
);

let systemPrompt;

const systemPromptFile = args['system-prompt-file'] ?? (existsSync(DEFAULT_SYSTEM_PROMPT_FILE) ? DEFAULT_SYSTEM_PROMPT_FILE : null);

if (systemPromptFile) systemPrompt = readFileSync(systemPromptFile, 'utf8');

function buildUserPrompt(transcript) {
  if (systemPromptFile) return `Transcripción (fecha del día: ${args.date}):\n${transcript}`;
  return `Eres un extractor de registros atómicos a partir de una transcripción de conversación en español entre el usuario y su asistente Claude. Lee la transcripción y devuelve CON LA MAYOR CANTIDAD DE DETALLES POSIBLE SOLO los registros que valgan la pena recordar a largo plazo, incluyendo datos e información de contexto que enriquezca informativamente cada uno de esos registros : decisiones cerradas, correcciones, compromisos con fecha, hallazgos con fecha. Ignora saludos, preguntas sin resolver, contenido puramente exploratorio sin conclusión, y subproductos operativos que ya quedan escritos en otro lado (commits y pushes, que un script corrió o qué imprimió, cambios de código o configuración que se entienden leyendo el archivo, resultados de chequeos rutinarios, reuniones y citas que ya están en el calendario, resúmenes de registros que ya existen). Ante la duda, omite.

Transcripción (fecha del día: ${args.date}):
${transcript}

Responde SOLO con JSON, sin texto adicional, con esta forma exacta:
{"records": [{"claim": "registro atómico en una o varias oraciones, en una sola línea de texto, español, autocontenido", "date": "YYYY-MM-DD", "kind": "fact"|"event"|"commitment", "sourceTime": "HH:MM"}]}

Si no hay nada capturable, responde {"records": []}. No inventes fechas: si el registro no tiene \
fecha explícita, usa la fecha del día (${args.date}). Para "sourceTime": copia EXACTAMENTE una de \
las etiquetas [HH:MM] que ya aparecen al inicio de cada línea de la transcripción, la del turno \
donde el hecho quedó confirmado o cerrado (no el primero que lo menciona, si hubo una corrección \
posterior). No inventes ni calcules una hora. Si no hay un turno único al que anclarlo, omite el \
campo o usa null.`;
}

let userPrompt = buildUserPrompt(transcriptChunks[0] + registeredBlock);

if (args['dump-prompt']) {
  const dumped = systemPrompt ? `--- SYSTEM ---\n${systemPrompt}\n\n--- USER ---\n${userPrompt}` : userPrompt;
  writeFileSync(args['dump-prompt'], dumped, 'utf8');
  console.error(`Prompt completo (tal como se envía a ${provider}) escrito en ${args['dump-prompt']}`);
  process.exit(0);
}

// process.exit() forzado mientras undici aún tiene sockets keep-alive
// pooleados provoca un crash de libuv en Windows (UV_HANDLE_CLOSING
// assertion) en vez de una salida limpia. Por eso los errores de red/API
// abajo NO llaman a process.exit(): fijan process.exitCode y devuelven null,
// dejando que el módulo termine solo (Node sale con ese código al drenar el
// event loop de forma natural).
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Mismo criterio que lastGeminiStatus: solo 503 (servicio sobrecargado) vale
// la pena reintentar con el siguiente modelo de la lista; cualquier otro
// error (auth, cuota, red) no se arregla cambiando de modelo.
let lastOllamaStatus = null;

/** @returns {Promise<string|null>} el texto crudo de respuesta (se espera JSON), o null si falló */
async function callOllama() {
  lastOllamaStatus = null;
  let res;
  try {
    res = await fetchWithTimeout(
      'https://ollama.com/api/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: userPrompt,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          format: 'json',
          stream: false,
        }),
      },
      // 60s se quedaba corto con nemotron-3-ultra (550B, el más pesado de
      // los modelos que se comparan en config/task-models.json, ver
      // lib/task-models.mjs) -- "This operation was aborted" real,
      // 2026-09-08, extrayendo una página de ~6200 caracteres.
      120_000,
    );
  } catch (err) {
    console.error(`ERROR DE RED llamando a Ollama Cloud (modelo "${model}"): ${err.message}`);
    process.exitCode = 1;
    return null;
  }
  if (!res.ok) {
    lastOllamaStatus = res.status;
    console.error(`Ollama Cloud respondió ${res.status} (modelo "${model}"): ${await res.text()}`);
    process.exitCode = 1;
    return null;
  }
  const { response } = await res.json();
  return response;
}

async function callOllamaWithFallback(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    model = candidates[i];
    if (i > 0) console.error(`Reintentando con el siguiente modelo de respaldo: ${model}`);
    const result = await callOllama();
    if (result != null) return result;
    const isLast = i === candidates.length - 1;
    if (lastOllamaStatus !== 503 || isLast) return null;
    process.exitCode = 0;
  }
  return null;
}

// Status del último fallo de Gemini, para que el loop de fallback decida si
// vale la pena probar el siguiente modelo (solo UNAVAILABLE = 503, "modelo
// sobrecargado") o si hay que rendirse ya (cuota, permisos, red: reintentar
// con otro modelo no cambia nada ahí).
let lastGeminiStatus = null;

/** @returns {Promise<string|null>} el texto crudo de respuesta (se espera JSON), o null si falló */
async function callGemini() {
  lastGeminiStatus = null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(systemPrompt ? { system_instruction: { parts: [{ text: systemPrompt }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      },
      90_000,
    );
  } catch (err) {
    console.error(`ERROR DE RED llamando a Gemini (modelo "${model}"): ${err.message}`);
    process.exitCode = 1;
    return null;
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const status = body?.error?.status ?? 'DESCONOCIDO';
    lastGeminiStatus = status;
    const message = body?.error?.message ?? '(sin cuerpo de error legible)';
    const hint =
      status === 'RESOURCE_EXHAUSTED'
        ? ' [CUOTA AGOTADA]'
        : status === 'PERMISSION_DENIED' || status === 'UNAUTHENTICATED'
          ? ' [PROBLEMA DE ACCESO/API KEY]'
          : status === 'NOT_FOUND'
            ? ` [MODELO "${model}" NO EXISTE, Google puede haberlo renombrado/retirado, prueba --model otro-id]`
            : '';
    console.error(`Gemini respondió ${res.status} (${status})${hint}: ${message}`);
    process.exitCode = 1;
    return null;
  }

  if (body?.promptFeedback?.blockReason) {
    console.error(`Gemini bloqueó la solicitud por seguridad: ${body.promptFeedback.blockReason}`);
    process.exitCode = 1;
    return null;
  }

  const candidate = body?.candidates?.[0];
  if (!candidate) {
    console.error(`Gemini no devolvió candidatos. Respuesta completa:\n${JSON.stringify(body, null, 2)}`);
    process.exitCode = 1;
    return null;
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    console.error(`(aviso: finishReason="${candidate.finishReason}", la respuesta puede estar incompleta)`);
  }

  const text = (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) {
    console.error(`Gemini devolvió una respuesta sin texto. Respuesta completa:\n${JSON.stringify(body, null, 2)}`);
    process.exitCode = 1;
    return null;
  }
  return text;
}

async function callGeminiWithFallback(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    model = candidates[i];
    if (i > 0) console.error(`Reintentando con el siguiente modelo de respaldo: ${model}`);
    const result = await callGemini();
    if (result != null) return result;
    const isLast = i === candidates.length - 1;
    if (lastGeminiStatus !== 'UNAVAILABLE' || isLast) return null; // otro tipo de error, o ya no quedan candidatos: no insistir
    process.exitCode = 0; // el intento fallido puso exitCode=1; si hay otro candidato, no es un fallo final todavía
  }
  return null;
}

// Mismo criterio que lastOllamaStatus/lastGeminiStatus: 429 (rate limit),
// 502 y 503 (sobrecarga del proveedor upstream, ver más abajo) valen la
// pena reintentar con el siguiente modelo de la lista; cualquier otro
// error (auth, modelo inexistente) no se arregla cambiando de modelo.
let lastOpenRouterStatus = null;

/** @returns {Promise<string|null>} el texto crudo de respuesta (se espera JSON), o null si falló */
async function callOpenRouterModel() {
  lastOpenRouterStatus = null;
  let res;
  try {
    res = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
        }),
      },
      120_000,
    );
  } catch (err) {
    console.error(`ERROR DE RED llamando a OpenRouter (modelo "${model}"): ${err.message}`);
    process.exitCode = 1;
    return null;
  }
  if (!res.ok) {
    lastOpenRouterStatus = res.status;
    console.error(`OpenRouter respondió ${res.status} (modelo "${model}"): ${await res.text()}`);
    process.exitCode = 1;
    return null;
  }
  const body = await res.json();
  // OpenRouter a veces devuelve el fallo del proveedor upstream (ej. "Nvidia:
  // Service temporarily overloaded") DENTRO de un body 200, no como error
  // HTTP real (hallazgo en vivo, 2026-09-15). Sin este chequeo, res.ok pasa,
  // no hay `choices`, y el fallback nunca se dispara porque
  // lastOpenRouterStatus se queda en null.
  if (body?.error) {
    lastOpenRouterStatus = body.error.code ?? null;
    console.error(`OpenRouter devolvió un error del proveedor (modelo "${model}", code ${body.error.code}): ${body.error.message}`);
    process.exitCode = 1;
    return null;
  }
  const text = body?.choices?.[0]?.message?.content;
  if (!text) {
    console.error(`OpenRouter no devolvió texto (modelo "${model}"). Respuesta completa:\n${JSON.stringify(body, null, 2)}`);
    process.exitCode = 1;
    return null;
  }
  return text;
}

async function callOpenRouterWithFallback(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    model = candidates[i];
    if (i > 0) console.error(`Reintentando con el siguiente modelo de respaldo: ${model}`);
    const result = await callOpenRouterModel();
    if (result != null) return result;
    const isLast = i === candidates.length - 1;
    const retryable = [429, 502, 503].includes(lastOpenRouterStatus);
    if (!retryable || isLast) return null;
    process.exitCode = 0;
  }
  return null;
}

// Una llamada por trozo (ver transcriptChunks); basta que un trozo falle
// para abortar sin insertar nada parcial: el error ya se imprimió y
// process.exitCode ya quedó en 1.
let parsed = { records: [] };
let rawResponse = '';
const seenClaims = new Set();
for (let i = 0; i < transcriptChunks.length; i++) {
  if (transcriptChunks.length > 1) console.error(`Trozo ${i + 1}/${transcriptChunks.length}...`);
  userPrompt = buildUserPrompt(transcriptChunks[i] + registeredBlock);
  rawResponse =
    provider === 'gemini'
      ? await callGeminiWithFallback(geminiCandidates)
      : provider === 'openrouter'
        ? await callOpenRouterWithFallback(openrouterCandidates)
        : await callOllamaWithFallback(ollamaCandidates);
  if (rawResponse == null) {
    parsed = null;
    break;
  }
  const cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const chunkParsed = JSON.parse(cleaned);
    for (const r of chunkParsed.records ?? []) {
      if (seenClaims.has(r.claim)) continue;
      seenClaims.add(r.claim);
      parsed.records.push(r);
    }
  } catch (err) {
    console.error(`Respuesta no es JSON válido: ${err.message}`);
    console.error(rawResponse);
    process.exitCode = 1;
    parsed = null;
    break;
  }
}

{
  if (parsed) {
    const records = parsed.records ?? [];

    // En --auto se captura stdout: un candidato correctamente rechazado como
    // "redundant" por classify-duplicate.mjs no debe contarse igual que uno
    // insertado de verdad -- sin esto no había forma de distinguir "el gate
    // hizo su trabajo" de "sí se guardó un registro nuevo".
    const source = `Extracción automática (${provider}/${model}), rango ${args.date} ${args.from}-${args.to}${args.auto ? ', inserción automática sin revisión humana' : ', revisado y aprobado por el usuario'}`;
    const REDUNDANT_MARKER = /^Ya cubierto por #\d+, no se inserta \(redundante\)\.$/m;

    // Resuelve f.sourceTime (etiqueta [HH:MM] que el modelo copió, ver prompt)
    // contra el instante REAL (timestamp completo del .jsonl) del turno que la
    // generó -- nunca se confía en que el modelo calcule un ISO completo, solo
    // en que copie una etiqueta que ya existe en el texto que vio; el resto es
    // una búsqueda determinística en `turns`. Sin match (etiqueta inventada),
    // devuelve null: el registro simplemente entra sin source_at, ni error ni
    // bloqueo.
    function resolveSourceAt(sourceTime) {
      if (!sourceTime || typeof sourceTime !== 'string') return null;
      const match = turns.find((t) => t.time.slice(11, 16) === sourceTime);
      return match ? match.time : null;
    }

    // el usuario solo aprueba/edita/salta el texto extraído. Si remember.mjs no
    // puede insertar (duplicado ambiguo, su propio clasificador no tuvo
    // confianza suficiente), NO se le pregunta al usuario aquí qué hacer: eso es
    // una decisión de remember.mjs, no de esta revisión. Se registra aparte para
    // que la resuelva a mano después, con calma.
    function insertFact(f) {
      const cliArgs = [REMEMBER_SCRIPT, '--claim', f.claim, '--date', f.date, '--kind', f.kind, '--source', source];
      const sourceAt = resolveSourceAt(f.sourceTime);
      if (sourceAt) cliArgs.push('--source-at', sourceAt);
      // Propuestas de etiqueta (v0.11.0): nadie confirma en mitad de una extracción,
      // así que van a la cola de revisión del dashboard en vez de bloquear o aplicarse solas.
      cliArgs.push('--queue-proposals');
      if (args.auto) {
        // windowsHide: sin esto, cada llamada abre una consola visible en
        // Windows aunque stdio esté redirigido; --auto no espera que nadie la mire.
        const result = spawnSync(process.execPath, cliArgs, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
        if (result.status === 0 && REDUNDANT_MARKER.test(result.stdout ?? '')) return 'redundant';
        return result.status === 0 ? 'inserted' : 'manual';
      }
      const result = spawnSync(process.execPath, cliArgs, { stdio: 'inherit' });
      return result.status === 0;
    }

    if (args.auto) {
      // Modo no interactivo: inserta cada candidato directo, sin pedir aprobación
      // turno a turno. No es "insertar a ciegas": pasa por el mismo remember.mjs
      // con su mismo gate de duplicados y contradicciones que ya protege
      // cualquier otra vía de inserción. Lo que remember.mjs no puede
      // autoresolver queda pendiente igual, nunca se fuerza.
      let insertedCount = 0;
      let redundantCount = 0;
      const needsManualReview = [];
      for (const f of records) {
        const outcome = insertFact(f);
        if (outcome === 'inserted') insertedCount++;
        else if (outcome === 'redundant') redundantCount++;
        else needsManualReview.push(f);
      }
      console.log(`\nInsertado(s) automáticamente: ${insertedCount}.`);
      if (redundantCount > 0) {
        console.log(`Ya cubierto(s) por un registro existente, correctamente NO insertado(s): ${redundantCount}.`);
      }
      if (needsManualReview.length > 0) {
        console.log(`Pendiente(s) de revisión manual (remember.mjs no pudo autoresolver):`);
        for (const f of needsManualReview) {
          console.log(`- [${f.date}] (${f.kind}) ${f.claim}`);
        }
      }
      console.log('\nAuto-inserción terminada.');
    } else if (!args.review) {
      console.log(`\n${records.length} registro(s) candidato(s):\n`);
      for (const f of records) {
        console.log(`- [${f.date}] (${f.kind}) ${f.claim}`);
      }
      console.log('\nEsto NO se insertó en la base. Revisa y captura a mano con remember.mjs lo que valga la pena.');
    } else if (records.length === 0) {
      console.log('\nNada capturable en ese rango.');
    } else {
      const rlp = createInterfaceAsync({ input: process.stdin, output: process.stdout });
      console.log(`\nRevisión interactiva: ${records.length} registro(s) candidato(s).\n`);
      let inserted = 0;
      let skipped = 0;
      const needsManualReview = [];
      let quit = false;

      for (let i = 0; i < records.length && !quit; i++) {
        const f = { ...records[i] };
        console.log(`\n[${i + 1}/${records.length}] (${f.kind}) [${f.date}]\n${f.claim}`);

        let decision = null; // 'approve' | 'skip' | null (sigue preguntando)
        while (decision === null) {
          const ans = (await rlp.question('[Enter]=aprobar  e=editar  s=saltar  q=salir > ')).trim().toLowerCase();
          if (ans === 'q') { decision = 'skip'; quit = true; }
          else if (ans === 's') { decision = 'skip'; }
          else if (ans === 'e') {
            const newClaim = (await rlp.question('Nuevo texto (Enter = dejar igual):\n> ')).trim();
            if (newClaim) f.claim = newClaim;
            const newDate = (await rlp.question(`Nueva fecha YYYY-MM-DD (Enter = dejar ${f.date}): `)).trim();
            if (newDate) f.date = newDate;
            const newKind = (await rlp.question(`Nuevo tipo fact|event|commitment (Enter = dejar ${f.kind}): `)).trim();
            if (newKind) f.kind = newKind;
            console.log(`\nActualizado: [${f.date}] (${f.kind}) ${f.claim}`);
          } else {
            decision = 'approve';
          }
        }

        if (decision === 'approve') {
          if (insertFact(f)) {
            inserted++;
          } else {
            console.log('\n(remember.mjs no insertó, queda pendiente de revisión manual, ver resumen al final)');
            needsManualReview.push(f);
          }
        } else {
          skipped++;
        }
      }

      rlp.close();
      console.log(
        `\nRevisión terminada: ${inserted} insertado(s), ${skipped} saltado(s), ${needsManualReview.length} pendiente(s) de revisión manual de ${records.length}.`,
      );
      if (needsManualReview.length > 0) {
        console.log('\nPendientes de revisión manual (duplicado ambiguo, resolver con remember.mjs a mano):');
        for (const f of needsManualReview) {
          console.log(`  - [${f.date}] (${f.kind}) ${f.claim}`);
        }
      }
    }
  }
}
