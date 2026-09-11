// Chequeo de integridad de segundo-cerebro (Supabase). Adaptado del concepto
// de `gbrain doctor` (health_score / multi_source_drift / content_hash_duplicates)
// al backend real: no hay multi-fuente que pueda divergir (una sola base
// compartida, no copias), así que ese chequeo no aplica; los que sí aplican
// son RLS regresando a estar apagado (ya pasó una vez, registro #108), datos
// de `records` inconsistentes, y (agregado 2026-09-03 al notar que el
// rediseño node del 2026-08-29 nunca se reflejó aquí) drift de la
// arquitectura node: RLS de memories/record_memories/memory_links/
// memory_pair_checks, memory_links/memory_pair_checks que quedaron
// apuntando a un recuerdo ya fusionado (merge-memories.mjs no las
// reasigna, solo record_memories), y colisión de alias entre recuerdos vigentes
// (merge-memories.mjs pliega alias sin pasar por check-alias-collision.mjs).
// Pensado para el job `brain-hygiene` de HEARTBEAT.md.
//
// Sin chequeos de `pages` (retirados 2026-09-11): `load-pages.mjs` solo
// indexa daily/guides/people/projects/wiki de ESTE repo (el vault personal
// de Oscar, MyBrain/UAObrain), disparado por el hook post-commit -- 2oBrain,
// la plantilla que se distribuye a otros usuarios, no trae esas carpetas ni
// documenta ese flujo en ningún lado (confirmado: cero menciones en
// README_SP.md, sin endpoint de carga en dashboard-server.mjs). Para
// cualquier usuario real de 2oBrain, `pages` queda vacía siempre, así que
// esos chequeos eran ruido permanente, no una función que alguien fuera a
// usar. Un duplicado real en el propio vault de Oscar se nota editando el
// vault directamente (Obsidian, git status), no hace falta un chequeo de
// base de datos para eso.
//
// --fix (2026-09-11): aplica sin preguntar SOLO los chequeos "mecánicos",
// aquellos donde el estado correcto es determinista y no hay una segunda
// respuesta válida (RLS apagado, superseded_by sin valid_until,
// memory_links/memory_pair_checks huérfanos por fusión). El resto
// (duplicados de contenido, fechas futuras, registros sin recuerdo, colisión
// de alias) requiere que alguien decida cuál dato es el correcto, así que se
// quedan como diagnóstico con el comando manual impreso, nunca se auto-aplican.
//
// --json (2026-09-11): mismo chequeo, salida estructurada en vez de texto
// para terminal -- pensado para que dashboard-server.mjs renderice una
// tarjeta por caso individual (id, campos relevantes) en vez de un bloque de
// texto plano. Contrato: { ok, fixed, warnings, checks: [{ id, label,
// status: 'ok'|'warn'|'fixed', mechanical, cases: [...] }] }. `cases` trae
// los datos mínimos para construir una acción de UI (ids, slugs, nombres),
// nunca el texto ya formateado para humano -- eso lo arma quien consuma el
// JSON. En este modo NO se imprime nada más que el JSON final a stdout (el
// consumidor hace JSON.parse sobre stdout completo).
//
// Uso: node doctor.mjs [--fix] [--json]
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

// --fix: aplica SOLO los chequeos "mecánicos" (donde el estado correcto es
// determinista, sin ambigüedad de criterio, ver discusión 2026-09-11).
// Nunca pregunta antes de aplicar (decisión explícita de Oscar): un chequeo
// mecánico no tiene una segunda respuesta válida, así que confirmar no
// añade seguridad real, solo fricción. Los chequeos que sí requieren
// criterio humano (cuál página es la canónica, qué fecha es la correcta, a
// qué recuerdo pertenece un registro huérfano, quién se queda con un alias
// disputado) siguen siendo solo-diagnóstico, con el comando manual impreso.
const willFix = process.argv.includes('--fix');
const wantsJson = process.argv.includes('--json');

let warnings = 0;
let fixed = 0;
const checks = [];

