// Herramienta de revisión, no de automatización (mismo principio que
// list-merge-candidates.mjs y list-edge-candidates.mjs): a diferencia de la
// versión barata (que solo encuentra relaciones ya escritas juntas en un
// mismo hecho), esta le da al LLM el texto COMPLETO de los hechos vigentes
// de dos nodos y le pide que encuentre relaciones que nunca comparten texto
// literal. Nunca crea nada solo: node-link.mjs sigue siendo quien conecta.
//
// Costo controlado (2026-09-02, ver discusión en segundo-cerebro): sin
// memoria, cada corrida repetiría TODOS los pares desde cero y el costo
// crecería cuadráticamente con el número de nodos. node_pair_checks recuerda
// qué pares ya se evaluaron (y con cuántos hechos tenía cada lado en ese
// momento): una corrida normal solo procesa pares nuevos o donde algún lado
// creció desde el último check. Los nodos marcados is_meta (el propio
// sistema hablando de sí mismo) se excluyen siempre: verificado en vivo que
// "se relacionan" tautológicamente con todo.
//
// Grounding: ver lib/classify-relation.mjs para el diseño validado (copiar
// el hecho completo, no un fragmento): este script además verifica cada
// relación devuelta contra el texto real antes de mostrarla; ninguna
// relación no verificable llega a la salida.
//
// Uso:
//   node list-edge-candidates-deep.mjs                (barrido incremental completo)
//   node list-edge-candidates-deep.mjs --node-a X --node-b Y --force   (un par puntual, ignora la memoria)
//   node list-edge-candidates-deep.mjs --provider ollama --model gemma4:31b-cloud   (modelo Ollama Cloud explícito)
//   node list-edge-candidates-deep.mjs --limit 8   (procesa solo los primeros 8 pares pendientes -- lotes contra cuota ajustada)
//   node list-edge-candidates-deep.mjs --threshold 0.8   (umbral del filtro de centroide, default 0.85)
//   node list-edge-candidates-deep.mjs --no-filter   (desactiva el filtro de centroide, todos los pares van al LLM)
//   [--provider gemini|ollama]  Default gemini -- ver lib/classify-relation.mjs, es el único
//     validado en la práctica contra el patrón espurio "ambos hechos mencionan a la misma persona".
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { classifyRelation, CLASSIFIER_MODELS, CLASSIFIER_DEFAULT_PROVIDER } from './lib/classify-relation.mjs';
import { formatFactsBlock } from './lib/format-facts.mjs';

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
const provider = args.provider ?? CLASSIFIER_DEFAULT_PROVIDER;
if (provider !== 'gemini' && provider !== 'ollama') {
  console.error(`--provider inválido: "${provider}". Debe ser "gemini" u "ollama".`);
  process.exit(1);
}
// --model solo aplica a provider ollama (gemini siempre usa su lista de
// respaldo, ver classifyRelation()) -- ej. --provider ollama --model gemma4:31b-cloud
const modelOverride = provider === 'ollama' ? args.model : undefined;
const modelLabel = modelOverride ?? CLASSIFIER_MODELS[provider];

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

async function factCount(node) {
  const { rows } = await client.query(
    `select count(*)::int as n from fact_nodes fn join facts f on f.id = fn.fact_id where fn.node_name = $1 and f.valid_until is null`,
    [node],
  );
  return rows[0].n;
}

async function fetchFacts(node) {
  const { rows } = await client.query(`select * from facts_timeline($1, $2, false)`, [node, 1000]);
  return rows;
}

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

