// Catch-up de sesión: qué cambió en segundo-cerebro desde la última vez que
// se corrió esto en esta máquina. Adaptado del concepto de `gbrain delta` /
// `context-pack`, pero sobre el backend real (Postgres compartido, sin
// proceso local): usa `pages.updated_at` y `facts.created_at`, que ya
// existen, en vez de un mecanismo de "thread-id" propio.
// Uso: node delta.mjs [--since 2026-08-20T00:00:00Z] [--budget-tokens 4000] [--no-advance] [--quiet]
//
// --quiet (2026-09-03): para cuando lo que cambió fue producido por el usuario en
// otra sesión/máquina, no algo que Claude necesite repasar palabra por
// palabra -- el recuento completo ya vive en `facts`/`pages` y es
// consultable con search.mjs cuando haga falta un detalle puntual. Sin esto,
// "ponte al día" siempre imprimía el detalle completo (truncado si excedía
// el presupuesto de tokens, perdiendo ítems sin decirlo con claridad), que
// paral usuario no aporta nada: lo que él quiere saber es si quedó capturado y
// cuánto, no una relectura de su propio trabajo. --quiet imprime solo el
// recuento, sin límite de presupuesto porque no hay contenido que truncar.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import pg from 'pg';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const budgetTokens = args['budget-tokens'] ? Number(args['budget-tokens']) : 4000;
const budgetChars = budgetTokens * 4; // heurística gruesa, no hay tokenizer aquí

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

const statePath = new URL('../../state/delta-state.local.json', import.meta.url);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

let since = args.since ?? state.lastRun ?? null;
if (!since) {
  const { rows } = await client.query(`select (now() - interval '1 day') as since`);
  since = rows[0].since.toISOString();
}

const { rows: nowRows } = await client.query('select now() as now');
const runAt = nowRows[0].now.toISOString();

const { rows: pages } = await client.query(
  `select slug, type, title, updated_at from pages where updated_at > $1 order by updated_at desc`,
  [since],
);
const { rows: facts } = await client.query(
  `select f.id, f.date, f.claim, f.created_at,
          (select string_agg(node_name, ', ' order by node_name) from fact_nodes where fact_id = f.id) as nodes
   from facts f
   where f.created_at > $1 and f.valid_until is null
   order by f.created_at desc`,
  [since],
);

if (args.quiet) {
  if (pages.length === 0 && facts.length === 0) {
    console.log(`Al día, sin cambios desde ${since}.`);
  } else {
    const parts = [];
    if (facts.length > 0) parts.push(`${facts.length} hecho(s) nuevo(s)`);
    if (pages.length > 0) parts.push(`${pages.length} página(s) nueva(s)`);
    console.log(`Al día: ${parts.join(', ')} desde ${since}.`);
  }
} else if (pages.length === 0 && facts.length === 0) {
  console.log(`Sin cambios desde ${since}.`);
} else {
  const lines = [`Cambios desde ${since}:`, ''];
  if (pages.length > 0) {
    lines.push(`Páginas (${pages.length}):`);
    for (const p of pages) {
      lines.push(`  - ${p.slug} (${p.type}) — ${p.title ?? 'sin título'}`);
    }
    lines.push('');
  }
  if (facts.length > 0) {
    lines.push(`Hechos (${facts.length}):`);
    for (const f of facts) {
      lines.push(`  - #${f.id} [${f.date.toISOString().slice(0, 10)}] ${f.claim}${f.nodes ? ` (${f.nodes})` : ''}`);
    }
  }

  let out = lines.join('\n');
  let omitted = 0;
  while (out.length > budgetChars && (pages.length + facts.length - omitted) > 0) {
    // recorta desde el fondo (lo menos reciente) hasta caber en el presupuesto
    if (facts.length > 0) {
      facts.pop();
    } else {
      pages.pop();
    }
    omitted += 1;
    const rebuilt = [`Cambios desde ${since}:`, ''];
    if (pages.length > 0) {
      rebuilt.push(`Páginas (${pages.length}):`);
      for (const p of pages) rebuilt.push(`  - ${p.slug} (${p.type}) — ${p.title ?? 'sin título'}`);
      rebuilt.push('');
    }
    if (facts.length > 0) {
      rebuilt.push(`Hechos (${facts.length}):`);
      for (const f of facts) rebuilt.push(`  - #${f.id} [${f.date.toISOString().slice(0, 10)}] ${f.claim}${f.nodes ? ` (${f.nodes})` : ''}`);
    }
    out = rebuilt.join('\n');
  }
  if (omitted > 0) {
    out += `\n\n(${omitted} ítem(s) más recortado(s) por presupuesto de ${budgetTokens} tokens, no mostrados.)`;
  }
  console.log(out);
}

if (!args['no-advance']) {
  writeFileSync(statePath, JSON.stringify({ lastRun: runAt }, null, 2));
}

await client.end();
