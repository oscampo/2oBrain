// Lista los slugs de páginas existentes. Desde el rediseño node (2026-08-29,
// ver PLAN-nodos.md) timeline.mjs/remember.mjs ya no toman --slug de hechos
// (ver list-nodes.mjs para eso): esto sigue sirviendo para inspeccionar
// pages tal cual, y para el autocompletado de Timeline en el dashboard viejo.
// Uso: node list-pages.mjs [--json]
import { readFileSync } from 'node:fs';
import pg from 'pg';

const asJson = process.argv.includes('--json');

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

const { rows } = await client.query('select slug, type, title from pages order by slug');

if (asJson) {
  console.log(JSON.stringify({ pages: rows }));
} else if (rows.length === 0) {
  console.log('No hay páginas cargadas.');
} else {
  for (const r of rows) {
    console.log(`${r.slug} (${r.type}), ${r.title}`);
  }
}

await client.end();
