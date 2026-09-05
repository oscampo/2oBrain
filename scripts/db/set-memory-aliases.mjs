// Aplica alias a un recuerdo -- escritor manual, contraparte de
// list-alias-candidates.mjs (que solo propone, nunca escribe). Suma
// (unión, sin duplicados) sobre los alias existentes, nunca sobreescribe --
// mismo principio fail-closed que el resto de Etapa 6: una aprobación no
// debería poder borrar por accidente un alias que ya estaba.
//
// Chequeo de colisión (2026-09-02, a pedido del usuario): a diferencia de
// remember.mjs --create-memory (que corre memories_similar()+classify-memory.mjs
// antes de dar de alta un recuerdo), este escritor no validaba si el alias que
// se va a escribir ya es name/alias de OTRO recuerdo -- riesgo real, no
// hipotético: el backfill propuso el nombre de pila del usuario como alias
// de 3 recuerdos distintos a la vez (ej. gestion-academica-jane, preferencias-jane,
// plan-habitos-jane-2026). Si un alias colisiona con otro recuerdo, no se
// aplica nada (todo o nada, no parcial) y se lista el conflicto.
// Uso:
//   node set-memory-aliases.mjs --memory atlas-2026 --aliases "Jane Doe,jane-doe,Atlas" --reason "backfill guiado, aprobado por el usuario"
//   node set-memory-aliases.mjs --memory DB2-gestion-github --remove "Diseño Biomédico 2,DB2" --reason "..."
//
// --remove (2026-09-02): quita alias existentes en vez de sumar -- caso real
// que lo motivó: "Diseño Biomédico 2"/"DB2" eran alias de DB2-gestion-github
// (recuerdo de infraestructura GitHub) pero en la práctica esas formas genéricas
// se usan en prosa para el semestre/curso, no específicamente para su
// gestión de GitHub -- confirmado con la evidencia real: los matches de
// *-gestion-github siempre fueron por la forma técnica concatenada
// ("DisenoBiomedico-N", como aparece en rutas de repos), nunca por la forma
// genérica con espacio/tilde o la sigla sola. --remove y --aliases son
// mutuamente excluyentes -- una operación a la vez, para no mezclar semántica.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { findAliasCollisions } from './lib/check-alias-collision.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.memory || !args.reason || (!args.aliases && !args.remove) || (args.aliases && args.remove)) {
  console.error(
    'Uso:\n' +
    '  node set-memory-aliases.mjs --memory <recuerdo> --aliases "a,b,c" --reason "..."\n' +
    '  node set-memory-aliases.mjs --memory <recuerdo> --remove "a,b,c" --reason "..."\n' +
    '  (--aliases y --remove son mutuamente excluyentes)',
  );
  process.exit(1);
}

const envPath = new URL('../../.env', import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows } = await client.query(`select name, aliases, merged_into from memories where name = $1`, [args.memory]);
if (rows.length === 0) {
  console.error(`recuerdo "${args.memory}" no existe. Revisa el nombre con list-memories.mjs.`);
  await client.end();
  process.exit(1);
}
if (rows[0].merged_into) {
  console.error(`"${args.memory}" está fusionado en "${rows[0].merged_into}" -- aplica los alias al recuerdo vigente, no a este.`);
  await client.end();
  process.exit(1);
}

let merged;

if (args.remove) {
  const toRemove = new Set(args.remove.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean));
  merged = (rows[0].aliases ?? []).filter((a) => !toRemove.has(a.toLowerCase()));
} else {
  const newAliases = args.aliases.split(',').map((a) => a.trim()).filter(Boolean);

  const conflicts = await findAliasCollisions(client, args.memory, newAliases);
  if (conflicts.length > 0) {
    console.error(`Colisión -- no se aplica ningún alias. Ya pertenecen a otro recuerdo:`);
    for (const c of conflicts) console.error(`  "${c.alias}" ya es name/alias de "${c.node}"`);
    await client.end();
    process.exit(1);
  }

  merged = Array.from(new Set([...(rows[0].aliases ?? []), ...newAliases]));
}

await client.query(`update memories set aliases = $2 where name = $1`, [args.memory, merged]);

console.log(`Alias de "${args.memory}": ${merged.length ? merged.join(', ') : '(ninguno)'}`);
console.log(`Motivo: ${args.reason}`);

await client.end();
