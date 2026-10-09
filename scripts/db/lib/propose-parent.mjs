// Propone dónde colgar un recuerdo en la jerarquía pertenece_a flujo
// "nombre, padre"). Un recuerdo existente sin lugar, o uno nuevo que acaba
// de proponerse, llega con los TRES padres candidatos de más a menos probable.
//
// Método medido antes de escribir esto: se le da
// al LLM el recuerdo a ubicar, unos registros suyos y la lista completa de candidatos
// con lo que cada uno ya contiene (sus hijos) y un registro de ejemplo. Con el nombre
// del hijo OCULTO acertó top-1 ~50% y top-3 ~75-80% sobre los 70 hijos conocidos;
// con el nombre visible ~80% y ~94%. Por eso se muestran tres candidatos y decide el
// humano: nada de esto se aplica solo (ver parent_proposals en schema.sql).
//
// Mismo patrón de proveedor que classify-memory.mjs / suggest-category-name.mjs
// (task-models "classifiers": Ollama Cloud u OpenRouter). Fail-closed: cualquier fallo
// devuelve null y el llamador simplemente no propone nada.
import { readFileSync } from 'node:fs';
import { getTaskLlm } from './llm-call.mjs';

const LLM = getTaskLlm('classifiers');
const { provider: PROVIDER, model: MODEL } = LLM;

