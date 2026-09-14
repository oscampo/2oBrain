// Hook Stop de Claude Code: fuerza una revisión periódica antes de concluir
// un turno, para que la captura de registros (segundo cerebro) no dependa solo
// de que se me ocurra hacerlo en el momento. No reemplaza el juicio de qué
// es capturable (esa es la vía principal, ver MEMORY.md: captura proactiva
// durante la conversación): esto es solo la red de seguridad de respaldo.
//
// Corrección 2026-08-26 (ver registro #153/#154): la versión original solo
// usaba `stop_hook_active` (evita el loop infinito DENTRO de un mismo
// intento de cierre), pero no persistía nada entre turnos: en la práctica
// bloqueaba en CADA cierre de turno, no una vez por sesión como decía el
// comentario original.
//
// Segunda corrección, mismo día: la primera versión de este fix pasó a
// "una vez por sesión para siempre" (guardaba session_id y nunca volvía a
// bloquear). Eso se gasta en el primer cierre de turno de la sesión, a
// menudo al principio, cuando todavía no hay nada que capturar, y queda
// mudo el resto de una sesión larga, sin red de seguridad real. Fix:
// cooldown por tiempo, no one-shot.
//
// Tercer ajuste, mismo día (el usuario, ver registro #155): mecanismo principal de
// captura pasa a ser manual/proactivo (pedir "guarda este registro" o "genera
// lista de records" al cierre de una sesión de trabajo real, mismo patrón que
// ya usa en Chat/Cowork donde este hook nunca existió), por ser más barato
// que forzar revisiones periódicas. Este hook queda solo como respaldo poco
// frecuente, no como mecanismo principal.
//
// Rediseño 2026-09-06 ("niveles de proactividad", decisión de Oscar): el
// cooldown por TIEMPO (2h) se reemplaza por un contador de TURNOS. Motivo
// real, no teórico: en una sesión de trabajo denso (varios commits/decisiones
// en poco tiempo real) el cooldown de 2h no vuelve a dispararse aunque pase
// muchísimo, mientras que una sesión inactiva sí lo consumía sin que hubiera
// nada nuevo que capturar. Un contador de turnos es más fiel a "cuánto avanzó
// la conversación" que el reloj, y es agnóstico de dominio a propósito: contar
// commits de git habría sesgado el mecanismo a sesiones de código, sin
// generalizar a una sesión sobre hábitos de ejercicio o la planeación de un
// campamento (2oBrain sirve para eso también). Límite conocido y aceptado:
// el hook `Stop` dispara una vez por turno EXTERNO completo, sin importar
// cuántas llamadas a herramientas ocurran adentro -- una sesión con pocos
// turnos pero cada uno enorme sigue pudiendo subestimarse. No hay ajuste
// para eso sin sesgar a un dominio, se acepta como límite del respaldo, el
// mecanismo principal sigue siendo el juicio proactivo.
//
// Segundo eje, independiente del nivel: SILENT. Mismo "contrato de silencio"
// que ya rige los jobs de HEARTBEAT.md (ambient-delta, brain-hygiene: "trabaja
// en silencio, escribe a memoria, quédate callado"), aplicado acá: si es
// true, el chequeo sigue ocurriendo con la misma cadencia, pero no narra nada
// si no hay nada que guardar, y si sí se guarda algo, la única señal visible
// es un 🧠 al inicio de la siguiente respuesta normal al usuario -- un
// testigo de que el sistema sigue trabajando, no una explicación aparte.
//
// Extracción automática (2026-09-14, portado desde D:\UAObrain, ver
// projects/segundo-cerebro.md Etapa 18): hasta acá, el "LLM extrayendo
// candidatos" del plan original siempre fue Claude mismo, en el momento, sin
// red de seguridad más allá de este recordatorio -- si el agente no nota
// algo capturable, nunca se guarda. Se cierra reutilizando
// extract-records.mjs (ya existía, uso manual), ahora disparado por este
// mismo hook, en segundo plano, sobre la ventana de turnos desde la última
// extracción.
//
// No se llama en línea (bloqueante): probado en vivo en UAObrain que
// nemotron-3-ultra:cloud y gpt-oss:20b-cloud abortan consistentemente a los
// 120s contra una sesión real -- bloquear el cierre de turno ese tiempo cada
// N turnos habría sido inaceptable. En vez de eso: se lanza un proceso hijo
// *desacoplado* (spawn detached + unref, stdout redirigido a un archivo de
// estado) que sigue corriendo aunque este hook ya haya terminado; el
// resultado se recoge en el SIGUIENTE disparo del hook, nunca en el mismo.
// Ollama (gratis) en vez de Gemini, a propósito, para no sumar otro
// proveedor de pago a un mecanismo que corre solo, sin que nadie lo pida.
// Modelo usado: el configurado para el grupo "extraction" en
// config/task-models.json -- en UAObrain se cambió a gemma4:31b-cloud tras
// el hallazgo de los timeouts, replicar ese cambio ahí si aplica al mismo
// entorno de Ollama Cloud de esta instalación.
//
// Sigue sin reemplazar el juicio de qué es capturable: los candidatos que
// devuelve la extracción se muestran para que el agente decida qué insertar
// con remember.mjs (mismo criterio fail-closed que el resto del sistema),
// nunca se insertan solos.
import { readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Configuración: ajustar acá directamente (mismo patrón que ya usaba
// COOLDOWN_MS), no hace falta un archivo de config aparte para una
// preferencia de una sola persona/máquina. La Fase 5/9 de la instalación
// preguntan por esto y editan estas dos constantes con la respuesta real. ---
const LEVEL = 2; // 4 = cada turno · 3 = cada 5 · 2 = cada 10 · 1 = cada 20 (para nivel 0, desengancha este hook en settings, no cambies este número)
const SILENT = false; // true = solo testigo (N🧠) con el conteo si hubo captura · false = explicación completa
const LEVEL_TURNS = { 4: 1, 3: 5, 2: 10, 1: 20 };
const TRIGGER_EVERY = LEVEL_TURNS[LEVEL];

// Ventana mínima real antes de molestarse en lanzar una extracción: evita
// disparar sobre unos pocos segundos de conversación (candidatos vacíos casi
// seguro) cada vez que el conteo de turnos cae justo en el múltiplo de
// TRIGGER_EVERY al inicio de una sesión.
const MIN_WINDOW_MS = 45_000;
// Si un job en segundo plano lleva más de esto sin producir un archivo con
// el marcador de "terminado", se asume perdido (falla de red, proceso
// matado junto con la sesión) y se permite reintentar en el próximo disparo,
// en vez de quedar bloqueado esperando un resultado que nunca llega.
const INFLIGHT_STALE_MS = 5 * 60_000;
const DONE_MARKER = 'Esto NO se insertó en la base.';

const statePath = new URL('../../state/stop-capture-state.local.json', import.meta.url);
const EXTRACT_SCRIPT = fileURLToPath(new URL('../db/extract-records.mjs', import.meta.url));

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    writeFileSync(statePath, JSON.stringify(state));
  } catch {}
}

