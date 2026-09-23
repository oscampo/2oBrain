// Cruce mecánico de candidatos de morning-briefing contra el segundo
// cerebro. Por qué existe: el paso de "cruza cada candidato de
// mail/calendario contra tus propios registros antes de reportar" es fácil
// de describir en prosa y fácil de saltarse en el momento -- depende de
// que el agente se acuerde de aplicarlo, no de que exista una salida
// obligatoria de la que el reporte tenga que salir. Este script convierte
// ese paso en mecánico: si no se corre, no hay de dónde sacar el texto
// del briefing.
//
// Uso: un item candidato por línea via stdin, formato "etiqueta corta |
// texto de búsqueda" (la etiqueta es solo para el reporte, la búsqueda
// real usa el texto completo). Ejemplo:
//   printf '%s\n' \
//     "Factura pendiente | recordatorio pago factura proveedor X" \
//     "Reunión proyecto Y | correo agenda reunión proyecto Y" \
//   | node scripts/db/briefing-crossref.mjs
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral, rerank } from './lib/embed.mjs';

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

const stdin = readFileSync(0, 'utf8');
const items = stdin
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((line) => {
    const i = line.indexOf('|');
    if (i === -1) return { label: line, query: line };
    return { label: line.slice(0, i).trim(), query: line.slice(i + 1).trim() };
  });

if (items.length === 0) {
  console.error('Sin items por stdin. Uso: "etiqueta | texto de búsqueda" por línea.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const MATCH_FLOOR = 0.3; // piso más alto que search.mjs: acá se busca "¿ya existe esto?", no exploración abierta

for (const { label, query } of items) {
  const queryEmbedding = await embed(query, 'query');
  const vectorLiteral = toVectorLiteral(queryEmbedding);
  const { rows: candidates } = await client.query(`select * from records_search($1, $2, $3, $4)`, [vectorLiteral, query, 8, null]);

  let top = [];
  if (candidates.length > 0) {
    const ranked = await rerank(query, candidates.map((f) => (f.memories ? `[${f.memories}] ${f.claim}` : f.claim)));
    top = ranked.filter((r) => r.relevance_score >= MATCH_FLOOR).slice(0, 3).map((r) => ({ ...candidates[r.index], score: r.relevance_score }));
  }

  console.log(`\n=== ${label} ===`);
  if (top.length === 0) {
    console.log('  SIN COINCIDENCIA -- probablemente genuinamente nuevo, considerar guardar.');
  } else {
    for (const f of top) {
      const preview = f.claim.length > 220 ? f.claim.slice(0, 220) + '…' : f.claim;
      console.log(`  [${f.score.toFixed(2)}] #${f.id} (${f.memories ?? 'sin recuerdo'}): ${preview}`);
    }
  }
}

await client.end();
