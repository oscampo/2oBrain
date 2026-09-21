// Candidatos adicionales por mención LITERAL del nombre/alias de un recuerdo
// en el texto del claim (portado desde D:\MyBrain, cierre del hallazgo
// #1056/#872): el candidate-list de memories_similar() es puramente por
// similitud de embedding, y puede no incluir un recuerdo que el texto SÍ
// nombra explícitamente si su contenido existente es temáticamente lejano --
// caso real que lo motivó: un registro nombraba a una persona por su nombre
// completo para gestionar un trámite, pero el recuerdo de esa persona nunca
// rankeaba entre los candidatos semánticos, así que classifyAdditionalMemories
// no podía proponerlo aunque el texto lo nombrara explícito.
//
// Reusa detectNodeMentions (mismo mecanismo barato, sin embeddings ni LLM,
// que ya usa Etapa 6 de remember.mjs para crear memory_links), pero acá
// alimenta el clasificador de recuerdos ADICIONALES en vez de solo crear un
// enlace memoria-a-memoria -- cierra el hueco real: el memory_link podía
// existir, pero el registro nunca quedaba co-etiquetado en record_memories.
import { detectNodeMentions } from './detect-memory-mentions.mjs';

/**
 * @param {import('pg').Client} client
 * @param {string} claim
 * @param {string[]} excludeNames recuerdos ya asignados/considerados -- no tiene sentido "detectar" el mismo recuerdo
 * @param {{name: string, aliases: string[]}[]} allNodeRows recuerdos vigentes no-meta (mismo query que Etapa 6)
 * @param {number} examplesPerNode
 * @returns {Promise<{memory_name: string, examples: string[], similarity: null, aliases: string[], matchedOn: string}[]>}
 */
export async function literalMentionCandidates(client, claim, excludeNames, allNodeRows, examplesPerNode = 3) {
  const mentions = detectNodeMentions(claim, excludeNames, allNodeRows);
  const result = [];
  for (const m of mentions) {
    const { rows } = await client.query(
      `select r.claim from records r
       join record_memories rm on rm.record_id = r.id
       where rm.memory_name = $1 and r.valid_until is null
       order by r.date desc
       limit $2`,
      [m.node, examplesPerNode],
    );
    const nodeRow = allNodeRows.find((n) => n.name === m.node);
    result.push({
      memory_name: m.node,
      examples: rows.map((r) => r.claim),
      similarity: null,
      aliases: nodeRow?.aliases ?? [],
      matchedOn: m.matchedOn,
    });
  }
  return result;
}
