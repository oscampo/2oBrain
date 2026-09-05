// Servidor local (Hono) que expone los 8 scripts núcleo de scripts/db/*.mjs
// como endpoints HTTP, para que un dashboard HTML/JS los use por fetch en
// vez de la terminal. Decisión y alcance: hecho #251/#252.
//
// Solo localhost. SUPABASE_DB_URL y las demás keys viven en .env y nunca
// deben llegar al navegador: este servidor es el único que las lee (los
// scripts hijos las leen ellos mismos de .env, igual que si se corrieran a
// mano), el HTML del dashboard nunca las ve.
//
// Cada script sigue siendo un CLI standalone normal (nada de esto lo
// refactoriza): este servidor solo los invoca como subproceso y devuelve
// su salida. Salida de la mayoría de los scripts es texto plano formateado
// para terminal, no JSON estructurado; se devuelve tal cual por ahora
// (primer corte), sin inventar un formato JSON que ningún script produce.
//
// Uso: node server/dashboard-server.mjs [--port 4287]
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stream } from 'hono/streaming';
import { synthesize } from '../lib/synthesize.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(SERVER_DIR, '..');
const INDEX_HTML_PATH = join(SERVER_DIR, 'public', 'index.html');
const MODEL_CONFIG_PATHS = {
  gemini: join(DB_DIR, 'config', 'gemini-models.json'),
  ollama: join(DB_DIR, 'config', 'ollama-models.json'),
};

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
const cliArgs = parseArgs(process.argv.slice(2));
const PORT = cliArgs.port ? Number(cliArgs.port) : 4287;

/** Corre un script de scripts/db/ como subproceso y captura su salida. */
function runScript(scriptName, args, { input } = {}) {
  const result = spawnSync(process.execPath, [join(DB_DIR, scriptName), ...args], {
    cwd: DB_DIR,
    encoding: 'utf8',
    input,
  });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function respond(c, result) {
  return c.json(result, result.ok ? 200 : 422);
}

const app = new Hono();

// Solo un archivo estático (todo el JS/CSS va inline en el HTML, sin build
// step): se sirve leyéndolo directo en vez de configurar serveStatic para
// una sola ruta.
app.get('/', (c) => c.html(readFileSync(INDEX_HTML_PATH, 'utf8')));

app.get('/api/search', (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ ok: false, error: 'falta ?q=' }, 400);
  return respond(c, runScript('search.mjs', [q]));
});

// Toma resultados YA obtenidos de /api/search (el frontend los pasa, no se
// vuelve a buscar acá) y les pide a un LLM externo que sintetice una
// respuesta en prosa. Paso opcional y separado a propósito: /api/search
// sigue siendo determinista y sin costo.
app.post('/api/synthesize', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.query || !body?.rawResults || !body?.provider) {
    return c.json({ ok: false, error: 'faltan query/rawResults/provider' }, 400);
  }
  try {
    const answer = await synthesize(body.query, body.rawResults, body.provider, body.model);
    return c.json({ ok: true, answer });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 422);
  }
});

// Lista de slugs de páginas para poblar el autocompletado del campo
// "Página" en Timeline: sin esto hay que memorizar el slug exacto.
app.get('/api/pages', (c) => {
  const result = runScript('list-pages.mjs', ['--json']);
  if (!result.ok) return c.json({ ok: false, error: result.stderr || 'list-pages.mjs falló' }, 422);
  try {
    return c.json({ ok: true, ...JSON.parse(result.stdout) });
  } catch {
    return c.json({ ok: false, error: 'list-pages.mjs no devolvió JSON válido' }, 422);
  }
});

// Lista de nodos vigentes para poblar el autocompletado de Timeline y
// Guardar hecho: mismo motivo que /api/pages, pero para fact_nodes.
app.get('/api/nodes', (c) => {
  const result = runScript('list-nodes.mjs', ['--json']);
  if (!result.ok) return c.json({ ok: false, error: result.stderr || 'list-nodes.mjs falló' }, 422);
  try {
    return c.json({ ok: true, ...JSON.parse(result.stdout) });
  } catch {
    return c.json({ ok: false, error: 'list-nodes.mjs no devolvió JSON válido' }, 422);
  }
});