// Único punto de reporte para los 8 chequeos, mecánicos o no. `caseOf`
// convierte cada fila cruda en el objeto mínimo que necesita una tarjeta de
// UI (usado siempre, aunque --json no esté activo, es barato). `describe` es
// el texto de una línea para la salida de terminal. `applyFix`/`mechanical`
// solo importan si el chequeo es mecánico.
async function check({ id, label, rows, describe, caseOf, mechanical = false, applyFix, hint }) {
  const entry = { id, label, mechanical, status: 'ok', cases: [] };

  if (rows.length === 0) {
    checks.push(entry);
    if (!wantsJson) console.log(`OK    ${label}`);
    return;
  }

  if (mechanical && willFix) {
    await applyFix(client, rows);
    fixed += 1;
    entry.status = 'fixed';
    entry.cases = rows.map(caseOf);
    checks.push(entry);
    if (!wantsJson) console.log(`FIXED ${label} (${rows.length} corregida(s))`);
    return;
  }

  warnings += 1;
  entry.status = 'warn';
  entry.cases = rows.map(caseOf);
  checks.push(entry);
  if (!wantsJson) {
    console.log(`WARN  ${label} (${rows.length})`);
    for (const r of rows.slice(0, 10)) {
      console.log(`        ${describe(r)}`);
    }
    if (rows.length > 10) {
      console.log(`        ... y ${rows.length - 10} más`);
    }
    if (mechanical) {
      console.log(`        Auto-corregible: node doctor.mjs --fix`);
    } else if (hint) {
      console.log(`        Cómo arreglarlo: ${hint}`);
    }
  }
}

// Resuelve un nombre de recuerdo a su vigente siguiendo la cadena de
// merged_into (mismo patrón que graph.mjs usa al leer). Se recalcula en cada
// llamada a check() que lo necesita porque una fusión puede haber cambiado
// el mapa desde la última consulta en esta misma corrida.
async function resolveLiveMemoryMap() {
  const { rows: allMemories } = await client.query(`select name, merged_into from memories`);
  const mergedIntoOf = new Map(allMemories.map((r) => [r.name, r.merged_into]));
  return (name) => {
    const seen = new Set();
    let current = name;
    while (mergedIntoOf.get(current) && !seen.has(current)) {
      seen.add(current);
      current = mergedIntoOf.get(current);
    }
    return current;
  };
}

// RLS regresando a estar apagado (incidente real, registro #108/#109): sin esto,
// cualquier tabla queda legible/escribible por cualquiera con la publishable
// key. Extendido a las tablas del rediseño node (2026-08-29/2026-09-02),
// schema.sql las habilita todas, pero este chequeo se había quedado en el
// par original (pages/records) y nunca se actualizó al agregar memories/
// memory_links/memory_pair_checks/record_memories.
{
  const { rows } = await client.query(
    `select relname, relrowsecurity
     from pg_class
     where relnamespace = 'public'::regnamespace
       and relname in ('pages', 'records', 'memories', 'record_memories', 'memory_links', 'memory_pair_checks')`,
  );
  const rlsOff = rows.filter((r) => !r.relrowsecurity);
  await check({
    id: 'rls',
    label: 'RLS activo en todas las tablas',
    rows: rlsOff,
    describe: (r) => `${r.relname}: RLS DESACTIVADO`,
    caseOf: (r) => ({ id: r.relname, table: r.relname }),
    mechanical: true,
    // relname viene de pg_class filtrado contra la lista fija de arriba (no
    // input externo), interpolar el identificador aquí es seguro.
    applyFix: async (client, rows) => {
      for (const r of rows) {
        await client.query(`alter table ${r.relname} enable row level security`);
      }
    },
  });
}

{
  const { rows } = await client.query(
    `select id, claim from records where valid_until is null and embedding is null order by id`,
  );
  await check({
    id: 'records-no-embedding',
    label: 'registros vigentes con embedding',
    rows,
    describe: (r) => `#${r.id} ${r.claim.slice(0, 80)}`,
    caseOf: (r) => ({ id: r.id, claim: r.claim }),
  });
}

{
  const { rows } = await client.query(
    `select id, date, claim from records where date > current_date order by date desc`,
  );
  await check({
    id: 'records-future-date',
    label: 'registros sin fecha futura',
    rows,
    describe: (r) => `#${r.id} [${r.date.toISOString().slice(0, 10)}] ${r.claim.slice(0, 80)}`,
    caseOf: (r) => ({ id: r.id, date: r.date.toISOString().slice(0, 10), claim: r.claim }),
  });
}

