// Ingesta en lote de registros generados por la skill extract-code-records (u otro
// origen que produzca el mismo JSON). Reusa el mismo gate de contradicciones
// de remember.mjs (embedding + similitud + clasificador Ollama Cloud) registro
// por registro, pero sin la ruta interactiva de --supersedes/--distinct: si un
// registro choca con uno vivo y el clasificador no resuelve con confianza
// suficiente, ese registro queda bloqueado y el lote sigue con el resto. No hay
// ruta silenciosa: todo registro bloqueado se lista al final para resolverlo a
// mano con remember.mjs.
// Uso:
//   node remember-batch.mjs --file registros.json [--confirm-date]
//   cat registros.json | node remember-batch.mjs [--confirm-date]
//
// --confirm-date: obligatorio si algún registro del lote tiene --date distinto
// de hoy (America/Bogota): una sola confirmación cubre todo el lote, no una
// por registro (mismo criterio que remember.mjs, registro #528, a nivel de lote).
//
// Rediseño 2026-08-29: slug -> node (string o array de strings, record_memories
// many-to-many). Mismo criterio fail-closed que remember.mjs: un recuerdo debe
// existir de antemano salvo que el registro traiga createNode: true.
// Etapa 2 (2026-08-30): node ya es opcional por registro: si se omite, se
// desambigua por búsqueda vectorial (memories_similar()) + clasificador
// (lib/classify-memory.mjs), igual que remember.mjs. Sin humano presente para
// resolver un bloqueo, un registro ambiguo se salta (nodeAmbiguous) y el lote
// sigue con el resto, nunca aborta. Con node explícito, la desambiguación
// corre igual pero solo avisa, nunca sobreescribe.
// Formato esperado del JSON: {"records": [{claim, date, source, kind?, node?, createNode?, confidence?}, ...]}
// node acepta string ("cabd-2026-2") o array (["cabd-2026-2", "coil-2026-2"]).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral } from './lib/embed.mjs';
import { classifyDuplicate, CLASSIFIER_CONFIDENCE_THRESHOLD, CLASSIFIER_MODEL } from './lib/classify-duplicate.mjs';
import { classifyNode, CLASSIFIER_CONFIDENCE_THRESHOLD as NODE_CONFIDENCE_THRESHOLD, CLASSIFIER_MODEL as NODE_CLASSIFIER_MODEL } from './lib/classify-memory.mjs';
import { detectNodeMentions } from './lib/detect-memory-mentions.mjs';
import { classifyMentionRelationHybrid, CLASSIFIER_CONFIDENCE_THRESHOLD as MENTION_CONFIDENCE_THRESHOLD } from './lib/classify-mention-relation.mjs';
import { formatFactsBlock } from './lib/format-records.mjs';
import { createLink } from './lib/create-link.mjs';

const SIMILARITY_THRESHOLD = 0.6;

