// Lógica compartida de creación de enlaces en memory_links -- extraída de
// memory-link.mjs (2026-09-02) para que tanto el CLI manual como la
// auto-creación de remember.mjs (Etapa 6, decisión del usuario: "lo haremos
// automático") usen el mismo camino, sin duplicar la resolución de
// merged_into ni el insert. No maneja process.exit ni console.error --
// devuelve {ok, ...} para que cada llamador decida cómo reaccionar (el CLI
// termina el proceso, remember.mjs solo cae a mostrar el candidato para
// revisión manual si esto falla).
export async function resolveLiveMemory(client, name) {
  let current = name;
  const seen = new Set();
  while (true) {
    if (seen.has(current)) return { ok: false, error: `Ciclo de merged_into detectado empezando por "${name}".` };
    seen.add(current);
    const { rows } = await client.query(`select name, merged_into from memories where name = $1`, [current]);
    if (rows.length === 0) return { ok: false, error: `recuerdo "${current}" no existe.` };
    if (!rows[0].merged_into) return { ok: true, name: rows[0].name };
    current = rows[0].merged_into;
  }
}

/**
 * @returns {Promise<{ok: true, fromMemory: string, toMemory: string, relation: string} | {ok: false, error: string}>}
 */
export async function createLink(client, fromInput, toInput, relation, source, date) {
  const fromResolved = await resolveLiveMemory(client, fromInput);
  if (!fromResolved.ok) return fromResolved;
  const toResolved = await resolveLiveMemory(client, toInput);
  if (!toResolved.ok) return toResolved;

  const fromMemory = fromResolved.name;
  const toMemory = toResolved.name;

  if (fromMemory === toMemory) {
    return { ok: false, error: `"${fromInput}" y "${toInput}" resuelven al mismo recuerdo vigente ("${fromMemory}") -- no se puede conectar un recuerdo consigo mismo.` };
  }

  const { rows } = await client.query(
    `insert into memory_links (from_memory, to_memory, relation, source, date)
     values ($1, $2, $3, $4, $5)
     on conflict (from_memory, to_memory, relation) do update set source = excluded.source, date = excluded.date
     returning from_memory, to_memory, relation`,
    [fromMemory, toMemory, relation, source, date],
  );

  return { ok: true, fromMemory: rows[0].from_memory, toMemory: rows[0].to_memory, relation: rows[0].relation };
}
