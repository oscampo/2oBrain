// Crea un recuerdo standalone, sin necesidad de adjuntarlo a un registro (a
// diferencia de remember.mjs --memory X --create-memory, que exige --claim).
// Pensado para el caso de diseño top-down de grafo (armar la jerarquía de
// antemano, ej. registro #555-#556: plan-de-trabajo/ptp-2026-N/evidencias-*),
// antes de esto no existía, se usaba un INSERT SQL crudo sin ningún chequeo.
//
// Reusa la misma protección contra duplicados que ya tiene la creación
// automática (remember.mjs): (1) colisión de alias/nombre contra otros recuerdos
// (lib/check-alias-collision.mjs, mismo módulo que remember.mjs/
// set-memory-aliases.mjs), fail-closed siempre, --force no la salta; (2)
// desambiguación semántica (memories_similar() + lib/classify-memory.mjs) sobre
// un "registro sintético" armado con el nombre/alias propuestos, si ya hay
// registros de un recuerdo existente que temáticamente calzan, se bloquea salvo
// --force. recuerdo exacto ya existente: idempotente, informa y sale sin error.
//
// --parent (2026-09-04): crea, en el mismo comando, el enlace memory_links
// pertenece_a hacia una categoría ya existente -- pensado para la entrevista
// de instalación de 2oBrain (Fase 5.5: categorías tier-0/tier-1 fijos al
// elegir Trabajo/Vida personal, y cada recuerdo hoja que emerge de un registro se
// liga a su categoría en el mismo paso en que se crea, con el mismo criterio
// que hoy: quien construye el recuerdo ya sabe a qué grupo pertenece por
// contexto, no hace falta un clasificador). Reusa createLink (lib/
// create-link.mjs), la misma lógica que usa memory-link.mjs -- ningún camino
// nuevo, solo un atajo para no encadenar dos comandos.
//
// Uso:
//   node create-memory.mjs --name proyecto-x [--aliases "alias1,alias2"] [--is-meta] [--force] [--parent categoría --date YYYY-MM-DD [--reason "..."]]
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral } from './lib/embed.mjs';
import { classifyNode, CLASSIFIER_CONFIDENCE_THRESHOLD, CLASSIFIER_MODEL } from './lib/classify-memory.mjs';
import { findAliasCollisions } from './lib/check-alias-collision.mjs';
import { createLink } from './lib/create-link.mjs';

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

if (!args.name) {
  console.error(
    'Falta --name. Uso:\n' +
      '  node create-memory.mjs --name proyecto-x [--aliases "alias1,alias2"] [--is-meta] [--force]',
  );
  process.exit(1);
}

const name = String(args.name).trim();
const aliases = args.aliases
  ? String(args.aliases).split(',').map((s) => s.trim()).filter(Boolean)
  : [];

if (args.parent && !args.date) {
  console.error('--parent requiere --date (misma exigencia que memory-link.mjs: nunca se infiere).');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date ?? '') && args.parent) {
  console.error(`Fecha inválida: "${args.date}". Debe ser YYYY-MM-DD.`);
  process.exit(1);
}
const parentReason = args.reason ?? `recuerdo creado y ligado directamente a "${args.parent}" al construirse.`;

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

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

// Idempotente: si ya existe (siguiendo merged_into hasta el vigente), no es
// un error -- informa y sale limpio. No agrega alias aquí, ese es el trabajo
// de set-memory-aliases.mjs, no queremos dos caminos para lo mismo.
let current = name;
const seen = new Set();
while (true) {
  if (seen.has(current)) {
    console.error(`Ciclo de merged_into detectado empezando por "${name}".`);
    await client.end();
    process.exit(1);
  }
  seen.add(current);
  const { rows } = await client.query(`select name, merged_into from memories where name = $1`, [current]);
  if (rows.length === 0) break;
  if (!rows[0].merged_into) {
    console.log(`El recuerdo "${rows[0].name}" ya existe${rows[0].name !== name ? ` (fusionado desde "${name}")` : ''} -- nada que crear.`);
    if (args.parent) {
      const edgeResult = await createLink(client, rows[0].name, args.parent, 'pertenece_a', parentReason, args.date);
      if (!edgeResult.ok) {
        console.error(edgeResult.error);
        await client.end();
        process.exit(1);
      }
      console.log(`Enlazado: ${edgeResult.fromMemory} -> ${edgeResult.toMemory} (pertenece_a).`);
    }
    await client.end();
    process.exit(0);
  }
  current = rows[0].merged_into;
}