function pendingFilePath(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return fileURLToPath(new URL(`../../state/pending-extraction-${safe}.local.txt`, import.meta.url));
}

// Mismo tipo de conversión que ya usa extract-records.mjs (offset fijo desde
// UTC), pero calculada con Intl contra la zona real en vez de un offset
// numérico a mano, para no depender de qué TZ tenga configurado el SO (ver
// la advertencia ya documentada en HEARTBEAT.md sobre Git Bash y TZ=).
function bogotaParts(isoString) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(isoString)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}` };
}

// Lanza extract-records.mjs desacoplado de este proceso (detached + unref):
// este hook puede terminar y Claude Code puede cerrar el turno mientras el
// hijo sigue corriendo, el resultado se recoge en un disparo futuro.
function kickoffExtraction(sessionId, fromIso, toIso, outPath) {
  const fromParts = bogotaParts(fromIso);
  const toParts = bogotaParts(toIso);
  // Ventana que cruza medianoche local: aproximación aceptada (extender
  // hasta 00:00 del día de cierre), no vale la pena el código extra para un
  // caso raro en un respaldo, no en el mecanismo principal.
  const date = toParts.date;
  const from = fromParts.date === toParts.date ? fromParts.hhmm : '00:00';
  let fd;
  try {
    fd = openSync(outPath, 'w');
  } catch {
    return false;
  }
  try {
    const child = spawn(
      process.execPath,
      [EXTRACT_SCRIPT, '--date', date, '--from', from, '--to', toParts.hhmm, '--session', sessionId, '--provider', 'ollama'],
      { detached: true, stdio: ['ignore', fd, 'ignore'] },
    );
    child.unref();
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// Lee un resultado ya terminado (si lo hay) y lo convierte en líneas "- [fecha] (tipo) texto"
// listas para mostrar, o null si el archivo no existe o el job todavía no terminó.
function readCompletedCandidates(outPath) {
  if (!existsSync(outPath)) return null;
  let content;
  try {
    content = readFileSync(outPath, 'utf8');
  } catch {
    return null;
  }
  if (!content.includes(DONE_MARKER)) return null; // sigue corriendo, o terminó en error sin llegar a imprimir esto
  const lines = content.split(/\r?\n/).filter((l) => l.startsWith('- ['));
  return lines; // puede ser [] si el modelo no encontró nada capturable, sigue siendo un resultado válido
}

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {
    // Sin JSON válido en stdin, se asume primera pasada.
  }

  if (payload.stop_hook_active) {
    // Segundo intento de cierre del MISMO turno externo (evita el loop
    // infinito) -- no es un turno nuevo, no cuenta ni vuelve a bloquear.
    process.exit(0);
  }

  const nowIso = new Date().toISOString();
  const state = readState();
  const sameSession = state.session_id === payload.session_id;
  const turnCount = (sameSession ? state.turn_count ?? 0 : 0) + 1;
  const lastTriggeredAt = sameSession ? state.last_triggered_at ?? 0 : 0;
  const due = turnCount - lastTriggeredAt >= TRIGGER_EVERY;

  const sessionStartedAt = sameSession ? state.session_started_at ?? nowIso : nowIso;
  let lastExtractedTo = sameSession ? state.last_extracted_to ?? null : null;
  let extractionInflightSince = sameSession ? state.extraction_inflight_since ?? null : null;

  const newState = {
    session_id: payload.session_id,
    turn_count: turnCount,
    last_triggered_at: due ? turnCount : lastTriggeredAt,
    session_started_at: sessionStartedAt,
    last_extracted_to: lastExtractedTo,
    extraction_inflight_since: extractionInflightSince,
  };

  if (!due) {
    writeState(newState);
    process.exit(0);
  }

  let extractedLines = null;
  if (payload.session_id) {
    const outPath = pendingFilePath(payload.session_id);

    // 1. Recoger un resultado previo si ya terminó.
    extractedLines = readCompletedCandidates(outPath);
    const stillInflight =
      extractionInflightSince &&
      new Date(nowIso) - new Date(extractionInflightSince) < INFLIGHT_STALE_MS &&
      extractedLines === null;

    if (extractedLines !== null) {
      // Resultado consumido: libera el cupo para un próximo job.
      extractionInflightSince = null;
    }

    // 2. Lanzar la siguiente ventana, si no hay una en vuelo y hay suficiente
    // conversación nueva desde la última vez.
    const windowStart = lastExtractedTo ?? sessionStartedAt;
    const windowMs = new Date(nowIso) - new Date(windowStart);
    if (!stillInflight && windowMs >= MIN_WINDOW_MS) {
      const launched = kickoffExtraction(payload.session_id, windowStart, nowIso, outPath);
      if (launched) {
        extractionInflightSince = nowIso;
        lastExtractedTo = nowIso;
      }
    }
  }

  newState.last_extracted_to = lastExtractedTo;
  newState.extraction_inflight_since = extractionInflightSince;
  writeState(newState);

  const candidateBlock =
    extractedLines === null
      ? ''
      : extractedLines.length === 0
        ? '\n\nExtracción automática en segundo plano (ventana anterior): sin candidatos.'
        : `\n\nExtracción automática en segundo plano (ventana anterior) encontró estos candidatos, independiente de lo que ya se haya notado -- decide cuáles guardar, no asumas que ya están guardados:\n${extractedLines.join('\n')}`;

  const reason = SILENT
    ? 'Antes de cerrar el turno: revisa en silencio si hubo algo capturable en esta conversación ' +
      '(una decisión cerrada, una corrección, un registro con fecha). Guarda cada uno con ' +
      'node scripts/db/remember.mjs --claim "..." --date YYYY-MM-DD --source "..." sin narrar la revisión ' +
      'aparte, y cuenta cuántos registros guardaste de verdad en total (incluyendo los que vengan del bloque ' +
      'de extracción automática de abajo, si hay). Si guardaste alguno, antepón ' +
      '"(N🧠) " -- con N reemplazado por ese número exacto -- al inicio de tu próxima respuesta normal al ' +
      'usuario, esa es la única señal, nada más. Si no guardaste ninguno, no antepongas nada ni digas ' +
      'nada de esto, continúa normal.' + candidateBlock
    : 'Antes de cerrar el turno: revisa esta conversación. Si hubo una decisión cerrada, ' +
      'una corrección, o un registro con fecha que valga la pena recordar, captúralo ' +
      'ahora con node scripts/db/remember.mjs --claim "..." --date YYYY-MM-DD ' +
      '--source "..." (agrega --memory nombre-de-recuerdo si aplica, ver scripts/db/list-memories.mjs; ' +
      '--create-memory si es genuinamente nuevo). ' +
      'Si no hay nada capturable, dilo explícitamente y continúa.' + candidateBlock;

  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
});
