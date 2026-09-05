// Reasigna un registro de un recuerdo a otro -- distinto de merge-memories.mjs (que
// mueve TODOS los registros de un recuerdo, para fusionar dos recuerdos que resultaron
// ser el mismo asunto). Este es el caso contrario: un solo registro quedó
// etiquetado con el recuerdo equivocado (ej. classify-memory.mjs se equivocó, o se
// guardó con --memory a mano sin pensarlo), el resto de los registros del recuerdo
// están bien. No borra ni retracta el registro -- solo corrige su record_memories.
// Uso:
//   node recategorize-record.mjs --record 412 --from vault-overview --to cabd-2026-2 --reason "el registro es sobre el curso CABD, no sobre el vault en general"
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

if (!args.record || !args.from || !args.to || !args.reason) {
  console.error('Uso: node recategorize-record.mjs --record <id> --from <recuerdo> --to <recuerdo> --reason "..."');
  process.exit(1);
}

const recordId = Number(args.record);
if (!Number.isInteger(recordId)) {
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

const { rows: factRows } = await client.query(`select id, claim, valid_until from records where id = $1`, [recordId]);
if (factRows.length === 0) {
  console.error(`No existe ningún registro #${recordId}.`);
  await client.end();
  process.exit(1);
}

const { rows: linkRows } = await client.query(
  `select memory_name from record_memories where record_id = $1 and memory_name = $2`,
  [recordId, args.from],
);
if (linkRows.length === 0) {
  const { rows: actual } = await client.query(`select memory_name from record_memories where record_id = $1`, [recordId]);
  console.error(`El registro #${recordId} no está ligado a "${args.from}". recuerdos actuales: ${actual.map((r) => r.memory_name).join(', ') || '(ninguno)'}`);
  await client.end();
  process.exit(1);
}

const { rows: toRows } = await client.query(`select name, merged_into from memories where name = $1`, [args.to]);
if (toRows.length === 0) {
  console.error(`recuerdo destino "${args.to}" no existe. Revisa el nombre con list-memories.mjs.`);
  await client.end();
  process.exit(1);
}
if (toRows[0].merged_into) {
  console.error(`"${args.to}" está fusionado en "${toRows[0].merged_into}" -- reasigna al recuerdo vigente, no a este.`);
  await client.end();
  process.exit(1);
}

await client.query(`delete from record_memories where record_id = $1 and memory_name = $2`, [recordId, args.from]);
await client.query(
  `insert into record_memories (record_id, memory_name) values ($1, $2) on conflict do nothing`,
  [recordId, args.to],
);

console.log(`registro #${recordId} reasignado: "${args.from}" -> "${args.to}"`);
console.log(`  ${factRows[0].claim}`);
console.log(`Motivo: ${args.reason}`);

await client.end();