// Colisión de alias/nombre contra OTROS recuerdos existentes -- fail-closed
// siempre, --force no la salta (un alias/nombre compartido rompe
// detect-memory-mentions.mjs, no es un desacuerdo de opinión como el caso de
// abajo, es un conflicto real de datos).
const collisions = await findAliasCollisions(client, name, [name, ...aliases]);
if (collisions.length > 0) {
  console.error('Colisión de nombre/alias con recuerdo(s) existente(s), no se puede crear así:\n');
  for (const c of collisions) {
    console.error(`  "${c.alias}" ya lo usa el recuerdo "${c.node}"`);
  }
  console.error('\nElige un nombre/alias distinto, o si es genuinamente el mismo recuerdo, usa ese recuerdo existente en vez de crear uno nuevo.');
  await client.end();
  process.exit(1);
}

// Desambiguación semántica: mismo mecanismo que protege la creación
// automática en remember.mjs (memories_similar() + classify-memory.mjs), sobre un
// "registro sintético" armado con el nombre/alias propuestos -- no hay un claim
// real todavía (el recuerdo se crea antes de que existan registros), así que se
// aproxima describiendo el recuerdo mismo.
if (!args.force) {
  const syntheticClaim = `recuerdo nuevo: "${name}"${aliases.length ? `. Alias: ${aliases.join(', ')}` : ''}.`;
  const embedding = await embed(syntheticClaim, 'document');
  const vectorLiteral = toVectorLiteral(embedding);

  const { rows: nodeCandidateRows } = await client.query(`select * from memories_similar($1, 5)`, [vectorLiteral]);
  const nodeCandidates = nodeCandidateRows.map((r) => ({
    memory_name: r.memory_name,
    examples: r.examples,
    similarity: r.similarity,
    aliases: r.aliases,
  }));

  if (nodeCandidates.length > 0) {
    const verdict = await classifyNode(syntheticClaim, nodeCandidates);
    if (verdict && verdict.verdict === 'existing' && verdict.confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD) {
      console.error(
        `La desambiguación (${CLASSIFIER_MODEL}, confianza ${verdict.confidence.toFixed(2)}) sugiere que "${name}" ` +
          `es lo mismo que el recuerdo existente "${verdict.node}": ${verdict.reasoning}\n\n` +
          `Si es correcto, usa "${verdict.node}" en vez de crear uno nuevo.\n` +
          'Si de verdad es un recuerdo distinto (otro nivel de granularidad, otro aspecto), repite con --force.',
      );
      // process.exitCode, no process.exit() -- embed()/classifyNode() ya
      // hicieron fetch() antes de este punto, y un exit() forzado con un
      // socket keep-alive todavía abierto revienta con "Assertion failed:
      // !(handle->flags & UV_HANDLE_CLOSING)" en Windows (mismo bug ya
      // documentado en list-link-candidates-deep.mjs/extract-records.mjs,
      // visto en vivo acá mismo probando la sección "Candidatos de
      // categoría" del dashboard, 2026-09-04). exitCode + dejar que el
      // guard de abajo salte el insert logra el mismo bloqueo sin forzar el
      // cierre del proceso.
      process.exitCode = 1;
    }
  }
}

if (!process.exitCode) {
  await client.query(
    `insert into memories (name, aliases, is_meta) values ($1, $2, $3)`,
    [name, aliases, Boolean(args['is-meta'])],
  );

  console.log(`Creado recuerdo "${name}"${aliases.length ? ` (alias: ${aliases.join(', ')})` : ''}${args['is-meta'] ? ' [is_meta]' : ''}.`);

  if (args.parent) {
    const edgeResult = await createLink(client, name, args.parent, 'pertenece_a', parentReason, args.date);
    if (!edgeResult.ok) {
      console.error(edgeResult.error);
      process.exitCode = 1;
    } else {
      console.log(`Enlazado: ${edgeResult.fromMemory} -> ${edgeResult.toMemory} (pertenece_a).`);
    }
  }
}

await client.end();
