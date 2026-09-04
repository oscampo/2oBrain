// Fase 1: carga las páginas actuales del repo a Supabase, tal cual, sin
// extracción de facts ni embeddings todavía (eso es Fase 2/3).
//
// 2026-08-22: antes de esto, cada corrida leía y mandaba un UPSERT a
// Postgres por los 30 archivos, aunque 29 no hubieran cambiado — barato
// (consultas locales, no API externa), pero descuidado como principio. Un
// hash local por archivo (state/load-pages-cache.local.json, gitignored,
// no es fuente de verdad, solo un caché de optimización) deja saltarse por
// completo el archivo si su contenido no cambió desde la última corrida.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import pg from 'pg';

const repoRoot = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:');
const taxonomyDirs = ['daily', 'guides', 'people', 'projects', 'wiki'];
const cachePath = new URL('../../state/load-pages-cache.local.json', import.meta.url).pathname.replace(
  /^\/([A-Za-z]):/,
  '$1:',
);

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

function loadCache() {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (extname(entry) === '.md') out.push(full);
  }
  return out;
}

const files = taxonomyDirs
  .map((d) => join(repoRoot, d))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap((d) => walk(d));

console.log(`Encontrados ${files.length} archivos .md en ${taxonomyDirs.join(', ')}/`);

const cache = loadCache();
const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

let loaded = 0;
let skipped = 0;
for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const relPath = relative(repoRoot, file).replace(/\\/g, '/');
  const slug = relPath.replace(/\.md$/, '');
  const fileHash = hash(raw);

  if (cache[slug] === fileHash) {
    skipped++;
    continue;
  }

  const { data, content } = matter(raw);
  const type = data.type || 'note';
  const title = data.title || slug;
  const tags = Array.isArray(data.tags) ? data.tags : [];

  // `updated_at` solo se toca si algo realmente cambió (no en cada corrida),
  // porque embed-pages.mjs usa esa marca para decidir qué re-embeber.
  await client.query(
    `insert into pages (slug, type, title, content, tags, source_path)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (slug) do update set
       type = excluded.type,
       title = excluded.title,
       content = excluded.content,
       tags = excluded.tags,
       source_path = excluded.source_path,
       updated_at = case
         when pages.content is distinct from excluded.content
           or pages.title is distinct from excluded.title
           or pages.type is distinct from excluded.type
           or pages.tags is distinct from excluded.tags
         then now()
         else pages.updated_at
       end`,
    [slug, type, title, content.trim(), tags, relPath],
  );
  cache[slug] = fileHash;
  loaded++;
  console.log(`  ${slug}`);
}

saveCache(cache);

const { rows } = await client.query('select count(*)::int as n from pages');
console.log(`\nProcesadas ${loaded} página(s), ${skipped} sin cambios (omitidas). Total en la tabla: ${rows[0].n}`);

await client.end();
