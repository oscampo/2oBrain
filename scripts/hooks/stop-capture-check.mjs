// Hook Stop de Claude Code: fuerza una revisión periódica antes de concluir
// un turno, para que la captura de hechos (segundo cerebro) no dependa solo
// de que se me ocurra hacerlo en el momento. No reemplaza el juicio de qué
// es capturable (esa es la vía principal, ver MEMORY.md: captura proactiva
// durante la conversación): esto es solo la red de seguridad de respaldo.
//
// Corrección 2026-08-26 (ver hecho #153/#154): la versión original solo
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
// cooldown por tiempo, no one-shot. `state/stop-capture-state.local.json`
// guarda `session_id` + `reviewed_at`; si la misma sesión revisó hace menos
// de COOLDOWN_MS, no vuelve a bloquear; si ya pasó ese tiempo, vuelve a
// bloquear una vez más. Sigue sin cubrir el cierre abrupto de sesión
// (conexión caída, terminal cerrada a la fuerza).
//
// Tercer ajuste, mismo día (el usuario, ver hecho #155): mecanismo principal de
// captura pasa a ser manual/proactivo (pedir "guarda este hecho" o "genera
// lista de facts" al cierre de una sesión de trabajo real, mismo patrón que
// ya usa en Chat/Cowork donde este hook nunca existió), por ser más barato
// que forzar revisiones periódicas. Este hook queda solo como respaldo poco
// frecuente, no como mecanismo principal: de ahí el cooldown largo (2h en
// vez de 20min).
import { readFileSync, writeFileSync } from 'node:fs';

const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 horas, respaldo, no mecanismo principal (ver MEMORY.md / #153-#155)

const statePath = new URL('../../state/stop-capture-state.local.json', import.meta.url);

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function markReviewed(sessionId) {
  try {
    writeFileSync(statePath, JSON.stringify({ session_id: sessionId, reviewed_at: new Date().toISOString() }));
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

  const state = readState();
  const sameSession = state.session_id === payload.session_id;
  const withinCooldown = sameSession && Date.now() - Date.parse(state.reviewed_at ?? 0) < COOLDOWN_MS;

  if (withinCooldown || payload.stop_hook_active) {
    markReviewed(payload.session_id);
    process.exit(0);
  }

  const reason =
    'Antes de cerrar el turno: revisa esta conversación. Si hubo una decisión cerrada, ' +
    'una corrección, o un hecho con fecha que valga la pena recordar, captúralo ' +
    'ahora con node scripts/db/remember.mjs --claim "..." --date YYYY-MM-DD ' +
    '--source "..." (agrega --node nombre-de-nodo si aplica, ver scripts/db/list-nodes.mjs; ' +
    '--create-node si es genuinamente nuevo). ' +
    'Si no hay nada capturable, dilo explícitamente y continúa.';

  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
});
