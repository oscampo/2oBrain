// Fase 3: registra un registro atómico con fecha y fuente obligatorias.
// Fase 4: antes de insertar, busca registros vivos parecidos por embedding.
// Si hay candidatos por encima del umbral, se niega a insertar salvo que
// se pase --supersedes <id>[,<id>...] o --distinct explícitamente: no hay
// ruta silenciosa para que una contradicción quede sin resolver.
//
// Rediseño 2026-08-29 (ver PLAN-recuerdos.md): --slug (page_slug, columna
// única) reemplazado por --memory (record_memories, many-to-many). Etapa 2
// (2026-08-29): --memory ya es opcional: sin él, se busca por embedding entre
// registros existentes agrupados por recuerdo (memories_similar()) y un clasificador
// (lib/classify-memory.mjs) decide el recuerdo, o bloquea si no hay confianza
// suficiente (fail-closed, nunca inserta con recuerdo nulo o placeholder). Con
// --memory explícito, la desambiguación igual corre pero solo como aviso, la
// elección del humano nunca se sobreescribe. Un recuerdo debe existir de
// antemano en la tabla `memories` (fail-closed contra typos) salvo que se pase
// --create-memory explícitamente. Si un recuerdo fue fusionado a otro
// (`merged_into`), se resuelve solo al recuerdo vigente.
// Uso:
//   node remember.mjs --claim "texto del registro" --date 2026-08-22 --source "conversación Claude Code" [--kind fact|event|commitment] [--memory recuerdo1,recuerdo2] [--create-memory] [--aliases "alias1,alias2"] [--confidence 0.9] [--supersedes 12,15] [--distinct] [--confirm-date]
//
// --confirm-date: obligatorio si --date no es la fecha real de hoy (America/
// Bogota): confirma que un registro con fecha distinta es intencional
// (histórico, backfill), no un error de no verificar la fecha antes de llamar.
//
// Sin --memory, deja que la desambiguación automática lo resuelva (bloquea si no hay confianza suficiente).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral } from './lib/embed.mjs';
import { classifyDuplicate, CLASSIFIER_CONFIDENCE_THRESHOLD, CLASSIFIER_MODEL } from './lib/classify-duplicate.mjs';
import { classifyNode, CLASSIFIER_CONFIDENCE_THRESHOLD as NODE_CONFIDENCE_THRESHOLD, CLASSIFIER_MODEL as NODE_CLASSIFIER_MODEL } from './lib/classify-memory.mjs';
import { detectNodeMentions } from './lib/detect-memory-mentions.mjs';
import { findAliasCollisions } from './lib/check-alias-collision.mjs';
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
        out[key] = true; // flags sin valor, ej. --distinct
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.claim || !args.date || !args.source) {
  console.error(
    'Faltan campos obligatorios. Uso:\n' +
      '  node remember.mjs --claim "..." --date YYYY-MM-DD --source "..." [--kind fact] [--memory recuerdo1,recuerdo2] [--create-memory] [--aliases "a,b"] [--confidence 1.0] [--supersedes id,id] [--distinct] [--confirm-date]',
  );
  process.exit(1);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
  console.error(`Fecha inválida: "${args.date}". Debe ser YYYY-MM-DD, no se infiere.`);
  process.exit(1);
}

