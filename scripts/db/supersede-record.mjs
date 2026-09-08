// Marca un registro YA EXISTENTE como reemplazado por otro registro YA
// EXISTENTE -- distinto de `remember.mjs --supersedes` (que aplica al
// insertar un registro nuevo) y de `forget.mjs` (que retracta sin apuntar
// a un reemplazo). Este cubre el caso de descubrir DESPUÉS del hecho que
// dos registros que ya están en la base tienen esa relación: por ejemplo,
// un compromiso que quedó resuelto por un registro posterior que nadie
// cruzó en su momento. Esta es la pieza que le falta al respaldo diario de
// commitments-check en HEARTBEAT.md para poder actuar sobre lo que
// detecte, no solo reportarlo.
//
// No borra ni cambia `kind` -- el registro viejo conserva su etiqueta
// original (si era 'commitment', sigue diciendo que fue un compromiso,
// ahora cerrado), la trazabilidad completa queda en `superseded_by` y es
// justo lo que la vista "Ver evolución" del Timeline ya sabe visualizar.
//
// Uso:
//   node supersede-record.mjs --old 513 --new 637 --reason "el trámite ya quedó radicado"
import { readFileSync } from 'node:fs';
import pg from 'pg';

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
const USAGE = 'Uso: node supersede-record.mjs --old <id> --new <id> --reason "..."';

if (!args.old || !args.new || !args.reason) {
  console.error(USAGE);
  process.exit(1);
}

const oldId = Number(args.old);
const newId = Number(args.new);
if (!Number.isInteger(oldId) || !Number.isInteger(newId)) {
  console.error(`--old/--new inválidos: "${args.old}" / "${args.new}"`);
  process.exit(1);
}
if (oldId === newId) {
  console.error('--old y --new no pueden ser el mismo registro.');
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

const { rows } = await client.query(`select id, claim, kind, valid_until, superseded_by from records where id = any($1::bigint[])`, [[oldId, newId]]);
const byId = new Map(rows.map((r) => [Number(r.id), r]));

const oldRow = byId.get(oldId);
const newRow = byId.get(newId);
if (!oldRow) { console.error(`No existe ningún registro #${oldId} (--old).`); await client.end(); process.exit(1); }
if (!newRow) { console.error(`No existe ningún registro #${newId} (--new).`); await client.end(); process.exit(1); }
if (newRow.valid_until) {
  console.error(`#${newId} (--new) ya está retractado/reemplazado, no puede ser el reemplazo de otro registro.`);
  await client.end();
  process.exit(1);
}
if (oldRow.valid_until) {
  console.error(`#${oldId} (--old) ya está retractado/reemplazado (por #${oldRow.superseded_by ?? '?'}), no se puede reasignar. Revisa si de verdad quieres cambiar esa relación.`);
  await client.end();
  process.exit(1);
}

await client.query(
  `update records set valid_until = now(), superseded_by = $2::bigint,
     source = source || ' [SUPERSEDIDO ' || to_char(now(), 'YYYY-MM-DD') || ' por #' || $4 || ': ' || $3 || ']'
   where id = $1`,
  [oldId, newId, args.reason, String(newId)],
);

console.log(`#${oldId} [${oldRow.kind}] marcado como reemplazado por #${newId}.`);
console.log(`  #${oldId}: ${oldRow.claim}`);
console.log(`  #${newId}: ${newRow.claim}`);
console.log(`Motivo: ${args.reason}`);

await client.end();
