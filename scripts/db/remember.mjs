// Registra un registro atómico con fecha y fuente obligatorias en la base de registros.
//
// Uso:
//   node remember.mjs --claim "..." --date YYYY-MM-DD --source "..." [--kind fact|event|commitment]
//     [--memory recuerdo1,recuerdo2] [--confidence 0.9] [--supersedes 12,15] [--complements 12]
//     [--distinct] [--confirm-date] [--source-at ISO8601] [--queue-proposals] [--suggest-labels]
//
// Flujo:
//   1. Valida argumentos antes de gastar embedding o modelo.
//   2. Busca registros vivos parecidos. Texto idéntico nunca se inserta. Con
//      parecidos y sin --supersedes/--complements/--distinct, decide el clasificador de
//      duplicados; si no alcanza confianza, bloquea. "redundant" nunca inserta.
//   3. Recuerdos: liga solo los de --memory que existen (siguiendo merged_into). Lo demás es
//      PROPUESTA en memory_proposals, nunca etiqueta: un recuerdo pedido que
//      no existe, y lo que sugiera el clasificador. Sin --memory no se guarda y se imprime la
//      sugerencia, salvo con --queue-proposals (extract-records.mjs, sin nadie mirando), que
//      usa el primario auto-resuelto. Con --memory explícito el clasificador no corre, salvo
//      --suggest-labels (en pruebas, la confianza del clasificador no discriminaba las propuestas buenas).
//   4. Inserta en una transacción: registro, sus recuerdos y el cierre de --supersedes.
//   5. Después, a mejor esfuerzo: propuestas, enlaces entre recuerdos co-etiquetados,
//      cierre de compromisos resueltos (nunca el complementado) y
//      enlaces por mención literal de otro recuerdo (Etapa 6).
//
// --confirm-date: obligatorio si --date no es hoy en TIMEZONE.
// --source-at: instante real del hecho, no de la captura; classify-duplicate.mjs lo usa para que
// un hecho más viejo nunca reemplace a uno más nuevo.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral } from './lib/embed.mjs';
import { classifyDuplicate, CLASSIFIER_CONFIDENCE_THRESHOLD, CLASSIFIER_MODEL, CLASSIFIER_PROVIDER } from './lib/classify-duplicate.mjs';
import { classifyNode, classifyAdditionalMemories, CLASSIFIER_CONFIDENCE_THRESHOLD as NODE_CONFIDENCE_THRESHOLD, CLASSIFIER_MODEL as NODE_CLASSIFIER_MODEL } from './lib/classify-memory.mjs';
import { literalMentionCandidates } from './lib/literal-mention-candidates.mjs';
import { detectNodeMentions } from './lib/detect-memory-mentions.mjs';
import { classifyMentionRelationHybrid, CLASSIFIER_CONFIDENCE_THRESHOLD as MENTION_CONFIDENCE_THRESHOLD } from './lib/classify-mention-relation.mjs';
import { formatFactsBlock } from './lib/format-records.mjs';
import { createLink } from './lib/create-link.mjs';
import { classifyCommitmentResolution, CLASSIFIER_CONFIDENCE_THRESHOLD as COMMITMENT_CONFIDENCE_THRESHOLD } from './lib/classify-commitment-resolution.mjs';
import { proposalQueuedText, queueProposals } from './lib/memory-proposals.mjs';

const SIMILARITY_THRESHOLD = 0.6;
const KINDS = ['fact', 'event', 'commitment'];
const USAGE =
  'Uso:\n  node remember.mjs --claim "..." --date YYYY-MM-DD --source "..." [--kind fact|event|commitment] ' +
  '[--memory recuerdo1,recuerdo2] [--confidence 1.0] [--supersedes id,id] [--complements id] [--distinct] ' +
  '[--confirm-date] [--source-at ISO8601] [--queue-proposals] [--suggest-labels]';

const providerLabel = (p) => (p === 'openrouter' ? 'OpenRouter' : p === 'gemini' ? 'Gemini' : 'Ollama Cloud');
const truncateClaim = (claim, max = 15) => {
  const w = claim.split(/\s+/);
  return w.length <= max ? claim : `${w.slice(0, max).join(' ')}…`;
};
const splitList = (v) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const normClaim = (x) => String(x).replace(/\s+/g, ' ').trim().toLowerCase();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// --- 1. Validación, sin red ni base -------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const die = (msg) => { console.error(msg); process.exit(1); };