// --date distinto de hoy es legítimo a propósito (registros históricos,
// backfill de extract-records.mjs sobre una sesión pasada, timelines de
// proyectos armados en retrospectiva): nunca debe bloquearse por defecto
// solo por eso. Pero un aviso que solo se imprime y sigue de largo es
// exactamente el tipo de fallo silencioso que causó el error real del
// 2026-09-03 (registro #525 quedó fechado 2026-09-01 por no verificar la fecha
// antes de llamar esto): fácil de no leer entre el resto del output. Fix:
// bloquea salvo que se pase --confirm-date explícito, mismo patrón que
// --distinct/--create-memory en este mismo script: no es fricción para el
// caso histórico legítimo (un flag, no una re-ejecución completa), y hace
// imposible que el desfase pase desapercibido en el caso accidental.
const todayBogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
if (args.date !== todayBogota && !args['confirm-date']) {
  console.error(
    `--date ${args.date} es distinto de hoy (${todayBogota} en America/Bogota).\n` +
      'Si es un registro histórico o backfill intencional, agrega --confirm-date para confirmarlo.\n' +
      'Si fue sin querer, corrige --date y vuelve a intentar.',
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

const embedding = await embed(args.claim, 'document');
const vectorLiteral = toVectorLiteral(embedding);

const { rows: candidates } = await client.query(
  `select f.id, f.claim, f.date, f.source, f.kind,
          (select string_agg(memory_name, ', ' order by memory_name) from record_memories where record_id = f.id) as memories,
          1 - (f.embedding <=> $1) as similarity
   from records f
   where f.valid_until is null and f.embedding is not null
   order by f.embedding <=> $1
   limit 5`,
  [vectorLiteral],
);

const similar = candidates.filter((c) => c.similarity >= SIMILARITY_THRESHOLD);

let supersedesIds = args.supersedes
  ? String(args.supersedes)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n))
  : [];

let autoResolved = null;

if (similar.length > 0 && supersedesIds.length === 0 && !args.distinct) {
  autoResolved = await classifyDuplicate(args.claim, similar);
  if (autoResolved && autoResolved.confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD) {
    if (autoResolved.verdict === 'supersedes') {
      supersedesIds = autoResolved.supersedesIds;
    } else {
      args.distinct = true;
    }
    console.error(
      `(auto-resuelto por Ollama Cloud, ${CLASSIFIER_MODEL}, confianza ${autoResolved.confidence.toFixed(2)}: ${autoResolved.reasoning})`,
    );
  } else {
    autoResolved = null; // confianza insuficiente o clasificador no disponible: no se usa como resolución
  }
}

if (similar.length > 0 && supersedesIds.length === 0 && !args.distinct) {
  console.error(`Hay ${similar.length} registro(s) vivo(s) parecido(s), resuélvelo antes de insertar:\n`);
  for (const c of similar) {
    console.error(
      `  #${c.id} [${c.date.toISOString().slice(0, 10)}] (similitud ${c.similarity.toFixed(2)}) ${truncateClaim(c.claim)}`,
    );
    console.error(`     fuente: ${c.source}${c.memories ? ` · recuerdos: ${c.memories}` : ''}`);
  }
  console.error(
    '\nSi este registro reemplaza a alguno de los anteriores, pasa --supersedes <id>[,<id>...].\n' +
      'Si es genuinamente distinto pese al parecido, pasa --distinct para confirmarlo explícitamente.',
  );
  await client.end();
  process.exit(1);
}

if (autoResolved) {
  args.source = `${args.source} [auto-resuelto por Ollama Cloud (${CLASSIFIER_MODEL}), confianza ${autoResolved.confidence.toFixed(2)}: ${autoResolved.reasoning}]`;
}

if (supersedesIds.length > 0) {
  const invalid = supersedesIds.filter((id) => !candidates.some((c) => Number(c.id) === id));
  if (invalid.length > 0) {
    console.error(
      `--supersedes referencia id(s) que no aparecieron entre los parecidos vivos: ${invalid.join(', ')}. Verifica los ids con timeline.mjs.`,
    );
    await client.end();
    process.exit(1);
  }
}

