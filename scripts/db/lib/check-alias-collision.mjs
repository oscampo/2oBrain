// Compartido entre set-node-aliases.mjs y remember.mjs --create-node --aliases
// -- un alias solo tiene sentido si identifica a un único nodo; si dos nodos
// reclaman el mismo alias, detect-node-mentions.mjs ya no puede saber a cuál
// de los dos se refiere una mención futura (ver hecho #497: "DB2" colisionó
// entre db2-2026-2 y DB2-gestion-github).
export async function findAliasCollisions(client, nodeName, aliases) {
  const { rows: others } = await client.query(
    `select name, aliases from nodes where name <> $1 and merged_into is null`,
    [nodeName],
  );
  const conflicts = [];
  for (const alias of aliases) {
    const aliasLower = alias.toLowerCase();
    for (const other of others) {
      const otherStrings = [other.name, ...(other.aliases ?? [])].map((s) => s.toLowerCase());
      if (otherStrings.includes(aliasLower)) conflicts.push({ alias, node: other.name });
    }
  }
  return conflicts;
}
