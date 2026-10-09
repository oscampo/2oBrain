// Propone padre para recuerdos que existen pero no tienen lugar en la jerarquía
// pertenece_a (flujo "nombre, padre"). Cada uno recibe los tres padres
// candidatos de más a menos probable (lib/propose-parent.mjs); con --queue quedan como
// propuestas pendientes en parent_proposals para que el usuario las acepte con
// `garden.mjs --parent-proposal <id> accept [padre]` o desde el dashboard. Nunca crea
// enlaces por su cuenta.
//
// Por defecto SOLO muestra (no escribe nada en la base). Acierto medido de este método:
// ~50% top-1 y ~75-80% top-3 con el nombre oculto, ~80% y ~94% con el nombre visible
// por eso se muestran tres candidatos.
//
// Uso:
//   node propose-parents.mjs                      recuerdos fuera de toda jerarquía (vista previa)
//   node propose-parents.mjs --memory a,b         solo esos recuerdos
//   node propose-parents.mjs --queue              además deja las propuestas pendientes
//   node propose-parents.mjs --exclude usuario,x  recuerdos que no deben ubicarse (default: usuario)
//   node propose-parents.mjs --limit 5
//
// "Fuera de toda jerarquía": ni hijo ni padre en ningún enlace pertenece_a. `usuario`
// queda excluido por defecto a propósito (decisión de diseño): tiene demasiados
// registros y no debe colgar de nada.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { proposeParents, parentProposerEnabled } from './lib/propose-parent.mjs';

const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const queue = args.includes('--queue');
const only = opt('--memory', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const exclude = new Set((opt('--exclude', 'usuario') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const limit = Number(opt('--limit', 0)) || Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!parentProposerEnabled) { console.error('El clasificador no está disponible (falta la clave del proveedor).'); process.exit(1); }

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows: mems } = await client.query(`select name, aliases, is_meta from memories where merged_into is null`);
const { rows: edges } = await client.query(`select from_memory c, to_memory p from memory_links where relation = 'pertenece_a'`);
const { rows: pend } = await client.query(`select memory_name from parent_proposals where status = 'pending'`);
const inHierarchy = new Set(edges.flatMap((e) => [e.c, e.p]));
const pending = new Set(pend.map((p) => p.memory_name));

let targets;
if (only) {
  const known = new Set(mems.map((m) => m.name));
  const missing = only.filter((n) => !known.has(n));
  if (missing.length) { console.error(`No existen como recuerdo vigente: ${missing.join(', ')}`); await client.end(); process.exit(1); }
  targets = mems.filter((m) => only.includes(m.name));
} else {
  targets = mems.filter((m) => !m.is_meta && !inHierarchy.has(m.name) && !exclude.has(m.name));
}
const omitidos = targets.filter((m) => pending.has(m.name));
targets = targets.filter((m) => !pending.has(m.name)).slice(0, limit);
console.log(`Recuerdos a ubicar: ${targets.length}${omitidos.length ? ` (ya tienen propuesta pendiente: ${omitidos.map((m) => m.name).join(', ')})` : ''}${queue ? '' : ' [vista previa, sin escribir; usa --queue para dejarlas pendientes]'}\n`);

let guardadas = 0;
for (const m of targets) {
  const { rows: recs } = await client.query(
    `select r.claim from records r join record_memories rm on rm.record_id = r.id where rm.memory_name = $1 and r.valid_until is null order by r.id desc limit 12`,
    [m.name],
  );
  const res = await proposeParents(client, { name: m.name, aliases: m.aliases ?? [], claims: recs.map((r) => r.claim) });
  if (!res) { console.log(`${m.name} (${recs.length} reg): sin propuesta\n`); continue; }
  console.log(`${m.name} (${recs.length} reg)`);
  res.candidates.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));
  console.log(`   razón: ${res.reasoning}\n`);
  if (queue) {
    await client.query(
      `insert into parent_proposals (memory_name, is_new, candidates, reasoning, model) values ($1, false, $2::jsonb, $3, $4)
       on conflict (memory_name) where status = 'pending' do nothing`,
      [m.name, JSON.stringify(res.candidates.map((p) => ({ parent: p }))), res.reasoning, res.model],
    );
    guardadas++;
  }
  await sleep(600);
}
if (queue) console.log(`Propuestas pendientes creadas: ${guardadas}. Para decidir: node garden.mjs --parent-proposals`);
await client.end();