if (!args.claim || !args.date || !args.source || [args.claim, args.date, args.source].includes(true)) {
  die(`Faltan campos obligatorios. ${USAGE}`);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) die(`Fecha inválida: "${args.date}". Debe ser YYYY-MM-DD, no se infiere.`);
if (args['memories-confirmed']) {
  die('--memories-confirmed ya no existe: remember.mjs guarda con los recuerdos pedidos que existen y deja todo lo demás ' +
    'como propuesta pendiente. Las propuestas las acepta el usuario en el dashboard o con garden.mjs --proposal <id> accept.');
}
if (args.aliases) die('--aliases ya no aplica: remember.mjs no crea recuerdos. Los alias se ponen al aceptar la propuesta o con set-memory-aliases.mjs.');

const kind = args.kind ?? 'fact';
if (!KINDS.includes(kind)) die(`--kind inválido: "${kind}". Debe ser ${KINDS.join(', ')}.`);
const confidence = args.confidence ? Number(args.confidence) : 1.0;
if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) die(`--confidence inválido: "${args.confidence}". Debe ser un número entre 0 y 1.`);

let sourceAt = null;
if (args['source-at'] && args['source-at'] !== true) {
  const parsed = new Date(args['source-at']);
  if (Number.isNaN(parsed.getTime())) die(`--source-at inválido: "${args['source-at']}". Debe ser un instante ISO 8601 parseable (ej. 2026-09-21T18:07:00Z).`);
  sourceAt = parsed.toISOString();
}

let supersedesIds = splitList(args.supersedes).map(Number);
if (supersedesIds.some((n) => !Number.isInteger(n))) die(`--supersedes inválido: "${args.supersedes}". Debe ser una lista de ids.`);
let complementsId = args.complements && args.complements !== true ? Number(args.complements) : null;
if (complementsId !== null && !Number.isInteger(complementsId)) die(`--complements inválido: "${args.complements}". Debe ser un id.`);

const requestedInput = splitList(args.memory);
const queueMode = Boolean(args['queue-proposals']);
const wantSuggestions = requestedInput.length === 0 || Boolean(args['suggest-labels']);
let distinct = Boolean(args.distinct);
let source = args.source;

const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const TIMEZONE = env.TIMEZONE?.trim() || 'America/Bogota';
// formatToParts: con ICU reducido (Node en iSH/iPad) 'en-CA' cae a M/D/YYYY.
const today = Object.fromEntries(
  new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]),
);
const todayLocal = `${today.year}-${today.month}-${today.day}`;
if (args.date !== todayLocal && !args['confirm-date']) {
  die(`--date ${args.date} es distinto de hoy (${todayLocal} en ${TIMEZONE}).\n` +
    'Si es un registro histórico o backfill intencional, agrega --confirm-date para confirmarlo.\n' +
    'Si fue sin querer, corrige --date y vuelve a intentar.');
}

// --- 2. Parecidos y duplicados -------------------------------------------------------------
const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const stop = async (msg, code = 1) => {
  if (code === 0) console.log(msg); else console.error(msg);
  await client.end();
  process.exit(code);
};

const [vectorLiteral, { rows: memoryRows }] = await Promise.all([
  embed(args.claim, 'document').then(toVectorLiteral),
  client.query(`select name, aliases, merged_into, is_meta from memories`),
]);
const memByName = new Map(memoryRows.map((m) => [m.name, m]));
// Filas vigentes y no meta: las que usan la detección por mención literal.
const liveNonMeta = memoryRows.filter((m) => !m.merged_into && !m.is_meta).map(({ name, aliases }) => ({ name, aliases }));
const resolveLive = (name) => {
  const seen = new Set();
  for (let cur = name; ; cur = memByName.get(cur).merged_into) {
    if (!memByName.has(cur)) return { ok: false };
    if (seen.has(cur)) return { ok: false, cycle: true };
    seen.add(cur);
    if (!memByName.get(cur).merged_into) return { ok: true, name: cur };
  }
};

const { rows: candidates } = await client.query(
  `select f.id, f.claim, f.date, f.source, f.kind, f.source_at,
          (select string_agg(memory_name, ', ' order by memory_name) from record_memories where record_id = f.id) as memories,
          1 - (f.embedding <=> $1) as similarity
   from records f
   where f.valid_until is null and f.embedding is not null
   order by f.embedding <=> $1
   limit 5`,
  [vectorLiteral],
);
const similar = candidates.filter((c) => c.similarity >= SIMILARITY_THRESHOLD);

