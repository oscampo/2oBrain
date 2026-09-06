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
import { readFileSync, writeFileSync } from 'node:fs';

// --- Configuración: ajustar acá directamente (mismo patrón que ya usaba
// COOLDOWN_MS), no hace falta un archivo de config aparte para una
// preferencia de una sola persona/máquina. La Fase 5/9 de la instalación
// preguntan por esto y editan estas dos constantes con la respuesta real. ---
const LEVEL = 2; // 4 = cada turno · 3 = cada 5 · 2 = cada 10 · 1 = cada 20 (para nivel 0, desengancha este hook en settings, no cambies este número)
const SILENT = false; // true = solo testigo 🧠 si hubo captura · false = explicación completa (como hasta ahora)
const LEVEL_TURNS = { 4: 1, 3: 5, 2: 10, 1: 20 };
const TRIGGER_EVERY = LEVEL_TURNS[LEVEL];

const statePath = new URL('../../state/stop-capture-state.local.json', import.meta.url);

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

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
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

  const state = readState();
  const sameSession = state.session_id === payload.session_id;
  const turnCount = (sameSession ? state.turn_count ?? 0 : 0) + 1;
  const lastTriggeredAt = sameSession ? state.last_triggered_at ?? 0 : 0;
  const due = turnCount - lastTriggeredAt >= TRIGGER_EVERY;

  writeState({
    session_id: payload.session_id,
    turn_count: turnCount,
    last_triggered_at: due ? turnCount : lastTriggeredAt,
  });

  if (!due) process.exit(0);

  const reason = SILENT
    ? 'Antes de cerrar el turno: revisa en silencio si hubo algo capturable en esta conversación ' +
      '(una decisión cerrada, una corrección, un registro con fecha). Si sí, guárdalo con ' +
      'node scripts/db/remember.mjs --claim "..." --date YYYY-MM-DD --source "..." sin narrar la revisión ' +
      'aparte, y antepón "🧠 " al inicio de tu próxima respuesta normal al usuario -- esa es la única señal, ' +
      'nada más. Si no hay nada capturable, no digas nada de esto, continúa normal.'
    : 'Antes de cerrar el turno: revisa esta conversación. Si hubo una decisión cerrada, ' +
      'una corrección, o un registro con fecha que valga la pena recordar, captúralo ' +
      'ahora con node scripts/db/remember.mjs --claim "..." --date YYYY-MM-DD ' +
      '--source "..." (agrega --memory nombre-de-recuerdo si aplica, ver scripts/db/list-memories.mjs; ' +
      '--create-memory si es genuinamente nuevo). ' +
      'Si no hay nada capturable, dilo explícitamente y continúa.';

  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
});
