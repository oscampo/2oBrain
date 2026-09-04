// Fase 3: lee hechos registrados, opcionalmente filtrados por nodo.
// Fase 4: por defecto solo muestra hechos vigentes (valid_until is null);
// --all incluye los reemplazados, marcados como tal.
// Rediseño 2026-08-29: filtro por page_slug -> filtro por node (fact_nodes).
// Uso: node timeline.mjs [nombre-de-nodo] [--all]
import { readFileSync } from 'node:fs';
import pg from 'pg';

const rawArgs = process.argv.slice(2);
const showAll = rawArgs.includes('--all');
const node = rawArgs.find((a) => !a.startsWith('--')) ?? null;

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

const { rows } = await client.query('select * from facts_timeline($1, $2, $3)', [node, 20, showAll]);

if (rows.length === 0) {
  console.log('Sin hechos registrados' + (node ? ` para el nodo ${node}` : '') + '.');
} else {
  for (const r of rows) {
    const date = r.date.toISOString().slice(0, 10);
    const replaced = r.valid_until ? ` [reemplazado por #${r.superseded_by}]` : '';
    console.log(`\n#${r.id} [${date}] ${r.claim}${replaced}`);
    console.log(`  fuente: ${r.source} · tipo: ${r.kind}${r.nodes ? ` · nodos: ${r.nodes}` : ''}`);
  }
}

await client.end();
