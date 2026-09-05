// Etapa 3 (PLAN-recuerdos.md, 2026-08-30): extrae registros candidatos del
// contenido de una página (`pages`) para migrarla a `records`/`record_memories`.
// Mismo patrón que extract-records.mjs (que lee .jsonl de sesión), adaptado
// para leer una página en vez de una transcripción:
//   - Contexto negativo: los registros ya vigentes del recuerdo asociado a la
//     página se le pasan al LLM para que no proponga de nuevo lo que ya
//     existe.
//   - Cada candidato trae un `node` propuesto (default: el slug sin el
//     prefijo de tipo, ej. "people/x" -> "x") y un `source_fragment`
//     citado literal, para que la auditoría manual (obligatoria, sin
//     excepción) pueda verificar contra el original sin releer toda la
//     página.
//
// Dos modos, igual que extract-records.mjs:
//   - Sin --review: solo IMPRIME los candidatos, no toca la base.
//   - Con --review: revisión interactiva (requiere TTY real) por cada
//     candidato -- aprobar tal cual, editar (claim/fecha/tipo/recuerdo), o
//     saltar. Los aprobados se acumulan y se insertan TODOS JUNTOS al
//     final vía remember-batch.mjs (no uno por uno como extract-records.mjs
//     -- decisión explícita de la planeación de Etapa 3, reusa el gate de
//     contradicciones existente sin construir nada nuevo ahí).
//
// Proveedor por defecto: Gemini. Ollama Cloud gratuito quedó por debajo de
// la calidad necesaria para extracción en pruebas comparativas (mismo
// hallazgo que extract-records.mjs, ver su cabecera) -- se deja como opción,
// no como default.
//
// --page acepta DOS formas (2026-08-31, generalización pedida por el usuario):
//   - un slug ya existente en la tabla `pages` (comportamiento original), o
//   - la ruta a cualquier archivo .md en disco, esté o no en `pages`;
//     permite extraer registros de una nota nueva, todavía sin cargar/commitear,
//     o de un .md fuera del vault indexado (ej. D:\Notes\otra-carpeta\...). Se
//     prueba primero como slug; si no existe, se trata como ruta de archivo.
//     Rutas relativas se resuelven contra la raíz del repo, no contra el
//     directorio desde el que se corra el comando.
//
// Uso:
//   node extract-page-records.mjs --page people/jane-doe [--review]
//   node extract-page-records.mjs --page D:\Notes\otra-carpeta\alguna-nota.md [--review]
//     [--provider gemini|ollama] [--model <id>] [--dump-prompt <archivo>]
//     [--system-prompt-file <ruta>]
// --json   En vez de --review o el listado en texto, entrega los candidatos
//          en un solo objeto JSON por stdout (page, defaultNode, liveNode,
//          records con similarNodes ya calculado por cada uno). No pregunta
//          nada por stdin -- pensado para que un frontend (el dashboard)
//          arme su propia revisión interactiva sin terminal real.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createInterface as createInterfaceAsync } from 'node:readline/promises';
import { join, dirname, isAbsolute, relative, sep, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { embed, toVectorLiteral } from './lib/embed.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, '..', '..');
const REMEMBER_BATCH_SCRIPT = join(SCRIPT_DIR, 'remember-batch.mjs');
const DEFAULT_SYSTEM_PROMPT_FILE = join(SCRIPT_DIR, 'prompts', 'gemini-page-extractor-system-prompt.md');
const GEMINI_MODELS_CONFIG_FILE = join(SCRIPT_DIR, 'config', 'gemini-models.json');
const OLLAMA_MODELS_CONFIG_FILE = join(SCRIPT_DIR, 'config', 'ollama-models.json');

const MODELS = { ollama: 'gpt-oss:120b-cloud', gemini: 'gemini-flash-latest' };
const MAX_CONTENT_CHARS = { ollama: 20_000, gemini: 400_000 };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.page) {
  console.error('Uso: node extract-page-records.mjs --page <slug o ruta .md> [--review] [--provider gemini|ollama] [--model <id>]');
  process.exit(1);
}