// Etapa 2 (PLAN-recuerdos.md, 2026-08-29): desambiguación por búsqueda vectorial
// + clasificador. Corre SIEMPRE (Etapa 0: "siempre corre desambiguación
// después, incluso si viene explícito"), pero solo bloquea cuando --memory no
// vino: si el humano ya eligió explícitamente, la desambiguación es un
// chequeo informativo (stderr), nunca sobreescribe una decisión explícita.
const { rows: nodeCandidateRows } = await client.query(`select * from memories_similar($1, 5)`, [vectorLiteral]);
const nodeCandidates = nodeCandidateRows.map((r) => ({
  memory_name: r.memory_name,
  examples: r.examples,
  similarity: r.similarity,
  aliases: r.aliases,
}));

let nodeVerdict = null;
if (nodeCandidates.length > 0) {
  nodeVerdict = await classifyNode(args.claim, nodeCandidates);
}

let requestedNodes = args.memory
  ? String(args.memory)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

if (requestedNodes.length === 0) {
  // Sin --memory explícito: la propuesta del clasificador ES la decisión, no
  // solo una sugerencia: pero solo si pasa el umbral de confianza.
  if (!nodeVerdict || nodeVerdict.confidence < NODE_CONFIDENCE_THRESHOLD) {
    console.error('No se pasó --memory y la desambiguación automática no alcanzó confianza suficiente.\n');
    if (nodeCandidates.length > 0) {
      console.error('recuerdos existentes más parecidos:');
      for (const c of nodeCandidates) {
        console.error(`  "${c.memory_name}" (similitud ${c.similarity.toFixed(2)}):`);
        for (const ex of c.examples) console.error(`      - ${truncateClaim(ex)}`);
      }
    } else {
      console.error('(no hay registros con embedding en ningún recuerdo todavía para comparar)');
    }
    console.error(
      '\nPasa --memory <nombre existente>, o --memory <nombre nuevo> --create-memory si es genuinamente un recuerdo nuevo.',
    );
    await client.end();
    process.exit(1);
  }
  if (nodeVerdict.verdict === 'new') {
    console.error(
      `El clasificador (${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}) propone un recuerdo NUEVO: "${nodeVerdict.node}" (${nodeVerdict.reasoning})\n` +
        `Si es correcto, vuelve a llamar con --memory "${nodeVerdict.node}" --create-memory.`,
    );
    await client.end();
    process.exit(1);
  }
  // verdict === 'existing' con confianza suficiente: la propuesta ES el recuerdo.
  requestedNodes = [nodeVerdict.node];
  console.error(
    `(recuerdo auto-resuelto por ${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}: ${nodeVerdict.reasoning})`,
  );
} else if (
  nodeVerdict &&
  nodeVerdict.confidence >= NODE_CONFIDENCE_THRESHOLD &&
  (nodeVerdict.verdict === 'new' || !requestedNodes.includes(nodeVerdict.node))
) {
  // --memory vino explícito pero la desambiguación sugiere algo distinto con
  // confianza alta: se avisa, nunca se bloquea ni se sobreescribe.
  console.error(
    `(aviso: la desambiguación automática (${NODE_CLASSIFIER_MODEL}, confianza ${nodeVerdict.confidence.toFixed(2)}) ` +
      `sugiere ${nodeVerdict.verdict === 'new' ? `un recuerdo nuevo distinto: "${nodeVerdict.node}"` : `el recuerdo existente "${nodeVerdict.node}"`}` +
      ` en vez de ${requestedNodes.map((n) => `"${n}"`).join(', ')}, ${nodeVerdict.reasoning}. Se respeta tu elección explícita.)`,
  );
}

