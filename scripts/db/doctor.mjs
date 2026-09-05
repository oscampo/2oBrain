// Chequeo de integridad de segundo-cerebro (Supabase). Adaptado del concepto
// de `gbrain doctor` (health_score / multi_source_drift / content_hash_duplicates)
// al backend real: no hay multi-fuente que pueda divergir (una sola base
// compartida, no copias), así que ese chequeo no aplica; los que sí aplican
// son duplicados de contenido, embeddings faltantes/desactualizados, RLS
// regresando a estar apagado (ya pasó una vez, registro #108), datos de `records`
// inconsistentes, y (agregado 2026-09-03 al notar que el rediseño node del
// 2026-08-29 nunca se reflejó aquí) drift de la arquitectura node: RLS de
// memories/record_memories/memory_links/memory_pair_checks, memory_links/memory_pair_checks
// que quedaron apuntando a un recuerdo ya fusionado (merge-memories.mjs no las
// reasigna, solo record_memories), y colisión de alias entre recuerdos vigentes
// (merge-memories.mjs pliega alias sin pasar por check-alias-collision.mjs).
// Pensado para el job `brain-hygiene` de HEARTBEAT.md.
// Uso: node doctor.mjs
import { readFileSync } from 'node:fs';
import pg from 'pg';

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

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

let warnings = 0;

function report(label, rows, describe) {
  if (rows.length === 0) {
    console.log(`OK    ${label}`);
    return;
  }
  warnings += 1;
  console.log(`WARN  ${label} (${rows.length})`);
  for (const r of rows.slice(0, 10)) {
    console.log(`        ${describe(r)}`);
  }
  if (rows.length > 10) {
    console.log(`        ... y ${rows.length - 10} más`);
  }
}

// RLS regresando a estar apagado (incidente real, registro #108/#109): sin esto,
// cualquier tabla queda legible/escribible por cualquiera con la publishable
// key. Extendido a las tablas del rediseño node (2026-08-29/2026-09-02),
// schema.sql las habilita todas, pero este chequeo se había quedado en el
// par original (pages/records) y nunca se actualizó al agregar memories/
// memory_links/memory_pair_checks/record_memories.
const { rows: rls } = await client.query(
  `select relname, relrowsecurity
   from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('pages', 'records', 'memories', 'record_memories', 'memory_links', 'memory_pair_checks')`,
);
const rlsOff = rls.filter((r) => !r.relrowsecurity);
report('RLS activo en todas las tablas', rlsOff, (r) => `${r.relname}: RLS DESACTIVADO`);

const { rows: noEmbedPages } = await client.query(
  `select slug from pages where embedding is null order by slug`,
);
report('Páginas con embedding', noEmbedPages, (r) => r.slug);

const { rows: staleEmbed } = await client.query(
  `select slug, updated_at, embedded_at from pages
   where embedding is not null and (embedded_at is null or embedded_at < updated_at)
   order by updated_at desc`,
);
report(
  'Embeddings al día (updated_at vs embedded_at)',
  staleEmbed,
  (r) => `${r.slug} (updated ${r.updated_at.toISOString().slice(0, 10)}, embedded ${r.embedded_at ? r.embedded_at.toISOString().slice(0, 10) : 'nunca'})`,
);

const { rows: dupContent } = await client.query(
  `select md5(content) as hash, array_agg(slug order by slug) as slugs
   from pages
   group by md5(content)
   having count(*) > 1`,
);
report('Contenido duplicado entre páginas', dupContent, (r) => r.slugs.join(', '));

const { rows: noEmbedFacts } = await client.query(
  `select id, claim from records where valid_until is null and embedding is null order by id`,
);
report('registros vigentes con embedding', noEmbedFacts, (r) => `#${r.id} ${r.claim.slice(0, 80)}`);

const { rows: futureDated } = await client.query(
  `select id, date, claim from records where date > current_date order by date desc`,
);
report('registros sin fecha futura', futureDated, (r) => `#${r.id} [${r.date.toISOString().slice(0, 10)}] ${r.claim.slice(0, 80)}`);

// Corregido 2026-08-30 (causa raíz de la resurrección accidental de #159/160,
// dos veces -- ver registros #175/#180/#290/#336): `valid_until` seteado con
// `superseded_by` null es el estado normal y permanente de cualquier registro
// retractado con `forget.mjs` (retractar sin reemplazo nunca tiene
// superseded_by, por diseño), no una inconsistencia. La única mitad
// genuinamente rota es la otra: `superseded_by` seteado sin `valid_until` --
// remember.mjs/remember-batch.mjs/los 2 MCP siempre setean ambos juntos al
// resolver --supersedes, así que si aparece uno sin el otro es un bug real,
// no una retractación legítima.
const { rows: inconsistentSupersede } = await client.query(
  `select id, claim, valid_until, superseded_by from records
   where valid_until is null and superseded_by is not null
   order by id`,
);
report(
  'registros con superseded_by consistente (valid_until presente)',
  inconsistentSupersede,
  (r) => `#${r.id} valid_until=${r.valid_until ?? 'null'} superseded_by=${r.superseded_by ?? 'null'}`,
);

