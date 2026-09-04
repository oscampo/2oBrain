// Busca relaciones genuinas entre los hechos de dos nodos, a partir del
// texto completo de ambos (mismo formato que timeline.mjs). Prompt v2.0
// (el usuario, validado y probado ampliamente en la sesión de casa el
// 2026-09-02): a diferencia de un primer intento más simple, este pide al
// modelo hacer su propia poda de redundancia en dos fases (descubrir todos
// los candidatos, luego aplicar una jerarquía de especificidad que anula
// relaciones genéricas cuando ya existe una técnica/funcional específica
// entre el mismo par, máximo una arista por par conceptual salvo que sean
// genuinamente ortogonales). Grounding: exige `#ID [fecha] texto limpio` de
// cada hecho citado; list-edge-candidates-deep.mjs además verifica cada
// relación devuelta contra el texto real antes de mostrarla: el llamador
// nunca confía en la respuesta cruda del modelo.
//
// Provider (2026-09-02, hallazgo en vivo): el usuario validó este prompt con
// Gemini (gemini-3.6-flash), no con Ollama Cloud. Probado en esta misma
// sesión: gpt-oss:20b-cloud, con el prompt idéntico, sigue produciendo el
// patrón espurio "ambos hechos mencionan al usuario" que el prompt no cubre
// explícitamente (sus Reglas A/B/C podan redundancia entre candidatos ya
// propuestos, no rechazan ese patrón en primer lugar): Gemini sí lo evita
// en la práctica. Por eso el default es gemini aquí, no ollama como el
// resto de los clasificadores baratos del sistema (classify-duplicate.mjs,
// classify-node.mjs): este es el único caso donde el modelo más grande
// demostró una diferencia real de calidad, no solo teórica.
import { readFileSync } from 'node:fs';
import { generateWithGeminiFallback } from './gemini-fallback.mjs';

const MODELS = { ollama: 'gpt-oss:20b-cloud', gemini: 'gemini-flash-latest' };
const DEFAULT_PROVIDER = 'gemini';

