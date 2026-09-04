// Lógica compartida de creación de enlaces en node_edges -- extraída de
// node-link.mjs (2026-09-02) para que tanto el CLI manual como la
// auto-creación de remember.mjs (Etapa 6, decisión del usuario: "lo haremos
// automático") usen el mismo camino, sin duplicar la resolución de
// merged_into ni el insert. No maneja process.exit ni console.error --
// devuelve {ok, ...} para que cada llamador decida cómo reaccionar (el CLI
// termina el proceso, remember.mjs solo cae a mostrar el candidato para
// revisión manual si esto falla).
export async function resolveLiveNode(client, name) {
  let current = name;
  const seen = new Set();
  while (true) {
    if (seen.has(current)) return { ok: false, error: `Ciclo de merged_into detectado empezando por "${name}".` };
    seen.add(current);
    const { rows } = await client.query(`select name, merged_into from nodes where name = $1`, [current]);
    if (rows.length === 0) return { ok: false, error: `Nodo "${current}" no existe.` };
    if (!rows[0].merged_into) return { ok: true, name: rows[0].name };
    current = rows[0].merged_into;
  }
}

/**
 * @returns {Promise<{ok: true, fromNode: string, toNode: string, relation: string} | {ok: false, error: string}>}
 */
export async function createEdge(client, fromInput, toInput, relation, source, date) {
  const fromResolved = await resolveLiveNode(client, fromInput);
  if (!fromResolved.ok) return fromResolved;
  const toResolved = await resolveLiveNode(client, toInput);
  if (!toResolved.ok) return toResolved;

  const fromNode = fromResolved.name;
  const toNode = toResolved.name;

  if (fromNode === toNode) {
    return { ok: false, error: `"${fromInput}" y "${toInput}" resuelven al mismo nodo vigente ("${fromNode}") -- no se puede conectar un nodo consigo mismo.` };
  }

  const { rows } = await client.query(
    `insert into node_edges (from_node, to_node, relation, source, date)
     values ($1, $2, $3, $4, $5)
     on conflict (from_node, to_node, relation) do update set source = excluded.source, date = excluded.date
     returning from_node, to_node, relation`,
    [fromNode, toNode, relation, source, date],
  );

  return { ok: true, fromNode: rows[0].from_node, toNode: rows[0].to_node, relation: rows[0].relation };
}
