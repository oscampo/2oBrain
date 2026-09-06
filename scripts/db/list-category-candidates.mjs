// Herramienta de revisión, no de automatización (mismo principio que
// list-merge-candidates.mjs/list-link-candidates-deep.mjs): detecta recuerdos de
// dominio que no tienen NINGÚN enlace con otro recuerdo -- de ninguna
// relación, no solo `pertenece_a` -- y los agrupa en clusters temáticos por
// similitud de sus registros, para proponer una categoría nueva que los
// agrupe. Mismo criterio de "sin conexión" que ya usa la sección Grafo
// (touched.add(e.from)/touched.add(e.to) sobre TODOS los edges, ver
// index.html) -- antes de 2026-09-06 este script era más estricto (solo
// contaba `pertenece_a`), lo que producía falsos positivos reales: Oscar
// encontró que "contacto-personal-x" y "automatizacion-solidworks-com" salían
// como huérfanos en esta herramienta pero NO en el conteo "sin conexión"
// del Grafo, porque ya tenían un enlace de otra relación (colabora_con,
// usado_para_calificar, etc.) que sí cuenta como "tiene lugar", aunque no
// sea jerárquico. Ver más abajo el detalle histórico de por qué el chequeo
// empezó estricto -- ya no aplica, esto lo reemplaza.
//
// Nace de una idea de Oscar (2026-09-04): un "Asistente" que sugiriera esto
// proactivamente al usuario nuevo de 2oBrain (día 1, luego semanal). Se
// descartó la versión proactiva -- mismo patrón que ya se probó y se
// abandonó con el hook Stop (ver MEMORY.md, registro #153-155): un push
// disparado por el sistema en vez de pedido por el usuario genera más
// fricción que valor, y el disparo "al día siguiente del primer uso" no
// tiene señal real todavía (un día de registros es ruido). Esta versión queda
// bajo demanda (el usuario la corre cuando siente el grafo desordenado,
// igual que list-merge-candidates.mjs/list-link-candidates-deep.mjs).
//
// Por qué "sin ningún enlace" y no "sin lugar en la jerarquía": una
// categoría raíz legítima (ej. trabajo-uao) tampoco tiene `pertenece_a`
// saliente, pero SÍ tiene entrante (es padre de algo) -- eso ya la excluye
// bajo cualquiera de los dos criterios, no hace falta distinguirlos para
// ese caso. Lo que sí cambió es qué cuenta como "tener lugar": antes solo
// `pertenece_a` contaba (ver el historial de relation-text-drift más abajo,
// motivo original de esa restricción); ahora cualquier memory_link cuenta,
// igual que la sección Grafo.
//
// Clustering: reusa el filtro de "similitud máxima entre registros individuales
// de cada recuerdo" ya validado en list-link-candidates-deep.mjs (mejor señal
// que promediar/centroide, ver ese archivo) -- pares por encima del umbral
// se agrupan por componentes conexas (union-find), no solo pares sueltos,
// para que A-B-C parecidos entre sí salgan como un solo cluster de 3 en vez
// de 3 pares redundantes.
//
// Historial de por qué el chequeo empezó restringido a `pertenece_a`
// (2026-09-04, ya SUPERADO el 2026-09-06, ver arriba): `relation` en
// memory_links es texto libre A PROPÓSITO (ver schema.sql, comentario sobre
// memory_links -- "la variedad de relaciones humanas reales no cabe bien en
// una lista cerrada"), y el riesgo temido entonces era que un recuerdo con
// SOLO un `colabora_con` (sin ninguna relación de jerarquía) igual necesitaba
// aparecer como candidato -- ensanchar el chequeo a "cualquier edge cuenta"
// se descartó por eso. En la práctica pasó lo contrario: Oscar encontró
// (2026-09-06) que "automatizacion-solidworks-com" (con un `usado_para_calificar`
// real) y "contacto-personal-x" (con un `pertenece_a` real, solo que mal escrito
// como 'pertenece a', ver más abajo) salían como falsos positivos en esta
// herramienta pero no en el conteo "sin conexión" del Grafo -- el costo real
// terminó siendo justo el opuesto al previsto. Nota aparte, sigue vigente:
// `relation` mal escrito (espacio en vez de guion bajo, u otro texto para el
// mismo significado) sigue pudiendo esconder una relación real de
// findExistingCategoryMatch() más abajo (que sí sigue mirando específicamente
// `pertenece_a`, porque ESO es lo que define la jerarquía de categorías) --
// si eso vuelve a pasar, la corrección es unificar el texto de relación en
// los datos, no ensanchar ese chequeo.
//
// Sugerencia de nombre (2026-09-04, pedido de Oscar tras ver que la sección
// del dashboard solo mostraba texto sin ninguna acción posible, a diferencia
// de "Extraer de página"): cada cluster trae, además de los miembros, un
// nombre de categoría propuesto (lib/suggest-category-name.mjs, mismo
// modelo barato que classify-memory.mjs) -- best-effort, nunca bloquea: si el
// clasificador no está disponible, suggestedName queda null y el dashboard
// simplemente deja el campo vacío para que el usuario escriba a mano.
//
// Encaje contra jerarquía existente (2026-09-06, pedido de Oscar): antes,
// todo grupo (suelto o cluster) proponía siempre una categoría NUEVA, sin
// mirar si ya existía una categoría/subcategoría a la que encajara mejor.
// Ahora cada grupo trae `mode`: 'link-existing' (un huérfano suelto que
// encaja con una categoría/subcategoría existente -- se liga directo, sin
// crear nada), 'new-subcategory' (un cluster que encaja -- se propone como
// subcategoría nueva bajo esa categoría existente), o 'new-category'
// (ningún encaje -- comportamiento original). Ver findExistingCategoryMatch
// más abajo para el porqué de comparar contra los HIJOS de la categoría, no
// contra la categoría misma.
//
// Uso:
//   node list-category-candidates.mjs [--threshold 0.75] [--min-cluster 2] [--json]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { suggestCategoryName } from './lib/suggest-category-name.mjs';

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
const threshold = args.threshold ? Number(args.threshold) : 0.75;
const minCluster = args['min-cluster'] ? Number(args['min-cluster']) : 2;

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

