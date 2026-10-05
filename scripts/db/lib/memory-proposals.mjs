// Propuestas de etiqueta del clasificador de recuerdos (v0.11.0, ver
// memory_proposals en schema.sql): nunca se aplican solas. Se guardan aquí como
// pendientes y solo el usuario las acepta (dashboard o garden.mjs --proposal).

const KIND_TEXT = {
  additional: 'además de los que tiene',
  instead: 'en vez del pedido',
  new: 'recuerdo NUEVO, aceptarlo lo crea',
};

/**
 * Guarda las propuestas de un registro ya insertado como pendientes de revisión.
 * Una propuesta repetida para el mismo registro y recuerdo no se duplica.
 * @param {import('pg').Client} client
 * @param {{memory: string, kind: 'additional'|'instead'|'new', confidence: number|null, reasoning: string}[]} proposals
 * @returns {Promise<{id: number, memory: string}[]>} las que quedaron guardadas, con su número
 */
export async function queueProposals(client, recordId, proposals, model) {
  const queued = [];
  for (const p of proposals) {
    try {
      const { rows } = await client.query(
        `insert into memory_proposals (record_id, memory_name, kind, confidence, reasoning, model)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (record_id, memory_name) do nothing
         returning id`,
        [recordId, p.memory, p.kind, p.confidence, p.reasoning, model],
      );
      if (rows[0]) queued.push({ id: Number(rows[0].id), memory: p.memory });
    } catch (err) {
      // El registro ya está insertado: si falta la tabla (schema.sql sin aplicar),
      // no se tumba el resto del flujo, pero se dice qué propuesta se perdió.
      if (err.code !== '42P01') throw err;
      console.error(
        `(aviso: falta la tabla memory_proposals, corre node scripts/db/apply-schema.mjs; ` +
          `propuesta NO guardada para #${recordId}: "${p.memory}" (${p.kind}))`,
      );
    }
  }
  return queued;
}

/** Texto visible de las propuestas que quedaron pendientes, con su número. */
export function proposalQueuedText(queued, proposals) {
  if (queued.length === 0) return '';
  const lines = queued.map((q) => {
    const p = proposals.find((x) => x.memory === q.memory);
    const conf = p?.confidence == null ? '' : `, confianza ${Number(p.confidence).toFixed(2)}`;
    return `  - propuesta ${q.id}: "${q.memory}" (${KIND_TEXT[p?.kind] ?? p?.kind}${conf}): ${p?.reasoning ?? ''}`;
  });
  return [
    'PROPUESTAS DE ETIQUETA PENDIENTES (no aplicadas, esperan aprobación del usuario):',
    ...lines,
    'Muéstraselas al usuario tal cual. Solo se aplican desde el dashboard (Revisión de etiquetas > Propuestas pendientes)',
    'o con node scripts/db/garden.mjs --proposal <id> accept, que corre el usuario.',
  ].join('\n');
}