app.get('/api/timeline', (c) => {
  const node = c.req.query('node');
  const all = c.req.query('all');
  const args = [];
  if (node) args.push(node);
  if (all) args.push('--all');
  return respond(c, runScript('timeline.mjs', args));
});

app.get('/api/delta', (c) => {
  const args = [];
  const since = c.req.query('since');
  const budget = c.req.query('budgetTokens');
  const advance = c.req.query('advance');
  const quiet = c.req.query('quiet');
  if (since) args.push('--since', since);
  if (budget) args.push('--budget-tokens', budget);
  if (!advance) args.push('--no-advance'); // ver GET como acción pasiva por defecto; ?advance=1 para mover el watermark
  if (quiet) args.push('--quiet');
  return respond(c, runScript('delta.mjs', args));
});

app.get('/api/doctor', (c) => respond(c, runScript('doctor.mjs', [])));

// Datos del grafo (graph.mjs, reescrito 2026-09-03 para grafo interactivo
// dirigido por fuerzas -- ver comentario en graph.mjs) -- sin caché: cada
// llamada consulta el estado vigente de nodes/fact_nodes/node_edges, así
// que abrir/refrescar la sección "Grafo" siempre refleja el último hecho o
// nodo integrado. El layout (posiciones, física, drag/zoom) corre en el
// navegador con d3-force (server/public/vendor/d3.v7.min.js), este
// endpoint solo entrega los datos crudos en JSON.
app.get('/api/graph', (c) => {
  const result = runScript('graph.mjs', []);
  if (!result.ok) return c.json({ ok: false, error: result.stderr || 'graph.mjs falló' }, 422);
  try {
    return c.json({ ok: true, ...JSON.parse(result.stdout) });
  } catch {
    return c.json({ ok: false, error: 'graph.mjs no devolvió JSON válido' }, 422);
  }
});

// d3.v7.min.js vendorizado (no CDN) -- "solo localhost" también aplica a
// dependencias del frontend: nada de terceros en la red, ni siquiera para
// servir una librería JS.
app.get('/vendor/d3.v7.min.js', (c) => {
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  return c.body(readFileSync(join(SERVER_DIR, 'public', 'vendor', 'd3.v7.min.js')));
});

// Etapa 5 (PLAN-nodos.md): "estado actual del nodo X" generado al momento de
// la consulta desde sus hechos vigentes reales: node-status.mjs ya hace
// todo el trabajo (trae los hechos, llama a synthesizeNodeStatus), esto solo
// lo expone como subproceso igual que el resto.
app.get('/api/node-status', (c) => {
  const node = c.req.query('node');
  const provider = c.req.query('provider');
  const model = c.req.query('model');
  if (!node) return c.json({ ok: false, error: 'falta ?node=' }, 400);
  const args = [node];
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  return respond(c, runScript('node-status.mjs', args));
});

app.post('/api/remember', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.claim || !body?.date || !body?.source) {
    return c.json({ ok: false, error: 'faltan claim/date/source' }, 400);
  }
  const args = ['--claim', body.claim, '--date', body.date, '--source', body.source];
  if (body.kind) args.push('--kind', body.kind);
  if (body.node) args.push('--node', body.node);
  if (body.createNode) args.push('--create-node');
  if (body.aliases) args.push('--aliases', body.aliases);
  if (body.confidence) args.push('--confidence', String(body.confidence));
  if (body.supersedes) args.push('--supersedes', String(body.supersedes));
  if (body.distinct) args.push('--distinct');
  if (body.confirmDate) args.push('--confirm-date');
  return respond(c, runScript('remember.mjs', args));
});

app.post('/api/remember-batch', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.facts) return c.json({ ok: false, error: 'falta {facts: [...]}' }, 400);
  const args = body.confirmDate ? ['--confirm-date'] : [];
  return respond(c, runScript('remember-batch.mjs', args, { input: JSON.stringify(body) }));
});