// recuerdo de dominio, con al menos un registro vigente, que no participa en
// NINGÚN memory_link (cualquier relación) en ningún sentido -- ni como
// origen ni como destino. Mismo criterio que "sin conexión" en la sección
// Grafo (ver comentario de cabecera para el porqué del cambio 2026-09-06).
const { rows: orphans } = await client.query(`
  select n.name, count(fn.record_id)::int as fact_count
  from memories n
  join record_memories fn on fn.memory_name = n.name
  join records f on f.id = fn.record_id and f.valid_until is null
  where n.merged_into is null and not n.is_meta
    and not exists (select 1 from memory_links e where e.from_memory = n.name)
    and not exists (select 1 from memory_links e where e.to_memory = n.name)
  group by n.name
  order by n.name
`);

if (orphans.length === 0) {
  if (args.json) {
    console.log(JSON.stringify({ orphanCount: 0, clusters: [], unclustered: [] }));
  } else {
    console.log('0 recuerdo(s) de dominio sin lugar en la jerarquía.');
  }
  await client.end();
  process.exit(0);
}

// Menos huérfanos que --min-cluster: ninguno puede formar cluster
// matemáticamente, pero cada uno sigue siendo un candidato individual a
// categoría propia -- se resuelven como "unclustered" más abajo, no se
// descarta el caso aquí (2026-09-06, hallazgo de Oscar: antes esta rama
// salía con solo un conteo, sin listar ni un nombre).

const names = orphans.map((o) => o.name);
const { rows: maxSims } = await client.query(
  `select fn1.memory_name as memory_a, fn2.memory_name as memory_b,
          max(1 - (f1.embedding <=> f2.embedding)) as similarity
   from record_memories fn1
   join records f1 on f1.id = fn1.record_id and f1.valid_until is null and f1.embedding is not null
   join record_memories fn2 on fn2.memory_name = any($1::text[]) and fn2.memory_name > fn1.memory_name
   join records f2 on f2.id = fn2.record_id and f2.valid_until is null and f2.embedding is not null
   where fn1.memory_name = any($1::text[])
   group by fn1.memory_name, fn2.memory_name
   having max(1 - (f1.embedding <=> f2.embedding)) >= $2`,
  [names, threshold],
);

// Componentes conexas por union-find: un cluster es un grupo de recuerdos donde
// cada uno tiene al menos un vecino en el grupo por encima del umbral --
// transitivo, no exige que TODOS los pares dentro del cluster lo superen.
const parent = new Map(names.map((n) => [n, n]));
function find(x) {
  while (parent.get(x) !== x) x = parent.get(x);
  return x;
}
function union(a, b) {
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
}
for (const s of maxSims) union(s.memory_a, s.memory_b);

const groups = new Map();
for (const n of names) {
  const root = find(n);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(n);
}

