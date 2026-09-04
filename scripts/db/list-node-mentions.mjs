// Corre lib/detect-node-mentions.mjs (Etapa 6, co-ocurrencia textual) sobre
// TODOS los hechos vigentes existentes -- prueba retroactiva del detector
// contra el histórico real, ya que remember.mjs/remember-batch.mjs solo lo
// disparan hacia adelante, en hechos nuevos. Herramienta de revisión, no de
// automatización (mismo principio que el resto de Etapa 6): nunca crea nada
// en node_edges ni fact_nodes por su cuenta, solo lista candidatos.
// Uso: node list-node-mentions.mjs
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { detectNodeMentions } from './lib/detect-node-mentions.mjs';

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

const { rows: allNodes } = await client.query(`select name, aliases from nodes where merged_into is null and not is_meta`);

// Excluye hechos ligados a un nodo is_meta (segundo-cerebro,
// segundo-cerebro-dashboard-log): documentan la construcción del propio
// sistema, así que mencionan otros nodos como ejemplos dentro de su propia
// narración (ej. "se probó con el caso john-smith/atlas-2026") --
// eso no es una relación real entre segundo-cerebro y esos nodos, es
// autorreferencia. Mismo criterio que ya excluye is_meta del lado del nodo
// mencionado, aplicado ahora también al nodo dueño del hecho.
const { rows: facts } = await client.query(
  `select f.id, f.claim,
          coalesce(array_agg(fn.node_name) filter (where fn.node_name is not null), '{}') as own_nodes
   from facts f
   left join fact_nodes fn on fn.fact_id = f.id
   where f.valid_until is null
     and f.id not in (
       select fn2.fact_id from fact_nodes fn2
       join nodes n2 on n2.name = fn2.node_name
       where n2.is_meta
     )
   group by f.id, f.claim
   order by f.id`,
);

console.error(`Revisando ${facts.length} hecho(s) vigente(s) contra ${allNodes.length} nodo(s) de dominio...`);

// Agrupa por PAR de nodos (no por hecho individual) -- si varios hechos
// mencionan el mismo par, alcanza con verlo una vez para decidir si vale la
// pena conectar con node-link.mjs.
const byPair = new Map();
for (const f of facts) {
  const mentions = detectNodeMentions(f.claim, f.own_nodes, allNodes);
  for (const m of mentions) {
    for (const ownNode of f.own_nodes) {
      const [a, b] = [ownNode, m.node].sort((x, y) => x.localeCompare(y));
      const key = `${a}|${b}`;
      if (!byPair.has(key)) byPair.set(key, { a, b, examples: [] });
      byPair.get(key).examples.push({ factId: f.id, claim: f.claim, matchedOn: m.matchedOn });
    }
  }
}

if (byPair.size === 0) {
  console.log('Ningún hecho vigente menciona a otro nodo por nombre/alias. Nada que revisar.');
} else {
  console.log(`${byPair.size} par(es) de nodos con mención textual directa:\n`);
  for (const { a, b, examples } of byPair.values()) {
    console.log(`"${a}" <-> "${b}" (${examples.length} hecho(s)):`);
    for (const ex of examples.slice(0, 3)) {
      console.log(`  #${ex.factId} (coincide con "${ex.matchedOn}"): ${ex.claim.slice(0, 140)}${ex.claim.length > 140 ? '…' : ''}`);
    }
    if (examples.length > 3) console.log(`  ... y ${examples.length - 3} más`);
    console.log(`  node-link.mjs --from ${a} --to ${b} --relation "..." --date YYYY-MM-DD --reason "..."`);
    console.log('');
  }
}

await client.end();
