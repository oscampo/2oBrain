// Genera embeddings con Voyage AI (voyage-4-lite, 1024 dims, multilingüe)
// solo para páginas nuevas o con contenido cambiado desde el último embed
// (embedded_at is null or embedded_at < updated_at). Antes re-embebía las
// 30 páginas en cada corrida sin importar si algo cambió: con Ollama
// local eso era gratis, con Voyage es texto real mandado a una API de pago
// sin necesidad. input_type 'document' porque esto es contenido
// almacenado, no una consulta de búsqueda (ver lib/embed.mjs).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral, BATCH_DELAY_MS } from './lib/embed.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const { rows } = await client.query(
  `select id, slug, title, content from pages
   where embedded_at is null or embedded_at < updated_at
   order by id`,
);

if (rows.length === 0) {
  console.log('Nada que re-embeber, todas las páginas ya están al día.');
  await client.end();
  process.exit(0);
}

console.log(`Generando embeddings para ${rows.length} página(s) nueva(s)/cambiada(s) (Voyage)...`);
console.log(`Delay entre llamadas: ${BATCH_DELAY_MS}ms.`);

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const full = `${row.title ?? ''}\n\n${row.content}`;
  const vector = await embed(full, 'document');
  await client.query('update pages set embedding = $1, embedded_at = now() where id = $2', [
    toVectorLiteral(vector),
    row.id,
  ]);
  console.log(`  ${row.slug} (${vector.length} dims, ${full.length} chars)`);
  if (i < rows.length - 1) await sleep(BATCH_DELAY_MS);
}

console.log('\nListo.');
await client.end();