const identical = candidates.find((c) => normClaim(c.claim) === normClaim(args.claim) && !supersedesIds.includes(Number(c.id)));
if (identical) await stop(`Ya existe un registro con el mismo texto: #${identical.id}, no se inserta (duplicado exacto).`, 0);

// El clasificador de recuerdos no depende del de duplicados: arrancan juntos. Si una salida
// temprana corta el flujo, ese trabajo sobra pero no escribe nada.
const nodePipeline = wantSuggestions
  ? (async () => {
      const { rows } = await client.query(`select * from memories_similar($1, 5)`, [vectorLiteral]);
      // is_meta marcado a mano: que el clasificador no elija un recuerdo del propio sistema solo
      // porque el registro ocurre en él.
      const nodeCandidates = rows.map((r) => ({
        memory_name: r.memory_name, examples: r.examples, similarity: r.similarity, aliases: r.aliases,
        is_meta: Boolean(memByName.get(r.memory_name)?.is_meta),
      }));
      const nodeVerdict = nodeCandidates.length > 0 ? await classifyNode(args.claim, nodeCandidates) : null;
      return { nodeCandidates, nodeVerdict };
    })().catch((err) => {
      // Fail-open, igual que los clasificadores: si falla memories_similar, sin veredicto y con
      // aviso. `failed` evita que el mensaje de la sección 3 diga que no hay recuerdos con embedding.
      console.error(`(sugerencia de recuerdos no disponible: ${err.message})`);
      return { nodeCandidates: [], nodeVerdict: null, failed: true };
    })
  : Promise.resolve({ nodeCandidates: [], nodeVerdict: null });

const needsResolution = () => similar.length > 0 && supersedesIds.length === 0 && complementsId === null && !distinct;
if (needsResolution()) {
  const auto = await classifyDuplicate(args.claim, similar, args.source, sourceAt);
  if (auto && auto.confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD) {
    console.error(`(auto-resuelto por ${providerLabel(CLASSIFIER_PROVIDER)}, ${CLASSIFIER_MODEL}, confianza ${auto.confidence.toFixed(2)}: ${auto.reasoning})`);
    if (auto.verdict === 'redundant') await stop(`Ya cubierto por #${auto.redundantId}, no se inserta (redundante).`, 0);
    if (auto.verdict === 'supersedes') supersedesIds = auto.supersedesIds;
    else if (auto.verdict === 'complements') complementsId = auto.complementsId;
    else distinct = true;
    source = `${source} [auto-resuelto por ${providerLabel(CLASSIFIER_PROVIDER)} (${CLASSIFIER_MODEL}), confianza ${auto.confidence.toFixed(2)}: ${auto.reasoning}]`;
  }
}
if (needsResolution()) {
  const lines = similar.map((c) =>
    `  #${c.id} [${c.date.toISOString().slice(0, 10)}] (similitud ${c.similarity.toFixed(2)}) ${truncateClaim(c.claim)}\n` +
    `     fuente: ${c.source}${c.memories ? ` · recuerdos: ${c.memories}` : ''}`);
  await stop(`Hay ${similar.length} registro(s) vivo(s) parecido(s), resuélvelo antes de insertar:\n\n${lines.join('\n')}\n\n` +
    'Si este registro reemplaza a alguno de los anteriores, pasa --supersedes <id>[,<id>...].\n' +
    'Si agrega información real sobre UNO de ellos sin repetir todo lo que ya dice, pasa --complements <id>.\n' +
    'Si es genuinamente distinto pese al parecido, pasa --distinct para confirmarlo explícitamente.\n' +
    'Si NO aporta nada que alguno de ellos no tuviera ya, no lo insertes: no hace falta ningún flag, ese es justo el caso que el clasificador debería haber resuelto solo como "redundant".');
}
const candidateIds = new Set(candidates.map((c) => Number(c.id)));
const invalid = supersedesIds.filter((id) => !candidateIds.has(id));
if (invalid.length > 0) await stop(`--supersedes referencia id(s) que no aparecieron entre los parecidos vivos: ${invalid.join(', ')}. Verifica los ids con timeline.mjs.`);
if (complementsId !== null && !candidateIds.has(complementsId)) {
  await stop(`--complements referencia un id que no apareció entre los parecidos vivos: ${complementsId}. Verifica el id con timeline.mjs.`);
}

