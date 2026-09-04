// Datos crudos del grafo (nodes, fact_nodes, node_edges) en JSON para la
// visualización interactiva del dashboard -- reescrito 2026-09-03: la
// versión anterior calculaba el layout (posiciones x/y) y emitía SVG
// estático en el servidor, con heurísticas propias por tipo de componente
// (estrella de 1 nivel, árbol por niveles, círculo genérico). Tras la
// reestructuración del grafo en categorías de nodos (trabajo, proyectos
// personales, vida personal), el usuario pidió algo más cercano a lo que ya conoce de
// LightRAG/Obsidian: un grafo dirigido por fuerzas (force-directed),
// interactivo -- arrastrar nodos, zoom, clic para explorar. Eso requiere
// que la física corra en el navegador (d3-force, vendorizado en
// server/public/vendor/d3.v7.min.js), así que este script deja de generar
// HTML/SVG y solo expone los datos; el layout completo vive en
// server/public/index.html (sección "Grafo").
// Uso: node graph.mjs   (imprime {"nodes":[...],"edges":[...]} a stdout)
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

const { rows: nodeRows } = await client.query(`
  select n.name, n.is_meta, count(fn.fact_id)::int as fact_count
  from nodes n
  left join fact_nodes fn on fn.node_name = n.name
  where n.merged_into is null
  group by n.name, n.is_meta
  order by n.name
`);

const { rows: edgeRows } = await client.query(`
  select from_node, to_node, relation from node_edges order by from_node, to_node
`);

await client.end();

console.log(JSON.stringify({
  nodes: nodeRows.map((r) => ({ name: r.name, factCount: r.fact_count, isMeta: r.is_meta })),
  edges: edgeRows.map((r) => ({ from: r.from_node, to: r.to_node, relation: r.relation })),
}));
