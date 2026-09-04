// Herramienta de revisión, no de automatización (mismo principio que
// list-merge-candidates.mjs/list-edge-candidates-deep.mjs): detecta nodos de
// dominio que quedaron sin ningún lugar en la jerarquía -- ni son hijos de
// nada (`pertenece_a` saliente) ni son padre de nada (`pertenece_a`
// entrante) -- y los agrupa en clusters temáticos por similitud de sus
// hechos, para proponer un supernodo nuevo que los agrupe.
//
// Nace de una idea de Oscar (2026-09-04): un "Asistente" que sugiriera esto
// proactivamente al usuario nuevo de 2oBrain (día 1, luego semanal). Se
// descartó la versión proactiva -- mismo patrón que ya se probó y se
// abandonó con el hook Stop (ver MEMORY.md, hecho #153-155): un push
// disparado por el sistema en vez de pedido por el usuario genera más
// fricción que valor, y el disparo "al día siguiente del primer uso" no
// tiene señal real todavía (un día de hechos es ruido). Esta versión queda
// bajo demanda (el usuario la corre cuando siente el grafo desordenado,
// igual que list-merge-candidates.mjs/list-edge-candidates-deep.mjs).
//
// Por qué "sin padre Y sin hijo" y no solo "sin padre": un supernodo raíz
// legítimo (ej. trabajo-uao) tampoco tiene `pertenece_a` saliente -- excluirlo
// solo por eso lo marcaría como huérfano cuando en realidad ya cumple su rol
// de agrupador. Lo que se busca es un nodo que no participa en la jerarquía
// en ningún sentido, no un nodo en la raíz de la jerarquía.
//
// Clustering: reusa el filtro de "similitud máxima entre hechos individuales
// de cada nodo" ya validado en list-edge-candidates-deep.mjs (mejor señal
// que promediar/centroide, ver ese archivo) -- pares por encima del umbral
// se agrupan por componentes conexas (union-find), no solo pares sueltos,
// para que A-B-C parecidos entre sí salgan como un solo cluster de 3 en vez
// de 3 pares redundantes.
//
// PELIGRO real, ya materializado (2026-09-04): `relation` en node_edges es
// texto libre A PROPÓSITO (ver schema.sql, comentario sobre node_edges --
// "la variedad de relaciones humanas reales no cabe bien en una lista
// cerrada"). El chequeo de jerarquía de este script compara contra el string
// literal 'pertenece_a' abajo -- si en algún momento se usa OTRO texto para
// el mismo significado ("es parte de", "agrupa a", lo que sea), esos nodos
// se reportan como huérfanos aunque ya tengan hogar. Pasó de verdad: la
// reestructuración del 2026-09-03 (hecho #522) había usado 'hace parte de'
// para 6 edges, la primera corrida de este script las marcó como cluster
// candidato (falso positivo, cluster de 5 nodos ya conectados entre sí desde
// hacía un día). Se migraron esos 6 edges a 'pertenece_a' (único valor usado
// para jerarquía desde entonces, 31 de 37 edges totales al momento de
// escribir esto) en vez de generalizar el chequeo a "cualquier edge cuenta"
// -- eso habría diluido la detección real (un nodo con solo un
// `colabora_con` y ningún lugar en la jerarquía debe seguir apareciendo como
// candidato). Si esto vuelve a pasar, la corrección es la misma: unificar el
// texto de relación usado para jerarquía, no ensanchar el chequeo de este
// script.
//
// Sugerencia de nombre (2026-09-04, pedido de Oscar tras ver que la sección
// del dashboard solo mostraba texto sin ninguna acción posible, a diferencia
// de "Extraer de página"): cada cluster trae, además de los miembros, un
// nombre de supernodo propuesto (lib/suggest-supernode-name.mjs, mismo
// modelo barato que classify-node.mjs) -- best-effort, nunca bloquea: si el
// clasificador no está disponible, suggestedName queda null y el dashboard
// simplemente deja el campo vacío para que el usuario escriba a mano.
//
// Uso:
//   node list-supernode-candidates.mjs [--threshold 0.75] [--min-cluster 2] [--json]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { suggestSupernodeName } from './lib/suggest-supernode-name.mjs';

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

