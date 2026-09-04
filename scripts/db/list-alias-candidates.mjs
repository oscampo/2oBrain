// Backfill guiado de alias (Etapa 6, 2026-09-02, decisión del usuario tras el
// hecho #493): recorre los nodos de dominio con aliases vacío y propone
// candidatos -- (a) determinísticos, gratis: nombres de nodos ya fusionados
// (merged_into) que apuntan a este pero cuyo nombre nunca quedó plegado como
// alias (ver merge-nodes.mjs); (b) sugeridos por lib/classify-aliases.mjs a
// partir del texto de los propios hechos del nodo, verificados contra ese
// texto antes de mostrarse. Solo lectura -- nunca escribe en `nodes`, imprime
// el comando `set-node-aliases.mjs` listo para que el usuario apruebe/edite/corra.
// Uso: node list-alias-candidates.mjs [nombre-de-nodo]  (por defecto, todos los que tengan aliases vacío)
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { classifyAliases, classifierEnabled } from './lib/classify-aliases.mjs';

const onlyNode = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

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

if (!classifierEnabled) {
  console.error('OLLAMA_API_KEY no configurado -- solo se mostrarán candidatos determinísticos (nodos fusionados), sin extracción desde hechos.');
}

const { rows: targets } = await client.query(
  `select name from nodes
   where merged_into is null and not is_meta and (aliases is null or aliases = '{}')
   ${onlyNode ? 'and name = $1' : ''}
   order by name`,
  onlyNode ? [onlyNode] : [],
);

if (targets.length === 0) {
  console.log(onlyNode ? `"${onlyNode}" no calza (no existe, ya tiene aliases, o está fusionado/es is_meta).` : 'Ningún nodo de dominio con aliases vacío. Nada que backfillear.');
  await client.end();
  process.exit();
}

console.log(`Revisando ${targets.length} nodo(s) sin alias...\n`);

for (const { name } of targets) {
  console.log(`=== ${name} ===`);
  const candidates = new Set();

  // (a) determinístico: nombres de nodos fusionados hacia este que nunca quedaron plegados como alias
  const { rows: mergedAway } = await client.query(`select name from nodes where merged_into = $1`, [name]);
  for (const r of mergedAway) candidates.add(r.name);

  // (b) sugerido: extracción desde el texto de los propios hechos del nodo
  const { rows: facts } = await client.query(
    `select f.claim from facts f join fact_nodes fn on fn.fact_id = f.id
     where fn.node_name = $1 and f.valid_until is null order by f.id`,
    [name],
  );
  const factsText = facts.map((f) => `- ${f.claim}`).join('\n');
  const suggested = await classifyAliases(name, factsText);
  if (suggested) for (const a of suggested) candidates.add(a);

  if (candidates.size === 0) {
    console.log('  (sin candidatos -- ni fusiones pendientes de plegar, ni formas naturales detectadas en sus hechos)\n');
    continue;
  }

  const list = [...candidates];
  console.log(`  Candidatos: ${list.join(' | ')}`);
  console.log(`  node set-node-aliases.mjs --node ${name} --aliases "${list.join(',')}" --reason "backfill guiado, aprobado por el usuario"\n`);
}

await client.end();
