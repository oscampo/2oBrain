// Escribe o borra la ficha de definición de un recuerdo (memories.description, ).
// Una o dos frases de qué trata y qué cabe en él; la lee lib/propose-parent.mjs para ubicar
// recuerdos en la jerarquía. Las escribe el usuario (o las aprueba): este script no las inventa.
//
// Uso:
//   node set-memory-description.mjs --memory hardware --description "Dispositivos físicos: ..."
//   node set-memory-description.mjs --memory hardware                    (sin --description: muestra la actual)
//   node set-memory-description.mjs --memory hardware --clear            (borra la ficha)
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const name = opt('--memory');
const desc = opt('--description');
if (!name) { console.error('Uso: node set-memory-description.mjs --memory <nombre> [--description "..." | --clear]'); process.exit(1); }

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(`select name, description, merged_into from memories where name = $1`, [name]);
if (!rows[0]) { console.error(`No existe el recuerdo "${name}".`); await client.end(); process.exit(1); }
if (rows[0].merged_into) { console.error(`"${name}" fue fusionado en "${rows[0].merged_into}": pon la ficha ahí.`); await client.end(); process.exit(1); }

if (args.includes('--clear')) {
  await client.query(`update memories set description = null where name = $1`, [name]);
  console.log(`Ficha de "${name}" borrada.`);
} else if (desc) {
  if (desc.length > 400) { console.error('La ficha debe tener 400 caracteres o menos.'); await client.end(); process.exit(1); }
  await client.query(`update memories set description = $2 where name = $1`, [name, desc]);
  console.log(`Ficha de "${name}" guardada${rows[0].description ? ` (antes: "${rows[0].description}")` : ''}.`);
} else {
  console.log(rows[0].description ? `${name}: ${rows[0].description}` : `${name}: (sin ficha)`);
}
await client.end();
