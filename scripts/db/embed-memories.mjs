// Backfill del embedding de IDENTIDAD de cada recuerdo (nombre + alias),
// distinto de memories_similar (que compara contra el CONTENIDO de los
// registros de cada recuerdo, pensado para "a qué recuerdo pertenece este
// registro nuevo", no para "la pregunta nombra/parafrasea este recuerdo").
// Ver comentario en schema.sql junto a memories_match_query para el porqué:
// probado en vivo (portado desde D:\MyBrain) que comparar por contenido daba
// ruido real (un recuerdo rankeaba 9no en su propia pregunta), comparar por
// nombre+alias separa bien. Texto corto a propósito (nunca todo el
// contenido del recuerdo), es la identidad, no el contenido.
//
// Ni create-memory.mjs ni remember.mjs generan este embedding al crear un
// recuerdo (verificado, no lo hacen); este script es el único camino para
// poblarlo, tanto para los recuerdos que ya existían antes de esta
// migración como para cualquiera nuevo, o si se le cambia el alias a
// alguno a mano.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral, memoryIdentityText, BATCH_DELAY_MS } from './lib/embed.mjs';

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
  'select name, aliases from memories where embedding is null and merged_into is null order by name',
);
console.log(`Generando embeddings de identidad para ${rows.length} recuerdo(s) sin embedding (Voyage)...`);

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const vector = await embed(memoryIdentityText(row.name, row.aliases), 'document');
  await client.query('update memories set embedding = $1 where name = $2', [
    toVectorLiteral(vector),
    row.name,
  ]);
  console.log(`  ${row.name} (${vector.length} dims)`);
  if (i < rows.length - 1) await sleep(BATCH_DELAY_MS);
}

console.log('\nListo.');
await client.end();