const provider = args.provider ?? 'gemini';
if (provider !== 'gemini' && provider !== 'ollama') {
  console.error(`--provider inválido: "${provider}". Debe ser "gemini" u "ollama".`);
  process.exit(1);
}

function loadEnv() {
  const envPath = new URL('../../.env', import.meta.url);
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

const env = loadEnv();

const apiKeyVar = provider === 'gemini' ? 'GEMINI_API_KEY' : 'OLLAMA_API_KEY';
if (!env[apiKeyVar] && !args['dump-prompt']) {
  console.error(`Falta ${apiKeyVar} en .env, no se puede llamar a ${provider}.`);
  process.exit(1);
}

if (args.review && !process.stdin.isTTY) {
  console.error('--review requiere una terminal interactiva (stdin no es TTY). Corre esto directamente en tu propia terminal.');
  process.exit(1);
}

function loadFallbackOrder(configFile, fallbackDefault) {
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    if (Array.isArray(config.fallbackOrder) && config.fallbackOrder.length > 0) return config.fallbackOrder;
  } catch {
    // archivo ausente o inválido: cae a un solo modelo
  }
  return [fallbackDefault];
}
const loadGeminiFallbackOrder = () => loadFallbackOrder(GEMINI_MODELS_CONFIG_FILE, MODELS.gemini);
const loadOllamaFallbackOrder = () => loadFallbackOrder(OLLAMA_MODELS_CONFIG_FILE, MODELS.ollama);

const geminiCandidates = args.model ? [args.model] : provider === 'gemini' ? loadGeminiFallbackOrder() : [];
const ollamaCandidates = args.model ? [args.model] : provider === 'ollama' ? loadOllamaFallbackOrder() : [];
let model = provider === 'gemini' ? geminiCandidates[0] : ollamaCandidates[0];

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

// Prueba primero como slug existente (comportamiento original); si no hay
// fila, cae a tratar el argumento como ruta de archivo .md en disco.
function resolveMdPath(p) {
  if (extname(p).toLowerCase() !== '.md') return null;
  const abs = isAbsolute(p) ? p : join(PROJECT_ROOT, p);
  return existsSync(abs) ? abs : null;
}

const { rows: pageRows } = await client.query(`select slug, type, title, content, source_path, updated_at from pages where slug = $1`, [args.page]);

let page;
if (pageRows.length > 0) {
  page = pageRows[0];
} else {
  const mdPath = resolveMdPath(args.page);
  if (!mdPath) {
    console.error(`No existe ninguna página con slug "${args.page}" en la tabla pages, ni un archivo .md en esa ruta. Revisa con list-pages.mjs, o la ruta dada.`);
    await client.end();
    process.exit(1);
  }
  const insideRepo = mdPath === PROJECT_ROOT || mdPath.startsWith(PROJECT_ROOT + sep);
  const relPath = insideRepo ? relative(PROJECT_ROOT, mdPath).split(sep).join('/') : mdPath;
  const title = basename(mdPath, '.md');
  page = {
    slug: insideRepo ? relPath.replace(/\.md$/, '') : title,
    type: 'adhoc',
    title,
    content: readFileSync(mdPath, 'utf8'),
    source_path: relPath,
    updated_at: statSync(mdPath).mtime,
  };
  console.error(`Archivo .md fuera de "pages" (ad hoc): ${mdPath}`);
}

// Convención confirmada en la clasificación de Etapa 3 (PLAN-recuerdos.md): el
// recuerdo de una página es su slug sin el primer segmento de ruta (el tipo),
// ej. "people/x" -> "x". Excepción conocida: "projects/curso-admin" no
// mapea a un recuerdo propio (se dividió en DB1/DB2-gestion-github en la
// Etapa 1) -- si el slug es ese, avisa en vez de adivinar mal.
const defaultNode = page.slug.split('/').slice(1).join('/') || page.slug;
if (page.slug === 'projects/curso-admin') {
  console.error(
    'Aviso: "projects/curso-admin" no tiene un recuerdo propio -- se dividió en DB1-gestion-github/DB2-gestion-github en la Etapa 1. ' +
      'El recuerdo sugerido por defecto ("curso-admin") probablemente no existe; revisa/edita el recuerdo de cada candidato a mano.',
  );
}