// Variante en streaming del endpoint de arriba: remember-batch.mjs ya
// imprimía "[i/n] claim" por hecho a stderr según avanzaba, pero
// spawnSync solo entrega esa salida completa al final: el usuario veía
// el botón "Ingiriendo…" sin ninguna señal de avance real durante todo el
// lote. Este endpoint corre el mismo script con spawn (no spawnSync) y
// reenvía cada chunk de stdout/stderr al cliente apenas llega, en el mismo
// orden en que el proceso los escribe. Termina con una línea
// "\n[EXIT:<código>]" para que el frontend sepa que ya no viene más y
// pueda pintar éxito/error.
app.post('/api/remember-batch/stream', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.facts) return c.json({ ok: false, error: 'falta {facts: [...]}' }, 400);
  const streamArgs = body.confirmDate ? ['--confirm-date'] : [];
  c.header('Content-Type', 'text/plain; charset=utf-8');
  return stream(c, async (s) => {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(DB_DIR, 'remember-batch.mjs'), ...streamArgs], { cwd: DB_DIR });
      child.stdout.on('data', (chunk) => s.write(chunk));
      child.stderr.on('data', (chunk) => s.write(chunk));
      child.on('close', (code) => {
        s.write(`\n[EXIT:${code}]`).then(resolve);
      });
      child.stdin.write(JSON.stringify(body));
      child.stdin.end();
    });
  });
});

app.post('/api/forget', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.id || !body?.reason) return c.json({ ok: false, error: 'faltan id/reason' }, 400);
  return respond(c, runScript('forget.mjs', ['--id', String(body.id), '--reason', body.reason]));
});

// Vista previa de hecho(s) por id, usada por "Retractar" antes de dejar
// confirmar: sin esto, retractar era escribir un id a ciegas y confiar en
// que era el correcto. No modifica nada (get-facts.mjs es de solo lectura).
app.get('/api/facts', (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ ok: false, error: 'falta ?id=' }, 400);
  return respond(c, runScript('get-facts.mjs', ['--id', id]));
});

// Lee/edita la lista de modelos de respaldo (config/gemini-models.json o
// config/ollama-models.json) que usan extract-facts.mjs y
// extract-page-facts.mjs: un único origen de verdad, editable a mano o
// desde el dashboard (antes solo se podía leer, hoy también escribir).
app.get('/api/model-config', (c) => {
  const provider = c.req.query('provider');
  const path = MODEL_CONFIG_PATHS[provider];
  if (!path) return c.json({ ok: false, error: 'falta ?provider=gemini|ollama' }, 400);
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return c.json({ ok: true, fallbackOrder: config.fallbackOrder ?? [] });
  } catch {
    return c.json({ ok: true, fallbackOrder: [] });
  }
});