// --aliases (2026-09-02): un recuerdo nuevo nacía siempre con aliases vacío --
// el mismo hueco que forzó el backfill guiado de 24 recuerdos (ver PLAN-recuerdos.md,
// Etapa 6, registro #497: un `name` kebab-case casi nunca aparece literal en
// prosa natural, así que detect-memory-mentions.mjs no podía reconocer
// menciones futuras sin alias). Solo aplica junto con --create-memory, y solo
// si esta llamada crea exactamente UN recuerdo nuevo -- con varios a la vez, una
// sola lista de alias sería ambigua (¿de cuál de todos?). Mismo chequeo de
// colisión que set-memory-aliases.mjs (lib/check-alias-collision.mjs): un
// alias que ya es name/alias de otro recuerdo bloquea, no se crea nada.
let aliasesForNewNode = null;
if (args.aliases) {
  if (!args['create-memory']) {
    console.error('--aliases solo aplica junto con --create-memory.');
    await client.end();
    process.exit(1);
  }
  const { rows: existing } = await client.query(`select name from memories where name = any($1::text[])`, [requestedNodes]);
  const existingNames = new Set(existing.map((r) => r.name));
  const toCreate = requestedNodes.filter((n) => !existingNames.has(n));
  if (toCreate.length !== 1) {
    console.error(
      `--aliases solo aplica si esta llamada crea exactamente un recuerdo nuevo (crearía ${toCreate.length}: ${toCreate.join(', ') || 'ninguno'}). Créalos por separado, o aplica alias después con set-memory-aliases.mjs.`,
    );
    await client.end();
    process.exit(1);
  }
  const newAliases = args.aliases.split(',').map((a) => a.trim()).filter(Boolean);
  const conflicts = await findAliasCollisions(client, toCreate[0], newAliases);
  if (conflicts.length > 0) {
    console.error(`Colisión -- no se crea el recuerdo. Los siguientes alias ya pertenecen a otro recuerdo:`);
    for (const c of conflicts) console.error(`  "${c.alias}" ya es name/alias de "${c.node}"`);
    await client.end();
    process.exit(1);
  }
  aliasesForNewNode = { name: toCreate[0], aliases: newAliases };
}

// Resuelve cada recuerdo: debe existir en `memories` (fail-closed contra typos que
// crearían un recuerdo fantasma), salvo --create-memory explícito. Si un recuerdo fue
// fusionado a otro (merged_into), sigue la cadena al vigente: nadie que
// llame remember.mjs necesita saber que un recuerdo cambió de nombre.
const resolvedNodes = [];
for (const name of requestedNodes) {
  let current = name;
  const seen = new Set();
  let row = null;
  while (true) {
    if (seen.has(current)) {
      console.error(`Ciclo de merged_into detectado en recuerdos empezando por "${name}".`);
      await client.end();
      process.exit(1);
    }
    seen.add(current);
    const { rows: found } = await client.query(`select name, merged_into from memories where name = $1`, [current]);
    if (found.length === 0) {
      row = null;
      break;
    }
    row = found[0];
    if (!row.merged_into) break;
    current = row.merged_into;
  }
  if (row) {
    resolvedNodes.push(row.name);
  } else if (args['create-memory']) {
    if (aliasesForNewNode?.name === name) {
      await client.query(
        `insert into memories (name, aliases) values ($1, $2) on conflict (name) do nothing`,
        [name, aliasesForNewNode.aliases],
      );
    } else {
      await client.query(`insert into memories (name) values ($1) on conflict (name) do nothing`, [name]);
    }
    resolvedNodes.push(name);
  } else {
    console.error(
      `recuerdo "${name}" no existe en la tabla memories. Pasa --create-memory si es genuinamente uno nuevo, o revisa el nombre con list-memories.mjs.`,
    );
    await client.end();
    process.exit(1);
  }
}