// Resuelve merged_into como el resto del sistema, para el contexto
// negativo -- si el recuerdo por defecto fue fusionado a otro, los registros
// "ya existentes" viven bajo el nombre vigente, no el original.
async function resolveLive(name) {
  let current = name;
  const seen = new Set();
  while (true) {
    if (seen.has(current)) return null; // ciclo: no debería pasar, cae a "no existe"
    seen.add(current);
    const { rows } = await client.query(`select name, merged_into from memories where name = $1`, [current]);
    if (rows.length === 0) return null;
    if (!rows[0].merged_into) return rows[0].name;
    current = rows[0].merged_into;
  }
}

const liveNode = await resolveLive(defaultNode);

// Contexto negativo: registros vigentes ya ligados al recuerdo (vía record_memories,
// la fuente autoritativa desde la Etapa 1) + cualquier residuo aún bajo el
// page_slug legado (red de seguridad, no debería aportar nada nuevo si la
// migración de Etapa 1 quedó completa).
const { rows: existingByNode } = liveNode
  ? await client.query(
      `select f.id, f.claim, f.date from records f
       join record_memories fn on fn.record_id = f.id
       where fn.memory_name = $1 and f.valid_until is null
       order by f.date`,
      [liveNode],
    )
  : { rows: [] };
const { rows: existingByLegacySlug } = await client.query(
  `select id, claim, date from records where page_slug = $1 and valid_until is null order by date`,
  [page.slug],
);
const existingIds = new Set(existingByNode.map((r) => r.id));
const existingFacts = [...existingByNode, ...existingByLegacySlug.filter((r) => !existingIds.has(r.id))];

// El recuerdo por defecto sale del nombre del slug/archivo -- una suposición
// léxica, no de contenido. Para que no dependa solo de acertar el nombre a
// mano (hallazgo del usuario 2026-08-31: qué pasa si el recuerdo que uno cree que
// existe en realidad debería ser otro), cada candidato se compara por
// embedding contra los recuerdos existentes (memories_similar, misma función que
// usa la desambiguación de remember.mjs/remember-batch.mjs) y se muestran
// los más parecidos como sugerencia -- no reemplaza al recuerdo por defecto,
// solo informa antes de que el usuario decida.
async function suggestSimilarNodes(claim) {
  try {
    const embedding = await embed(claim, 'query');
    const { rows } = await client.query(`select * from memories_similar($1, 3, 1)`, [toVectorLiteral(embedding)]);
    return rows;
  } catch (err) {
    console.error(`  (no se pudo sugerir recuerdos parecidos: ${err.message})`);
    return [];
  }
}
function formatNodeSuggestions(rows) {
  if (rows.length === 0) return '(sin sugerencias)';
  return rows.map((r) => `${r.memory_name} (${r.similarity.toFixed(2)})`).join(', ');
}

console.error(`Página: ${page.slug} (${page.type}), "${page.title}"`);
console.error(`recuerdo sugerido por defecto: "${defaultNode}"${liveNode && liveNode !== defaultNode ? ` (fusionado, vigente: "${liveNode}")` : liveNode ? ' (ya existe)' : ' (no existe todavía, se creará si se aprueba algún registro)'}`);
console.error(`Contexto negativo: ${existingFacts.length} registro(s) ya vigente(s) para este recuerdo/slug.`);
const candidatesForStatus = provider === 'gemini' ? geminiCandidates : ollamaCandidates;
console.error(
  candidatesForStatus.length > 1
    ? `Proveedor: ${provider} (probará en orden: ${candidatesForStatus.join(' -> ')})`
    : `Proveedor: ${provider} (${model})`,
);

