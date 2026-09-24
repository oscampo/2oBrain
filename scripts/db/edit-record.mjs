// Edita directamente cualquier campo de un registro ya existente: claim,
// date, kind, source, memory(s). Distinto de las herramientas puntuales que
// ya existían (set-record-kind.mjs solo kind, recategorize-record.mjs solo
// un recuerdo a la vez) -- esta es la "super gestión" pedida por Oscar para
// correcciones directas (typo en claim/source, fecha mal capturada) sin
// tener que retractar y volver a insertar. No bloquea sobre registros
// retractados (a propósito: corregir un dato histórico sigue siendo válido
// aunque el registro ya no esté vigente).
//
// Si --claim cambia, se recalcula el embedding (imprescindible: search.mjs/
// records_similar/records_search comparan contra el texto vigente, dejar el
// embedding viejo desalinearía cualquier búsqueda o chequeo de duplicados
// futuro).
//
// --memory reemplaza la lista COMPLETA de recuerdos ligados a este registro
// (no agrega, sustituye) -- se muestra el antes/después en la salida para
// que quede claro qué se quitó y qué se agregó antes de confirmar en el
// dashboard. Cada nombre se resuelve seleccionando el vigente (sigue
// merged_into); si alguno no existe, se niega salvo --create-memory (mismo
// criterio que remember.mjs).
//
// Uso:
//   node edit-record.mjs --id 412 --claim "texto corregido" --reason "typo en la fecha del evento"
//   node edit-record.mjs --id 412 --date 2026-08-30 --source "corrección: fuente real era el correo, no la sesión" --reason "..."
//   node edit-record.mjs --id 412 --memory recuerdo-a,recuerdo-b [--create-memory] --reason "..."
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral } from './lib/embed.mjs';
import { resolveLiveMemory, createLink } from './lib/create-link.mjs';
import { classifyMentionRelationHybrid } from './lib/classify-mention-relation.mjs';
import { formatFactsBlock } from './lib/format-records.mjs';

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
const USAGE =
  'Uso: node edit-record.mjs --id <id> [--claim "..."] [--date YYYY-MM-DD] [--kind fact|event|commitment] ' +
  '[--source "..."] [--memory recuerdo1,recuerdo2 [--create-memory]] --reason "..."';

if (!args.id || !args.reason) {
  console.error(USAGE);
  process.exit(1);
}
const editable = ['claim', 'date', 'kind', 'source', 'memory'];
if (!editable.some((k) => args[k] !== undefined)) {
  console.error('No pasaste ningún campo para editar (claim/date/kind/source/memory).\n' + USAGE);
  process.exit(1);
}