// Contra qué categoría/subcategoría existente encaja mejor un grupo de
// huérfanos (2026-09-06, pedido de Oscar): una categoría no acumula
// registros propios (queda vacía a propósito, ver CLAUDE.md Fase 6), así
// que no se puede comparar el embedding del huérfano contra el de la
// categoría misma -- no tiene ninguno. La señal real es la de sus HIJOS ya
// ligados (`pertenece_a` entrante): si el huérfano se parece a los
// registros de los miembros que ya viven bajo una categoría, esa categoría
// es la candidata. Esto generaliza solo: contra una categoría raíz con
// hijos vacíos (recién creada, sin contenido real todavía) no encuentra
// nada y cae al camino de "categoría nueva" -- comportamiento correcto,
// no hay con qué comparar.
async function findExistingCategoryMatch(names) {
  // matched_via: qué hijo concreto de la categoría disparó la mejor
  // similitud -- se muestra en la sugerencia (texto y JSON) para que la
  // revisión humana entienda POR QUÉ se propuso esa categoría, no solo el
  // número. Se resuelve con DISTINCT ON (mejor fila por categoría) en vez
  // de max() + group by, para poder traer también el nombre del hijo sin
  // una segunda consulta.
  const { rows } = await client.query(
    `with children as (
       select ml.to_memory as category, ml.from_memory as child
       from memory_links ml
       where ml.relation = 'pertenece_a' and ml.to_memory <> all($1::text[])
     ),
     child_records as (
       select c.category, c.child, r.embedding
       from children c
       join record_memories rm on rm.memory_name = c.child
       join records r on r.id = rm.record_id and r.valid_until is null and r.embedding is not null
     ),
     orphan_records as (
       select r.embedding
       from record_memories rm
       join records r on r.id = rm.record_id and r.valid_until is null and r.embedding is not null
       where rm.memory_name = any($1::text[])
     ),
     pairs as (
       select cr.category, cr.child, 1 - (o.embedding <=> cr.embedding) as similarity
       from child_records cr
       cross join orphan_records o
     )
     select distinct on (category) category, child, similarity
     from pairs
     order by category, similarity desc`,
    [names],
  );
  const best = rows.sort((a, b) => b.similarity - a.similarity)[0];
  if (!best || best.similarity < threshold) return null;
  return { category: best.category, matchedVia: best.child, similarity: best.similarity };
}

const factCountByName = new Map(orphans.map((o) => [o.name, o.fact_count]));
const clusters = [...groups.values()]
  .filter((g) => g.length >= minCluster)
  .map((g) => g.sort((a, b) => a.localeCompare(b)))
  .sort((a, b) => b.length - a.length);

// Huérfanos que no entraron en ningún cluster (2026-09-06, hallazgo de
// Oscar): antes, si ninguno superaba el umbral con otro, el script no
// listaba ni un solo nombre -- "3 huérfanos, 0 clusters" y nada más que
// hacer con ellos desde el dashboard. Un huérfano suelto sigue siendo
// accionable uno por uno (crear su propia categoría, o ligarlo a mano a una
// ya existente vía "Relaciones"), no necesita esperar a tener un "hermano"
// parecido.
const clusteredNames = new Set(clusters.flat());
const unclustered = orphans.filter((o) => !clusteredNames.has(o.name)).map((o) => o.name);

async function exampleClaim(node) {
  const { rows } = await client.query(
    `select claim from records f join record_memories fn on fn.record_id = f.id
     where fn.memory_name = $1 and f.valid_until is null order by f.date desc limit 1`,
    [node],
  );
  return rows[0]?.claim ?? '';
}

// Miembros + sugerencia de nombre se resuelven una sola vez, se usan en
// ambos modos de salida (json y texto) -- evita duplicar las mismas
// consultas/llamadas al clasificador. Un huérfano suelto se resuelve igual
// (mismo suggestCategoryName con un solo miembro): sigue siendo un
// candidato válido a categoría propia, solo que sin "hermanos" parecidos.
// Tres modos posibles, según haya o no una categoría/subcategoría existente
// que encaje (pedido de Oscar, 2026-09-06): un huérfano SUELTO que encaja
// con algo existente se propone como enlace directo ("categoría-recuerdo" o
// "categoría-subcategoría-recuerdo" si lo que encaja ya es en sí una
// subcategoría); un CLUSTER que encaja se propone como subcategoría nueva
// bajo esa categoría existente ("categoría existente -> nueva subcategoría
// -> miembros"); sin ningún encaje, cae al comportamiento original
// (categoría nueva, suelta o con los miembros del cluster).
async function resolveGroup(names) {
  const members = [];
  for (const name of names) {
    members.push({ name, factCount: factCountByName.get(name), example: await exampleClaim(name) });
  }
  const existingMatch = await findExistingCategoryMatch(names);

  if (existingMatch && members.length === 1) {
    return {
      mode: 'link-existing',
      members,
      existingCategory: existingMatch.category,
      existingMatchedVia: existingMatch.matchedVia,
      existingSimilarity: existingMatch.similarity,
      suggestedName: null,
      suggestedReasoning: null,
    };
  }

  if (existingMatch && members.length > 1) {
    const suggestion = await suggestCategoryName(members);
    return {
      mode: 'new-subcategory',
      members,
      existingCategory: existingMatch.category,
      existingMatchedVia: existingMatch.matchedVia,
      existingSimilarity: existingMatch.similarity,
      suggestedName: suggestion?.name ?? null,
      suggestedReasoning: suggestion?.reasoning ?? null,
    };
  }

  const suggestion = await suggestCategoryName(members);
  return {
    mode: 'new-category',
    members,
    existingCategory: null,
    existingMatchedVia: null,
    existingSimilarity: null,
    suggestedName: suggestion?.name ?? null,
    suggestedReasoning: suggestion?.reasoning ?? null,
  };
}