let content = page.content;
let truncated = false;
const maxChars = MAX_CONTENT_CHARS[provider];
if (content.length > maxChars) {
  content = content.slice(0, maxChars);
  truncated = true;
}
console.error(`${page.content.length} caracteres de contenido${truncated ? ' (TRUNCADO)' : ''}.`);

const negativeContextBlock =
  existingFacts.length === 0
    ? '(ninguno todavía -- esta es la primera extracción para este recuerdo)'
    : existingFacts.map((f) => `  - [${f.date.toISOString().slice(0, 10)}] ${f.claim}`).join('\n');

const userPrompt = `recuerdo sugerido por defecto para esta página: "${defaultNode}"

registros que YA existen para este recuerdo (contexto negativo, no los repitas):
${negativeContextBlock}

Contenido de la página "${page.slug}" (título: "${page.title}"):
${content}`;

let systemPrompt;
const systemPromptFile = args['system-prompt-file'] ?? DEFAULT_SYSTEM_PROMPT_FILE;
try {
  systemPrompt = readFileSync(systemPromptFile, 'utf8');
} catch {
  console.error(`No se pudo leer el system prompt en ${systemPromptFile}.`);
  process.exit(1);
}

if (args['dump-prompt']) {
  writeFileSync(args['dump-prompt'], `--- SYSTEM ---\n${systemPrompt}\n\n--- USER ---\n${userPrompt}`, 'utf8');
  console.error(`Prompt completo escrito en ${args['dump-prompt']}`);
  process.exit(0);
}

// Mismo motivo que extract-records.mjs: process.exit() forzado con sockets
// keep-alive de undici aún abiertos crashea libuv en Windows. Los errores
// de red/API fijan process.exitCode y devuelven null en vez de exit().
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let lastOllamaStatus = null;

async function callOllama() {
  lastOllamaStatus = null;
  let res;
  try {
    res = await fetchWithTimeout(
      'https://ollama.com/api/generate',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: userPrompt, system: systemPrompt, format: 'json', stream: false }),
      },
      60_000,
    );
  } catch (err) {
    console.error(`ERROR DE RED llamando a Ollama Cloud (modelo "${model}"): ${err.message}`);
    process.exitCode = 1;
    return null;
  }
  if (!res.ok) {
    lastOllamaStatus = res.status;
    console.error(`Ollama Cloud respondió ${res.status} (modelo "${model}"): ${await res.text()}`);
    process.exitCode = 1;
    return null;
  }
  const { response } = await res.json();
  return response;
}

async function callOllamaWithFallback(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    model = candidates[i];
    if (i > 0) console.error(`Reintentando con el siguiente modelo de respaldo: ${model}`);
    const result = await callOllama();
    if (result != null) return result;
    const isLast = i === candidates.length - 1;
    if (lastOllamaStatus !== 503 || isLast) return null;
    process.exitCode = 0;
  }
  return null;
}

let lastGeminiStatus = null;

async function callGemini() {
  lastGeminiStatus = null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      },
      90_000,
    );
  } catch (err) {
    console.error(`ERROR DE RED llamando a Gemini (modelo "${model}"): ${err.message}`);
    process.exitCode = 1;
    return null;
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const status = body?.error?.status ?? 'DESCONOCIDO';
    lastGeminiStatus = status;
    const message = body?.error?.message ?? '(sin cuerpo de error legible)';
    const hint =
      status === 'RESOURCE_EXHAUSTED'
        ? ' [CUOTA AGOTADA]'
        : status === 'PERMISSION_DENIED' || status === 'UNAUTHENTICATED'
          ? ' [PROBLEMA DE ACCESO/API KEY]'
          : status === 'NOT_FOUND'
            ? ` [MODELO "${model}" NO EXISTE, prueba --model otro-id]`
            : '';
    console.error(`Gemini respondió ${res.status} (${status})${hint}: ${message}`);
    process.exitCode = 1;
    return null;
  }

  if (body?.promptFeedback?.blockReason) {
    console.error(`Gemini bloqueó la solicitud por seguridad: ${body.promptFeedback.blockReason}`);
    process.exitCode = 1;
    return null;
  }

  const candidate = body?.candidates?.[0];
  if (!candidate) {
    console.error(`Gemini no devolvió candidatos. Respuesta completa:\n${JSON.stringify(body, null, 2)}`);
    process.exitCode = 1;
    return null;
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    console.error(`(aviso: finishReason="${candidate.finishReason}", la respuesta puede estar incompleta)`);
  }

  const text = (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) {
    console.error(`Gemini devolvió una respuesta sin texto. Respuesta completa:\n${JSON.stringify(body, null, 2)}`);
    process.exitCode = 1;
    return null;
  }
  return text;
}

