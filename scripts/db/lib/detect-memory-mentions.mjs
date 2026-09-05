// Detecta menciones literales de OTROS recuerdos (nombre o alias) dentro del
// texto de un claim -- señal de co-ocurrencia barata (gratis: coincidencia
// de texto, sin embeddings ni LLM), pensada para reemplazar el barrido O(n²)
// de list-link-candidates-deep.mjs que dos intentos de filtro por embedding
// (centroide, luego similitud máxima) no lograron acotar sin perder la
// mayoría de las relaciones reales (PLAN-recuerdos.md, Etapa 6, registro #487).
//
// Fundamento (LightRAG): las relaciones se definen por co-ocurrencia
// textual dentro del mismo fragmento, no por comparar entidades ya
// separadas después del registro -- si un registro nuevo menciona por nombre a
// otro recuerdo existente, esa mención ES la señal, no un proxy indirecto.
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
 * @param {string[]} excludeNodeNames recuerdos ya asignados a este registro -- no tiene sentido "detectar" el mismo recuerdo
 * @param {{name: string, aliases: string[]}[]} allNodes recuerdos vigentes candidatos (normalmente todos menos is_meta/merged)
 * @returns {{node: string, matchedOn: string}[]} recuerdos mencionados, con el texto exacto (nombre o alias) que hizo match
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
        break; // un match por recuerdo alcanza, no hace falta seguir probando sus otros alias
      }
    }
  }

  return found;
}
