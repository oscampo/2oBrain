// Recorrido multi-salto sobre memory_links -- cierra la brecha real frente a
// LightRAG identificada en conversación (2026-09-14): el grafo recuerdo-a-
// recuerdo ya existe (memory_links, creado a mano o vía
// list-link-candidates-deep.mjs) pero graph.mjs solo lo expone completo para
// visualización, no hay forma de preguntar "qué conecta a X con Y" o "qué es
// alcanzable desde X en N saltos" sin mirar el grafo entero a ojo. No agrega
// tablas nuevas ni un nivel de granularidad de entidades: reutiliza
// memory_links tal cual, tratado como grafo no dirigido (una colaboración o
// pertenencia se puede recorrer en cualquier sentido), con BFS en JS (misma
// resolución de merged_into que graph.mjs) -- a la escala real (57 recuerdos
// vivos, 72 enlaces) un recorrido en memoria es instantáneo, no hace falta
// CTE recursiva en Postgres.
// Uso:
//   node traverse.mjs --from <recuerdo> [--max-hops N]              (todo lo alcanzable, BFS de salida, N por defecto 3)
//   node traverse.mjs --from <recuerdo> --to <recuerdo> [--max-hops N]   (camino más corto entre ambos, si existe dentro de N saltos)
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { resolveLiveMemory } from './lib/create-link.mjs';

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

const USAGE =
  'Uso:\n' +
  '  node traverse.mjs --from <recuerdo> [--max-hops N]\n' +
  '  node traverse.mjs --from <recuerdo> --to <recuerdo> [--max-hops N]';

if (!args.from) {
  console.error(USAGE);
  process.exit(1);
}

const maxHops = args['max-hops'] ? parseInt(args['max-hops'], 10) : 3;
if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 8) {
  console.error('--max-hops debe ser un entero entre 1 y 8 (grafo personal, no hace falta más).');
  process.exit(1);
}

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

async function resolveLiveOrExit(name) {
  const result = await resolveLiveMemory(client, name);
  if (!result.ok) {
    console.error(`${result.error} Revisa el nombre con list-memories.mjs.`);
    await client.end();
    process.exit(1);
  }
  return result.name;
}

const start = await resolveLiveOrExit(args.from);
const target = args.to ? await resolveLiveOrExit(args.to) : null;

if (target && start === target) {
  console.error(`"${args.from}" y "${args.to}" resuelven al mismo recuerdo vigente ("${start}").`);
  await client.end();
  process.exit(1);
}

// Mismo saneo que graph.mjs: memory_links puede apuntar a un nombre viejo que
// ya fue fusionado (merge-memories.mjs no reescribe memory_links), así que
// toda arista se normaliza a su recuerdo vivo antes de construir la lista de
// adyacencia.
const { rows: allMemories } = await client.query(`select name, merged_into from memories`);
const mergedIntoOf = new Map(allMemories.map((r) => [r.name, r.merged_into]));
function resolveLive(name) {
  const seen = new Set();
  let current = name;
  while (mergedIntoOf.get(current) && !seen.has(current)) {
    seen.add(current);
    current = mergedIntoOf.get(current);
  }
  return current;
}

const { rows: edgeRows } = await client.query(
  `select from_memory, to_memory, relation, date from memory_links order by date`,
);
await client.end();

const adj = new Map(); // node -> [{to, relation, date}]
function addEdge(a, b, relation, date) {
  if (!adj.has(a)) adj.set(a, []);
  adj.get(a).push({ to: b, relation, date });
}
const seenEdgeKeys = new Set();
for (const r of edgeRows) {
  const from = resolveLive(r.from_memory);
  const to = resolveLive(r.to_memory);
  if (from === to) continue;
  const key = `${from}|${to}|${r.relation}`;
  if (seenEdgeKeys.has(key)) continue; // fusión pudo colapsar dos aristas distintas en una sola
  seenEdgeKeys.add(key);
  addEdge(from, to, r.relation, r.date);
  addEdge(to, from, r.relation, r.date); // no dirigido a propósito, ver comentario de cabecera
}

// BFS estándar: en un grafo no ponderado, la primera vez que se alcanza un
// nodo es siempre por el camino más corto, así que no hace falta Dijkstra.
const visited = new Map(); // node -> { depth, path: [{node, relation, date}] }
visited.set(start, { depth: 0, path: [{ node: start, relation: null, date: null }] });
const queue = [start];
let qi = 0;
while (qi < queue.length) {
  const node = queue[qi++];
  const info = visited.get(node);
  if (info.depth >= maxHops) continue;
  for (const edge of adj.get(node) || []) {
    if (visited.has(edge.to)) continue;
    visited.set(edge.to, {
      depth: info.depth + 1,
      path: [...info.path, { node: edge.to, relation: edge.relation, date: edge.date }],
    });
    queue.push(edge.to);
  }
}

function formatPath(path) {
  let out = path[0].node;
  for (let i = 1; i < path.length; i++) {
    out += ` --(${path[i].relation})--> ${path[i].node}`;
  }
  return out;
}

if (target) {
  const info = visited.get(target);
  if (!info) {
    console.log(`Sin conexión encontrada entre "${start}" y "${target}" dentro de ${maxHops} salto(s).`);
  } else {
    console.log(`Camino más corto (${info.depth} salto(s)):`);
    console.log(`  ${formatPath(info.path)}`);
  }
} else {
  const reached = [...visited.entries()].filter(([node]) => node !== start);
  if (reached.length === 0) {
    console.log(`"${start}" no tiene ninguna conexión registrada en memory_links.`);
  } else {
    console.log(`Alcanzable desde "${start}" en hasta ${maxHops} salto(s): ${reached.length} recuerdo(s).\n`);
    for (const [node, info] of reached.sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]))) {
      console.log(`[${info.depth} salto(s)] ${node}`);
      console.log(`  ${formatPath(info.path)}`);
    }
  }
}