// Extrae el #id inicial de un texto tipo "#123 [2026-01-01] claim...": el
// modelo debe devolver exactamente este formato (mismo que timeline.mjs).
function extractId(text) {
  const m = String(text).match(/^#(\d+)/);
  return m ? Number(m[1]) : null;
}

// Verifica que el "hecho completo" que devolvió el modelo de verdad
// corresponda a un hecho real de ese nodo: no solo que el id exista, sino
// que el texto citado contenga el claim real (tolerante a espacios/acentos,
// pero no a contenido inventado).
function validateSide(text, rowsById) {
  const id = extractId(text);
  if (id === null) return { ok: false, reason: 'no se pudo extraer un #id del inicio del texto' };
  const real = rowsById.get(id);
  if (!real) return { ok: false, reason: `el id #${id} no existe en los hechos de este nodo` };
  if (!normalize(text).includes(normalize(real.claim))) {
    return { ok: false, reason: `el texto citado no coincide con el hecho real #${id}: "${real.claim}"` };
  }
  return { ok: true, id, real };
}

async function comparePair(nodeA, nodeB) {
  const [rowsA, rowsB] = await Promise.all([fetchFacts(nodeA), fetchFacts(nodeB)]);
  if (rowsA.length === 0 || rowsB.length === 0) return { edges: [], countA: rowsA.length, countB: rowsB.length };

  // facts.id es bigint: node-pg lo devuelve como string, no number. Sin
  // Number() aquí, Map.get(184) (extractId devuelve number) nunca coincide
  // con la clave "184" (string): bug real encontrado probando este mismo
  // script: descartaba relaciones correctas creyendo que el id no existía.
  const byIdA = new Map(rowsA.map((r) => [Number(r.id), r]));
  const byIdB = new Map(rowsB.map((r) => [Number(r.id), r]));

  const proposed = await classifyRelation(nodeA, formatFactsBlock(rowsA), nodeB, formatFactsBlock(rowsB), provider, modelOverride);
  if (proposed === null) {
    console.error(`  (clasificador no disponible para "${nodeA}" <-> "${nodeB}", se deja pendiente)`);
    return null;
  }

  const edges = [];
  for (const r of proposed) {
    const va = validateSide(r.fact_a, byIdA);
    const vb = validateSide(r.fact_b, byIdB);
    if (va.ok && vb.ok) {
      edges.push({ ...r, idA: va.id, idB: vb.id });
    } else {
      console.log(`  ✗ descartada ("${r.relation}"): ${!va.ok ? `A: ${va.reason}` : `B: ${vb.reason}`}`);
    }
  }
  return { edges, countA: rowsA.length, countB: rowsB.length };
}

async function recordCheck(nodeA, nodeB, countA, countB, edgesFound) {
  const [a, b] = [nodeA, nodeB].sort((x, y) => x.localeCompare(y));
  const [ca, cb] = a === nodeA ? [countA, countB] : [countB, countA];
  await client.query(
    `insert into node_pair_checks (node_a, node_b, fact_count_a, fact_count_b, edges_found, model)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (node_a, node_b) do update set
       fact_count_a = excluded.fact_count_a, fact_count_b = excluded.fact_count_b,
       edges_found = excluded.edges_found, model = excluded.model, checked_at = now()`,
    [a, b, ca, cb, edgesFound, modelLabel],
  );
}

// process.exit() forzado mientras Gemini/Ollama aún tienen sockets
// keep-alive pooleados provoca un crash de libuv en Windows
// (UV_HANDLE_CLOSING assertion) en vez de una salida limpia -- mismo bug
// que ya se documentó en extract-facts.mjs. Se usa process.exitCode +
// caída natural del módulo (guardando el resto del script en un `else`)
// en vez de exit() forzado.
if (args['node-a'] && args['node-b']) {
  console.error(`Comparando "${args['node-a']}" <-> "${args['node-b']}"...`);
  const result = await comparePair(args['node-a'], args['node-b']);
  if (result === null) {
    process.exitCode = 1;
  } else {
    if (result.edges.length === 0) {
      console.log('Sin relaciones validables entre estos dos nodos.');
    } else {
      for (const e of result.edges) {
        console.log(`\n"${args['node-a']}" <-> "${args['node-b']}", relación propuesta: ${e.relation}`);
        console.log(`  ${e.evidence}`);
        console.log(`  A: ${e.fact_a}`);
        console.log(`  B: ${e.fact_b}`);
        console.log(`  node-link.mjs --from ${args['node-a']} --to ${args['node-b']} --relation "${e.relation}" --date YYYY-MM-DD --reason "..."`);
      }
    }
    if (!args.force) await recordCheck(args['node-a'], args['node-b'], result.countA, result.countB, result.edges.length);
  }
  await client.end();
} else {

const { rows: nodes } = await client.query(`select name from nodes where merged_into is null and not is_meta order by name`);
const counts = new Map();
for (const n of nodes) counts.set(n.name, await factCount(n.name));

const { rows: checks } = await client.query(`select node_a, node_b, fact_count_a, fact_count_b from node_pair_checks`);
const checked = new Map();
for (const c of checks) checked.set([c.node_a, c.node_b].join('|'), c);

const pending = [];
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    // localeCompare, no el sort() por defecto de JS (orden por código UTF-16,
    // mayúsculas antes que minúsculas) -- Postgres compara node_pair_checks
    // con su propio collation, donde "automatizacion..." < "DB1-gestion-github"
    // (alfabético, minúscula/mayúscula es secundario). sort() por defecto
    // discrepaba justo en pares con DB1/DB2-gestion-github (únicos nodos con
    // mayúscula inicial), violando el check (node_a < node_b) de la tabla.
    const [a, b] = [nodes[i].name, nodes[j].name].sort((x, y) => x.localeCompare(y));
    const key = `${a}|${b}`;
    const prior = checked.get(key);
    const [countA, countB] = [counts.get(a), counts.get(b)];
    if (countA === 0 || countB === 0) continue; // nada que comparar de ese lado
    if (prior && prior.fact_count_a === countA && prior.fact_count_b === countB) continue; // sin cambios desde el último check
    pending.push([a, b]);
  }
}