// Nodo de dominio, con al menos un hecho vigente, que no participa en
// node_edges (relation pertenece_a) en ningún sentido -- ni hijo ni padre.
const { rows: orphans } = await client.query(`
  select n.name, count(fn.fact_id)::int as fact_count
  from nodes n
  join fact_nodes fn on fn.node_name = n.name
  join facts f on f.id = fn.fact_id and f.valid_until is null
  where n.merged_into is null and not n.is_meta
    and not exists (select 1 from node_edges e where e.from_node = n.name and e.relation = 'pertenece_a')
    and not exists (select 1 from node_edges e where e.to_node = n.name and e.relation = 'pertenece_a')
  group by n.name
  order by n.name
`);

if (orphans.length < minCluster) {
  if (args.json) {
    console.log(JSON.stringify({ orphanCount: orphans.length, clusters: [] }));
  } else {
    console.log(`${orphans.length} nodo(s) de dominio sin lugar en la jerarquía -- menos que --min-cluster (${minCluster}), nada que agrupar todavía.`);
  }
  await client.end();
  process.exit(0);
}

const names = orphans.map((o) => o.name);
const { rows: maxSims } = await client.query(
  `select fn1.node_name as node_a, fn2.node_name as node_b,
          max(1 - (f1.embedding <=> f2.embedding)) as similarity
   from fact_nodes fn1
   join facts f1 on f1.id = fn1.fact_id and f1.valid_until is null and f1.embedding is not null
   join fact_nodes fn2 on fn2.node_name = any($1::text[]) and fn2.node_name > fn1.node_name
   join facts f2 on f2.id = fn2.fact_id and f2.valid_until is null and f2.embedding is not null
   where fn1.node_name = any($1::text[])
   group by fn1.node_name, fn2.node_name
   having max(1 - (f1.embedding <=> f2.embedding)) >= $2`,
  [names, threshold],
);

// Componentes conexas por union-find: un cluster es un grupo de nodos donde
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
for (const s of maxSims) union(s.node_a, s.node_b);

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
    `select claim from facts f join fact_nodes fn on fn.fact_id = f.id
     where fn.node_name = $1 and f.valid_until is null order by f.date desc limit 1`,
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
  console.log(`${orphans.length} nodo(s) de dominio sin lugar en la jerarquía, pero ninguno se agrupa con otro por encima de ${threshold} -- cada uno parece genuinamente distinto todavía.`);
  await client.end();
  process.exit(0);
}

console.log(`${resolvedClusters.length} cluster(es) candidato(s) sin agrupar (de ${orphans.length} nodo(s) huérfano(s), umbral ${threshold}):\n`);
for (const { members, suggestedName, suggestedReasoning } of resolvedClusters) {
  const names = members.map((m) => m.name);
  console.log(`  [${names.length} nodos] ${names.join(', ')}`);
  for (const m of members) {
    console.log(`    - ${m.name} (${m.factCount} hecho(s)): "${m.example.slice(0, 90)}"`);
  }
  if (suggestedName) console.log(`  Nombre sugerido: "${suggestedName}" (${suggestedReasoning})`);
  const placeholder = suggestedName ?? '<nombre-del-supernodo>';
  console.log(
    `  Si aplica, crea el supernodo y liga cada miembro:\n` +
      `    node create-node.mjs --name ${placeholder}\n` +
      names.map((n) => `    node node-link.mjs --from ${n} --to ${placeholder} --relation "pertenece_a" --date YYYY-MM-DD --reason "..."`).join('\n') +
      '\n',
  );
}
console.log('Revisión humana obligatoria -- ningún supernodo se crea ni se liga solo.');

await client.end();