// Corregido 2026-08-30 (causa raíz de la resurrección accidental de #159/160,
// dos veces -- ver registros #175/#180/#290/#336): `valid_until` seteado con
// `superseded_by` null es el estado normal y permanente de cualquier registro
// retractado con `forget.mjs` (retractar sin reemplazo nunca tiene
// superseded_by, por diseño), no una inconsistencia. La única mitad
// genuinamente rota es la otra: `superseded_by` seteado sin `valid_until` --
// remember.mjs/remember-batch.mjs/los 2 MCP siempre setean ambos juntos al
// resolver --supersedes, así que si aparece uno sin el otro es un bug real,
// no una retractación legítima.
{
  const { rows } = await client.query(
    `select id, claim, valid_until, superseded_by from records
     where valid_until is null and superseded_by is not null
     order by id`,
  );
  await check({
    id: 'records-inconsistent-supersede',
    label: 'registros con superseded_by consistente (valid_until presente)',
    rows,
    describe: (r) => `#${r.id} valid_until=${r.valid_until ?? 'null'} superseded_by=${r.superseded_by ?? 'null'}`,
    caseOf: (r) => ({ id: r.id, valid_until: r.valid_until, superseded_by: r.superseded_by }),
    mechanical: true,
    // Mismo patrón que supersede-record.mjs usa al resolver --supersedes:
    // valid_until = now(). No es la fecha real en que se rompió (esa nunca
    // quedó guardada), pero es el mismo criterio que el sistema ya considera
    // correcto para este campo en el camino normal de escritura.
    applyFix: async (client, rows) => {
      await client.query(
        `update records set valid_until = now() where id = any($1::bigint[])`,
        [rows.map((r) => r.id)],
      );
    },
  });
}

// Rediseño node (2026-08-29): node es obligatorio para registros vigentes
// (ver PLAN-recuerdos.md), aunque remember.mjs todavía no lo fuerza a nivel de
// esquema (la propuesta+desambiguación automática es Etapa 2). Este chequeo
// es la red de seguridad mientras tanto: si algo se cuela sin recuerdo, que se
// note aquí, no que se acumule en silencio como pasó con los 92 huérfanos
// de page_slug que se migraron a mano hoy.
{
  const { rows } = await client.query(
    `select id, claim from records
     where valid_until is null and id not in (select record_id from record_memories)
     order by id`,
  );
  await check({
    id: 'records-no-memory',
    label: 'registros vigentes con al menos un recuerdo',
    rows,
    describe: (r) => `#${r.id} ${r.claim.slice(0, 80)}`,
    caseOf: (r) => ({ id: r.id, claim: r.claim }),
  });
}

// merge-memories.mjs ya redirige memory_links y limpia memory_pair_checks al
// fusionar (arreglado 2026-09-08 y 2026-09-11 respectivamente), así que una
// fusión NUEVA no debería dejar filas muertas aquí. Este chequeo sigue
// siendo la red de seguridad para lo que quedó de fusiones VIEJAS, hechas
// antes de esos arreglos, o de cualquier corrección manual directa a la
// tabla `memories` que no haya pasado por merge-memories.mjs.
//
// Reclasificado a mecánico 2026-09-11: redirigir la arista al recuerdo
// vigente (o descartarla si ambos lados resuelven al mismo, auto-loop) es
// exactamente el mismo criterio que merge-memories.mjs ya aplica en
// escritura para aristas nuevas -- no hay una segunda respuesta válida.
{
  const { rows } = await client.query(
    `select ne.from_memory, ne.to_memory, ne.relation, ne.source, ne.date,
            nf.merged_into as from_dead, nt.merged_into as to_dead
     from memory_links ne
     join memories nf on nf.name = ne.from_memory
     join memories nt on nt.name = ne.to_memory
     where nf.merged_into is not null or nt.merged_into is not null
     order by ne.from_memory, ne.to_memory`,
  );
  await check({
    id: 'memory-links-dead',
    label: 'memory_links sin recuerdos fusionados (merged_into)',
    rows,
    describe: (r) => `${r.from_memory}${r.from_dead ? ` (fusionado -> ${r.from_dead})` : ''} -> ${r.to_memory}${r.to_dead ? ` (fusionado -> ${r.to_dead})` : ''} (${r.relation})`,
    caseOf: (r) => ({
      id: `${r.from_memory}->${r.to_memory}:${r.relation}`,
      from_memory: r.from_memory,
      to_memory: r.to_memory,
      relation: r.relation,
    }),
    mechanical: true,
    applyFix: async (client, rows) => {
      const resolveLive = await resolveLiveMemoryMap();
      for (const r of rows) {
        const liveFrom = resolveLive(r.from_memory);
        const liveTo = resolveLive(r.to_memory);
        if (liveFrom !== liveTo) {
          await client.query(
            `insert into memory_links (from_memory, to_memory, relation, source, date)
             values ($1, $2, $3, $4, $5)
             on conflict (from_memory, to_memory, relation) do nothing`,
            [liveFrom, liveTo, r.relation, r.source, r.date],
          );
        }
        await client.query(
          `delete from memory_links where from_memory = $1 and to_memory = $2 and relation = $3`,
          [r.from_memory, r.to_memory, r.relation],
        );
      }
    },
  });
}

