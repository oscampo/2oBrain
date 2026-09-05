// Mismo formato de texto que timeline.mjs para una lista de registros (filas de
// records_timeline()): extraído a helper porque list-link-candidates-deep.mjs
// necesita generar el mismo texto exacto que ya se probó que el clasificador
// lee bien (ver lib/classify-relation.mjs).
export function formatFactsBlock(rows) {
  return rows
    .map((r) => {
      const date = r.date.toISOString().slice(0, 10);
      const replaced = r.valid_until ? ` [reemplazado por #${r.superseded_by}]` : '';
      return `\n#${r.id} [${date}] ${r.claim}${replaced}\n  fuente: ${r.source} · tipo: ${r.kind}${r.memories ? ` · recuerdos: ${r.memories}` : ''}`;
    })
    .join('\n');
}