// --- 3. Recuerdos y propuestas -------------------------------------------------------------
const { nodeCandidates, nodeVerdict, failed: suggestionsFailed } = await nodePipeline;
const proposals = [];
const propose = (p) => { if (!proposals.some((q) => q.memory === p.memory)) proposals.push(p); };
let requested = requestedInput;
const verdictText = () => `${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}`;

if (requested.length === 0) {
  if (!nodeVerdict || nodeVerdict.confidence < NODE_CONFIDENCE_THRESHOLD) {
    const near = nodeCandidates.length > 0
      ? 'Recuerdos existentes más parecidos:\n' + nodeCandidates.map((c) =>
          `  "${c.memory_name}" (similitud ${c.similarity.toFixed(2)}):\n` + c.examples.map((ex) => `      - ${truncateClaim(ex)}`).join('\n')).join('\n')
      : suggestionsFailed
        ? '(no se pudieron consultar los recuerdos parecidos: falló la consulta, ver el aviso de arriba)'
        : '(no hay registros con embedding en ningún recuerdo todavía para comparar)';
    await stop(`No se pasó --memory y la desambiguación automática no alcanzó confianza suficiente.\n\n${near}\n\n` +
      'Pasa --memory <nombre existente>. Si hace falta uno nuevo, agrégalo también en --memory: quedará como propuesta pendiente.');
  }
  if (nodeVerdict.verdict === 'new') {
    await stop(`No se guardó. El clasificador (${verdictText()}) propone un recuerdo NUEVO: "${nodeVerdict.node}" (${nodeVerdict.reasoning})\n` +
      `Un registro necesita al menos un recuerdo existente: vuelve a llamar con --memory <existente adecuado>,${nodeVerdict.node}. ` +
      'El nuevo quedará como propuesta y solo se crea si el usuario la acepta.');
  }
  if (!queueMode) {
    await stop(`No se guardó. Falta --memory. El clasificador (${verdictText()}) sugiere el recuerdo existente "${nodeVerdict.node}" (${nodeVerdict.reasoning}).\n` +
      `Vuelve a llamar con --memory "${nodeVerdict.node}" (u otro que corresponda).`);
  }
  requested = [nodeVerdict.node];
  console.error(`(recuerdo auto-resuelto por ${verdictText()}: ${nodeVerdict.reasoning})`);
} else if (nodeVerdict && nodeVerdict.confidence >= NODE_CONFIDENCE_THRESHOLD &&
           (nodeVerdict.verdict === 'new' || !requested.includes(nodeVerdict.node))) {
  propose({ memory: nodeVerdict.node, kind: nodeVerdict.verdict === 'new' ? 'new' : 'instead', confidence: nodeVerdict.confidence, reasoning: nodeVerdict.reasoning });
}

// Recuerdos adicionales: los candidatos por embedding más los que el texto nombra literalmente
// aunque no rankeen. Solo propuestas.
if (wantSuggestions) {
  const literal = (await literalMentionCandidates(client, args.claim, requested, liveNonMeta))
    .filter((c) => !nodeCandidates.some((n) => n.memory_name === c.memory_name));
  const remaining = [
    ...nodeCandidates.filter((c) => !requested.includes(c.memory_name) && !proposals.some((p) => p.memory === c.memory_name)),
    ...literal,
  ];
  if (remaining.length > 0) {
    for (const item of await classifyAdditionalMemories(args.claim, requested.join(', '), remaining)) {
      if (item.confidence >= NODE_CONFIDENCE_THRESHOLD) propose({ memory: item.node, kind: 'additional', confidence: item.confidence, reasoning: item.reasoning });
    }
  }
}

const resolvedNodes = [];
for (const name of requested) {
  const r = resolveLive(name);
  if (r.cycle) await stop(`Ciclo de merged_into detectado en recuerdos empezando por "${name}".`);
  if (r.ok) { if (!resolvedNodes.includes(r.name)) resolvedNodes.push(r.name); }
  else propose({ memory: name, kind: 'new', confidence: null, reasoning: 'pedido en --memory, todavía no existe' });
}
if (args['create-memory']) console.error('(--create-memory ya no crea recuerdos: un recuerdo pedido que no existe queda como propuesta pendiente)');
if (resolvedNodes.length === 0) {
  await stop(`No se guardó: ninguno de los recuerdos pedidos existe (${requested.map((n) => `"${n}"`).join(', ')}). ` +
    'Un registro necesita al menos uno existente; agrega uno en --memory y el nuevo quedará como propuesta pendiente.');
}