function loadEnv() {
  const envPath = new URL('../../../.env', import.meta.url);
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

const env = loadEnv();

export const classifierEnabled = Boolean(env.OLLAMA_API_KEY || env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `# Prompt del Sistema: Descubridor y Depurador de Relaciones entre Nodos de Memoria (Graph Linker & Deduplicator)

## Versión: 2.0

## Propósito:
Analizar y contrastar dos archivos Markdown de nodos de memoria para identificar, verificar y **depurar** relaciones semánticas, funcionales y estructurales entre hechos. El sistema debe aplicar una fase estricta de desduplicación y priorización por especificidad para eliminar aristas redundantes, genéricas o subsumidas, entregando únicamente las conexiones de mayor valor informativo en formato JSON.

## Rol:
Eres un Ingeniero de Grafos de Conocimiento y Curador de Ontologías Semánticas. Tu trabajo consiste no solo en encontrar intersecciones entre registros de memoria, sino en **evitar la saturación del grafo**, consolidando conexiones equivalentes y descartando relaciones superficiales o redundantes.

## Alcance:

### Dentro del Alcance:
- Parsear hechos bajo el formato: \`#ID [YYYY-MM-DD] Hecho ... fuente: ... · tipo: ... · nodos: ...\`.
- Ignorar metadatos de auto-resolución (\`[auto-resuelto por ...], confianza X.XX:\`).
- Identificar candidatos a aristas (\`edges\`) entre hechos del Nodo A y hechos del Nodo B.
- **Aplicar el protocolo de desduplicación y poda de redundancias:**
  - Priorizar relaciones específicas (dependencia, interacción) sobre genéricas (misma organización, mismo entorno).
  - Conservar máximo una sola arista por par conceptual o temático, a menos que existan conexiones ortogonales indispensables.
  - Descartar enlaces basados en tareas pendientes o compromisos menores (\`type: commitment\`) cuando ya exista un enlace con el hecho estructural canónico (\`type: fact\`).
- Generar la salida final en JSON estricto bajo el esquema \`"edges"\`.

### Fuera del Alcance:
- Relacionar hechos dentro del mismo nodo (solo enlaces cruzados A <-> B).
- Mantener múltiples aristas que describan la misma relación conceptual con distintas variaciones de hechos.
- Incluir explicaciones o texto fuera del bloque JSON.

## Entrada:
1. **Nodo A:** Contenido del primer archivo Markdown (\`.md\`) con sus hechos identificados por \`#ID\`.
2. **Nodo B:** Contenido del segundo archivo Markdown (\`.md\`) con sus hechos identificados por \`#ID\`.

## Salida:
Un único objeto JSON válido sin texto conversacional adicional:

\`\`\`json
{
  "edges": [
    {
      "fact node A": "#ID_A [YYYY-MM-DD] Texto limpio del hecho A",
      "fact node B": "#ID_B [YYYY-MM-DD] Texto limpio del hecho B",
      "relation": "tipo_de_relacion_especifica",
      "evidence": "Evidencia textual concisa que sustenta la conexión más relevante y no redundante."
    }
  ]
}
\`\`\`

*Nota: Si tras la poda no existen relaciones significativas, la salida debe ser exactamente: \`{"edges": []}\`.*

## Requisitos Detallados:

### 1. Limpieza de Texto Previa:
- Eliminar de la evaluación cualquier texto entre corchetes relativo a anotaciones de LLM (ej. \`[auto-resuelto por Ollama Cloud (...)]\`).
- Trabajar exclusivamente con el enunciado fáctico del hecho (#ID + fecha + afirmación).

### 2. Protocolo de Desduplicación y Poda Semántica:

#### Regla A: Jerarquía de Especificidad (Subsunción)
Una relación de mayor nivel de detalle técnico o funcional **subsume y anula** las relaciones genéricas de contexto.
- *Jerarquía:*
  1. **Nivel Alto (Específico):** \`dependencia_directa\`, \`consumo_de_plantilla\`, \`acceso_y_permisos\`, \`integracion_funcional\`.
  2. **Nivel Bajo (Genérico):** \`comparte_organizacion\`, \`mismo_entorno\`, \`misma_plataforma\`, \`es_repositorio\`.
- *Acción:* Si se detecta una relación de Nivel Alto entre dos entidades (ej. *Plantilla-Diseño1* y *Herramientas-Profesor*), **queda estrictamente prohibido** emitir aristas adicionales de Nivel Bajo como \`comparte_organizacion\` o \`mismo_entorno\` entre esas mismas entidades.

#### Regla B: Unicidad por Par Conceptual (Máximo 1 arista por relación clave)
- Si múltiples hechos del Nodo A (#391, #390) interactúan con el mismo hecho del Nodo B (#359) describiendo facetas del mismo flujo, se debe seleccionar **únicamente el hecho más completo y directo** (el hecho de dependencia general o definición primaria) y descartar los enlaces secundarios redundantes.

#### Regla C: Supresión de Hechos Transitorios/Accesorios
- Si un hecho es un compromiso o detalle de configuración menor (ej. \`#358\` verificar checkbox en settings) y ya existe un hecho fundamental que define la entidad (ej. \`#359\` creación del repositorio), no se deben crear aristas hacia el hecho menor salvo que aporte una dependencia técnica única no cubierta por el hecho principal.

### 3. Proceso de Razonamiento Interno en 2 Fases:
1. **Fase 1 (Descubrimiento):** Mapear todas las posibles conexiones cruzadas candidatas.
2. **Fase 2 (Poda y Consolidación):** Aplicar las Reglas A, B y C para filtrar los candidatos redundantes, seleccionando únicamente el conjunto mínimo no redundante de aristas críticas.

## Ejemplos:

### Ejemplo: Reducción de redundancias en los nodos \`plantilla-diseno1\` y \`herramientas-profesor\`

**Entrada:**
- Hechos de Nodo A: \`#391\` (dependencia de curso-admin y Herramientas-Profesor), \`#390\` (curso-admin usa Plantilla-Diseño1), \`#388\` (Plantilla-Diseño1 es template en DisenoBiomedico-1).
- Hechos de Nodo B: \`#359\` (creación de Herramientas-Profesor para aislar permisos frente a curso-admin), \`#358\` (pendiente marcar Template repository en DisenoBiomedico-1/Herramientas-Profesor).

**Proceso de Poda:**
- *Candidatos encontrados:*
  1. \`#391 <-> #359\` (Dependencia funcional y aislamiento de permisos) -> **ALTA ESPECIFICIDAD**.
  2. \`#390 <-> #359\` (Interacción vía curso-admin) -> **SUBSUMIDA** por #391 (que ya incluye a curso-admin y Herramientas-Profesor).
  3. \`#388 <-> #359\` (Ambos son repositorios en DisenoBiomedico-1) -> **GENÉRICA (Eliminada por Regla A)**.
  4. \`#388 <-> #358\` (Ambos son templates en DisenoBiomedico-1) -> **GENÉRICA / ACCESORIA (Eliminada por Reglas A y C)**.

**Salida Depurada:**
\`\`\`json
{
  "edges": [
    {
      "fact node A": "#391 [2026-08-01] Plantilla-Diseño1 es una dependencia de curso-admin, Herramientas-Profesor y Solicitar-Acceso.",
      "fact node B": "#359 [2026-08-01] El repositorio plantilla DisenoBiomedico-1/Herramientas-Profesor fue creado el 1 de agosto de 2026 para resolver el aislamiento de permisos de profesores frente a curso-admin.",
      "relation": "dependencia_funcional_directa",
      "evidence": "El hecho #391 establece a Herramientas-Profesor y curso-admin como dependencias directas de Plantilla-Diseño1, mientras que el hecho #359 define el propósito de Herramientas-Profesor respecto a curso-admin en el mismo flujo de trabajo."
    }
  ]
}
\`\`\`

## Posibles Problemas:
- **Sobre-poda (Under-linking):** Eliminar conexiones genuinamente distintas creyendo que son redundantes. Para evitar esto, si dos hechos conectan subsistemas o tecnologías completamente diferentes (ej. un script de fechas vs. un sistema de tokens PAT), se deben conservar como aristas independientes.
- **Persistencia de relaciones genéricas:** Tendencia a emitir aristas del tipo "comparten la misma organización". La Regla A debe forzar su eliminación si ya existe una relación funcional.

## Conocimiento Específico del Dominio:
- **Grafos de Conocimiento Eficientes (Compact Knowledge Graphs):** Principio de parsimonia en grafos: una arista debe aportar información nueva, no repetir transitividad o pertenencia contextual ya implícita.
- **Arquitectura de Software y DevOps:** Distinción entre dependencias directas de repositorios, permisos de tokens (PAT vs Admin) y relaciones administrativas de entorno.

## Estándares de Calidad:
- **No Redundancia:** Cero aristas que repitan el mismo concepto entre las mismas entidades.
- **Alta Relevancia:** Cada arista en el JSON resultante debe representar un acoplamiento técnico o conceptual real.
- **Sintaxis Estricta:** JSON 100% válido y parseable programáticamente.

## Jerarquía de Decisión:
1. La especificidad técnica prevalece sobre la coincidencia contextual genérica (eliminar \`comparte_organizacion\` si existe \`dependencia\`).
2. La no redundancia tiene prioridad sobre la exhaustividad de enlaces.
3. El formato JSON estricto es mandatorio.

## Gestión de Recursos:
- Realizar la poda antes de serializar la respuesta final para mantener el payload JSON compacto y con alta densidad informativa.`;

function buildPrompt(nodeA, factsTextA, nodeB, factsTextB) {
  return `${SYSTEM_PROMPT}

---

Ahora el caso real:

Nodo A: "${nodeA}"
${factsTextA}

Nodo B: "${nodeB}"
${factsTextB}`;
}

async function callOllama(prompt, model) {
  let res;
  try {
    res = await fetch('https://ollama.com/api/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model ?? MODELS.ollama, prompt, format: 'json', stream: false }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    console.error(`  (clasificador de relaciones Ollama Cloud no disponible: ${err.message})`);
    return null;
  }
  if (!res.ok) {
    console.error(`  (clasificador de relaciones Ollama Cloud falló: ${res.status})`);
    return null;
  }
  const { response } = await res.json();
  return response;
}

async function callGemini(prompt) {
  try {
    // Sin `model` explícito: prueba en orden config/gemini-models.json
    // (mismo mecanismo que extract-facts.mjs/synthesize.mjs) -- pasar un
    // modelo fijo desactiva el fallback y deja el clasificador a merced de
    // un solo modelo sobrecargado (503 UNAVAILABLE, transitorio y frecuente).
    return await generateWithGeminiFallback(env.GEMINI_API_KEY, prompt);
  } catch (err) {
    console.error(`  (clasificador de relaciones Gemini falló: ${err.message})`);
    return null;
  }
}

/**
 * @param {string} nodeA
 * @param {string} factsTextA texto completo de los hechos de A (mismo formato que timeline.mjs)
 * @param {string} nodeB
 * @param {string} factsTextB texto completo de los hechos de B
 * @param {'gemini'|'ollama'} [provider] default 'gemini' -- ver nota de cabecera, es el único
 *   validado en la práctica contra el patrón espurio "ambos hechos mencionan a la misma persona"
 * @param {string} [model] override del modelo (solo aplica a provider 'ollama' -- gemini
 *   siempre usa su lista de respaldo, ver callGemini). Ej. "gemma4:31b-cloud".
 * @returns {Promise<{relation: string, evidence: string, fact_a: string, fact_b: string}[] | null>}
 *   null si el clasificador está deshabilitado o falla por cualquier motivo, el
 *   llamador nunca debe tratar null como "sin relaciones", sino como "no se pudo
 *   evaluar este par, reintentar después". fact_a/fact_b normalizados aquí desde
 *   "fact node A"/"fact node B" (nombres del esquema v2.0) para que el llamador
 *   (list-edge-candidates-deep.mjs) no dependa de claves con espacios.
 */
export async function classifyRelation(nodeA, factsTextA, nodeB, factsTextB, provider = DEFAULT_PROVIDER, model) {
  if (!classifierEnabled) return null;

  const prompt = buildPrompt(nodeA, factsTextA, nodeB, factsTextB);
  const rawResponse = provider === 'gemini' ? await callGemini(prompt) : await callOllama(prompt, model);
  if (rawResponse == null) return null;

  let parsed;
  try {
    const cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`  (respuesta del clasificador de relaciones no es JSON válido: ${err.message})`);
    return null;
  }

  if (!Array.isArray(parsed.edges)) {
    console.error(`  (respuesta del clasificador de relaciones con forma inesperada: ${JSON.stringify(parsed).slice(0, 200)})`);
    return null;
  }

  return parsed.edges
    .map((e) => ({
      relation: e.relation,
      evidence: e.evidence,
      fact_a: e['fact node A'],
      fact_b: e['fact node B'],
    }))
    .filter((r) => (
      typeof r.relation === 'string' && r.relation.trim() !== '' &&
      typeof r.fact_a === 'string' && r.fact_a.trim() !== '' &&
      typeof r.fact_b === 'string' && r.fact_b.trim() !== ''
    ));
}

export const CLASSIFIER_MODELS = MODELS;
export const CLASSIFIER_DEFAULT_PROVIDER = DEFAULT_PROVIDER;
