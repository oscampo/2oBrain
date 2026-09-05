// Compartido entre set-memory-aliases.mjs y remember.mjs --create-memory --aliases
// -- un alias solo tiene sentido si identifica a un único recuerdo; si dos recuerdos
// reclaman el mismo alias, detect-memory-mentions.mjs ya no puede saber a cuál
// de los dos se refiere una mención futura (ver registro #497: "DB2" colisionó
// entre db2-2026-2 y DB2-gestion-github).
export async function findAliasCollisions(client, memoryName, aliases) {
  const { rows: others } = await client.query(
    `select name, aliases from memories where name <> $1 and merged_into is null`,
    [memoryName],
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