// Aviso de fusión de contexto: el claim cita ids vigentes sin --supersedes/--complements.
const covered = new Set([...supersedesIds, ...(complementsId !== null ? [complementsId] : [])]);
const uncovered = [...new Set([...args.claim.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))].filter((id) => !covered.has(id));
if (uncovered.length > 0) {
  const { rows } = await client.query(`select id from records where id = any($1::bigint[]) and valid_until is null`, [uncovered]);
  if (rows.length > 0) {
    console.error(`(aviso: el claim menciona ${rows.map((r) => `#${r.id}`).join(', ')} -- si es solo una cita/referencia, ignora esto; ` +
      'si trajiste contenido de ese registro hacia este texto, revisa si de verdad pertenece aquí, memory-status.mjs ya sintetiza juntos los registros del mismo recuerdo, no hace falta repetirlo. ' +
      'Si es una relación real, --complements <id> lo deja trazable en vez de fundido en la prosa.)');
  }
}

// --- 4. Escritura atómica ------------------------------------------------------------------
// Registro, recuerdos y reemplazo van juntos: antes un fallo entre inserts dejaba un registro
// sin recuerdos, o el nuevo y el reemplazado vigentes a la vez.
let inserted;
try {
  await client.query('begin');
  ({ rows: [inserted] } = await client.query(
    `insert into records (claim, kind, date, source, confidence, embedding, complements, source_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, date, claim`,
    [args.claim, kind, args.date, source, confidence, vectorLiteral, complementsId, sourceAt],
  ));
  await client.query(
    `insert into record_memories (record_id, memory_name) select $1::bigint, unnest($2::text[]) on conflict do nothing`,
    [inserted.id, resolvedNodes],
  );
  if (supersedesIds.length > 0) {
    await client.query(`update records set valid_until = now(), superseded_by = $1 where id = any($2::bigint[])`, [inserted.id, supersedesIds]);
  }
  await client.query('commit');
} catch (err) {
  await client.query('rollback').catch(() => {});
  await stop(`No se guardó, la base rechazó la escritura: ${err.message}`);
}
const newId = inserted.id;

console.log(`Recuerdo(s): ${resolvedNodes.join(', ')}`);
if (proposals.length > 0) console.log(proposalQueuedText(await queueProposals(client, newId, proposals, NODE_CLASSIFIER_MODEL), proposals));

// --- 5. Después del registro, a mejor esfuerzo ---------------------------------------------
// Las llamadas al modelo van en paralelo; las escrituras, en orden.
const timelineCache = new Map();
const factsOf = (memory) => {
  if (!timelineCache.has(memory)) {
    timelineCache.set(memory, client.query(`select * from records_timeline($1, $2, false)`, [memory, 1000]).then((r) => formatFactsBlock(r.rows)));
  }
  return timelineCache.get(memory);
};

// Enlaces entre recuerdos co-etiquetados: la relación ya la decidió quien llamó con
// varios --memory; el clasificador solo le pone nombre, con respaldo genérico.
if (resolvedNodes.length > 1) {
  const { rows: links } = await client.query(
    `select from_memory, to_memory from memory_links where from_memory = any($1::text[]) and to_memory = any($1::text[])`,
    [resolvedNodes],
  );
  const linked = new Set(links.map((l) => [l.from_memory, l.to_memory].sort().join('\u0001')));
  const pairs = [];
  for (let i = 0; i < resolvedNodes.length; i++) {
    for (let j = i + 1; j < resolvedNodes.length; j++) {
      if (!linked.has([resolvedNodes[i], resolvedNodes[j]].sort().join('\u0001'))) pairs.push([resolvedNodes[i], resolvedNodes[j]]);
    }
  }
  const judgedPairs = await Promise.all(pairs.map(async ([from, to]) => classifyMentionRelationHybrid(args.claim, from, to, await factsOf(to))));
  for (const [k, [from, to]] of pairs.entries()) {
    const judged = judgedPairs[k];
    const reason = judged?.relation
      ? `[auto-creado por co-etiquetado explícito (${judged.via}), confianza ${judged.confidence.toFixed(2)}]: ${judged.reasoning} (registro #${newId})`
      : `[auto-creado por co-etiquetado explícito, sin clasificar -- clasificador no disponible o sin relación específica] (registro #${newId})`;
    const edge = await createLink(client, from, to, judged?.relation || 'co-registrado_en', reason, args.date);
    if (edge.ok) console.log(`(enlace auto-creado: ${edge.fromMemory} -> ${edge.toMemory} (${edge.relation}))`);
  }
}

