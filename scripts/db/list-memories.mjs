// Lista los recuerdos vigentes (no fusionados a otro): para saber qué pasarle a
// timeline.mjs/remember.mjs --memory sin tener que memorizarlos de antemano, y
// como primera línea de defensa manual contra crear un recuerdo casi-duplicado
// mientras la desambiguación automática (Etapa 2 de PLAN-recuerdos.md) no existe.
// Uso: node list-memories.mjs [--json]
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

const { rows } = await client.query(
  `select name, aliases from memories where merged_into is null order by name`,
);

if (asJson) {
  console.log(JSON.stringify({ memories: rows }));
} else if (rows.length === 0) {
  console.log('No hay recuerdos registrados.');
} else {
  for (const r of rows) {
    console.log(r.name + (r.aliases?.length ? ` (alias: ${r.aliases.join(', ')})` : ''));
  }
}

await client.end();
