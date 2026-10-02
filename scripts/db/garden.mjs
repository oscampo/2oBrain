// Jardineria de etiquetas: revision de CALIDAD de las etiquetas de los registros recientes.
// Herramienta de revision, no de automatizacion (mismo principio que list-merge-candidates.mjs): nunca
// cambia etiquetas (para eso esta recategorize-record.mjs); lo unico que escribe es record_reviews, el
// cursor de "ya lo revise" y conjunto de referencia verificado.
//
// Dos fuentes de items, ambas deterministas:
//   --sample   muestreo al azar de registros de extraccion automatica sin revision. No detecta nada por
//              si mismo: mide la tasa REAL de error del etiquetado cuando el usuario confirma o corrige.
//   (defecto)  senales de texto sobre los registros recientes sin revisar:
//                paraguas  solo tiene recuerdos paraguas, no dice de que asunto concreto trata
//                mencion   el texto nombra literalmente a otro recuerdo (nombre o alias) que no tiene
//                chico     alguno de sus recuerdos tiene 2 registros o menos (candidato a recuerdo suelto)
//              (se descarto "atipico por embeddings": no separa recuerdos de vocabulario parecido,
//              en una prueba con 25 etiquetas erroneas conocidas acerto 3, practicamente azar)
//
// Uso:
//   node garden.mjs --sample [N] [--since D]    N registros (3) de los ultimos D dias (3), sin revisar
//   node garden.mjs [--since D] [--limit N]     senales de texto (D=1, N=5)
//   node garden.mjs --verdict <id> ok|corrected [--note "..."]
//   node garden.mjs --stats
//   node garden.mjs --volume D                  items con senal de texto por dia, ultimos D dias
//   --json en --sample, --stats o el modo por defecto: salida JSON (la usa el dashboard)
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { detectNodeMentions } from './lib/detect-memory-mentions.mjs';

// Recuerdos paraguas (muy amplios: no dicen de que asunto trata un registro). Cada instalacion
// pone aqui los suyos; vacio = la senal "paraguas" no se usa.
const UMBRELLA = new Set([]);

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const asJson = args.includes('--json');
const short = (t, n = 150) => t.replace(/\s+/g, ' ').slice(0, n);

const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const done = async (code = 0) => { await c.end(); process.exit(code); };

if (args.includes('--verdict')) {
  const i = args.indexOf('--verdict'); const id = Number(args[i + 1]); const verdict = args[i + 2];
  if (!Number.isInteger(id) || !['ok', 'corrected'].includes(verdict)) { console.error('uso: --verdict <id> ok|corrected [--note "..."]'); await done(1); }
  const r = await c.query(`insert into record_reviews (record_id, verdict, note) select id, $2, $3 from records where id = $1
    on conflict (record_id) do update set verdict = excluded.verdict, note = excluded.note, reviewed_at = now() returning record_id`, [id, verdict, opt('--note', null)]);
  console.log(r.rowCount ? `Revision guardada: #${id} ${verdict}.` : `No existe el registro #${id}.`);
  await done(r.rowCount ? 0 : 1);
}

if (args.includes('--stats')) {
  const s = (await c.query(`select count(*) n, count(*) filter (where verdict = 'ok') ok, count(*) filter (where verdict = 'corrected') fixed from record_reviews`)).rows[0];
  const n = Number(s.n), fixed = Number(s.fixed);
  if (asJson) { console.log(JSON.stringify({ reviewed: n, correct: Number(s.ok), corrected: fixed })); await done(); }
  console.log(`Revisados: ${n} | etiquetas correctas: ${s.ok} | corregidas: ${fixed}${n ? ` | tasa de error observada: ${(100 * fixed / n).toFixed(0)}%` : ''}`);
  if (n && n < 30) console.log('(muestra todavia chica, no concluir con menos de ~30 revisiones)');
  await done();
}

const mems = (await c.query(`select name, coalesce(aliases, '{}') aliases, is_meta from memories where merged_into is null`)).rows;
const counts = new Map((await c.query(`select rm.memory_name, count(*) n from record_memories rm join records r on r.id = rm.record_id where r.valid_until is null group by 1`)).rows.map((x) => [x.memory_name, Number(x.n)]));
const recs = (await c.query(`
  select r.id, r.claim, r.source, r.created_at,
         coalesce(array_agg(rm.memory_name) filter (where rm.memory_name is not null), '{}') tags,
         exists (select 1 from record_reviews v where v.record_id = r.id) reviewed
  from records r left join record_memories rm on rm.record_id = r.id
  where r.valid_until is null
  group by r.id`)).rows.map((r) => ({ id: Number(r.id), claim: r.claim, source: r.source ?? '', created: r.created_at, tags: r.tags, reviewed: r.reviewed }));