async function callGeminiWithFallback(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    model = candidates[i];
    if (i > 0) console.error(`Reintentando con el siguiente modelo de respaldo: ${model}`);
    const result = await callGemini();
    if (result != null) return result;
    const isLast = i === candidates.length - 1;
    if (lastGeminiStatus !== 'UNAVAILABLE' || isLast) return null;
    process.exitCode = 0;
  }
  return null;
}

const rawResponse = provider === 'gemini' ? await callGeminiWithFallback(geminiCandidates) : await callOllamaWithFallback(ollamaCandidates);

if (rawResponse == null) {
  // el error ya se imprimió y process.exitCode ya quedó en 1
} else {
  const cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`Respuesta no es JSON válido: ${err.message}`);
    console.error(rawResponse);
    process.exitCode = 1;
    parsed = null;
  }

  if (parsed) {
    const records = parsed.records ?? [];
    const source = `Extracción automática de página (${provider}/${model}), ${page.slug}, revisado y aprobado por el usuario`;

    if (args.json) {
      // Modo sin prosa, para el dashboard (2026-08-31): la revisión
      // interactiva pasa a vivir en el navegador en vez de una terminal,
      // así que en vez de imprimir/preguntar por stdin, esto entrega los
      // candidatos ya con sus recuerdos parecidos precalculados, listos para
      // que el frontend arme sus propias tarjetas de aprobar/editar/saltar
      // y los inserte via /api/remember-batch (mismo remember-batch.mjs de
      // siempre, sin código nuevo de inserción).
      const factsWithSuggestions = [];
      for (const f of records) {
        factsWithSuggestions.push({
          claim: f.claim,
          date: f.date ?? null,
          kind: f.kind ?? 'fact',
          node: f.node ?? defaultNode,
          sourceFragment: f.source_fragment ?? null,
          similarNodes: await suggestSimilarNodes(f.claim),
        });
      }
      console.log(JSON.stringify({
        page: { slug: page.slug, type: page.type, title: page.title, sourcePath: page.source_path, updatedAt: page.updated_at },
        defaultNode,
        liveNode,
        existingFactsCount: existingFacts.length,
        provider,
        model,
        source,
        records: factsWithSuggestions,
      }));
    } else if (!args.review) {
      console.log(`\n${records.length} registro(s) candidato(s) para "${page.slug}":\n`);
      for (const f of records) {
        console.log(`- [${f.date ?? 'sin fecha'}] (${f.kind}) recuerdo:${f.node ?? defaultNode} ${f.claim}`);
        console.log(`    fragmento: "${f.source_fragment}"`);
        console.log(`    recuerdos existentes parecidos: ${formatNodeSuggestions(await suggestSimilarNodes(f.claim))}`);
      }
      console.log('\nEsto NO se insertó en la base. Corre con --review para revisar e insertar.');
    } else if (records.length === 0) {
      console.log(`\nNada capturable en "${page.slug}" (o todo ya está cubierto por el contexto negativo).`);
    } else {
      const rlp = createInterfaceAsync({ input: process.stdin, output: process.stdout });

      console.log(`\nRevisión interactiva: ${records.length} registro(s) candidato(s) para "${page.slug}".\n`);
      const approved = [];
      let skipped = 0;
      let quit = false;

      for (let i = 0; i < records.length && !quit; i++) {
        const f = { claim: records[i].claim, date: records[i].date, kind: records[i].kind ?? 'fact', node: records[i].node ?? defaultNode };
        console.log(`\n[${i + 1}/${records.length}] (${f.kind}) [${f.date ?? 'sin fecha'}] recuerdo:${f.node}`);
        console.log(f.claim);
        console.log(`  fragmento de origen: "${records[i].source_fragment ?? '(sin fragmento)'}"`);
        const similarNodes = await suggestSimilarNodes(f.claim);
        console.log(`  recuerdos existentes parecidos: ${formatNodeSuggestions(similarNodes)}`);

        let decision = null;
        while (decision === null) {
          const ans = (await rlp.question('[Enter]=aprobar  e=editar  s=saltar  q=salir > ')).trim().toLowerCase();
          if (ans === 'q') { decision = 'skip'; quit = true; }
          else if (ans === 's') { decision = 'skip'; }
          else if (ans === 'e') {
            const newClaim = (await rlp.question('Nuevo texto (Enter = dejar igual):\n> ')).trim();
            if (newClaim) f.claim = newClaim;
            const newDate = (await rlp.question(`Nueva fecha YYYY-MM-DD (Enter = dejar "${f.date ?? 'sin fecha'}"): `)).trim();
            if (newDate) f.date = newDate;
            const newKind = (await rlp.question(`Nuevo tipo fact|event|preference|commitment (Enter = dejar ${f.kind}): `)).trim();
            if (newKind) f.kind = newKind;
            const newNode = (await rlp.question(`Nuevo recuerdo (parecidos: ${formatNodeSuggestions(similarNodes)}; Enter = dejar "${f.node}"): `)).trim();
            if (newNode) f.node = newNode;
            console.log(`\nActualizado: [${f.date ?? 'sin fecha'}] (${f.kind}) recuerdo:${f.node} ${f.claim}`);
          } else {
            decision = 'approve';
          }
        }

        if (decision === 'approve') {
          if (!f.date) {
            console.log('  (sin fecha inferida -- usando la fecha de última actualización de la página)');
            f.date = page.updated_at.toISOString().slice(0, 10);
          }
          approved.push(f);
        } else {
          skipped++;
        }
      }

      rlp.close();

      if (approved.length === 0) {
        console.log(`\nRevisión terminada: 0 aprobado(s), ${skipped} saltado(s) de ${records.length}. Nada que insertar.`);
      } else {
        console.log(`\nRevisión terminada: ${approved.length} aprobado(s), ${skipped} saltado(s) de ${records.length}. Insertando vía remember-batch.mjs...\n`);

        // createNode: true por defecto -- el recuerdo viene de una página conocida,
        // no de un typo. Si el recuerdo por defecto ya existe (liveNode), lo
        // normal es que remember-batch.mjs lo resuelva igual sin crear nada
        // nuevo; createNode solo importa la primera vez que un recuerdo aparece.
        const batch = { records: approved.map((f) => ({ ...f, source, createNode: true })) };
        const result = spawnSync(process.execPath, [REMEMBER_BATCH_SCRIPT], {
          input: JSON.stringify(batch),
          stdio: ['pipe', 'inherit', 'inherit'],
        });
        if (result.status !== 0) {
          console.error('\nremember-batch.mjs terminó con errores -- revisa la salida arriba.');
          process.exitCode = 1;
        } else {
          console.log(`\nCerrando "${page.slug}": decide ahora el destino del .md (referencia / redundante) -- no es automático, ver PLAN-recuerdos.md paso 5.`);
        }
      }
    }
  }
}

// Se mantuvo abierta durante toda la revisión (antes se cerraba apenas se
// leía la página) porque suggestSimilarNodes() la necesita para cada
// candidato -- ver el hallazgo del usuario 2026-08-31 más arriba.
await client.end();
