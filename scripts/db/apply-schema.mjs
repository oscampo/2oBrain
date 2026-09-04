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

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
await client.query(schema);
console.log('Esquema aplicado.');

const { rows } = await client.query(
  `select column_name, data_type from information_schema.columns where table_name = 'pages' order by ordinal_position`,
);
console.table(rows);

await client.end();