app.post('/api/model-config', async (c) => {
  const body = await c.req.json().catch(() => null);
  const path = MODEL_CONFIG_PATHS[body?.provider];
  if (!path) return c.json({ ok: false, error: 'falta provider: "gemini"|"ollama"' }, 400);
  if (!Array.isArray(body.fallbackOrder) || body.fallbackOrder.some((m) => typeof m !== 'string' || !m.trim())) {
    return c.json({ ok: false, error: 'fallbackOrder debe ser un array de strings no vacíos' }, 400);
  }
  const fallbackOrder = body.fallbackOrder.map((m) => m.trim());
  if (fallbackOrder.length === 0) return c.json({ ok: false, error: 'la lista no puede quedar vacía' }, 400);
  try {
    writeFileSync(path, JSON.stringify({ fallbackOrder }, null, 2) + '\n', 'utf8');
    return c.json({ ok: true, fallbackOrder });
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

// Etapa 2 (PLAN-nodos.md): higiene de nodos: candidatos a fusión (revisión
// humana obligatoria, ninguno se fusiona solo) y la fusión misma.
app.get('/api/merge-candidates', (c) => respond(c, runScript('list-merge-candidates.mjs', [])));

app.post('/api/merge-nodes', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.from || !body?.to || !body?.reason) {
    return c.json({ ok: false, error: 'faltan from/to/reason' }, 400);
  }
  return respond(c, runScript('merge-nodes.mjs', ['--from', body.from, '--to', body.to, '--reason', body.reason]));
});

// Supernodos candidatos (2026-09-04): nodos de dominio sin lugar en la
// jerarquía (ni hijo ni padre de ningún pertenece_a), agrupados por
// similitud de sus hechos, ver list-supernode-candidates.mjs para el porqué
// de "sin padre Y sin hijo" y por qué quedó bajo demanda, no proactiva. Solo
// lectura, nunca crea/liga nada.
//
// A diferencia de merge-candidates/mention-candidates (texto plano, el
// usuario copia comandos a una terminal), este corre en modo --json: el
// frontend arma tarjetas editables (nombre sugerido, miembros) y crea/liga
// con /api/create-node de abajo, sin salir del navegador.
app.get('/api/supernode-candidates', (c) => {
  const result = runScript('list-supernode-candidates.mjs', ['--json']);
  if (!result.ok) return c.json({ ok: false, error: result.stderr || 'list-supernode-candidates.mjs falló' }, 422);
  try {
    return c.json({ ok: true, ...JSON.parse(result.stdout) });
  } catch {
    return c.json({ ok: false, error: 'list-supernode-candidates.mjs no devolvió JSON válido: ' + result.stdout.slice(0, 500) }, 422);
  }
});

// create-node.mjs: creación standalone de un nodo, opcionalmente ligado a un
// padre en el mismo llamado (--parent, ver el script para el diseño
// completo). Usado por la sección "Candidatos de supernodo" para crear el
// supernodo propuesto; --parent no aplica acá (el supernodo nuevo no tiene
// padre todavía), el enlace a cada miembro va por /api/node-link.
app.post('/api/create-node', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name) return c.json({ ok: false, error: 'falta name' }, 400);
  const args = ['--name', body.name];
  if (body.aliases) args.push('--aliases', body.aliases);
  if (body.isMeta) args.push('--is-meta');
  if (body.force) args.push('--force');
  if (body.parent) {
    if (!body.date) return c.json({ ok: false, error: '--parent requiere date' }, 400);
    args.push('--parent', body.parent, '--date', body.date);
    if (body.reason) args.push('--reason', body.reason);
  }
  return respond(c, runScript('create-node.mjs', args));
});

// Etapa 6 (PLAN-nodos.md, 2026-09-02): grafo de relaciones nodo-a-nodo.
// list-node-mentions.mjs es de solo lectura (revisión humana obligatoria,
// ningún enlace se crea desde acá sin pasar por node-link.mjs); la
// auto-creación a confianza alta ya corre dentro de remember.mjs/
// remember-batch.mjs mismos, no hace falta un endpoint aparte para eso.
app.get('/api/mention-candidates', (c) => respond(c, runScript('list-node-mentions.mjs', [])));

app.get('/api/node-edges', (c) => {
  const node = c.req.query('node');
  if (!node) return c.json({ ok: false, error: 'falta ?node=' }, 400);
  return respond(c, runScript('node-link.mjs', ['--list', node]));
});

app.post('/api/node-link', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.from || !body?.to || !body?.relation || !body?.date || !body?.reason) {
    return c.json({ ok: false, error: 'faltan from/to/relation/date/reason' }, 400);
  }
  return respond(c, runScript('node-link.mjs', ['--from', body.from, '--to', body.to, '--relation', body.relation, '--date', body.date, '--reason', body.reason]));
});

app.post('/api/node-unlink', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.from || !body?.to || !body?.reason) {
    return c.json({ ok: false, error: 'faltan from/to/reason' }, 400);
  }
  const args = ['--from', body.from, '--to', body.to, '--reason', body.reason];
  if (body.relation) args.push('--relation', body.relation);
  return respond(c, runScript('node-unlink.mjs', args));
});

