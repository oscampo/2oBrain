// Detecta menciones literales de OTROS nodos (nombre o alias) dentro del
// texto de un claim -- señal de co-ocurrencia barata (gratis: coincidencia
// de texto, sin embeddings ni LLM), pensada para reemplazar el barrido O(n²)
// de list-edge-candidates-deep.mjs que dos intentos de filtro por embedding
// (centroide, luego similitud máxima) no lograron acotar sin perder la
// mayoría de las relaciones reales (PLAN-nodos.md, Etapa 6, hecho #487).
//
// Fundamento (LightRAG): las relaciones se definen por co-ocurrencia
// textual dentro del mismo fragmento, no por comparar entidades ya
// separadas después del hecho -- si un hecho nuevo menciona por nombre a
// otro nodo existente, esa mención ES la señal, no un proxy indirecto.
//
// Coincidencia por palabra completa (regex con \b), insensible a
// mayúsculas/acentos, para no disparar con substrings sueltos dentro de
// otras palabras. Alias/nombres de menos de 3 caracteres se ignoran --
// demasiado cortos, generan más ruido que señal (ej. "kr" aparecería
// dentro de cualquier palabra que lo contenga).
const MIN_LENGTH = 3;

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} claimText
 * @param {string[]} excludeNodeNames nodos ya asignados a este hecho -- no tiene sentido "detectar" el mismo nodo
 * @param {{name: string, aliases: string[]}[]} allNodes nodos vigentes candidatos (normalmente todos menos is_meta/merged)
 * @returns {{node: string, matchedOn: string}[]} nodos mencionados, con el texto exacto (nombre o alias) que hizo match
 */
export function detectNodeMentions(claimText, excludeNodeNames, allNodes) {
  const normalizedClaim = normalize(claimText);
  const excludeSet = new Set(excludeNodeNames.map(normalize));
  const found = [];

  for (const node of allNodes) {
    if (excludeSet.has(normalize(node.name))) continue;

    const candidates = [node.name, ...(node.aliases ?? [])];
    for (const candidate of candidates) {
      if (!candidate || candidate.length < MIN_LENGTH) continue;
      const pattern = new RegExp(`\\b${escapeRegex(normalize(candidate))}\\b`, 'i');
      if (pattern.test(normalizedClaim)) {
        found.push({ node: node.name, matchedOn: candidate });
        break; // un match por nodo alcanza, no hace falta seguir probando sus otros alias
      }
    }
  }

  return found;
}