const env = Object.fromEntries(
  readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

export const parentProposerEnabled = LLM.enabled;
export const PARENT_MODEL = MODEL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Llama al modelo y devuelve el JSON ya parseado. Reintenta los 429 de Ollama Cloud. */
export async function callModelJson(prompt, timeoutMs = 90_000) {
  const text = await LLM.call(prompt, { timeoutMs, retry429: true });
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
}

/** Minúsculas, sin tildes, guiones en vez de todo lo que no sea alfanumérico. */
export function normName(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const short = (t, n) => String(t).replace(/\s+/g, ' ').slice(0, n);

/**
 * Árbol actual para armar el contexto: recuerdos vigentes con alias, hijos conocidos
 * (aristas pertenece_a) y un registro de ejemplo por recuerdo. `excludeTag` omite de los
 * ejemplos los registros que ya llevan esa etiqueta (el recuerdo que se está ubicando).
 */
export async function loadTreeContext(client, excludeTag = null) {
  const { rows: mems } = await client.query(`select name, aliases, description from memories where merged_into is null`);
  const { rows: edges } = await client.query(`select from_memory c, to_memory p from memory_links where relation = 'pertenece_a'`);
  const { rows: ex } = await client.query(
    `select distinct on (rm.memory_name) rm.memory_name n, r.claim c
     from record_memories rm join records r on r.id = rm.record_id
     where r.valid_until is null
       and ($1::text is null or not exists (select 1 from record_memories x where x.record_id = r.id and x.memory_name = $1))
     order by rm.memory_name, r.id desc`,
    [excludeTag],
  );
  const names = new Set(mems.map((m) => m.name));
  const kids = new Map();
  const parentOf = new Map();
  for (const e of edges) {
    if (!names.has(e.c) || !names.has(e.p)) continue;
    if (!kids.has(e.p)) kids.set(e.p, []);
    kids.get(e.p).push(e.c);
    if (!parentOf.has(e.c)) parentOf.set(e.c, []);
    parentOf.get(e.c).push(e.p);
  }
  return {
    names,
    alias: new Map(mems.map((m) => [m.name, m.aliases ?? []])),
    description: new Map(mems.filter((m) => m.description).map((m) => [m.name, m.description])),
    kids,
    parentOf,
    example: new Map(ex.map((x) => [x.n, x.c])),
  };
}

function descendants(ctx, root) {
  const out = new Set();
  const st = [root];
  while (st.length) for (const y of ctx.kids.get(st.pop()) ?? []) if (!out.has(y)) { out.add(y); st.push(y); }
  return out;
}

/**
 * @param {import('pg').Client} client
 * @param {{name: string, aliases?: string[], claims?: string[]}} target recuerdo a ubicar (puede no existir todavía)
 * @returns {Promise<{candidates: string[], reasoning: string, model: string} | null>}
 */
export async function proposeParents(client, { name, aliases = [], claims = [] }) {
  if (!parentProposerEnabled) return null;
  const ctx = await loadTreeContext(client, name);
  const excluded = new Set([name, ...descendants(ctx, name)]);
  const cand = [...ctx.names].filter((n) => !excluded.has(n)).sort();
  if (cand.length === 0) return null;

  const lines = cand.map((p) => {
    const hijos = (ctx.kids.get(p) ?? []).filter((x) => !excluded.has(x)).sort().slice(0, 6);
    const al = ctx.alias.get(p) ?? [];
    const e = ctx.example.get(p);
    const def = ctx.description.get(p);
    const padres = (ctx.parentOf.get(p) ?? []).slice(0, 2);
    return `- ${p}${al.length ? ` (alias: ${al.slice(0, 3).join(', ')})` : ''}${def ? ` | definición: "${short(def, 200)}"` : ''}${padres.length ? ` | hija de: ${padres.join(', ')}` : ''}${hijos.length ? ` | contiene: ${hijos.join(', ')}` : ''}${e ? ` | ejemplo: "${short(e, 110)}"` : ''}`;
  }).join('\n');
  const own = claims.slice(0, 4).map((c) => `  * "${short(c, 170)}"`).join('\n');

  const prompt = `Eres el archivista de un segundo cerebro personal. Los "recuerdos" (temas o entidades) forman una jerarquía: cada uno puede pertenecer a un recuerdo padre más general (por ejemplo un curso pertenece a "cursos-uao", una persona a un grupo de personas, un subproyecto a su proyecto).

Recuerdo a ubicar: "${name}"${aliases.length ? ` (alias: ${aliases.join(', ')})` : ''}
Registros suyos (muestra, ${claims.length} en total):
${own || '  (no tiene registros)'}

Candidatos a padre (todos los demás recuerdos, con lo que ya contienen):
${lines}

Elige los 3 candidatos que mejor serían su padre, del más al menos probable. Usa SOLO nombres exactos de la lista. Responde SOLO con JSON: {"padres": ["nombre1", "nombre2", "nombre3"], "razon": "una frase"}`;

  let out;
  try {
    out = await callModelJson(prompt);
  } catch (err) {
    console.error(`  (propuesta de padre (${PROVIDER}) no disponible: ${err.message})`);
    return null;
  }
  const candidates = (Array.isArray(out.padres) ? out.padres : []).map((x) => String(x).trim()).filter((x, i, a) => cand.includes(x) && a.indexOf(x) === i).slice(0, 3);
  if (candidates.length === 0) return null;
  return { candidates, reasoning: typeof out.razon === 'string' ? out.razon : '', model: MODEL };
}

/**
 * Nombre de recuerdo que el modelo daría a estos registros SIN conocer los recuerdos que ya
 * existen (la pieza "ciega" del flujo). Devuelve el nombre en
 * kebab-case o null.
 */
export async function suggestBlindName(claims) {
  if (!parentProposerEnabled || claims.length === 0) return null;
  const prompt = `Eres un archivista de un segundo cerebro personal. Cada "recuerdo" es un tema o entidad (un proyecto, una persona, un curso, un dispositivo, un trámite) que agrupa registros sobre el mismo asunto a lo largo del tiempo. Lee este registro y propón el nombre del recuerdo al que pertenecería. No conoces los recuerdos que ya existen: decide solo por el contenido.

Registro: "${short(claims[0], 600)}"

Reglas del nombre: kebab-case en minúsculas, de 1 a 4 palabras, específico del asunto (ni genérico como "configuracion" o "tecnologia", ni un evento puntual de un solo día).

Responde SOLO con JSON: {"nombre": "...", "razon": "una frase breve"}`;
  try {
    const out = await callModelJson(prompt, 60_000);
    const name = normName(out.nombre ?? '');
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? { name, reasoning: String(out.razon ?? '') } : null;
  } catch (err) {
    console.error(`  (nombre ciego (${PROVIDER}) no disponible: ${err.message})`);
    return null;
  }
}