const { rows } = await client.query(
  `insert into records (claim, kind, date, source, confidence, embedding)
   values ($1, $2, $3, $4, $5, $6)
   returning id, date, claim`,
  [
    args.claim,
    args.kind ?? 'fact',
    args.date,
    args.source,
    args.confidence ? Number(args.confidence) : 1.0,
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
if (resolvedNodes.length > 0) {
  console.log(`recuerdo(s): ${resolvedNodes.join(', ')}`);
}

if (supersedesIds.length > 0) {
  await client.query(
    `update records set valid_until = now(), superseded_by = $1 where id = any($2::bigint[])`,
    [newId, supersedesIds],
  );
  console.log(`Reemplazó a #${supersedesIds.join(', #')}.`);
} else if (similar.length > 0 && args.distinct) {
  console.log(`Confirmado como distinto pese al parecido con #${similar.map((c) => c.id).join(', #')}.`);
}

// Etapa 6 (PLAN-recuerdos.md, 2026-09-02, registro #487): co-ocurrencia textual en
// vez del barrido O(n²) por embeddings que no funcionó -- si el claim
// menciona por nombre a otro recuerdo vigente, es señal barata de una posible
// relación. Solo avisa (mismo criterio "revisión humana obligatoria" que
// list-link-candidates-deep.mjs/merge-memories.mjs) -- nunca crea nada solo.
// Se salta por completo si el registro es de un recuerdo is_meta (segundo-cerebro,
// segundo-cerebro-dashboard-log): esos registros documentan la construcción
// del propio sistema y mencionan otros recuerdos como ejemplos dentro de su
// narración -- autorreferencia, no relación real (hallazgo real probando
// list-memory-mentions.mjs contra el histórico, 2026-09-02).
const { rows: ownIsMeta } = resolvedNodes.length > 0
  ? await client.query(`select count(*)::int as n from memories where name = any($1::text[]) and is_meta`, [resolvedNodes])
  : { rows: [{ n: 0 }] };
const { rows: allNodeRows } = ownIsMeta[0].n > 0
  ? { rows: [] }
  : await client.query(`select name, aliases from memories where merged_into is null and not is_meta`);
const mentions = detectNodeMentions(args.claim, resolvedNodes, allNodeRows);

// Auto-creación de enlaces (2026-09-02, decisión del usuario: "lo haremos
// automático"). classify-mention-relation.mjs juzga cada candidato puntual
// (costo lineal con registros nuevos, no el barrido O(n²)) -- confianza alta
// crea el enlace solo (anotado en source, igual que un registro auto-resuelto);
// confianza baja o el clasificador no disponible cae al candidato de
// revisión manual de siempre; "no_relation" se descarta sin mostrar nada,
// es la reducción de ruido que pidió el usuario. Nunca trata un fallo del
// clasificador como "no hay relación" -- eso perdería la señal gratis de
// detectNodeMentions.
for (const m of mentions) {
  const { rows: bFactRows } = await client.query(`select * from records_timeline($1, $2, false)`, [m.node, 1000]);
  const judged = await classifyMentionRelationHybrid(args.claim, resolvedNodes[0], m.node, formatFactsBlock(bFactRows));

  if (judged?.verdict === 'no_relation') continue;

  if (judged?.verdict === 'relation' && judged.confidence >= MENTION_CONFIDENCE_THRESHOLD) {
    let allCreated = true;
    for (const from of resolvedNodes) {
      const edgeResult = await createLink(
        client, from, m.node, judged.relation,
        `[auto-creado por clasificador de menciones (${judged.via}), confianza ${judged.confidence.toFixed(2)}]: ${judged.reasoning} (registro #${newId})`,
        args.date,
      );
      if (edgeResult.ok) {
        console.log(`(enlace auto-creado: ${edgeResult.fromMemory} -> ${edgeResult.toMemory} (${edgeResult.relation}), confianza ${judged.confidence.toFixed(2)})`);
      } else {
        allCreated = false;
      }
    }
    if (allCreated) continue;
  }

  console.log(`\n(el claim menciona a "${m.node}" (coincide con "${m.matchedOn}") -- posible relación, revisión manual):`);
  for (const from of resolvedNodes) {
    console.log(`  memory-link.mjs --from ${from} --to ${m.node} --relation "${judged?.relation || '...'}" --date ${args.date} --reason "registro #${newId}"`);
  }
}

console.log(`Registrado #${newId}: [${rows[0].date.toISOString().slice(0, 10)}] ${rows[0].claim}`);
await client.end();
