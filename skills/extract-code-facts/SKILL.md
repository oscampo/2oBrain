---
name: extract-code-facts
description: Extrae los hechos semánticos de la sesión ACTUAL de Claude Code y los entrega como JSON en el chat, listo para ingerir después con scripts/db/remember-batch.mjs. No requiere que ESTA sesión tenga acceso a scripts/db/ ni a .env, solo extrae y entrega texto, nunca escribe a la base. Se activa con "extrae hechos", "genera facts de esta sesión", "/extract-code-facts". Funciona en cualquier sesión de Code, incluyendo contenedores remotos de otros repos sin ningún acceso a este segundo cerebro; el usuario copia el JSON después a la máquina donde sí corre remember-batch.mjs.
---

# Extracción de hechos de sesión Code (para remember-batch)

## Por qué este diseño

La skill nunca asume qué acceso tiene el entorno donde corre, porque casi
nunca es el mismo entorno del destino final. La skill **solo extrae y
entrega texto en el chat**, nunca intenta escribir al destino desde la
sesión donde corre, tenga o no acceso a él.

Esto importa en concreto: una sesión de Code sobre otro repo (ej. un
contenedor remoto sin ningún acceso al segundo cerebro) puede y debe usar
esta skill igual que una sesión local en el repo del segundo cerebro. La
diferencia de acceso a `scripts/db/` y `.env` solo determina si el Paso 6
(opcional) puede correr ahí mismo o si el usuario tiene que llevar el JSON
a otra máquina, no determina si la skill aplica.

## Cuándo se activa

Palabras clave: "extrae hechos", "genera facts de esta sesión", "/extract-code-facts".

## Pasos

### Paso 1: Fecha real, nunca inferida

Ejecutar en terminal `date '+%Y-%m-%d'` (en la zona horaria del usuario, ver
`USER.md`) y usar ese resultado como único valor posible para `date` en
cada hecho. Si el comando falla, preguntar la fecha al usuario antes de
continuar, nunca adivinarla ni tomarla del contenido de la conversación
(una sesión reanudada puede describir trabajo de días atrás; esa fecha del
contenido NUNCA es la fecha del hecho).

### Paso 2: Identificar el repo/proyecto

Nombre del repo de esta sesión. Se usa para `source` y como candidato de
`node`.

### Paso 3: Analizar la sesión actual

Única fuente: el contexto de esta conversación. Identificar candidatos a
hecho: decisiones tomadas, hallazgos técnicos con impacto, compromisos
asumidos (con quién y para cuándo), preferencias declaradas por el usuario
que deban persistir. Descartar: especulación sin resolver, ideas
exploratorias, riesgos no confirmados, narrativa de proceso ("primero
probamos X, después Y") que no deja un hecho verificable al final.

Un hecho verificable es una oración declarativa que se puede confirmar o
refutar después, no un resumen de actividad.

### Paso 4: Clasificar por `kind`

- `fact`: algo que quedó establecido o confirmado
- `event`: algo que ocurrió en una fecha concreta
- `preference`: una preferencia declarada por el usuario que debe persistir
- `commitment`: algo que alguien (el usuario o Claude) se comprometió a hacer

### Paso 5: Construir el JSON

Formato exacto, uno por hecho (esquema de `remember-batch.mjs`):

```json
{
  "facts": [
    {
      "claim": "oración declarativa corta, verificable, en tercera persona o impersonal",
      "date": "YYYY-MM-DD",
      "kind": "fact",
      "source": "extract-code-facts, sesión Code, repo <repo>",
      "node": "<repo>"
    }
  ]
}
```

Reglas de cada campo:
- `claim`: una idea por hecho, sin narrativa, sin adjetivos de relleno. Si
  no se puede refutar, no es un claim útil, descartarlo.
- `date`: siempre el resultado del Paso 1, nunca una fecha mencionada en el
  contenido analizado.
- `kind`: uno de los cuatro valores del Paso 4, nunca inventar otros.
- `source`: siempre `"extract-code-facts, sesión Code, repo <repo>"` con el
  repo real del Paso 2.
- `node`: nombre del nodo (string), o un array de nombres si el hecho toca
  más de uno (`fact_nodes` es N:N). Usar `<repo>` salvo que el hecho sea
  sobre una persona, proyecto o tema que ya tenga su propio nodo en el
  segundo cerebro (preguntar al usuario si no es obvio). **Es un campo
  opcional**: si no se sabe el nombre exacto del nodo, omitirlo por
  completo (no inventar uno), el clasificador de `remember-batch.mjs`
  (`lib/classify-node.mjs`) propone o reutiliza un nodo en tiempo de
  ingesta y deja el hecho como "ambiguo" para que el usuario lo resuelva a
  mano si la confianza no alcanza.

No incluir `confidence`, `supersedes`, `distinct` ni `createNode`, esos
los decide `remember-batch.mjs`/`classify-node.mjs` en tiempo de ingesta
(gate de duplicados/contradicciones y desambiguación de nodo ya
existente), no esta skill.

### Paso 6: Entregar

Mostrar el JSON completo en la respuesta, no solo un resumen. Esto es lo
que la skill garantiza siempre, sin importar el entorno.

Después, según lo que esta sesión pueda ver:

- **Si esta sesión NO tiene acceso a `scripts/db/` ni a `.env` del segundo
  cerebro** (caso normal: contenedor remoto de otro repo): cerrar ahí.
  Decirle al usuario que copie el JSON y lo ingiera desde una
  máquina/sesión con acceso: `node scripts/db/remember-batch.mjs --file
  <ruta-del-json>` (o por stdin).
- **Si esta sesión SÍ tiene ese acceso**: preguntar al usuario si quiere
  revisar la lista antes de ingerir, o correr `remember-batch.mjs` directo.
  No correrlo sin confirmación explícita, la ingesta escribe en Supabase,
  no es reversible con un simple `git revert`.

Nunca negarse a generar el JSON por falta de acceso al destino, eso
confundiría "no puedo ingerir desde aquí" con "no puedo extraer aquí", y
son cosas distintas.

## No hacer

- No inferir `date` del contenido de la conversación ni de commits
  mencionados. Siempre el comando `date` del Paso 1.
- No inventar un `node` que no se sabe si existe; si hay duda, omitir el
  campo (el clasificador de `remember-batch.mjs` decide) en vez de
  adivinar.
- No incluir hallazgos especulativos o ideas sin resolver como si fueran
  `fact`.
- No correr `remember-batch.mjs` automáticamente sin que el usuario
  confirme la lista.
- No negarse a generar el JSON por no tener acceso a `scripts/db/` o
  `.env` en esta sesión, la extracción no necesita ese acceso, solo la
  ingesta final (Paso 6) lo necesita, y esa parte es opcional y de otra
  máquina si hace falta.

## Reglas de calidad

- Una idea por `claim`, oración corta, verificable.
- `source` siempre completo, nunca campos vacíos o `null` por omisión.
- Sin narrativa de proceso, sin elogios, sin resumen de lo que se hizo si
  no deja un hecho verificable.
- `date` verificado contra el comando `date`, nunca contra el contenido
  analizado.