// Backfill guiado de alias (Etapa 6, hecho #497): list-alias-candidates.mjs
// solo propone (determinístico + extracción verificada contra el texto real
// de los hechos del nodo), set-node-aliases.mjs es el único que escribe,
// mismo patrón "revisión humana obligatoria" que Fusionar nodos.
app.get('/api/alias-candidates', (c) => {
  const node = c.req.query('node');
  return respond(c, runScript('list-alias-candidates.mjs', node ? [node] : []));
});

app.post('/api/set-node-aliases', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.node || !body?.reason || (!body?.aliases && !body?.remove)) {
    return c.json({ ok: false, error: 'faltan node/reason y (aliases o remove)' }, 400);
  }
  const args = ['--node', body.node, '--reason', body.reason];
  args.push(body.remove ? '--remove' : '--aliases', body.remove || body.aliases);
  return respond(c, runScript('set-node-aliases.mjs', args));
});

// Reasigna UN hecho a otro nodo sin tocar el resto del nodo (distinto de
// Fusionar nodos, que mueve todos los hechos): usado cuando
// classify-node.mjs se equivocó o el hecho se guardó con --node a mano sin
// pensarlo (ver hecho #498, caso real del hecho #412).
app.post('/api/recategorize-fact', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.fact || !body?.from || !body?.to || !body?.reason) {
    return c.json({ ok: false, error: 'faltan fact/from/to/reason' }, 400);
  }
  return respond(c, runScript('recategorize-fact.mjs', ['--fact', String(body.fact), '--from', body.from, '--to', body.to, '--reason', body.reason]));
});

// No hay endpoint que ejecute extract-facts.mjs: esa tarea corre en una
// terminal real (para poder usar --review), el frontend solo arma el
// comando (ver sección "Extraer de sesión" en public/index.html). Decisión
// del usuario tras encontrar que la selección de sesión desde el navegador era
// más fricción de la que valía: "extraer de sesión" ya es posible desde
// Chat/Cowork (MyMCP + skill), Code, o el .mjs a mano.

// extract-page-facts.mjs sí tiene endpoint (2026-08-31), a diferencia de
// extract-facts.mjs de arriba: --json no pregunta nada por stdin (a
// diferencia de --review), entrega los candidatos con sus nodos parecidos
// ya calculados en un solo JSON: la revisión aprobar/editar/saltar la hace
// el frontend con sus propios controles, no una terminal. La inserción
// sigue yendo por /api/remember-batch, sin código nuevo de escritura acá.
app.get('/api/extract-page-facts', (c) => {
  const page = c.req.query('page');
  if (!page) return c.json({ ok: false, error: 'falta ?page=' }, 400);
  const provider = c.req.query('provider');
  const model = c.req.query('model');
  const args = ['--page', page, '--json'];
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  const result = runScript('extract-page-facts.mjs', args);
  if (!result.ok) return c.json({ ok: false, error: result.stderr || 'extract-page-facts.mjs falló' }, 422);
  try {
    return c.json({ ok: true, ...JSON.parse(result.stdout) });
  } catch {
    return c.json({ ok: false, error: 'extract-page-facts.mjs no devolvió JSON válido: ' + result.stdout.slice(0, 500) }, 422);
  }
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`Dashboard server en http://127.0.0.1:${info.port} (solo localhost, nunca exponer a la red)`);
});

// Con la tarea de arranque instalada (install-boot-task.ps1), este caso deja
// de ser raro: alguien arrancando el server a mano para desarrollar mientras
// la tarea de inicio de sesión ya lo dejó corriendo. Fallar con gracia en vez
// de un stack trace crudo.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Ya hay un servidor escuchando en el puerto ${PORT}, probablemente la tarea de arranque ya lo dejó corriendo. Nada que hacer, abre http://127.0.0.1:${PORT} en el navegador.`);
    process.exit(0);
  }
  throw err;
});