const domain = mems.filter((m) => !m.is_meta && !UMBRELLA.has(m.name));
const isAuto = (r) => /^Extracción automática/.test(r.source);
const age = (r) => (Date.now() - r.created.getTime()) / 86400e3;

function signals(r) {
  const flags = []; let risk = 0;
  if (r.tags.length && r.tags.every((t) => UMBRELLA.has(t))) { flags.push({ kind: 'paraguas', memory: r.tags.join(',') }); risk += 2; }
  for (const m of detectNodeMentions(r.claim, r.tags, domain)) { flags.push({ kind: 'mencion', memory: m.node, via: m.matchedOn }); risk += 2; }
  const small = r.tags.filter((t) => (counts.get(t) ?? 0) <= 2);
  if (small.length) { flags.push({ kind: 'chico', memory: small.join(',') }); risk += 1; }
  if (flags.length && isAuto(r)) risk += 1;
  return { risk, flags };
}

if (args.includes('--sample')) {
  const n = Number(opt('--sample', 3)); const days = Number(opt('--since', 3));
  const pickFrom = (pool) => { const a = [...pool]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]); return out; };
  const fresh = recs.filter((r) => isAuto(r) && !r.reviewed && age(r) <= days);
  let picked = pickFrom(fresh);
  if (picked.length < n) picked = picked.concat(pickFrom(recs.filter((r) => isAuto(r) && !r.reviewed && !picked.includes(r) && age(r) > days)).slice(0, n - picked.length));
  if (asJson) { console.log(JSON.stringify({ available: fresh.length, days, items: picked.map((r) => ({ id: r.id, tags: r.tags, claim: r.claim, flags: [] })) })); await done(); }
  console.log(`Muestreo: ${picked.length} registro(s) de extraccion automatica sin revisar (${fresh.length} disponibles en los ultimos ${days} dia(s)).`);
  for (const r of picked) console.log(`\n#${r.id} [${r.tags.join(', ') || 'sin recuerdo'}]\n  ${short(r.claim, 320)}`);
  if (picked.length) console.log('\nPara cada uno: node garden.mjs --verdict <id> ok|corrected  (si hay que moverlo: recategorize-record.mjs y luego corrected)');
  await done();
}

if (args.includes('--volume')) {
  const days = Number(opt('--volume', 15)); const perDay = new Map();
  for (const r of recs) {
    if (age(r) > days) continue;
    const d = new Date(r.created.getTime() - 5 * 3600e3).toISOString().slice(0, 10);
    const e = perDay.get(d) ?? { n: 0, flagged: 0 }; e.n++; if (signals(r).flags.length) e.flagged++; perDay.set(d, e);
  }
  for (const d of [...perDay.keys()].sort()) { const e = perDay.get(d); console.log(`${d}  registros ${String(e.n).padStart(3)}  con senal de texto ${String(e.flagged).padStart(3)}`); }
  await done();
}

const since = Number(opt('--since', 1)); const limit = Number(opt('--limit', 5));
const pool = recs.filter((r) => !r.reviewed && age(r) <= since).map((r) => ({ r, ...signals(r) })).filter((x) => x.flags.length).sort((a, b) => b.risk - a.risk);
if (asJson) { console.log(JSON.stringify({ total: pool.length, days: since, items: pool.slice(0, limit).map((x) => ({ id: x.r.id, tags: x.r.tags, claim: x.r.claim, risk: x.risk, flags: x.flags })) })); await done(); }
console.log(`Jardin: ${pool.length} registro(s) con senal en los ultimos ${since} dia(s); se muestran ${Math.min(limit, pool.length)}.`);
for (const x of pool.slice(0, limit)) {
  console.log(`\n#${x.r.id} [${x.r.tags.join(', ') || 'sin recuerdo'}] riesgo ${x.risk}\n  ${short(x.r.claim, 220)}`);
  for (const f of x.flags) console.log(`  - ${f.kind}: ${f.memory}${f.via ? ` (por "${f.via}")` : ''}`);
}
await done();
