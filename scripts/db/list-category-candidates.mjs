// Herramienta de revisión, no de automatización (mismo principio que
// list-merge-candidates.mjs/list-link-candidates-deep.mjs): detecta recuerdos de
// dominio que quedaron sin ningún lugar en la jerarquía -- ni son hijos de
// nada (`pertenece_a` saliente) ni son padre de nada (`pertenece_a`
// entrante) -- y los agrupa en clusters temáticos por similitud de sus
// registros, para proponer una categoría nueva que los agrupe.
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
// Por qué "sin padre Y sin hijo" y no solo "sin padre": una categoría raíz
// legítimo (ej. trabajo-uao) tampoco tiene `pertenece_a` saliente -- excluirlo
// solo por eso lo marcaría como huérfano cuando en realidad ya cumple su rol
// de agrupador. Lo que se busca es un recuerdo que no participa en la jerarquía
// en ningún sentido, no un recuerdo en la raíz de la jerarquía.
//
// Clustering: reusa el filtro de "similitud máxima entre registros individuales
// de cada recuerdo" ya validado en list-link-candidates-deep.mjs (mejor señal
// que promediar/centroide, ver ese archivo) -- pares por encima del umbral
// se agrupan por componentes conexas (union-find), no solo pares sueltos,
// para que A-B-C parecidos entre sí salgan como un solo cluster de 3 en vez
// de 3 pares redundantes.
//
// PELIGRO real, ya materializado (2026-09-04): `relation` en memory_links es
// texto libre A PROPÓSITO (ver schema.sql, comentario sobre memory_links --
// "la variedad de relaciones humanas reales no cabe bien en una lista
// cerrada"). El chequeo de jerarquía de este script compara contra el string
// literal 'pertenece_a' abajo -- si en algún momento se usa OTRO texto para
// el mismo significado ("es parte de", "agrupa a", lo que sea), esos recuerdos
// se reportan como huérfanos aunque ya tengan hogar. Pasó de verdad: la
// reestructuración del 2026-09-03 (registro #522) había usado 'hace parte de'
// para 6 edges, la primera corrida de este script las marcó como cluster
// candidato (falso positivo, cluster de 5 recuerdos ya conectados entre sí desde
// hacía un día). Se migraron esos 6 edges a 'pertenece_a' (único valor usado
// para jerarquía desde entonces, 31 de 37 edges totales al momento de
// escribir esto) en vez de generalizar el chequeo a "cualquier edge cuenta"
// -- eso habría diluido la detección real (un recuerdo con solo un
// `colabora_con` y ningún lugar en la jerarquía debe seguir apareciendo como
// candidato). Si esto vuelve a pasar, la corrección es la misma: unificar el
// texto de relación usado para jerarquía, no ensanchar el chequeo de este
// script.
//
// Sugerencia de nombre (2026-09-04, pedido de Oscar tras ver que la sección
// del dashboard solo mostraba texto sin ninguna acción posible, a diferencia
// de "Extraer de página"): cada cluster trae, además de los miembros, un
// nombre de categoría propuesto (lib/suggest-category-name.mjs, mismo
// modelo barato que classify-memory.mjs) -- best-effort, nunca bloquea: si el
// clasificador no está disponible, suggestedName queda null y el dashboard
// simplemente deja el campo vacío para que el usuario escriba a mano.
//
// Uso:
//   node list-category-candidates.mjs [--threshold 0.75] [--min-cluster 2] [--json]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { suggestSupernodeName } from './lib/suggest-category-name.mjs';

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
// memory_links (relation pertenece_a) en ningún sentido -- ni hijo ni padre.
const { rows: orphans } = await client.query(`
  select n.name, count(fn.record_id)::int as fact_count
  from memories n
  join record_memories fn on fn.memory_name = n.name
  join records f on f.id = fn.record_id and f.valid_until is null
  where n.merged_into is null and not n.is_meta
    and not exists (select 1 from memory_links e where e.from_memory = n.name and e.relation = 'pertenece_a')
    and not exists (select 1 from memory_links e where e.to_memory = n.name and e.relation = 'pertenece_a')
  group by n.name
  order by n.name
`);

if (orphans.length < minCluster) {
  if (args.json) {
    console.log(JSON.stringify({ orphanCount: orphans.length, clusters: [] }));
  } else {
    console.log(`${orphans.length} recuerdo(s) de dominio sin lugar en la jerarquía -- menos que --min-cluster (${minCluster}), nada que agrupar todavía.`);
  }
  await client.end();
  process.exit(0);
}

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

const factCountByName = new Map(orphans.map((o) => [o.name, o.fact_count]));
const clusters = [...groups.values()]
  .filter((g) => g.length >= minCluster)
  .map((g) => g.sort((a, b) => a.localeCompare(b)))
  .sort((a, b) => b.length - a.length);

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
// consultas/llamadas al clasificador.
const resolvedClusters = [];
for (const cluster of clusters) {
  const members = [];
  for (const name of cluster) {
    members.push({ name, factCount: factCountByName.get(name), example: await exampleClaim(name) });
  }
  const suggestion = await suggestSupernodeName(members);
  resolvedClusters.push({ members, suggestedName: suggestion?.name ?? null, suggestedReasoning: suggestion?.reasoning ?? null });
}

if (args.json) {
  console.log(JSON.stringify({ orphanCount: orphans.length, clusters: resolvedClusters }));
  await client.end();
  process.exit(0);
}

if (resolvedClusters.length === 0) {
  console.log(`${orphans.length} recuerdo(s) de dominio sin lugar en la jerarquía, pero ninguno se agrupa con otro por encima de ${threshold} -- cada uno parece genuinamente distinto todavía.`);
  await client.end();
  process.exit(0);
}

console.log(`${resolvedClusters.length} cluster(es) candidato(s) sin agrupar (de ${orphans.length} recuerdo(s) huérfano(s), umbral ${threshold}):\n`);
for (const { members, suggestedName, suggestedReasoning } of resolvedClusters) {
  const names = members.map((m) => m.name);
  console.log(`  [${names.length} recuerdos] ${names.join(', ')}`);
  for (const m of members) {
    console.log(`    - ${m.name} (${m.factCount} registro(s)): "${m.example.slice(0, 90)}"`);
  }
  if (suggestedName) console.log(`  Nombre sugerido: "${suggestedName}" (${suggestedReasoning})`);
  const placeholder = suggestedName ?? '<nombre-del-categoría>';
  console.log(
    `  Si aplica, crea la categoría y liga cada miembro:\n` +
      `    node create-memory.mjs --name ${placeholder}\n` +
      names.map((n) => `    node memory-link.mjs --from ${n} --to ${placeholder} --relation "pertenece_a" --date YYYY-MM-DD --reason "..."`).join('\n') +
      '\n',
  );
}
console.log('Revisión humana obligatoria -- ningún categoría se crea ni se liga solo.');

await client.end();