const id = Number(args.id);
if (!Number.isInteger(id)) {
  console.error(`--id inválido: "${args.id}"`);
  process.exit(1);
}
if (args.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
  console.error(`--date inválida: "${args.date}". Debe ser YYYY-MM-DD.`);
  process.exit(1);
}
if (args.kind !== undefined && !VALID_KINDS.includes(args.kind)) {
  console.error(`--kind inválido: "${args.kind}". Valores permitidos: ${VALID_KINDS.join(', ')}.`);
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

const { rows: before } = await client.query(`select id, claim, date, kind, source, valid_until from records where id = $1`, [id]);
if (before.length === 0) {
  console.error(`No existe ningún registro #${id}.`);
  await client.end();
  process.exit(1);
}
const { rows: beforeMemRows } = await client.query(`select memory_name from record_memories where record_id = $1 order by memory_name`, [id]);
const beforeMemories = beforeMemRows.map((r) => r.memory_name);

let requestedMemories = null;
if (args.memory !== undefined) {
  requestedMemories = String(args.memory).split(',').map((s) => s.trim()).filter(Boolean);
  const resolved = [];
  for (const name of requestedMemories) {
    const result = await resolveLiveMemory(client, name);
    if (result.ok) {
      resolved.push(result.name);
      continue;
    }
    if (!args['create-memory']) {
      console.error(`${result.error} Pasa --create-memory si "${name}" es genuinamente nuevo, o revisa el nombre con list-memories.mjs.`);
      await client.end();
      process.exit(1);
    }
    await client.query(`insert into memories (name) values ($1) on conflict (name) do nothing`, [name]);
    resolved.push(name);
  }
  requestedMemories = resolved;
}

const sets = [];
const values = [];
let paramIdx = 1;

if (args.claim !== undefined) {
  const embedding = await embed(args.claim, 'document');
  sets.push(`claim = $${paramIdx++}`); values.push(args.claim);
  sets.push(`embedding = $${paramIdx++}`); values.push(toVectorLiteral(embedding));
}
if (args.date !== undefined) { sets.push(`date = $${paramIdx++}`); values.push(args.date); }
if (args.kind !== undefined) { sets.push(`kind = $${paramIdx++}`); values.push(args.kind); }
if (args.source !== undefined) { sets.push(`source = $${paramIdx++}`); values.push(args.source); }

if (sets.length > 0) {
  values.push(id);
  await client.query(`update records set ${sets.join(', ')} where id = $${paramIdx}`, values);
}

if (requestedMemories !== null) {
  await client.query(`delete from record_memories where record_id = $1`, [id]);
  if (requestedMemories.length > 0) {
    await client.query(
      `insert into record_memories (record_id, memory_name) select $1, unnest($2::text[]) on conflict do nothing`,
      [id, requestedMemories],
    );
  }
}

const { rows: after } = await client.query(`select id, claim, date, kind, source, valid_until from records where id = $1`, [id]);
const { rows: afterMemRows } = await client.query(`select memory_name from record_memories where record_id = $1 order by memory_name`, [id]);
const afterMemories = afterMemRows.map((r) => r.memory_name);

// Auto-enlace entre recuerdos co-etiquetados (2026-09-24, portado desde
// D:\MyBrain, mismo mecanismo que remember.mjs/remember-batch.mjs/MCP -- ver
// comentario allá): faltaba acá, editar --memory por el dashboard (este
// mismo script) nunca disparaba la creación automática de memory_links, a
// diferencia de capturar un registro nuevo con varios recuerdos a la vez.
// Caso real: #1174/#1175 (D:\MyBrain) editados por Oscar vía dashboard
// agregando "proyectos-personales" a la lista de recuerdos, asumiendo que
// guardar bastaba para conectar el nodo en el grafo -- no bastaba, el
// enlace nunca se creó hasta corregirlo a mano. Mismo criterio: solo pares
// que faltan, relación nombrada por el clasificador con fallback a
// "co-registrado_en".
const linkAdvisories = [];
if (requestedMemories !== null && afterMemories.length > 1) {
  for (let i = 0; i < afterMemories.length; i++) {
    for (let j = i + 1; j < afterMemories.length; j++) {
      const from = afterMemories[i];
      const to = afterMemories[j];
      const { rows: existingLink } = await client.query(
        `select 1 from memory_links where (from_memory, to_memory) in (($1, $2), ($2, $1)) limit 1`,
        [from, to],
      );
      if (existingLink.length > 0) continue;

      const { rows: bFactRows } = await client.query(`select * from records_timeline($1, $2, false)`, [to, 1000]);
      const judged = await classifyMentionRelationHybrid(after[0].claim, from, to, formatFactsBlock(bFactRows));
      const relation = judged?.relation || 'co-registrado_en';
      const reasonTag = judged?.relation
        ? `[auto-creado por co-etiquetado explícito vía edit-record.mjs (${judged.via}), confianza ${judged.confidence.toFixed(2)}]: ${judged.reasoning} (registro #${id})`
        : `[auto-creado por co-etiquetado explícito vía edit-record.mjs, sin clasificar] (registro #${id})`;

      const edgeResult = await createLink(client, from, to, relation, reasonTag, after[0].date.toISOString().slice(0, 10));
      if (edgeResult.ok) linkAdvisories.push(`(enlace auto-creado: ${edgeResult.fromMemory} -> ${edgeResult.toMemory} (${edgeResult.relation}))`);
    }
  }
}

console.log(`Registro #${id} editado${before[0].valid_until ? ' (estaba retractado, sigue retractado)' : ''}:`);
if (args.claim !== undefined) console.log(`  claim:   "${before[0].claim}"\n       ->  "${after[0].claim}"`);
if (args.date !== undefined) console.log(`  date:    ${before[0].date.toISOString().slice(0, 10)} -> ${after[0].date.toISOString().slice(0, 10)}`);
if (args.kind !== undefined) console.log(`  kind:    ${before[0].kind} -> ${after[0].kind}`);
if (args.source !== undefined) console.log(`  source:  "${before[0].source}"\n       ->  "${after[0].source}"`);
if (requestedMemories !== null) console.log(`  memory:  ${beforeMemories.join(', ') || '(ninguno)'} -> ${afterMemories.join(', ') || '(ninguno)'}`);
for (const advisory of linkAdvisories) console.log(advisory);
console.log(`Motivo: ${args.reason}`);

await client.end();
