// Hook UserPromptSubmit: detecta cuando el usuario saluda como si empezara
// el día ("buenos días", "iniciemos", "qué tenemos para hoy"...) y fuerza la
// revisión del due-job list de HEARTBEAT.md, sin depender de que Claude "se
// acuerde" ni de que una skill enrutada por un modelo reconozca la
// intención. HEARTBEAT.md, no MEMORY.md, a propósito: MEMORY.md se poda y
// reescribe activamente ("cut what no longer earns its place"), un due-job
// list es configuración estable, no memoria fluida, mezclarlo ahí lo deja
// en riesgo de desaparecer en una limpieza normal.
//
// Por qué esto y no otra cosa:
//   1. NO es un hook SessionStart: ese solo dispara en un arranque de
//      proceso nuevo (--resume/--continue/terminal nueva), nunca cuando la
//      MISMA conversación sigue abierta después de dormir -- el caso más
//      común de "empezar el día" en la práctica.
//   2. NO es un gate por tiempo transcurrido puro: volver después de varias
//      horas fuera casi siempre significa CONTINUAR una tarea, no arrancar
//      el día; un gate por tiempo solo interrumpiría con ruido.
//   3. La señal correcta es la frase/intención de arranque de día -- lo que
//      hace falta no es esa señal, es que dependa de un hook determinístico
//      (garantizado por el harness) en vez de una skill enrutada por un
//      modelo (juicio, no garantía).
//
// Cooldown por día calendario (no por hora): si ya se disparó hoy, un
// segundo saludo el mismo día no debe repetir el recordatorio.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const GREETING_PATTERN = /\b(buen[oa]s?\s*(d[ií]as?|tardes?|noches?)|hola|iniciemos|empecemos|arranquemos|comencemos|inicio de sesi[oó]n|iniciamos (la sesi[oó]n|el d[ií]a)|qu[eé]\s+(tenemos|hay)\s+(para\s+)?hoy|arrancamos)\b/i;

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0); // sin JSON válido, no bloquear nada
  }

  const prompt = payload.user_prompt ?? '';
  if (!GREETING_PATTERN.test(prompt)) {
    process.exit(0); // no parece un saludo de arranque de día, no interferir
  }

  const statePath = new URL('../../state/greeting-gate-state.local.json', import.meta.url);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};

  const today = new Date().toISOString().slice(0, 10); // fecha calendario, no hora -- el cooldown es "una vez por día"
  if (state.lastDate === today) {
    process.exit(0); // ya se disparó hoy, un segundo saludo no debe repetir el recordatorio
  }

  state.lastDate = today;
  try { writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch {}

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'allow',
      additionalContext:
        'Esto suena a arranque del día (primer saludo de hoy). Antes de responder al mensaje, revisa el ' +
        'due-job list de HEARTBEAT.md (si existe y tiene jobs habilitados) y actúa según su contrato de ' +
        'silencio -- solo entrega lo que de verdad amerite decirse, sin narrar el chequeo en sí.',
    },
  }));
  process.exit(0);
});