// Rediseño node (2026-08-29): node es obligatorio para registros vigentes
// (ver PLAN-recuerdos.md), aunque remember.mjs todavía no lo fuerza a nivel de
// esquema (la propuesta+desambiguación automática es Etapa 2). Este chequeo
// es la red de seguridad mientras tanto: si algo se cuela sin recuerdo, que se
// note aquí, no que se acumule en silencio como pasó con los 92 huérfanos
// de page_slug que se migraron a mano hoy.
const { rows: noNode } = await client.query(
  `select id, claim from records
   where valid_until is null and id not in (select record_id from record_memories)
   order by id`,
);
report('registros vigentes con al menos un recuerdo', noNode, (r) => `#${r.id} ${r.claim.slice(0, 80)}`);

// merge-memories.mjs (2026-09-02) reasigna record_memories al fusionar, pero nunca
// tocó memory_links ni memory_pair_checks (confirmado leyendo el script: solo
// hace insert/delete sobre record_memories y update sobre memories.merged_into) --
// si un recuerdo con edges o pair_checks propios se fusiona después, esas filas
// quedan apuntando a un nombre muerto en vez de resolver al recuerdo vigente.
const { rows: deadEdges } = await client.query(
  `select ne.from_memory, ne.to_memory, ne.relation, nf.merged_into as from_dead, nt.merged_into as to_dead
   from memory_links ne
   join memories nf on nf.name = ne.from_memory
   join memories nt on nt.name = ne.to_memory
   where nf.merged_into is not null or nt.merged_into is not null
   order by ne.from_memory, ne.to_memory`,
);
report(
  'memory_links sin recuerdos fusionados (merged_into)',
  deadEdges,
  (r) => `${r.from_memory}${r.from_dead ? ` (fusionado -> ${r.from_dead})` : ''} -> ${r.to_memory}${r.to_dead ? ` (fusionado -> ${r.to_dead})` : ''} (${r.relation})`,
);

const { rows: deadPairChecks } = await client.query(
  `select npc.memory_a, npc.memory_b, na.merged_into as a_dead, nb.merged_into as b_dead
   from memory_pair_checks npc
   join memories na on na.name = npc.memory_a
   join memories nb on nb.name = npc.memory_b
   where na.merged_into is not null or nb.merged_into is not null
   order by npc.memory_a, npc.memory_b`,
);
report(
  'memory_pair_checks sin recuerdos fusionados (merged_into)',
  deadPairChecks,
  (r) => `${r.memory_a}${r.a_dead ? ` (fusionado -> ${r.a_dead})` : ''} <-> ${r.memory_b}${r.b_dead ? ` (fusionado -> ${r.b_dead})` : ''}`,
);

// Colisión de alias entre recuerdos vigentes (ver lib/check-alias-collision.mjs,
// registro #497: "DB2" colisionó entre db2-2026-2 y DB2-gestion-github). Se
// bloquea al ESCRIBIR vía set-memory-aliases.mjs/remember.mjs --aliases, pero
// merge-memories.mjs pliega el nombre+alias del recuerdo origen como alias del
// destino SIN pasar por ese chequeo -- una fusión puede colar una colisión
// que el resto del sistema nunca habría permitido crear a mano.
const { rows: liveNodes } = await client.query(
  `select name, aliases from memories where merged_into is null order by name`,
);
const aliasOwners = new Map();
for (const n of liveNodes) {
  for (const form of [n.name, ...(n.aliases ?? [])]) {
    const key = form.toLowerCase();
    if (!aliasOwners.has(key)) aliasOwners.set(key, new Set());
    aliasOwners.get(key).add(n.name);
  }
}
const aliasCollisions = [...aliasOwners.entries()]
  .filter(([, owners]) => owners.size > 1)
  .map(([form, owners]) => ({ form, owners: [...owners] }));
report(
  'Alias sin colisión entre recuerdos vigentes',
  aliasCollisions,
  (r) => `"${r.form}" reclamado por: ${r.owners.join(', ')}`,
);

console.log('');
console.log(warnings === 0 ? 'Todo limpio.' : `${warnings} chequeo(s) con avisos.`);

await client.end();
process.exit(warnings === 0 ? 0 : 1);