function truncateClaim(claim, maxWords = 15) {
  const words = claim.split(/\s+/);
  if (words.length <= maxWords) return claim;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const args = parseArgs(process.argv.slice(2));

const raw = args.file ? readFileSync(args.file, 'utf8') : await readStdin();
if (!raw || !raw.trim()) {
  console.error('No llegó JSON ni por --file ni por stdin.\nUso:\n  node remember-batch.mjs --file registros.json\n  cat registros.json | node remember-batch.mjs');
  process.exit(1);
}

let parsedInput;
try {
  parsedInput = JSON.parse(raw);
} catch (err) {
  console.error(`JSON inválido: ${err.message}`);
  process.exit(1);
}

const records = parsedInput.records;
if (!Array.isArray(records) || records.length === 0) {
  console.error('El JSON debe tener la forma {"records": [...]} con al menos un registro.');
  process.exit(1);
}

// Mismo chequeo que remember.mjs (2026-09-03, registro #528), a nivel de lote:
// una sola confirmación cubre todo el archivo, en vez de una por registro: no
// tiene sentido pedir --confirm-date repetido cuando ES el timeline entero
// el que es histórico (caso real: timeline de "explorando-cuerpo-construir-
// suenos" armado en retrospectiva en una sola sesión). Se revisa ANTES de
// conectar a la base o gastar ningún embedding, para fallar barato.
const todayBogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const mismatchedDates = records.filter((f) => f.date && f.date !== todayBogota);
if (mismatchedDates.length > 0 && !args['confirm-date']) {
  console.error(
    `${mismatchedDates.length} de ${records.length} registro(s) del lote tienen --date distinto de hoy (${todayBogota} en America/Bogota):\n`,
  );
  for (const f of mismatchedDates.slice(0, 10)) {
    console.error(`  [${f.date}] ${truncateClaim(f.claim ?? '(sin claim)')}`);
  }
  if (mismatchedDates.length > 10) console.error(`  ... y ${mismatchedDates.length - 10} más.`);
  console.error(
    '\nSi es un lote histórico/backfill intencional (ej. un timeline armado en retrospectiva), agrega --confirm-date al comando.\n' +
      'Si no, revisa las fechas del JSON antes de reintentar.',
  );
  process.exit(1);
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

const results = { inserted: [], autoResolved: [], blocked: [], invalid: [], nodeMissing: [], nodeAmbiguous: [], mentions: [] };

// Etapa 6 (PLAN-recuerdos.md, 2026-09-02, registro #487): mismo detector de
// co-ocurrencia que remember.mjs -- una sola carga por lote, no cambia
// mientras el lote corre (salvo createNode, caso raro que no vale la pena
// refrescar a mitad de lote). recuerdos is_meta se cargan aparte para saltar la
// detección cuando el registro es de uno de ellos (autorreferencia, no
// relación real -- mismo hallazgo que remember.mjs).
const { rows: allNodeRowsForMentions } = await client.query(`select name, aliases from memories where merged_into is null and not is_meta`);
const { rows: metaNodeRows } = await client.query(`select name from memories where is_meta`);
const metaNodeNames = new Set(metaNodeRows.map((r) => r.name));

// Resuelve merged_into como remember.mjs: nadie que arme el batch necesita
// saber que un recuerdo cambió de nombre.
async function resolveNode(name) {
  let current = name;
  const seen = new Set();
  while (true) {
    if (seen.has(current)) return null;
    seen.add(current);
    const { rows } = await client.query(`select name, merged_into from memories where name = $1`, [current]);
    if (rows.length === 0) return null;
    if (!rows[0].merged_into) return rows[0].name;
    current = rows[0].merged_into;
  }
}

for (let i = 0; i < records.length; i++) {
  const f = records[i];
  const label = `[${i + 1}/${records.length}]`;

  if (!f.claim || !f.date || !f.source) {
    console.error(`${label} registro sin claim/date/source, se salta: ${JSON.stringify(f)}`);
    results.invalid.push(f);
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) {
    console.error(`${label} Fecha inválida "${f.date}", se salta: ${truncateClaim(f.claim)}`);
    results.invalid.push(f);
    continue;
  }

  console.error(`${label} ${truncateClaim(f.claim)}`);

  const embedding = await embed(f.claim, 'document');
  const vectorLiteral = toVectorLiteral(embedding);

  const { rows: candidates } = await client.query(
    `select id, claim, date, source, kind,
            1 - (embedding <=> $1) as similarity
     from records
     where valid_until is null and embedding is not null
     order by embedding <=> $1
     limit 5`,
    [vectorLiteral],
  );

  const similar = candidates.filter((c) => c.similarity >= SIMILARITY_THRESHOLD);

  let supersedesIds = [];
  let autoResolved = null;
  let source = f.source;

  if (similar.length > 0) {
    autoResolved = await classifyDuplicate(f.claim, similar);
    if (autoResolved && autoResolved.confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD) {
      if (autoResolved.verdict === 'supersedes') {
        supersedesIds = autoResolved.supersedesIds;
      }
      console.error(
        `  (auto-resuelto por Ollama Cloud, ${CLASSIFIER_MODEL}, confianza ${autoResolved.confidence.toFixed(2)}: ${autoResolved.reasoning})`,
      );
      source = `${source} [auto-resuelto por Ollama Cloud (${CLASSIFIER_MODEL}), confianza ${autoResolved.confidence.toFixed(2)}: ${autoResolved.reasoning}]`;
    } else {
      console.error(`  (${similar.length} registro(s) vivo(s) parecido(s), clasificador sin confianza suficiente, bloqueado)`);
      results.blocked.push({ fact: f, similar });
      continue;
    }
  }

  // Etapa 2 (PLAN-recuerdos.md, 2026-08-29): desambiguación automática, mismo
  // criterio que remember.mjs pero sin humano presente para el bloqueo: un
  // registro ambiguo se salta y se reporta al final, nunca detiene el lote.
  const { rows: nodeCandidateRows } = await client.query(`select * from memories_similar($1, 5)`, [vectorLiteral]);
  const nodeCandidates = nodeCandidateRows.map((r) => ({
    memory_name: r.memory_name,
    examples: r.examples,
    similarity: r.similarity,
    aliases: r.aliases,
  }));
  let nodeVerdict = nodeCandidates.length > 0 ? await classifyNode(f.claim, nodeCandidates) : null;

  let requestedNodes = f.node == null ? [] : Array.isArray(f.node) ? f.node : [f.node];

  if (requestedNodes.length === 0) {
    if (!nodeVerdict || nodeVerdict.confidence < NODE_CONFIDENCE_THRESHOLD) {
      console.error(`  Sin recuerdo y desambiguación sin confianza suficiente, bloqueado.`);
      results.nodeAmbiguous.push({ fact: f, nodeCandidates, nodeVerdict });
      continue;
    }
    if (nodeVerdict.verdict === 'new') {
      console.error(`  Desambiguación propone recuerdo NUEVO "${nodeVerdict.node}" (confianza ${nodeVerdict.confidence.toFixed(2)}), requiere confirmación, bloqueado.`);
      results.nodeAmbiguous.push({ fact: f, nodeCandidates, nodeVerdict });
      continue;
    }
    requestedNodes = [nodeVerdict.node];
    console.error(`  (recuerdo auto-resuelto por ${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}: ${nodeVerdict.reasoning})`);
  } else if (
    nodeVerdict &&
    nodeVerdict.confidence >= NODE_CONFIDENCE_THRESHOLD &&
    (nodeVerdict.verdict === 'new' || !requestedNodes.includes(nodeVerdict.node))
  ) {
    console.error(
      `  (aviso: desambiguación (confianza ${nodeVerdict.confidence.toFixed(2)}) sugiere ` +
        `${nodeVerdict.verdict === 'new' ? `un recuerdo nuevo distinto: "${nodeVerdict.node}"` : `el recuerdo existente "${nodeVerdict.node}"`}` +
        ` en vez de ${requestedNodes.map((n) => `"${n}"`).join(', ')}, se respeta el recuerdo explícito del JSON.)`,
    );
  }

  const resolvedNodes = [];
  let nodeFailed = false;
  for (const name of requestedNodes) {
    const resolved = await resolveNode(name);
    if (resolved) {
      resolvedNodes.push(resolved);
    } else if (f.createNode) {
      await client.query(`insert into memories (name) values ($1) on conflict (name) do nothing`, [name]);
      resolvedNodes.push(name);
    } else {
      console.error(`  recuerdo "${name}" no existe (pasa createNode: true en el JSON si es genuinamente nuevo), bloqueado.`);
      results.nodeMissing.push({ fact: f, missingNode: name });
      nodeFailed = true;
      break;
    }
  }
  if (nodeFailed) continue;

  const { rows } = await client.query(
    `insert into records (claim, kind, date, source, confidence, embedding)
     values ($1, $2, $3, $4, $5, $6)
     returning id, date, claim`,
    [
      f.claim,
      f.kind ?? 'fact',
      f.date,
      source,
      f.confidence ? Number(f.confidence) : 1.0,
      vectorLiteral,
    ],
  );

  const newId = rows[0].id;

  for (const memoryName of resolvedNodes) {
    await client.query(`insert into record_memories (record_id, memory_name) values ($1, $2) on conflict do nothing`, [
      newId,
      memoryName,
    ]);
  }

  if (supersedesIds.length > 0) {
    await client.query(
      `update records set valid_until = now(), superseded_by = $1 where id = any($2::bigint[])`,
      [newId, supersedesIds],
    );
    console.error(`  Reemplazó a #${supersedesIds.join(', #')}.`);
  }

  console.error(`  Registrado #${newId}.`);
  results.inserted.push({ id: newId, claim: f.claim });
  if (autoResolved) results.autoResolved.push({ id: newId, claim: f.claim });

  const mentions = resolvedNodes.some((n) => metaNodeNames.has(n))
    ? []
    : detectNodeMentions(f.claim, resolvedNodes, allNodeRowsForMentions);

  // Mismo criterio que remember.mjs (2026-09-02): auto-crea a confianza
  // alta, descarta "no_relation" en silencio, cae a revisión manual si el
  // clasificador no está disponible o la confianza es baja.
  const pendingMentions = [];
  for (const m of mentions) {
    const { rows: bFactRows } = await client.query(`select * from records_timeline($1, $2, false)`, [m.node, 1000]);
    const judged = await classifyMentionRelationHybrid(f.claim, resolvedNodes[0], m.node, formatFactsBlock(bFactRows));

    if (judged?.verdict === 'no_relation') continue;

    if (judged?.verdict === 'relation' && judged.confidence >= MENTION_CONFIDENCE_THRESHOLD) {
      let allCreated = true;
      for (const from of resolvedNodes) {
        const edgeResult = await createLink(
          client, from, m.node, judged.relation,
          `[auto-creado por clasificador de menciones (${judged.via}), confianza ${judged.confidence.toFixed(2)}]: ${judged.reasoning} (registro #${newId})`,
          f.date,
        );
        if (edgeResult.ok) {
          console.error(`  (enlace auto-creado: ${edgeResult.fromMemory} -> ${edgeResult.toMemory} (${edgeResult.relation}))`);
        } else {
          allCreated = false;
        }
      }
      if (allCreated) continue;
    }

    pendingMentions.push({ ...m, suggestedRelation: judged?.relation ?? null });
  }

  if (pendingMentions.length > 0) {
    console.error(`  (menciona ${pendingMentions.length} recuerdo(s) más -- posible relación, revisión manual)`);
    results.mentions.push({ id: newId, claim: f.claim, from: resolvedNodes, mentions: pendingMentions });
  }
}

await client.end();

console.log('\n--- Resumen ---');
console.log(`Insertados: ${results.inserted.length}`);
console.log(`  de los cuales auto-resueltos (duplicado/contradicción): ${results.autoResolved.length}`);
console.log(`Bloqueados (requieren remember.mjs manual con --supersedes o --distinct): ${results.blocked.length}`);
console.log(`recuerdo inexistente (falta createNode: true o corregir el nombre): ${results.nodeMissing.length}`);
console.log(`recuerdo ambiguo (sin node en el JSON, desambiguación sin confianza o propuso recuerdo nuevo): ${results.nodeAmbiguous.length}`);
console.log(`Inválidos (faltaba claim/date/source o fecha mal formada): ${results.invalid.length}`);
console.log(`Mencionan otro recuerdo (posible relación, revisión manual): ${results.mentions.length}`);

if (results.blocked.length > 0) {
  console.log('\nregistros bloqueados:');
  for (const { fact, similar } of results.blocked) {
    console.log(`  - "${truncateClaim(fact.claim)}"`);
    for (const c of similar) {
      console.log(`      parecido a #${c.id} [${c.date.toISOString().slice(0, 10)}] ${truncateClaim(c.claim)}`);
    }
  }
}

if (results.nodeMissing.length > 0) {
  console.log('\nregistros con recuerdo inexistente:');
  for (const { fact, missingNode } of results.nodeMissing) {
    console.log(`  - "${truncateClaim(fact.claim)}" -> recuerdo "${missingNode}"`);
  }
}

if (results.nodeAmbiguous.length > 0) {
  console.log('\nregistros con recuerdo ambiguo (resuélvelos a mano con remember.mjs, pasando --memory o --memory ... --create-memory):');
  for (const { fact, nodeCandidates, nodeVerdict } of results.nodeAmbiguous) {
    console.log(`  - "${truncateClaim(fact.claim)}"`);
    if (nodeVerdict?.verdict === 'new') {
      console.log(`      propuesta: recuerdo nuevo "${nodeVerdict.node}" (confianza ${nodeVerdict.confidence.toFixed(2)}: ${nodeVerdict.reasoning})`);
    } else {
      for (const c of nodeCandidates) {
        console.log(`      candidato "${c.memory_name}" (similitud ${c.similarity.toFixed(2)}):`);
        for (const ex of c.examples) console.log(`          - ${truncateClaim(ex)}`);
      }
    }
  }
}

if (results.mentions.length > 0) {
  console.log('\nregistros que mencionan otros recuerdos (posible relación, revisión manual con memory-link.mjs):');
  for (const { id, claim, from, mentions } of results.mentions) {
    console.log(`  - #${id} "${truncateClaim(claim)}"`);
    for (const m of mentions) {
      console.log(`      "${m.node}" (coincide con "${m.matchedOn}")`);
      for (const f of from) {
        console.log(`        memory-link.mjs --from ${f} --to ${m.node} --relation "${m.suggestedRelation || '...'}" --date YYYY-MM-DD --reason "registro #${id}"`);
      }
    }
  }
}
