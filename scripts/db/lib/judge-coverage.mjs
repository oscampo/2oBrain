// Juez de cobertura ): antes de proponer un recuerdo NUEVO a partir de un nombre
// ciego, decide si ese concepto ya está cubierto por un recuerdo existente. Motivo medido:
// el usuario marcó "existe" el 65% de 20 nombres ciegos, y la comprobación nominal (nombre o alias)
// solo atrapaba 3 de las 13. Veredictos:
//   nuevo     ningún recuerdo existente cubre el concepto
//   cubierto  un recuerdo existente ya agrupa estos registros (se devuelve cuál)
//   alias     el nombre ciego es otro rótulo de un recuerdo existente (se devuelve cuál)
// Fail-closed: ante cualquier fallo devuelve null y el llamador NO propone nada.
import { embed, toVectorLiteral } from './embed.mjs';
import { callModelJson, parentProposerEnabled, normName } from './propose-parent.mjs';

const short = (t, n) => String(t).replace(/\s+/g, ' ').slice(0, n);

/**
 * Candidatos a "ya cubre este concepto": etiquetas de los registros más cercanos a estos
 * registros + recuerdos cuyo embedding está cerca del nombre ciego. `exclude` omite recuerdos
 * (p. ej. los creados después, al reproducir casos pasados).
 */
export async function coverageCandidates(client, { name, recordIds, max = 10, exclude = [] }) {
  const label = name.replace(/-/g, ' ');
  const vec = toVectorLiteral(await embed(label, 'query'));
  const { rows: porNombre } = await client.query(
    `select name from memories where merged_into is null and embedding is not null and not (name = any($2::text[]))
     order by embedding <=> $1::vector limit 6`,
    [vec, exclude],
  );
  const { rows: porVecinos } = await client.query(
    `with vecinos as (
       select b.id from records a, records b
       where a.id = any($1::bigint[]) and b.valid_until is null and b.embedding is not null and b.id <> all($1::bigint[])
       order by b.embedding <=> a.embedding limit 20)
     select rm.memory_name name, count(*) n from record_memories rm join vecinos v on v.id = rm.record_id
     join memories m on m.name = rm.memory_name and m.merged_into is null and not (m.name = any($2::text[]))
     group by rm.memory_name order by n desc limit 6`,
    [recordIds, exclude],
  );
  // lo primero que se mira: los recuerdos que estos registros ya tienen (si ya les sirven, no hace falta uno nuevo)
  const { rows: propios } = await client.query(
    `select rm.memory_name name from record_memories rm join memories m on m.name = rm.memory_name and m.merged_into is null
     where rm.record_id = any($1::bigint[]) and not (m.name = any($2::text[])) group by rm.memory_name order by count(*) desc`,
    [recordIds, exclude],
  );
  const seen = new Set();
  const out = [];
  for (const r of [...propios, ...porVecinos, ...porNombre]) if (!seen.has(r.name) && out.length < max) { seen.add(r.name); out.push(r.name); }
  return out;
}

async function describeCandidate(client, mem) {
  const { rows: [m] } = await client.query(`select name, aliases, description from memories where name = $1`, [mem]);
  const { rows: parents } = await client.query(`select to_memory p from memory_links where from_memory = $1 and relation = 'pertenece_a'`, [mem]);
  const { rows: ex } = await client.query(
    `select r.claim from record_memories rm join records r on r.id = rm.record_id where rm.memory_name = $1 and r.valid_until is null order by r.id desc limit 2`,
    [mem],
  );
  return `- ${m.name}${m.aliases?.length ? ` (alias: ${m.aliases.join(', ')})` : ''}${m.description ? `\n  definición: ${m.description}` : ''}${parents.length ? `\n  hija de: ${parents.map((p) => p.p).join(', ')}` : ''}${ex.map((e) => `\n  ejemplo: ${short(e.claim, 220)}`).join('')}`;
}

/** @returns {{verdict:'nuevo'|'cubierto'|'alias', memory:string|null, reasoning:string, candidates:string[]}|null} */
export async function judgeCoverage(client, { name, claims, recordIds, exclude = [] }) {
  if (!parentProposerEnabled) return null;
  const candidates = await coverageCandidates(client, { name, recordIds, exclude });
  if (candidates.length === 0) return { verdict: 'nuevo', memory: null, reasoning: 'sin candidatos cercanos', candidates };
  const descr = [];
  for (const c of candidates) descr.push(await describeCandidate(client, c)); // secuencial: un solo cliente pg
  const lista = descr.join('\n');
  const prompt = `Eres un archivista de un segundo cerebro personal. Un "recuerdo" es un tema o entidad (un proyecto, un dispositivo, un trámite, un curso) que agrupa registros sobre el mismo asunto a lo largo del tiempo. Se está considerando CREAR un recuerdo nuevo llamado "${name}" para estos registros:

${claims.slice(0, 3).map((c, i) => `Registro ${i + 1}: "${short(c, 500)}"`).join('\n')}

Recuerdos existentes que podrían cubrirlo (los primeros suelen ser los que estos registros ya tienen asignados):
${lista}

Criterio del dueño del archivo: un recuerdo nuevo solo vale la pena cuando el tema aparece DISPERSO, repartido entre varios recuerdos sin tener casa propia. Si estos registros ya viven en un recuerdo existente y ahí tienen sentido (aunque el tema sea un subtema, un componente, una herramienta o un asunto puntual dentro de ese recuerdo, o de un proyecto o curso mayor), NO hace falta uno nuevo. Que el tema sea específico no basta para justificar un recuerdo nuevo.
- "cubierto": un recuerdo existente ya agrupa estos registros y les sirve.
- "alias": "${name}" es solo otro nombre del mismo recuerdo existente.
- "nuevo": el tema no cabe bien en ningún recuerdo existente, o está repartido entre varios sin que ninguno lo agrupe.

Responde SOLO con JSON: {"veredicto": "nuevo|cubierto|alias", "recuerdo": "nombre exacto del existente o null", "razon": "una frase"}`;
  try {
    const out = await callModelJson(prompt, 90_000);
    const verdict = ['nuevo', 'cubierto', 'alias'].includes(out.veredicto) ? out.veredicto : null;
    if (!verdict) return null;
    const memory = verdict === 'nuevo' ? null : candidates.find((c) => normName(c) === normName(out.recuerdo ?? '')) ?? null;
    if (verdict !== 'nuevo' && !memory) return null; // cita un recuerdo que no estaba en la lista: se descarta
    return { verdict, memory, reasoning: String(out.razon ?? ''), candidates };
  } catch (err) {
    console.error(`  (juez de cobertura no disponible: ${err.message})`);
    return null;
  }
}
