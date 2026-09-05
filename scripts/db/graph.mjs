// Datos crudos del grafo (memories, record_memories, memory_links) en JSON para la
// visualización interactiva del dashboard -- reescrito 2026-09-03: la
// versión anterior calculaba el layout (posiciones x/y) y emitía SVG
// estático en el servidor, con heurísticas propias por tipo de componente
// (estrella de 1 nivel, árbol por niveles, círculo genérico). Tras la
// reestructuración del grafo en categorías de recuerdos (trabajo, proyectos
// personales, vida personal), el usuario pidió algo más cercano a lo que ya conoce de
// LightRAG/Obsidian: un grafo dirigido por fuerzas (force-directed),
// interactivo -- arrastrar recuerdos, zoom, clic para explorar. Eso requiere
// que la física corra en el navegador (d3-force, vendorizado en
// server/public/vendor/d3.v7.min.js), así que este script deja de generar
// HTML/SVG y solo expone los datos; el layout completo vive en
// server/public/index.html (sección "Grafo").
// Uso: node graph.mjs   (imprime {"memories":[...],"edges":[...]} a stdout)
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
  select n.name, n.is_meta, count(fn.record_id)::int as fact_count
  from memories n
  left join record_memories fn on fn.memory_name = n.name
  where n.merged_into is null
  group by n.name, n.is_meta
  order by n.name
`);

const { rows: edgeRows } = await client.query(`
  select from_memory, to_memory, relation from memory_links order by from_memory, to_memory
`);

await client.end();

console.log(JSON.stringify({
  memories: nodeRows.map((r) => ({ name: r.name, factCount: r.fact_count, isMeta: r.is_meta })),
  edges: edgeRows.map((r) => ({ from: r.from_memory, to: r.to_memory, relation: r.relation })),
}));