// Filtro previo por similitud MÁXIMA entre hechos individuales (2026-09-02,
// segunda versión -- la primera usaba centroide/promedio y falló en vivo:
// verificado contra los 36 pares reales que encontró un barrido sin filtro,
// el centroide solo capturaba 6/36 (17%), descartando 30 relaciones reales
// por error. Causa: promediar TODOS los hechos de un nodo diluye un único
// punto de conexión real si el resto de los hechos del nodo son de otro
// tema. Esta versión no promedia -- toma, para cada par de nodos, el par de
// hechos individuales más parecido entre los dos (mismo criterio que
// nodes_similar(), Etapa 2, ya usa para clasificar un hecho nuevo contra
// nodos existentes, aplicado aquí nodo-contra-nodo). Un solo hecho de cada
// lado que se parezca es señal suficiente de que vale la pena mandarlo al
// LLM, aunque el resto de los hechos de ambos nodos no tengan nada que ver.
// Sin columna nueva que mantener -- se calcula al vuelo, mismo criterio
// "cero mantenimiento" de list-merge-candidates.mjs. El filtro NO reemplaza
// el juicio del LLM para los pares que sí pasan -- DB1/DB2 ya enseñó que
// "parecido" no es lo mismo que "relacionado" (misma infraestructura de
// GitHub, cursos distintos). --no-filter lo desactiva (todos los pares van
// al LLM, como antes).
const threshold = args.threshold ? Number(args.threshold) : 0.85;
let toCheck = pending;
if (!args['no-filter'] && pending.length > 0) {
  const { rows: maxSims } = await client.query(
    `select fn1.node_name as node_a, fn2.node_name as node_b,
            max(1 - (f1.embedding <=> f2.embedding)) as similarity
     from fact_nodes fn1
     join facts f1 on f1.id = fn1.fact_id and f1.valid_until is null and f1.embedding is not null
     join fact_nodes fn2 on fn2.node_name > fn1.node_name
     join facts f2 on f2.id = fn2.fact_id and f2.valid_until is null and f2.embedding is not null
     group by fn1.node_name, fn2.node_name`,
  );
  const simByPair = new Map(maxSims.map((r) => [`${r.node_a}|${r.node_b}`, r.similarity]));

  toCheck = [];
  let skipped = 0;
  for (const [a, b] of pending) {
    const sim = simByPair.get(`${a}|${b}`);
    if (sim !== undefined && sim < threshold) {
      await recordCheck(a, b, counts.get(a), counts.get(b), 0);
      skipped++;
    } else {
      toCheck.push([a, b]);
    }
  }
  if (skipped > 0) {
    console.error(`Filtro de centroide (umbral ${threshold}): ${skipped} par(es) descartado(s) sin gastar LLM, ${toCheck.length} pasan al clasificador.`);
  }
}

// --limit N: procesa solo los primeros N pares pendientes y para -- pensado
// para lotes chicos contra cuotas de API ajustadas (ej. 429 RESOURCE_EXHAUSTED
// de Gemini free tier), corriendo el script varias veces seguidas. Como los
// pares exitosos quedan en node_pair_checks y los fallidos no, cada corrida
// retoma solo lo que falta -- no hace falta llevar la cuenta a mano.
const limit = args.limit ? Number(args.limit) : null;
const batch = limit ? toCheck.slice(0, limit) : toCheck;

if (pending.length === 0) {
  console.log(`${nodes.length} nodo(s) de dominio, todos los pares ya revisados y sin cambios desde entonces. Nada que hacer.`);
} else if (toCheck.length === 0) {
  console.log(`${pending.length} par(es) pendiente(s), todos descartados por el filtro de centroide (umbral ${threshold}). Nada para el LLM esta corrida.`);
} else {
  console.error(`${batch.length} par(es) en este lote de ${toCheck.length} que pasaron el filtro (de ${pending.length} pendiente(s) totales, ${nodes.length} nodos de dominio) con ${modelLabel}...`);

  let totalEdges = 0;
  let failed = 0;
  for (const [a, b] of batch) {
    console.error(`\n"${a}" <-> "${b}"...`);
    const result = await comparePair(a, b);
    if (result === null) { failed++; continue; }
    for (const e of result.edges) {
      totalEdges++;
      console.log(`\n"${a}" <-> "${b}", relación propuesta: ${e.relation}`);
      console.log(`  ${e.evidence}`);
      console.log(`  A: ${e.fact_a}`);
      console.log(`  B: ${e.fact_b}`);
      console.log(`  node-link.mjs --from ${a} --to ${b} --relation "${e.relation}" --date YYYY-MM-DD --reason "..."`);
    }
    await recordCheck(a, b, result.countA, result.countB, result.edges.length);
  }

  console.log(`\n--- ${totalEdges} relación(es) validada(s) contra texto real, de ${batch.length} par(es) de este lote (${failed} fallido(s), quedan pendientes) ---`);
  console.log('Revisión humana obligatoria, ninguna conexión se crea sola.');
}

await client.end();
}