if (supersedesIds.length > 0) console.log(`Reemplazó a #${supersedesIds.join(', #')}.`);
else if (complementsId !== null) console.log(`Complementa a #${complementsId} (ambos quedan vigentes, se anexan juntos en la búsqueda).`);
else if (similar.length > 0 && distinct) console.log(`Confirmado como distinto pese al parecido con #${similar.map((c) => c.id).join(', #')}.`);

// Cierre de compromisos abiertos de los mismos recuerdos. Lo ya relacionado de forma
// explícita (complementado o reemplazado) no entra al juicio del clasificador.
const { rows: openCommitments } = await client.query(
  `select distinct r.id, r.claim from records r join record_memories rm on rm.record_id = r.id
   where r.kind = 'commitment' and r.valid_until is null and rm.memory_name = any($1::text[])
     and r.id <> $2 and r.id <> all($3::bigint[])`,
  [resolvedNodes, newId, [...covered]],
);
const verdicts = await Promise.all(openCommitments.map((c) => classifyCommitmentResolution(args.claim, c.claim)));
for (const [k, commitment] of openCommitments.entries()) {
  const v = verdicts[k];
  if (!v || v.verdict === 'none' || v.confidence < COMMITMENT_CONFIDENCE_THRESHOLD) continue;
  await client.query(
    `update records set valid_until = now(), superseded_by = $2::bigint,
       source = source || ' [SUPERSEDIDO ' || to_char(now(), 'YYYY-MM-DD') || ' por #' || $3 || ': cierre automático de compromiso, confianza ' || $4 || ']'
     where id = $1 and valid_until is null`,
    [commitment.id, newId, String(newId), v.confidence.toFixed(2)],
  );
  if (v.verdict === 'full') {
    console.log(`(compromiso #${commitment.id} cerrado por completo por este registro, confianza ${v.confidence.toFixed(2)}: ${v.reasoning})`);
  } else {
    console.log(`(compromiso #${commitment.id} cerrado PARCIALMENTE por este registro, confianza ${v.confidence.toFixed(2)}: ${v.reasoning})`);
    console.log(`  Queda pendiente crear un nuevo --kind commitment con lo que sigue sin resolver de: "${truncateClaim(commitment.claim)}"`);
  }
}

// Menciones literales de otro recuerdo (Etapa 6). Se salta si el registro es de un recuerdo
// is_meta: esos registros nombran otros recuerdos como ejemplos, no como relación.
const ownIsMeta = resolvedNodes.some((n) => memByName.get(n)?.is_meta);
const mentions = ownIsMeta ? [] : detectNodeMentions(args.claim, resolvedNodes, liveNonMeta);
const judgedMentions = await Promise.all(
  mentions.map(async (m) => classifyMentionRelationHybrid(args.claim, resolvedNodes[0], m.node, await factsOf(m.node))),
);
for (const [k, m] of mentions.entries()) {
  const judged = judgedMentions[k];
  if (judged?.verdict === 'no_relation') continue;
  if (judged?.verdict === 'relation' && judged.confidence >= MENTION_CONFIDENCE_THRESHOLD) {
    let allCreated = true;
    for (const from of resolvedNodes) {
      const edge = await createLink(client, from, m.node, judged.relation,
        `[auto-creado por clasificador de menciones (${judged.via}), confianza ${judged.confidence.toFixed(2)}]: ${judged.reasoning} (registro #${newId})`, args.date);
      if (edge.ok) console.log(`(enlace auto-creado: ${edge.fromMemory} -> ${edge.toMemory} (${edge.relation}), confianza ${judged.confidence.toFixed(2)})`);
      else allCreated = false;
    }
    if (allCreated) continue;
  }
  console.log(`\n(el claim menciona a "${m.node}" (coincide con "${m.matchedOn}") -- posible relación, revisión manual):`);
  for (const from of resolvedNodes) {
    console.log(`  memory-link.mjs --from ${from} --to ${m.node} --relation "${judged?.relation || '...'}" --date ${args.date} --reason "registro #${newId}"`);
  }
}

console.log(`Registrado #${newId}: [${inserted.date.toISOString().slice(0, 10)}] ${inserted.claim}`);
await client.end();