{
  const { rows } = await client.query(
    `select npc.memory_a, npc.memory_b, na.merged_into as a_dead, nb.merged_into as b_dead
     from memory_pair_checks npc
     join memories na on na.name = npc.memory_a
     join memories nb on nb.name = npc.memory_b
     where na.merged_into is not null or nb.merged_into is not null
     order by npc.memory_a, npc.memory_b`,
  );
  await check({
    id: 'memory-pair-checks-dead',
    label: 'memory_pair_checks sin recuerdos fusionados (merged_into)',
    rows,
    describe: (r) => `${r.memory_a}${r.a_dead ? ` (fusionado -> ${r.a_dead})` : ''} <-> ${r.memory_b}${r.b_dead ? ` (fusionado -> ${r.b_dead})` : ''}`,
    caseOf: (r) => ({ id: `${r.memory_a}|${r.memory_b}`, memory_a: r.memory_a, memory_b: r.memory_b }),
    mechanical: true,
    // Es solo caché de costo (qué pares ya comparó el LLM, ver
    // list-link-candidates-deep.mjs): borrar es seguro, la próxima corrida
    // de ese script recalcula el par bajo el nombre vigente sin perder nada.
    applyFix: async (client) => {
      await client.query(
        `delete from memory_pair_checks npc
         using memories na, memories nb
         where na.name = npc.memory_a and nb.name = npc.memory_b
           and (na.merged_into is not null or nb.merged_into is not null)`,
      );
    },
  });
}

// Colisión de alias entre recuerdos vigentes (ver lib/check-alias-collision.mjs,
// registro #497: "DB2" colisionó entre db2-2026-2 y DB2-gestion-github). Se
// bloquea al ESCRIBIR vía set-memory-aliases.mjs/remember.mjs --aliases, pero
// merge-memories.mjs pliega el nombre+alias del recuerdo origen como alias del
// destino SIN pasar por ese chequeo -- una fusión puede colar una colisión
// que el resto del sistema nunca habría permitido crear a mano.
{
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
  const rows = [...aliasOwners.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([form, owners]) => ({ form, owners: [...owners] }));
  await check({
    id: 'alias-collisions',
    label: 'Alias sin colisión entre recuerdos vigentes',
    rows,
    describe: (r) => `"${r.form}" reclamado por: ${r.owners.join(', ')}`,
    caseOf: (r) => ({ id: r.form, form: r.form, owners: r.owners }),
    hint: 'decide quién se queda con el alias y quítaselo al otro: node set-memory-aliases.mjs --memory <perdedor> --remove <alias> --reason "..."',
  });
}

if (wantsJson) {
  console.log(JSON.stringify({ ok: warnings === 0, fixed, warnings, checks }, null, 2));
} else {
  console.log('');
  if (fixed > 0) {
    console.log(`${fixed} chequeo(s) corregido(s) automáticamente.`);
  }
  console.log(warnings === 0 ? 'Todo limpio.' : `${warnings} chequeo(s) con avisos (correr con --fix para aplicar los auto-corregibles).`);
}

await client.end();
process.exit(warnings === 0 ? 0 : 1);
