// Cambia el `kind` (fact|event|commitment) de uno o más registros ya
// existentes -- distinto de recategorize-record.mjs (que mueve un registro
// de un recuerdo a otro, nunca toca `kind`). Caso real que lo motivó
// (2026-09-06): compromisos guardados con kind='commitment' que en realidad
// describían un estado/hecho, no una acción pendiente futura -- corregidos a
// mano vía SQL directo por no existir esta herramienta. No borra ni
// retracta nada, solo corrige la etiqueta.
// Uso:
//   node set-record-kind.mjs --record 94,95,96 --kind fact --reason "describe una configuración ya aplicada, no una acción pendiente"
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

const VALID_KINDS = ['fact', 'event', 'commitment'];

const args = parseArgs(process.argv.slice(2));
const USAGE = 'Uso: node set-record-kind.mjs --record <id>[,<id>...] --kind fact|event|commitment --reason "..."';

if (!args.record || !args.kind || !args.reason) {
  console.error(USAGE);
  process.exit(1);
}

if (!VALID_KINDS.includes(args.kind)) {
  console.error(`--kind inválido: "${args.kind}". Valores permitidos: ${VALID_KINDS.join(', ')}.`);
  process.exit(1);
}

const ids = String(args.record)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n));

if (ids.length === 0) {
  console.error(`--record inválido: "${args.record}"`);
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

const { rows: targets } = await client.query(
  `select id, claim, kind, valid_until from records where id = any($1::bigint[])`,
  [ids],
);
const foundIds = new Set(targets.map((r) => Number(r.id)));
const missing = ids.filter((id) => !foundIds.has(id));
const retracted = targets.filter((r) => r.valid_until !== null);

if (missing.length > 0) {
  console.error(`No existe(n) registro(s) con id: ${missing.join(', ')}. No se cambió nada.`);
  await client.end();
  process.exit(1);
}
if (retracted.length > 0) {
  console.error(
    `${retracted.length} de los ids ya están retractados, cambiar el kind de un registro retractado no tiene efecto real: ${retracted.map((r) => `#${r.id}`).join(', ')}. No se cambió nada.`,
  );
  await client.end();
  process.exit(1);
}

const { rows: updated } = await client.query(
  `update records set kind = $2 where id = any($1::bigint[]) returning id, claim, kind`,
  [ids, args.kind],
);

for (const r of updated) {
  console.log(`#${r.id} -> kind: ${r.kind}`);
  console.log(`  ${r.claim}`);
}
console.log(`Motivo: ${args.reason}`);

await client.end();
