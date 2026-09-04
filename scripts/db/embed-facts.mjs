// Backfill de embeddings para facts que quedaron con embedding = null (ej.
// tras la migración de dimensión a Voyage, 2026-08-22). remember.mjs ya
// genera el embedding al insertar un hecho nuevo, este script es solo para
// rellenar los que quedaron atrás. input_type 'document' (mismo criterio
// que embed-pages.mjs: es contenido almacenado, no una consulta).
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
  'select id, claim from facts where embedding is null order by id',
);
console.log(`Generando embeddings para ${rows.length} hechos sin embedding (Voyage)...`);
console.log(`Sin tarjeta en la cuenta, throttled a ~3/min (${BATCH_DELAY_MS / 1000}s entre llamadas).`);

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const vector = await embed(row.claim, 'document');
  await client.query('update facts set embedding = $1 where id = $2', [
    toVectorLiteral(vector),
    row.id,
  ]);
  console.log(`  #${row.id} (${vector.length} dims)`);
  if (i < rows.length - 1) await sleep(BATCH_DELAY_MS);
}

console.log('\nListo.');
await client.end();
