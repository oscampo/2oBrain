// Corre lib/detect-memory-mentions.mjs (Etapa 6, co-ocurrencia textual) sobre
// TODOS los registros vigentes existentes -- prueba retroactiva del detector
// contra el histórico real, ya que remember.mjs/remember-batch.mjs solo lo
// disparan hacia adelante, en registros nuevos. Herramienta de revisión, no de
// automatización (mismo principio que el resto de Etapa 6): nunca crea nada
// en memory_links ni record_memories por su cuenta, solo lista candidatos.
// Uso: node list-memory-mentions.mjs
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { detectNodeMentions } from './lib/detect-memory-mentions.mjs';

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

const { rows: allNodes } = await client.query(`select name, aliases from memories where merged_into is null and not is_meta`);

// Excluye registros ligados a un recuerdo is_meta (segundo-cerebro,
// segundo-cerebro-dashboard-log): documentan la construcción del propio
// sistema, así que mencionan otros recuerdos como ejemplos dentro de su propia
// narración (ej. "se probó con el caso john-smith/atlas-2026") --
// eso no es una relación real entre segundo-cerebro y esos recuerdos, es
// autorreferencia. Mismo criterio que ya excluye is_meta del lado del recuerdo
// mencionado, aplicado ahora también al recuerdo dueño del registro.
const { rows: records } = await client.query(
  `select f.id, f.claim,
          coalesce(array_agg(fn.memory_name) filter (where fn.memory_name is not null), '{}') as own_nodes
   from records f
   left join record_memories fn on fn.record_id = f.id
   where f.valid_until is null
     and f.id not in (
       select fn2.record_id from record_memories fn2
       join memories n2 on n2.name = fn2.memory_name
       where n2.is_meta
     )
   group by f.id, f.claim
   order by f.id`,
);

console.error(`Revisando ${records.length} registro(s) vigente(s) contra ${allNodes.length} recuerdo(s) de dominio...`);

// Agrupa por PAR de recuerdos (no por registro individual) -- si varios registros
// mencionan el mismo par, alcanza con verlo una vez para decidir si vale la
// pena conectar con memory-link.mjs.
const byPair = new Map();
for (const f of records) {
  const mentions = detectNodeMentions(f.claim, f.own_nodes, allNodes);
  for (const m of mentions) {
    for (const ownNode of f.own_nodes) {
      const [a, b] = [ownNode, m.node].sort((x, y) => x.localeCompare(y));
      const key = `${a}|${b}`;
      if (!byPair.has(key)) byPair.set(key, { a, b, examples: [] });
      byPair.get(key).examples.push({ recordId: f.id, claim: f.claim, matchedOn: m.matchedOn });
    }
  }
}

if (byPair.size === 0) {
  console.log('Ningún registro vigente menciona a otro recuerdo por nombre/alias. Nada que revisar.');
} else {
  console.log(`${byPair.size} par(es) de recuerdos con mención textual directa:\n`);
  for (const { a, b, examples } of byPair.values()) {
    console.log(`"${a}" <-> "${b}" (${examples.length} registro(s)):`);
    for (const ex of examples.slice(0, 3)) {
      console.log(`  #${ex.recordId} (coincide con "${ex.matchedOn}"): ${ex.claim.slice(0, 140)}${ex.claim.length > 140 ? '…' : ''}`);
    }
    if (examples.length > 3) console.log(`  ... y ${examples.length - 3} más`);
    console.log(`  memory-link.mjs --from ${a} --to ${b} --relation "..." --date YYYY-MM-DD --reason "..."`);
    console.log('');
  }
}

await client.end();