const resolvedClusters = [];
for (const cluster of clusters) resolvedClusters.push(await resolveGroup(cluster));

const resolvedUnclustered = [];
for (const name of unclustered) resolvedUnclustered.push(await resolveGroup([name]));

if (args.json) {
  console.log(JSON.stringify({ orphanCount: orphans.length, clusters: resolvedClusters, unclustered: resolvedUnclustered }));
  await client.end();
  process.exit(0);
}

function printGroup({ mode, members, existingCategory, existingMatchedVia, existingSimilarity, suggestedName, suggestedReasoning }) {
  const names = members.map((m) => m.name);
  console.log(`  [${names.length} recuerdo(s)] ${names.join(', ')}`);
  for (const m of members) {
    console.log(`    - ${m.name} (${m.factCount} registro(s)): "${m.example.slice(0, 90)}"`);
  }

  if (mode === 'link-existing') {
    console.log(`  Encaja con la categoría existente "${existingCategory}" (similitud ${existingSimilarity.toFixed(2)}, por parecido con "${existingMatchedVia}").`);
    console.log(
      `  Si aplica, liga directo:\n` +
        `    node memory-link.mjs --from ${names[0]} --to ${existingCategory} --relation "pertenece_a" --date YYYY-MM-DD --reason "..."\n`,
    );
    return;
  }

  if (mode === 'new-subcategory') {
    const placeholder = suggestedName ?? '<nombre-de-la-subcategoría>';
    console.log(`  Encaja con la categoría existente "${existingCategory}" (similitud ${existingSimilarity.toFixed(2)}, por parecido con "${existingMatchedVia}").`);
    if (suggestedName) console.log(`  Nombre de subcategoría sugerido: "${suggestedName}" (${suggestedReasoning})`);
    console.log(
      `  Si aplica, crea la subcategoría bajo "${existingCategory}" y liga cada miembro:\n` +
        `    node create-memory.mjs --name ${placeholder} --parent ${existingCategory} --date YYYY-MM-DD --reason "..."\n` +
        names.map((n) => `    node memory-link.mjs --from ${n} --to ${placeholder} --relation "pertenece_a" --date YYYY-MM-DD --reason "..."`).join('\n') +
        '\n',
    );
    return;
  }

  if (suggestedName) console.log(`  Nombre sugerido: "${suggestedName}" (${suggestedReasoning})`);
  const placeholder = suggestedName ?? '<nombre-de-la-categoría>';
  console.log(
    `  Si aplica, crea la categoría y liga cada miembro:\n` +
      `    node create-memory.mjs --name ${placeholder}\n` +
      names.map((n) => `    node memory-link.mjs --from ${n} --to ${placeholder} --relation "pertenece_a" --date YYYY-MM-DD --reason "..."`).join('\n') +
      '\n',
  );
}

if (resolvedClusters.length === 0 && resolvedUnclustered.length === 0) {
  console.log(`${orphans.length} recuerdo(s) de dominio sin lugar en la jerarquía, pero ninguno se agrupa con otro por encima de ${threshold} -- cada uno parece genuinamente distinto todavía.`);
  await client.end();
  process.exit(0);
}

if (resolvedClusters.length > 0) {
  console.log(`${resolvedClusters.length} cluster(es) candidato(s) sin agrupar (de ${orphans.length} recuerdo(s) huérfano(s), umbral ${threshold}):\n`);
  for (const group of resolvedClusters) printGroup(group);
}

if (resolvedUnclustered.length > 0) {
  console.log(`${resolvedUnclustered.length} recuerdo(s) huérfano(s) sin ningún otro parecido por encima de ${threshold} -- candidatos igual a categoría propia:\n`);
  for (const group of resolvedUnclustered) printGroup(group);
}
console.log('Revisión humana obligatoria -- ninguna categoría se crea ni se liga sola.');

await client.end();
