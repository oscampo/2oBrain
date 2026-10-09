# CHANGELOG

Versiones etiquetadas de 2oBrain. `scripts/db/check-for-updates.mjs`
compara el `VERSION` local contra el último tag de `oscampo/2oBrain` --
lee esto antes de aplicar una actualización para saber qué esperar, no
asumas que es solo un número.

## v0.12.2 (2026-10-09)

Mejoras al extractor de registros (`extract-records.mjs`, el que corre el hook
`Stop` en segundo plano, y `extract-page-records.mjs`). No hay pasos
obligatorios: no cambia el esquema ni el servidor MCP.

- **Las ventanas largas ya no pierden el final.** Si la conversación supera el
  límite del proveedor (20.000 caracteres en Ollama), antes se cortaba el final,
  justo donde están las decisiones más recientes. Ahora se parte en trozos de
  turnos completos, cada trozo se extrae por separado y los candidatos se unen,
  sin repetir un mismo texto. El bloque "Ya registrado en esta ventana" va
  completo en cada trozo. Un solo turno más largo que el límite sigue
  recortándose. Con `--dump-prompt` se ve solo el primer trozo.
- **El prompt del extractor excluye lo que ya queda escrito en otro lado.** No se
  registran los commits y su contenido, que un script se ejecutó o qué imprimió,
  cambios de configuración que se explican al leer el archivo, resultados de
  chequeos rutinarios sin novedad, citas de registros que ya existen,
  explicaciones del asistente sobre cómo funciona el sistema de memoria,
  advertencias que el usuario no adoptó, reuniones que ya están en el calendario
  ni ecos mecánicos de la propia captura. Se mantienen las excepciones: una
  decisión del usuario, un hallazgo no obvio, un compromiso con fecha o un
  cambio de estado que el repositorio no conserva. Se quitó del ejemplo del
  prompt una cita de calendario.
- **El prompt ahora le dice al modelo que no repita lo ya registrado.** El código
  del extractor ya agregaba el bloque "Ya registrado en esta ventana", pero el
  prompt por defecto no tenía la regla que le indica al modelo qué hacer con él.
- **Proveedor por defecto.** Sin `--provider`, ambos extractores usan el
  proveedor del grupo "extraction" del dashboard (Modelos por tarea) en vez de
  Gemini fijo. El hook `Stop` ya pasaba `--provider ollama`, así que su
  comportamiento no cambia. Gemini sigue disponible con `--provider gemini`.
- **Gemini:** `gemini-2.5-flash` pasa al inicio del orden de respaldo en
  `config/gemini-models.json`.

## v0.12.1 (2026-10-09)

**Retira de v0.12.0 todo lo relacionado con la jardinería de etiquetas.** Esa
parte entró por error: sigue en pruebas y calibración y no estaba lista para
publicarse. v0.12.1 conserva solo la reescritura de `remember.mjs`, el ajuste de
fecha de `remember-batch.mjs` y la marca `is_meta` del clasificador.

No hay pasos obligatorios. Si ya actualizaste a v0.12.0:

- `apply-schema.mjs` no se vuelve a correr: v0.12.1 no cambia el esquema. Las
  tablas `parent_proposals` y `blind_name_sightings` y la columna
  `memories.description` que v0.12.0 creó siguen en tu base, vacías y sin uso;
  no estorban y no hace falta borrarlas.
- Los archivos retirados desaparecen al actualizar el repositorio:
  `propose-categories.mjs`, `propose-parents.mjs`, `set-memory-description.mjs`,
  `lib/propose-parent.mjs`, `lib/judge-coverage.mjs` y `lib/llm-call.mjs`.
- `garden.mjs` vuelve a la versión de v0.11.0: sin `--parent-proposals` ni
  `--parent-proposal`, y el contador de propuestas pendientes vuelve a contar
  también las de registros ya reemplazados.
- `.claude/settings.json` y `CLAUDE.md` vuelven a lo de v0.11.0.

Se quedan de v0.12.0: `remember.mjs` reescrito (registro, recuerdos y cierre en
una sola transacción; avisa si falla `memories_similar`; fecha de hoy con
`formatToParts`), el mismo ajuste de fecha en `remember-batch.mjs`, y la marca
`is_meta` en el clasificador de recuerdos.

## v0.12.0 (2026-10-09)

**Nota:** todo lo relacionado con la jardinería de etiquetas (propuestas de padre y de categoría nueva, y los cambios de `garden.mjs`) se retiró en v0.12.1. Lo que sigue lo describe tal como se publicó.

Hay dos pasos para actualizar, en este orden:

1. `node scripts/db/apply-schema.mjs` (crea las tablas `parent_proposals` y
   `blind_name_sightings`, ambas con RLS activo, y la columna
   `memories.description`; es idempotente).
2. Reinicia el servidor del dashboard.

No hay cambios incompatibles: `remember.mjs` conserva las mismas opciones. No
hace falta redesplegar la Edge Function `mcp-server`.

- **`remember.mjs` reescrito.** Mismo comportamiento de cara al usuario, un
  archivo mucho más corto (409 líneas contra 688). El registro, sus recuerdos y el
  cierre de lo que reemplaza se guardan en **una sola transacción**, así que un
  fallo a medias ya no deja un registro sin sus recuerdos. Si la consulta de
  recuerdos parecidos (`memories_similar`) falla, el script avisa y sigue sin
  sugerencias, en vez de caer sin tratar o afirmar que no hay embeddings. La fecha
  de hoy se calcula con `formatToParts`, que funciona también con Node con ICU
  reducido (`en-CA` devolvía otro formato y la fecha de hoy nunca coincidía con
  `--date`). `remember-batch.mjs` recibe el mismo ajuste de fecha.
- **Propuestas de padre (nuevo).** Un recuerdo sin lugar en la jerarquía
  `pertenece_a`, o uno nuevo que nace de un cúmulo de registros, recibe tres
  padres candidatos, del más al menos probable. Nada se aplica solo, igual que las
  propuestas de etiqueta.
  - `propose-parents.mjs` propone padre para recuerdos que existen y están fuera
    de toda jerarquía. Por defecto solo muestra; con `--queue` deja las propuestas
    pendientes en la tabla nueva `parent_proposals`. El recuerdo `usuario` queda
    excluido por defecto.
  - `propose-categories.mjs` propone recuerdos **nuevos**: el modelo da un nombre
    sin ver los recuerdos existentes (3 corridas, deben coincidir 2), un juez de
    cobertura (`lib/judge-coverage.mjs`) descarta los que un recuerdo existente ya
    cubre, y se exige un apoyo mínimo (`--min-support`, 7) y que converjan al menos 2 registros (`--min-records`). Con `--queue` guarda
    en `blind_name_sightings` los nombres de un solo registro, para que la
    convergencia cuente también corridas de días anteriores (`--memory-days`).
    Los umbrales no están calibrados contra un criterio externo: tómalos como
    punto de partida.
  - `set-memory-description.mjs` escribe la ficha de definición de un recuerdo
    (`memories.description`), que `propose-parent.mjs` usa para ubicarlo.
  - **Dónde se deciden:** con `garden.mjs --parent-proposals` (lista) y
    `--parent-proposal <id> accept [1|2|3|nombre] | reject | undo`. Aceptar crea el
    enlace `pertenece_a` y, si el recuerdo es nuevo, lo crea y etiqueta los
    registros que lo originaron; rechaza ciclos. **El dashboard todavía no tiene
    la pantalla "Propuestas de padre"**: por ahora se decide solo por consola.
- **`lib/llm-call.mjs`.** Una sola función, `getTaskLlm(grupo)`, para llamar al
  modelo de un grupo de "Modelos por tarea" (Ollama Cloud, OpenRouter o Gemini).
  Hoy la usan las propuestas de padre; los clasificadores existentes siguen con su
  llamada propia. La rama de Gemini solo se activa cuando un grupo tenga Gemini
  elegido; en esta versión `task-models.mjs` todavía no lo ofrece.
- **Recuerdos marcados `is_meta` en el clasificador.** El clasificador de recuerdos
  recibe la marca y, para un recuerdo sobre el propio sistema, no se deja llevar
  por la mención literal ni por el parecido de ejemplos. `remember-batch.mjs` la
  pasa igual que `remember.mjs`.
- **Revisión de etiquetas:** el contador de propuestas pendientes de `garden.mjs`
  ignora las de registros ya reemplazados, que inflaban el total sin aparecer
  nunca en la lista.
- **Claude Code:** `.claude/settings.json` suma reglas `ask` para
  `garden.mjs --parent-proposal`, y `CLAUDE.md` lo nombra junto a
  `--proposal` en el protocolo del hook Stop.

## v0.11.0 (2026-10-04)

**Cambio incompatible:** `remember.mjs` ya no crea recuerdos ni acepta
`--create-memory` para crearlos, `--aliases`, `--no-suggest-aliases` ni
`--memories-confirmed`. Si tienes scripts propios o instrucciones que los usan,
crea antes el recuerdo con `create-memory.mjs` (ver la Fase 5 de `CLAUDE.md`).

Hay cuatro pasos, en este orden:

1. `node scripts/db/apply-schema.mjs` (crea la tabla `memory_proposals`, con RLS
   activo, y cambia la función de búsqueda `records_search`; es idempotente).
2. Redespliega la Edge Function `mcp-server` con el `index.ts` nuevo: `remember`
   cambia de comportamiento y hay dos herramientas nuevas, y sin redesplegar el
   servidor MCP sigue aplicando etiquetas solo.
3. Reinicia el servidor del dashboard.
4. `CLAUDE.md` cambia en dos lugares fuera de "Cómo trabajar con el usuario":
   el "Protocolo del hook Stop" y la Fase 5 de la instalación. Aplícalos a mano.

- **Ninguna etiqueta se aplica sin que la aceptes.** Antes el clasificador de
  recuerdos podía agregar solo un recuerdo adicional a un registro, o crear uno
  nuevo. Una etiqueta equivocada puesta así se reforzaba sola: el clasificador usa
  los registros de cada recuerdo como ejemplos, así que un recuerdo contaminado
  atraía cada vez más registros ajenos. Ahora el registro se guarda con los
  recuerdos que pediste y existen, y todo lo demás (un recuerdo que no existe, o
  lo que sugiera el clasificador) queda como **propuesta pendiente** en la tabla
  nueva `memory_proposals`, con su número.
- **Dónde se deciden las propuestas:** en el dashboard, Revisión de etiquetas >
  Propuestas pendientes (Aceptar / Descartar, y Deshacer en "Decididas
  recientemente"), o con `garden.mjs --proposals`, `--proposal <id>
  accept|reject|undo` y `--decided`. Aceptar una propuesta de recuerdo nuevo lo
  crea.
- **Servidor MCP:** `remember` ya no crea recuerdos ni aplica etiquetas no
  pedidas, y lista las propuestas en su respuesta. Herramientas nuevas:
  `list_memory_proposals` (solo lee) y `decide_memory_proposal` (acepta o
  descarta). **Deja `decide_memory_proposal` en "Needs approval" en tu cliente
  MCP**: el servidor no puede saber si una decisión la tomaste tú o el modelo, así
  que esa aprobación es la única que de verdad espera tu clic. `remember` además
  corre sus clasificadores en paralelo y responde más rápido.
- **Claude Code:** `.claude/settings.json` nuevo con reglas `ask` para que Claude
  pida permiso antes de correr `garden.mjs --proposal`, `recategorize-record.mjs`
  y `edit-record.mjs ... --memory`. Son un respaldo, no una barrera: otra forma de
  escribir el comando las evita, por eso la regla principal sigue en `CLAUDE.md`.
  `create-memory.mjs` queda fuera a propósito: la instalación lo corre muchas
  veces seguidas.
- **El dashboard y la extracción de páginas siguen creando recuerdos cuando tú
  lo marcas:** como ahí decide el usuario, crean el recuerdo con `create-memory.mjs`
  antes de guardar (Guardar registro con "Crear recuerdo", Extraer con
  `createMemory`, y `extract-page-records.mjs --review`).
- **Búsqueda más precisa:** `records_search` ya no premia los registros de un
  recuerdo solo porque su nombre o alias comparta una palabra con la pregunta.
  Bastaba una palabra genérica ("proyecto", o "iniciar" que coincide con
  "iniciativa" por raíz) para que esos registros desplazaran al resultado
  correcto. Los recuerdos nombrados en la pregunta los sigue trayendo aparte el
  detector de recuerdos de `search.mjs` y del servidor MCP, por alias exacto: si
  sueles nombrar un recuerdo con una palabra corta (una sigla, por ejemplo),
  agrégala como alias con `set-memory-aliases.mjs`.
- **Fix propio**: la copia de `segundo-cerebro-capture` en `.claude/skills/` (la
  que Claude Code carga) se había quedado atrás de la de `skills/`; ahora son
  iguales.
- **Cómo se verificó**: `node --check` sobre todos los `.mjs` tocados y
  `deno check` sobre `index.ts`, sin errores. El sistema de propuestas y el cambio
  de búsqueda se probaron primero en la instancia de desarrollo contra una base
  real (cola desde la extracción y desde MCP, aceptar, descartar, deshacer, y
  búsquedas con y sin palabras genéricas). Esta copia de 2oBrain no se probó
  contra una base: el port se hizo fusionando los mismos cambios sobre los
  archivos de 2oBrain.

## v0.10.9 (2026-10-03)

Hay tres pasos, en este orden:

1. `node scripts/db/apply-schema.mjs` (crea las tablas nuevas `settings` y
   `settings_history`, con RLS activo y sembradas con los valores actuales de
   `config/task-models.json`; es idempotente y nunca pisa un valor ya editado).
2. Redespliega la Edge Function `mcp-server` con el `index.ts` nuevo: las
   herramientas nuevas y la lectura del modelo desde la base viven ahí, y sin
   redesplegar el servidor MCP sigue con su modelo escrito a mano.
3. Reinicia el servidor del dashboard.

- **El modelo de IA por tarea ahora vive en la base, no en cada máquina.** Antes
  la elección de modelo para cada grupo de tareas (classifiers, extraction,
  synthesis, deepSweep) se guardaba en `config/task-models.json` de cada máquina,
  y el servidor MCP tenía la suya escrita a mano: dos máquinas, o una máquina y
  el MCP, podían usar modelos distintos para la misma tarea sin que nadie lo
  notara. Ahora hay una sola fila en la base (`settings.task_models`) que leen por
  igual los scripts y el servidor MCP. Los scripts la sincronizan al arrancar,
  con un caché local de 10 minutos (`state/task-models.cache.local.json`, fuera de
  git); si la base no responde en 3 segundos usan el caché anterior o, si nunca
  hubo, `config/task-models.json`, que queda solo como respaldo.
- **El dashboard escribe en la base.** Cambiar un modelo en la sección de modelos
  por tarea ya no edita `config/task-models.json`: escribe en la base y deja el
  cambio en `settings_history`. Si la base no responde, el cambio falla visible en
  vez de guardarse solo en esa máquina.
- **El servidor MCP expone dos herramientas nuevas:** `get_settings` (muestra el
  modelo de cada grupo, los disponibles por proveedor y los últimos cambios) y
  `set_task_model` (cambia el modelo de un grupo).
- **Aviso de seguridad:** `set_task_model` cambia el modelo para TODAS las
  máquinas y para el propio servidor MCP a la vez. Tiene salvaguardas (solo
  modelos de la lista de disponibles, solo Ollama Cloud, motivo obligatorio,
  historial en `settings_history` y bloqueo optimista contra cambios
  simultáneos), pero en la app de Claude conviene dejar esa herramienta en
  "Needs approval" para que nunca se ejecute sin que la confirmes.
- **Cómo se verificó**: `node --check` sobre los dos `.mjs` tocados y
  `deno check` sobre `index.ts`, sin errores. Con una copia de prueba se comprobó
  que, sin base alcanzable, los scripts caen a `config/task-models.json` (en modo
  nube al instante; en local tras esperar los 3 segundos del límite) y que
  `setTaskModel` rechaza un modelo que no está en la lista de disponibles. **No se
  probó contra una base real**: ni `apply-schema.mjs`, ni la sincronización
  real, ni el guardado desde el dashboard, ni `get_settings`/`set_task_model`
  desplegados.

## v0.10.8 (2026-10-02)

Sin migración de `schema.sql` y sin pasos a mano, solo reinicia el servidor del
dashboard (el cambio está en el servidor, no en la página).

- **Corrige las vistas Lista, Gráfico y Heatmap del Timeline y el Grafo, que
  dejaban de cargar cuando la base crecía.** El servidor del dashboard corre cada
  script como subproceso y `spawnSync` limita su salida a 1 MiB por defecto. El
  JSON de `/api/timeline` y de `/api/graph` supera ese límite hacia los 1.500 o
  1.700 registros: el subproceso se mataba (`ENOBUFS`) y el dashboard respondía
  422 sin explicar por qué, así que las vistas quedaban vacías sin ningún aviso.
  Ahora el límite es de 256 MiB, y si un subproceso no termina por sí mismo el
  error se devuelve en `stderr` en vez de un 422 mudo. Si tu base es chica no lo
  habías notado, pero habría aparecido con el uso.
- **Cómo se verificó**: el fallo se reprodujo primero (los dos endpoints daban 422
  con salidas de 1,10 MB y 1,05 MB, `status` nulo y `ENOBUFS`), y tras el cambio
  los dos devolvieron 200 con los mismos tamaños; en el navegador cargaron las
  tres vistas del Timeline sin errores nuevos de consola.

## v0.10.7 (2026-10-02)

Hay un paso de migración y un reinicio:

1. `node scripts/db/apply-schema.mjs` (crea la tabla nueva `record_reviews`, con
   RLS activo; es idempotente).
2. Reinicia el servidor del dashboard: la página se recarga sola, pero los
   endpoints nuevos (`/api/garden/...`) solo existen tras reiniciar.

- **Revisión de etiquetas (nueva sección del dashboard, grupo Recuerdos).** Para
  revisar a mano si los registros recientes quedaron en el recuerdo correcto, sin
  depender de que ningún modelo opine sobre el asunto:
  - **Muestrear registros automáticos:** trae al azar registros de la extracción
    automática que nadie ha revisado. No detecta errores por sí mismo, mide qué
    tan seguido el etiquetado se equivoca.
  - **Señales de texto:** registros con un indicio concreto (solo tiene recuerdos
    paraguas, el texto nombra a otro recuerdo que no tiene, o alguno de sus
    recuerdos tiene 2 registros o menos).
  - **Una tabla por tarjeta:** cada etiqueta actual se decide por separado
    (Correcto, Mover a otro recuerdo o Quitar), se pueden añadir etiquetas
    nuevas, y todo se aplica junto con **Aplicar** y un solo motivo. No se deja
    el registro sin ninguna etiqueta. **Todas correctas** guarda el veredicto de
    una vez. Cada revisión se guarda en `record_reviews` y el registro no vuelve a
    salir; arriba se muestra la tasa de error observada (no concluir con menos de
    unas 30 revisiones).
  - También por consola: `node scripts/db/garden.mjs --sample`, `--stats`,
    `--verdict <id> ok|corrected`.
- **`recategorize-record.mjs` con dos modos nuevos:** `--remove` (quita una
  etiqueta sin reasignarla, nunca la única) y `--add <recuerdo>` (agrega una
  etiqueta sin tocar las que ya tiene). `--add` no crea enlaces entre recuerdos:
  si el registro queda con dos recuerdos sin enlace, `doctor.mjs --fix` lo
  resuelve.
- **La señal "paraguas" arranca vacía.** En `garden.mjs`, `UMBRELLA` es la lista de
  tus recuerdos demasiado amplios para decir de qué trata un registro; ponla ahí
  si la quieres usar.
- **Cómo se verificó**: se levantó el dashboard de 2oBrain en un puerto de prueba
  contra una base real. Los tres endpoints de lectura (estadísticas, muestreo y
  señales) respondieron bien y la sección se renderizó en el navegador sin
  errores de consola; solo se hicieron lecturas desde esta copia. Las escrituras
  (Aplicar con mover, quitar y añadir, y las guardas) se probaron en la copia de
  trabajo de origen antes de portar.

## v0.10.6 (2026-10-02)

Sin migración de `schema.sql`, sin redespliegue del servidor MCP y sin pasos a
mano: recarga la página del dashboard (el servidor lee `index.html` en cada
carga, no hace falta reiniciarlo).

- **Grafo: la búsqueda ahora avisa cuando no encuentra nada.** Antes, buscar
  algo que no estaba en el grafo no mostraba ningún mensaje: el botón "Ir" se
  quedaba sin efecto visible. Ahora aparece un aviso bajo la barra de búsqueda:
  - **Vista por recuerdos:** si el recuerdo no existe, dice que puede haberse
    fusionado, renombrado o borrado, y sugiere "Refrescar". La búsqueda ya no
    distingue mayúsculas de minúsculas como último recurso.
  - **Vista por registros, búsqueda por número (`#123`, `#94, #95`):** distingue
    tres casos que antes se veían igual: el registro no existe en la base
    (purgado o nunca existió), existe pero está retractado o reemplazado
    (indica por cuál), o existe y el filtro "Ocultar registros
    supersedidos/retractados" lo esconde del grafo. Un registro vigente no
    muestra aviso.
  - **Vista por registros, texto libre sin resultados:** avisa y sugiere buscar
    por número.
  El aviso se limpia al cambiar de vista o de búsqueda.
- **Cómo se verificó**: el dashboard se levantó en un puerto de prueba contra una
  base real y se probaron en el navegador los siete casos (recuerdo existente e
  inexistente, id purgado, retractado, reemplazado, vigente y mezcla de ids),
  más el caso del filtro de ocultar, sin errores de consola. La rama de "texto
  libre sin resultados" no se pudo provocar, porque la búsqueda híbrida casi
  siempre devuelve algo.

## v0.10.5 (2026-10-02)

**Cambia `schema.sql` y el servidor MCP.** Corre `node scripts/db/apply-schema.mjs`
y, si usas el servidor MCP, redespliégalo (`supabase functions deploy mcp-server`).
Completa v0.10.4: aquel cambio cerraba el duplicado exacto en la aplicación, este
lo cierra en la base de datos.

- **`schema.sql`**: índice único parcial `records_live_claim_uniq` sobre el
  texto normalizado (sin contar espacios ni mayúsculas) de los registros
  vigentes. La guarda de v0.10.4 compara contra lo ya insertado, así que dos
  llamadas idénticas que llegan a la vez la pasaban las dos antes de que
  cualquiera insertara; el índice las frena en la base. Un registro retractado o
  reemplazado no cuenta, así que volver a guardar un texto retractado sigue
  funcionando.
- **Si tu base ya tiene duplicados vigentes**, el índice no se crea: el schema
  avisa con un `notice` y sigue, no se rompe. Retracta las copias
  (`node scripts/db/forget.mjs --id N --reason "..."`) y vuelve a correr
  `apply-schema.mjs`. Para encontrarlas: agrupa por
  `lower(regexp_replace(btrim(claim), '\s+', ' ', 'g'))` entre los registros con
  `valid_until is null` y revisa los grupos de más de uno.
- **Servidor MCP**: si el insert choca con ese índice, responde "Ya existe un
  registro vigente con el mismo texto" como duplicado, no como error. Los scripts
  de línea de comandos (`remember.mjs`, `remember-batch.mjs`) no manejan ese
  error: ante la carrera extrema fallarían con el error de Postgres en vez de un
  mensaje amable, sin insertar nada.
- **Cómo se verificó**: el índice se creó en una base real y rechazó una copia
  con espacios de más; el bloque del schema se probó con duplicados presentes
  (avisa y no crea el índice, sin error). El servidor se desplegó y probó en la
  instalación de origen con la guarda de aplicación, pero la rama del error
  `23505` del servidor no se pudo ejercitar con llamadas realmente simultáneas,
  y esta copia solo pasa `deno check`.

## v0.10.4 (2026-10-02)

Sin migración de `schema.sql` y sin pasos a mano, salvo **redesplegar el
servidor MCP** si lo usas (`supabase functions deploy mcp-server`): el cambio
también está en `supabase/functions/mcp-server/index.ts`.

- **Un registro con texto idéntico a uno vigente ya no se inserta, sin importar
  las banderas.** Antes, pasar `--complements`/`--distinct` (o `complements`/
  `distinct` en el MCP y en el JSON de `remember-batch.mjs`) saltaba el
  clasificador de duplicados, así que dos llamadas iguales seguidas dejaban el
  mismo registro dos veces. Caso real: un cliente de voz llamó dos veces a
  `remember` con el mismo texto y `complements` apuntando al mismo registro,
  y entró el duplicado exacto. La guarda es determinista (compara el texto sin
  contar espacios ni mayúsculas, sin modelo), vive en `remember.mjs`,
  `remember-batch.mjs` y el servidor MCP, y responde "Ya existe un registro con
  el mismo texto: #id". En `remember-batch.mjs` cuenta como redundante.
- **Qué no cubre**: textos casi iguales pero no idénticos con `complements` o
  `distinct` explícitos siguen entrando, porque ahí la decisión es de quien
  llama. Sin banderas, esos casos los sigue resolviendo el clasificador.
- **Cómo se verificó**: `remember.mjs` y `remember-batch.mjs` contra una base
  real con el texto de un registro existente más `--complements`/`distinct`:
  ninguno insertó nada. El servidor MCP se desplegó en la instalación de
  origen y rechazó el duplicado con `distinct: true`; esta copia pasa
  `deno check`, pero no se desplegó ni se probó en ejecución.

## v0.10.3 (2026-10-01)

Sin migración de `schema.sql`, sin redespliegue del servidor MCP y sin pasos a
mano: reinicia el dashboard (botón "Reiniciar servidor" o tu proceso habitual)
para que tome el servidor y el frontend nuevos. Cierra el porte desde MyBrain
iniciado en v0.10.0 con el dashboard.

- **El timeline muestra la hora de cada registro.** Cada entrada agrega
  "instante: HH:MM" (la hora real del mensaje o evento fuente, `source_at`) o,
  si no existe, "insertado: HH:MM" (cuándo entró la fila, `created_at`). Usa la
  zona horaria del navegador, no una fija. Estos dos campos llegaron al schema
  en v0.10.0 y hasta ahora solo se podían ver con SQL; no se muestra nada para
  registros que no tengan ninguno de los dos.
- **Enter ejecuta la acción en tres campos**: la pregunta de "Buscar", el
  recuerdo de "Estado de recuerdo" y el id de "Retractar/editar registro" (antes
  había que hacer clic en el botón).
- **`/favicon.svg` ahora se sirve.** `index.html` ya lo referenciaba pero el
  servidor no tenía la ruta, así que el navegador recibía un 404 en cada carga.
- **"Buscar" pide el contenido completo de las páginas** (`search.mjs --full`,
  disponible desde v0.10.1): el bloque de datos crudos del dashboard lo
  espera así para colorear cada resultado por relevancia.
- **Windows**: el lote de "Guardar lote" ya no abre una ventana de consola
  visible por cada ejecución de `remember-batch.mjs`.
- **El resaltado del menú lateral** solo recorre los botones de navegación
  (`button[data-target]`), no cualquier botón del panel.
- **`scripts/db/server/dashboard.log` deja de estar versionado.** El servidor lo
  reescribe en cada arranque, así que quedaba siempre como modificado sin
  comitear. Ahora está en `.gitignore`; el archivo local sigue existiendo.
- **Cómo se verificó**: se levantó el dashboard en un puerto de prueba contra
  una base real y se revisó en el navegador: sin errores de consola, Enter lanza
  la búsqueda y la síntesis responde, el menú se cierra al elegir "Timeline", el
  timeline muestra "instante" e "insertado" con la hora local, y `/favicon.svg`
  responde 200 con `image/svg+xml`. No se probaron en el navegador "Estado de
  recuerdo" ni "Retractar/editar" con Enter, ni "Guardar lote" en Windows.

## v0.10.2 (2026-10-01)

Sin migración de `schema.sql` y sin redespliegue del servidor MCP. **Pide dos
cosas a mano** (el hook y `CLAUDE.md` nunca se reemplazan a ciegas porque
llevan tus preferencias), ver "Al actualizar" abajo. Porta el hook `Stop` desde
MyBrain: último pendiente del porte iniciado en v0.10.0.

- **`scripts/hooks/stop-capture-check.mjs`**:
  - **El texto del protocolo ya no se repite en cada bloqueo.** El hook manda
    un puntero corto a la sección "Protocolo del hook Stop" de `CLAUDE.md` más
    el bloque dinámico de esa ejecución. En Claude Code CLI (a diferencia de
    Desktop, que pliega estos bloques) el texto de un hook que bloquea se
    imprime crudo en la terminal en cada cierre de turno, así que repetir
    ~1500 caracteres estáticos era ruido y tokens gastados. El mensaje trae una
    frase de respaldo por si todavía no copiaste esa sección a tu `CLAUDE.md`.
  - **Nueva constante `AUTO_INSERT`, apagada por defecto.** Con `false`
    (comportamiento de siempre) la extracción en segundo plano solo propone
    candidatos y tú decides cuáles guardar. Con `true` lanza
    `extract-records.mjs --auto`: un modelo barato inserta solo los candidatos
    rutinarios, sin revisión humana, pasando por el mismo gate de duplicados de
    `remember.mjs`, y el hook reporta cuántos insertó, cuántos descartó por ya
    estar cubiertos y los que quedan pendientes para ti. Insertar sin revisión
    es una decisión de cada usuario, por eso no se activa sola.
  - En Windows, el job en segundo plano ya no abre una ventana de consola
    visible cada vez que se lanza.
- **`CLAUDE.md`**: nueva sección "Protocolo del hook Stop (captura de cierre
  de turno)", con el texto de ambos modos (`SILENT` verdadero y falso), cómo
  interpretar el bloque de extracción según `AUTO_INSERT`, y el "chequeo de
  skill": evaluar si el contexto reciente amerita algo más que un registro (una
  skill nueva), y proponérselo al usuario, nunca crearla sola. La Fase 9
  recuerda dejar `AUTO_INSERT` en `false` salvo petición expresa.
- **Al actualizar**: (1) antes de reemplazar `stop-capture-check.mjs`, anota los
  valores de `LEVEL` y `SILENT` que tienes puestos y vuelve a ponerlos en la
  versión nueva (el reemplazo los devuelve a los valores por defecto, `2` y
  `false`); (2) copia a mano la sección "Protocolo del hook Stop" de este
  `CLAUDE.md` al tuyo, justo antes de "Fase 0", sin tocar el resto.
- **Cómo se verificó**: el hook se ejecutó de verdad en ambos modos. La
  cadencia dispara exactamente en la llamada 10 con `LEVEL = 2` y no antes. El
  bloque de candidatos aparece en modo propuesta, y con `AUTO_INSERT = true` se
  leen bien los conteos de insertados y redundantes y las líneas pendientes; un
  archivo de resultado del otro modo no se consume por error. No se probó el
  ciclo completo con un modelo de extracción real lanzado por el hook.

## v0.10.1 (2026-10-01)

Sin migración de `schema.sql`. No hace falta redesplegar el servidor MCP: el
único cambio en `supabase/functions/mcp-server/index.ts` es un comentario.
Termina el porte desde MyBrain iniciado en v0.10.0: `extract-records.mjs` y
`search.mjs`.

- **`deno-deploy/mcp-server/` y `deno.jsonc` eliminados.** Esa copia ya estaba
  por detrás del servidor de Supabase (no soportaba `complements` ni los alias
  automáticos) y mantener dos servidores "intercambiables" era una trampa: un
  arreglo aplicado a uno no llegaba al otro sin que nadie lo notara. El único
  servidor MCP alojado de 2oBrain es ahora la Edge Function de Supabase
  (`supabase/functions/mcp-server/`); `CLAUDE.md`, `README.md`, `README_SP.md` y
  `.env.example` ya no mencionan Deno Deploy, ni piden `DENO_DEPLOY_TOKEN`.
  **Si tenías el servidor en Deno Deploy**, tu instancia desplegada sigue
  funcionando como estaba, pero ya no recibirá actualizaciones desde este repo:
  para tener `complements`, `redundant` y lo que venga, despliega la Edge
  Function de Supabase y cambia la URL en tus clientes MCP. El código viejo
  sigue en el historial de git (`git show v0.10.0:deno-deploy/mcp-server/main.ts`).
- **`extract-records.mjs`**:
  - Nuevo modo `--auto` (excluyente con `--review`): inserta cada candidato sin
    pedir aprobación, pasando por el mismo gate de duplicados de `remember.mjs`;
    lo que ese gate no puede resolver queda listado como pendiente de revisión
    manual, nunca se fuerza, y los candidatos rechazados como `redundant` se
    cuentan aparte, no como insertados. Las inserciones llevan la marca
    "inserción automática sin revisión humana" en la fuente, que el candado de
    procedencia de `classify-duplicate.mjs` reconoce.
  - El extractor ahora ve las líneas `Registrado #N: ...` que `remember.mjs` ya
    imprimió dentro de la misma ventana y se le ordena no volver a proponerlas
    (antes proponía de nuevo lo que ya se había guardado a mano, con menos
    detalle). Ese bloque se agrega después de truncar la conversación, nunca
    antes, para que un truncado en una ventana larga no se lo coma.
  - El modelo devuelve `sourceTime` (una etiqueta `[HH:MM]` copiada de la
    transcripción) y el script la resuelve al instante real del turno y la pasa
    como `--source-at`: así los registros extraídos quedan con `source_at`
    (columna que llegó en v0.10.0).
  - Nota: el hook `Stop` de este scaffold todavía no usa `--auto`; sigue
    funcionando como antes y `--auto` queda disponible a mano.
- **`search.mjs`**:
  - Un flag que no existe (por ejemplo `--limit 15`) ahora es un error
    explícito. Antes se colaba como texto dentro de la pregunta semántica,
    degradaba el embedding sin aviso y hacía desaparecer resultados relevantes.
  - Nuevo `--full`: imprime el contenido completo de cada página en vez de los
    primeros 200 caracteres.
  - El router de recuerdos deja de usar el segmento del nombre como respaldo
    (causaba falsos positivos con palabras genéricas) y suma el matching por
    identidad semántica (`memories_match_query`, ya presente en el schema): el
    CLI queda alineado con la tool `search` del servidor MCP, que ya lo hacía.
- **Cómo se verificó**: `search.mjs` se ejecutó contra una base real (flag
  inválido rechazado con código 1, búsqueda normal con el router semántico,
  `--full` imprime más de cinco veces el contenido). `extract-records.mjs` se
  probó con `--dump-prompt` sobre una sesión real: el prompt pide `sourceTime` y
  el bloque "ya registrado" recoge las líneas `Registrado #N`. No se probó una
  corrida completa con `--auto` contra un modelo de extracción, ni `--review`.

## v0.10.0 (2026-10-01)

**Cambia `schema.sql` y el servidor MCP.** Corre `node scripts/db/apply-schema.mjs`
después de actualizar, y **redespliega** `supabase/functions/mcp-server/`
(`supabase functions deploy mcp-server`): actualizar el archivo local no
basta, el servidor corre desplegado aparte. Cierra el drift de la ruta
`remember` acumulado desde mediados de septiembre entre D:\MyBrain y este
scaffold (tres piezas encadenadas, portadas juntas).

- **`schema.sql`**: nueva columna `records.source_at timestamptz` (instante
  real del evento fuente, distinto de `created_at` y de `date`) y las
  funciones `records_similar` y `records_timeline`, que ahora devuelven
  `source_at` (y `created_at` en la segunda). Cambiar el tipo de retorno de
  una función exige drop + create, el schema lo hace solo. Sin
  `apply-schema.mjs`, `remember` fallará al leer `source_at`.
- **`lib/classify-duplicate.mjs`**: el clasificador ahora devuelve cuatro
  veredictos (antes tres). Nuevo **`redundant`**: el registro nuevo no
  aporta nada que uno vigente no tuviera ya, así que nunca se inserta (antes
  entraba como `distinct` y dejaba una fila duplicada). Además ve la fuente y
  el instante de cada registro y aplica dos candados deterministas, no solo
  instrucciones de prompt: una extracción automática sin revisión humana no
  puede reemplazar a un registro de fuente directa, y un hecho más viejo no
  puede reemplazar a uno más nuevo cuando ambos instantes se conocen.
- **`remember.mjs`**: nuevo `--source-at` (instante ISO 8601 del evento);
  `redundant` responde `Ya cubierto por #N, no se inserta` y sale con código
  0; el mensaje de bloqueo explica el caso redundante. **Arreglo**: el cierre
  automático de compromisos ya no toca a un compromiso que el registro nuevo
  declara complementar (`--complements`) o que ya reemplaza (`--supersedes`):
  antes, un registro "complementa a #N" cerraba además #N por completo.
- **`remember-batch.mjs`**: igual que `remember.mjs`. `redundant` ya no
  inserta (se cuenta aparte en el resumen), `complements` guarda el vínculo
  (antes se perdía) y cada registro del JSON acepta `sourceAt` opcional.
- **`supabase/functions/mcp-server/index.ts`**: la tool `remember` gana el
  parámetro `complements` y el opcional `sourceAt` (por defecto, el instante de
  la llamada), maneja `redundant`, cuenta `complements` como cubierto en el
  aviso de citas cruzadas y avisa de los compromisos abiertos de los mismos
  recuerdos (consulta SQL determinista, sin modelo) porque este servidor no
  cierra compromisos solo: si el registro nuevo resuelve alguno, hay que
  cerrarlo después con `supersede-record.mjs` desde Claude Code.
- **`skills/segundo-cerebro-capture/SKILL.md`**: documenta `--complements`,
  el caso redundante y `--source-at`.
- **Sin cambios en `deno-deploy/mcp-server/`.** Esa copia ya estaba por
  detrás de la de Supabase en funciones (no soporta `complements` ni los alias
  automáticos) y no se actualiza en esta versión. Si la usas, sigue
  funcionando como antes, sin lo nuevo; para tenerlo, migra a la Edge Function
  de Supabase.
- **Cómo se verificó**: `remember.mjs` y `remember-batch.mjs` se ejecutaron de
  verdad contra una base con el schema aplicado: `source_at` se guarda
  (también por lote, y un valor inválido se ignora con aviso), `redundant` no
  inserta, `--complements` guarda el vínculo y protege al compromiso (sin
  él, el mismo registro lo cierra). El servidor pasa `deno check`. No se
  probó en vivo contra una Edge Function desplegada de este scaffold, ni el
  veredicto `complements` del clasificador dentro del lote.

## v0.9.6 (2026-09-28)

- **El menú lateral del dashboard se cierra solo al elegir una sección.**
  Antes solo se cerraba con un clic fuera de él (o tocando el botón ☰):
  el clic en un botón de navegación caía dentro del panel, así que el
  listener de "clic fuera" lo dejaba abierto a propósito, tapando el
  contenido hasta un segundo clic aparte. Sin migración de esquema.

## v0.9.5 (2026-09-24)

- **Barra lateral del dashboard como panel flotante.** El botón ☰ en el
  header muestra/oculta el menú lateral completo; en vez de empujar el
  contenido (comportamiento anterior), ahora se superpone encima sin
  desplazarlo (`position: absolute` + `transform: translateX`), arranca
  cerrado por defecto, y se cierra solo con un clic fuera de él (o del
  botón ☰). Estado (abierto/cerrado) persistido en `localStorage`. Sin
  migración de esquema.

## v0.9.4 (2026-09-24)

Sin migración de `schema.sql`.

- **`edit-record.mjs` dispara auto-enlace al editar `--memory`.** Bug real:
  editar un registro ya existente para agregarle un recuerdo (por CLI o vía
  el botón "Editar" del dashboard) actualizaba la etiqueta (`record_memories`)
  pero nunca conectaba los nodos en el grafo (`memory_links`) -- el
  auto-enlace entre recuerdos co-etiquetados solo estaba conectado a la ruta
  de *inserción* (`remember.mjs`/`remember-batch.mjs`/la tool `remember` del
  MCP), nadie lo había portado a la ruta de *edición*. Ahora, tras aplicar
  `--memory`, recorre todos los pares del conjunto resultante y crea los que
  falten, mismo criterio de siempre (relación nombrada por el clasificador,
  `co-registrado_en` como respaldo).

## v0.9.3 (2026-09-23)

- **Nuevo `scripts/db/briefing-crossref.mjs`.** El check `morning-briefing`
  de `HEARTBEAT.md` pedía en prosa cruzar cada candidato de mail/calendario
  contra tus propios registros antes de reportar -- fácil de saltarse bajo
  presión, depende de acordarse en el momento. Este script lo convierte en
  mecánico: recibe los candidatos por stdin (`etiqueta | texto de
  búsqueda`, uno por línea), corre la búsqueda híbrida (embedding + rerank)
  contra `records_search` para cada uno, e imprime qué registro vigente ya
  lo cubre o `SIN COINCIDENCIA` si es genuinamente nuevo. `HEARTBEAT.md`
  ahora exige que el texto del briefing se componga desde esa salida, no
  desde memoria de lo que está o no registrado. Sin migración de esquema.

## v0.9.2 (2026-09-23)

**Requiere migración de `schema.sql`** (agrega `records_newer_in_memory`).

- **Verificación de vigencia en `search`.** Un resultado con buen score de
  similitud puede venir de un registro que ya fue superado por otro más
  reciente del mismo recuerdo, que el ranking por similitud simplemente no
  trajo (vocabulario distinto describiendo el mismo hecho -- la búsqueda
  por embeddings no siempre conecta dos registros sobre lo mismo). Ahora,
  por cada recuerdo tocado por los resultados mostrados, `search.mjs` y la
  tool `search` del MCP server chequean si existen registros vigentes de
  ese mismo recuerdo con fecha posterior al más reciente ya mostrado; si
  los hay, se listan aparte bajo "posible desactualización". Chequeo
  determinístico (una consulta SQL acotada por fecha, `records_newer_in_memory`
  en `schema.sql`), sin LLM ni costo adicional cuando no hay brecha.

## v0.9.1 (2026-09-21)

Sin migración de `schema.sql`. Cierra el hueco de recuerdos adicionales que
v0.9.0 había dejado a medias (solo `remember.mjs`/`remember-batch.mjs`, no
los servidores MCP), y trae varios ajustes de grafo que se habían quedado
sin portar de sesiones anteriores.

- **Grafo (vista por registros): aislar cluster de búsqueda.** "Ir" sobre
  una búsqueda de texto libre ahora oculta por completo lo que no coincide
  (antes solo atenuaba), dejando visible solo el cluster de resultados,
  coloreado y dimensionado por relevancia real (layout radial: el registro
  más relevante en el centro, los demás a distancia proporcional a su
  score). "Encuadre" rompe ese aislamiento y vuelve a mostrar el grafo
  completo; el registro más relevante conserva su color pero pasa a un
  glow pulsante en vez de tamaño variable, para seguir distinguiéndose sin
  destacar por tamaño entre 1000+ puntos (respeta `prefers-reduced-motion`).
- **Grafo: clusters visuales para relaciones "complementa".** Un grupo de
  registros que se complementan entre sí ahora queda encerrado en un
  círculo de fondo compacto (2.5x el diámetro del miembro más grande del
  grupo, con un tope duro de cohesión, no solo un objetivo blando de
  fuerza) en vez de mostrarse como líneas sueltas de longitud arbitraria
  sin relación con el tamaño real de los puntos. Los círculos solo
  aparecen en modo aislado (tras "Ir"), nunca en Encuadre; el texto
  "complementa" se quitó de la línea (el círculo ya lo comunica).
- **Recuerdos adicionales en los servidores MCP** (`deno-deploy/mcp-server/`
  y `supabase/functions/mcp-server/`): `classifyAdditionalMemories` y
  `literalMentionCandidates`/`detectNodeMentions` portados desde
  `remember.mjs`, cerrando el hueco de v0.9.0 -- un registro creado vía MCP
  (móvil, otro cliente sin CLI local) ahora también puede quedar
  co-etiquetado a más de un recuerdo.
- **Aviso de fusión de contexto cruzado**, en los cuatro caminos de
  escritura (`remember.mjs`, `remember-batch.mjs`, y ambos servidores
  MCP): si un `claim` nuevo cita literalmente "#NNN" de un registro
  vigente sin `--supersedes`/`--complements`, avisa (no bloquea) para
  revisar si se trajo contenido de ese registro hacia el texto nuevo en
  vez de solo citarlo -- previene que un registro nuevo repita, sin
  dejarlo trazable, información que ya vive en otro registro del mismo
  recuerdo.

## v0.9.0 (2026-09-21)

Sin migración de `schema.sql`. Un registro puede pertenecer genuinamente a
más de un recuerdo a la vez (ej. un hecho que describe tanto a una persona
como a la institución/lugar del que participa) -- hasta ahora `remember.mjs`
solo podía asignar un único recuerdo primario, aunque el segundo ya
apareciera entre los candidatos por similitud de embedding. Salto de
versión menor por ser un cambio de comportamiento visible en la escritura
de registros para cualquier instalación existente, no solo un fix interno.

- **`classifyAdditionalMemories`** (`lib/classify-memory.mjs`): segunda
  pasada del clasificador, tras el pick primario de `classifyNode`, que
  pregunta si el registro pertenece TAMBIÉN a otro de los candidatos que
  `memories_similar()` ya trajo. Mismo umbral de confianza que el pick
  primario para no diluir un recuerdo "paraguas" (ej. "usuario",
  "vida-personal") con falsos positivos; ese tipo de recuerdo se rechaza
  explícito como candidato adicional. Fail-open: cualquier fallo del
  clasificador no bloquea el registro, sigue con lo que ya tenía.
- **Candidatos por mención literal** (`lib/literal-mention-candidates.mjs`,
  nuevo): `memories_similar()` es puramente por similitud de embedding y
  puede no traer un recuerdo que el texto SÍ nombra explícito, si su
  contenido existente es temáticamente lejano. Se suman como candidatos
  adicionales los recuerdos que `detectNodeMentions` encuentra por
  nombre/alias literal en el texto (mismo mecanismo barato, sin embeddings
  ni LLM, que ya usaba Etapa 6 para crear `memory_links`), aunque no hayan
  rankeado por embedding.
- Wiring en `remember.mjs` y `remember-batch.mjs`: ambos caminos de
  escritura (interactivo y por lote) corren la segunda pasada tras resolver
  el recuerdo primario, y suman al registro cualquier recuerdo adicional
  confirmado antes de continuar con la creación de enlaces (Etapa 6).

## v0.8.0 (2026-09-20)

Sin migración de `schema.sql`. Grafo (vista por registros) y `search.mjs`
terminan de convertirse en una sola herramienta de auditoría real de qué
tan bien respondió una búsqueda, no solo un mapa de "qué está conectado" --
salto de versión menor por ser un cambio de comportamiento visible en la UI
para cualquier instalación existente, no solo un fix interno.

- **Resaltado por relevancia en escala de calor**, no binario: cada registro
  resaltado por una búsqueda en la vista por registros ahora se colorea y
  dimensiona según su score real (relevance_score del reranker de Voyage),
  normalizado al min/max del resultado actual -- color sólido (rojo-verde
  por defecto, más tonos de rojo/azul-ámbar seleccionables en Configuración
  para daltonismo rojo-verde), diámetro = 10·√score (con piso de diámetro 1
  para que un score muy bajo siga siendo clickeable). Antes todo lo
  resaltado se veía igual de "rojo", sin distinguir un match fuerte de uno
  débil.
- **Los "datos crudos" de Buscar usan el mismo criterio de color**
  (`renderRawColored`): cada fragmento se colorea según su relevancia real
  en vez de mostrarse todo plano, para auditar de un vistazo qué pesó más
  en la síntesis.
- **El cluster de resultados se ancla al registro más relevante real**, no a
  un centroide promedio del grupo -- ese registro no se atrae a sí mismo, el
  resto orbita hacia su posición.
- **`search.mjs` deja de imprimir "[recuerdo]" (100% de relevancia
  garantizada) para matches del router de recuerdos y complementos
  reinyectados** cuando sí existe un score real que mostrar: el router ya
  calculaba un score de relevancia real internamente (solo se usaba para
  decidir cuáles 15 mostrar, nunca se imprimía) y ahora sale; los
  complementos reinyectados heredan el score de lo que complementan (misma
  información continuada, no un hallazgo independiente). Corrige un caso
  real: preguntas sin match verdadero disparaban el router sobre nodos
  apenas por encima del piso, y sus registros se pintaban todos como
  "100% seguro" en el grafo pese a ser matches débiles.
- **Leyenda de colores del grafo** ahora vive como recuadro flotante en la
  esquina superior derecha del propio lienzo del grafo, en vez de debajo --
  visible sin necesidad de hacer scroll pasado el grafo, sobrevive a cada
  refresco del grafo (envoltorio `#graph-canvas-wrap` separado de
  `#graph-canvas`, que se limpia por completo en cada render).

## v0.7.12 (2026-09-19)

Sin migración de `schema.sql`. Cambio solo en `CLAUDE.md` (guion de la
entrevista de instalación, Fase 6), no en scripts. Motivado por un uso real
distinto al de Oscar: evaluar 2oBrain como backend de memoria para un
agente/personaje (Cora, oscampo/KR) en vez de para una persona -- ninguna
de las 4 ramas fijas del checklist (Trabajo/Personal/Estudio/Comunidad)
aplica a ese caso, y la única vía existente para categorías fuera de esas 4
("Otro") solo permitía una raíz sin hijos.

- **Nueva rama "Personalizado"** en la pregunta `¿Para qué vas a usar
  2oBrain?`: generaliza "Otro" de una sola categoría sin subcategorías a un
  árbol completo definido por quien instala -- pregunta las categorías
  raíz que necesita y, para cada una, si quiere subcategorías fijas ya
  mismo o las deja para crear después. Mismo comando (`create-memory.mjs`)
  y mismo esquema de sufijo `<subcategoría>-<categoría>` que ya usan las
  demás ramas, para evitar colisión de nombres entre categorías (los
  nombres de recuerdo son únicos globales, no por rama).
- Sin implementación para Cora todavía (queda para después del cierre de
  exámenes/calificaciones del semestre) -- este cambio solo deja la
  entrevista lista para ese caso y para cualquier otro uso atípico futuro.

## v0.7.11 (2026-09-19)

Sin migración de `schema.sql`. Portado desde D:\MyBrain (commit `0106cf0`):
dos ajustes chicos al Grafo, motivados por una pregunta real de la persona
que usa esto ("el timeline muestra el registro #984 pero el grafo dice que
hay 919 registros, por qué") -- la respuesta era que el `id` de `records`
es una secuencia que nunca se reutiliza, así que un registro borrado de
verdad (no solo supersedido) deja un hueco permanente.

- **Grafo -> stat "registros borrados"** (ambas vistas): `id más alto que
  existe hoy − total de filas que existen` es exactamente ese número de
  huecos, sin necesitar guardar tumbstones ni tocar `graph.mjs` (se
  calcula en el cliente con los datos que ya trae `/api/graph`).
- **Grafo -> vista por registros -> checkbox "Ocultar registros
  supersedidos/retractados"**: solo visible en esa vista (en la vista por
  recuerdos no hay noción de "supersedido" a nivel de nodo); filtra el
  conjunto que se dibuja/simula, pero los stats de "supersedidos" y
  "registros borrados" siguen contando sobre el universo completo --son
  informativos, no dependen de si están visibles ahora mismo.

## v0.7.10 (2026-09-19)

Sin migración de `schema.sql`. Portado desde D:\MyBrain (commits
6294d2e/acc72b3/0f3ba56/b8e8290): grafo con vista por registros, y un
chequeo nuevo de `doctor.mjs` que corrige el mismo tipo de hueco que
resolvió v0.7.9 pero para registros que ya existían antes de ese fix.

- **`scripts/db/graph.mjs`**: agrega `records`/`recordEdges` a la salida
  (además de `memories`/`edges` de siempre). Cada registro trae su(s)
  recuerdo(s) (`memories`, desde `record_memories`) y sus conexiones reales
  registro-a-registro (`reemplazado_por`/`complementa`, desde
  `superseded_by`/`complements` -- las únicas que existen de verdad en el
  schema, no derivadas de compartir recuerdo).
- **`server/public/index.html` (sección "Grafo")**: toggle "Por
  recuerdos"/"Por registros". La vista por registros muestra cada registro
  como un punto de diámetro fijo etiquetado `#N`, agrupado POR DEFECTO en
  clusters por recuerdo (cada recuerdo distinto recibe un punto de anclaje
  en círculo; un registro con varios recuerdos se ancla al promedio de
  todos los suyos). El buscador cambia de modo en esa vista: "Ir" resalta
  en rojo los registros relacionados (por `#id` exacto o texto libre) y
  la cámara los SIGUE (no salta una vez, sigue en cada tick hasta que la
  simulación se enfría de verdad -- un salto de una sola vez quedaba
  apuntando a donde el nodo YA NO estaba, con cientos de puntos casi
  todos aislados tardando varios segundos en asentarse). Con texto libre,
  además agrupa visualmente (recalienta la simulación) antes de centrar la
  cámara en ese cluster. Clic derecho en un registro: "Ver estado del
  registro" / "Sintetizar respuesta" (ambos llevan a "Buscar"). Checkbox
  "Mostrar nombres de relaciones" ahora desactivado por defecto, y el stat
  "registros" (total) se agregó a la vista por recuerdos.
- **`scripts/db/doctor.mjs`**: nuevo chequeo mecánico
  `records-multi-memory-unlinked` -- registros vigentes con 2+ recuerdos
  donde ningún par tiene `memory_links` entre sí (el mismo hueco que
  resolvió v0.7.9 hacia adelante, pero para los que ya existían antes de
  ese fix). Auto-corregible con el mismo criterio que `remember.mjs` usa al
  escribir (`createLink` + clasificador de relación, fallback genérico
  `co-registrado_en`).

Verificado con `node --check` sobre los tres archivos (sin proyecto
Supabase propio en esta copia de mantenedor para probarlo en vivo, mismo
límite que v0.7.9).

## v0.7.9 (2026-09-19)

Sin cambios en `schema.sql` que requieran migración (solo un comentario
actualizado, ver abajo). Portado desde D:\MyBrain (commits 7e3c684/e04414d):
auto-enlace en `memory_links` cuando un registro queda co-etiquetado a 2+
recuerdos a la vez vía `memory`/`--memory`.

- **`scripts/db/remember.mjs` y `remember-batch.mjs`**: cuando `resolvedNodes`
  tiene 2+ recuerdos, se crea automáticamente el enlace entre cada par que
  todavía no lo tenga (no filtra por confianza del clasificador -- la
  relación ya está confirmada por quien co-etiquetó el registro, el
  clasificador solo le pone nombre, con fallback genérico
  `co-registrado_en`). Distinto del mecanismo de menciones incidentales ya
  existente desde v0.6.x, que sí filtra por confianza porque puede ser ruido.
- **`supabase/functions/mcp-server/index.ts`**: mismo fix, portado a
  TypeScript (`suggestRelationLabel`) -- esta Edge Function nunca tuvo
  ningún mecanismo de auto-enlace hasta ahora, ni siquiera el de menciones.
  Sin acceso a proyecto Supabase propio en esta copia de mantenedor
  (solo `.env.example`), verificado con `deno check` y comparación de
  cuerpo de código contra la versión de D:\MyBrain ya probada en vivo
  (registro de prueba #970, retractado tras confirmar).
- **`schema.sql`**: comentario de `memory_links` actualizado -- ya no dice
  "se crea siempre a mano", refleja los dos mecanismos automáticos que
  existen hoy (menciones incidentales y co-etiquetado explícito).

## v0.7.8 (2026-09-18)

**Incluye migración de schema.** Cierra el drift de `search` acumulado
entre D:\MyBrain y este scaffold desde el 2026-09-14 (nunca se había
portado): tres piezas encadenadas, portadas juntas.

- **`schema.sql`**: nueva columna `memories.embedding vector(1024)` y
  función `memories_match_query`, para matching de recuerdos por
  identidad semántica (nombre + alias embebidos), no solo por alias
  literal exacto. **Correr `apply-schema.mjs` (o aplicar el schema a
  mano) después de actualizar** -- sin esto, `search` fallará al llamar
  a `memories_match_query`.
- **`scripts/db/embed-memories.mjs`** (nuevo): backfill del embedding de
  identidad de cada recuerdo. Ni `create-memory.mjs` ni `remember.mjs`
  lo generan al crear un recuerdo, es el único camino para poblarlo.
  **Correr una vez después de aplicar el schema.** `lib/embed.mjs` gana
  el helper `memoryIdentityText`.
- **`supabase/functions/mcp-server/index.ts`**:
  - `nodeIsMatched` pierde el fallback de "segmento del nombre
    kebab-case" (causaba falsos positivos con palabras genéricas
    sueltas). Lo reemplaza el matching semántico de arriba.
  - `search` ahora también busca en `pages` (proyectos/guías
    narrativas), vía `search_pages` (ya existía en el schema de este
    scaffold, nunca se había conectado en el MCP). Antes, una pregunta
    cuya respuesta vivía en la prosa de una página solo tenía hechos
    sueltos como base.

## v0.7.7 (2026-09-18)

Sin cambios en `schema.sql`. Portado desde D:\MyBrain (registro #891):
extiende al MCP server (Supabase Edge Function) la sugerencia automática
de alias que v0.7.6 solo traía para el CLI (`scripts/db/`).

- **`supabase/functions/mcp-server/index.ts`**: agrega `findAliasCollisions`
  y `suggestAliases`, hasta ahora ausentes en esta implementación TS
  separada (no importa `remember.mjs`). Al crear un recuerdo con
  `createMemory: true`, propone variantes plausibles de alias y las
  muestra en el texto de respuesta.
- **Fix propio**: `createMemory` en el MCP nunca soportó `aliases`
  explícitos (solo `upsert({name})`, sin alias posible), a diferencia del
  CLI (`remember.mjs --aliases`). Ahora acepta `aliases` +
  `noSuggestAliases`, con la misma validación de "exactamente un recuerdo
  nuevo" que el CLI.

## v0.7.6 (2026-09-17)

Sin cambios en `schema.sql`. Portado desde D:\MyBrain (registro #887):
sugerencia automática de alias al crear un recuerdo.

- **Nuevo `lib/suggest-aliases.mjs`**: al crear un recuerdo (`create-
  memory.mjs`, o `remember.mjs --create-memory`), propone variantes
  plausibles de alias a partir del name/alias dados (nombre completo,
  sigla, con/sin tilde, título, forma abreviada), genérico para
  cualquier tipo de entidad, no solo personas. Fail-open (nunca bloquea
  la creación), descarta propuestas que colisionan con otro recuerdo,
  imprime lo agregado para que sea auditable. Desactivable con
  `--no-suggest-aliases`.
- **Motivación**: `remember.mjs` y `list-memory-mentions.mjs` hacen
  matching literal de substring contra la lista de alias de cada
  recuerdo, no fuzzy. Un recuerdo de persona creado con solo su apodo
  quedaba ciego a cualquier registro que la mencionara por su nombre
  real, aunque ese registro ya existiera en la base.

## v0.7.5 (2026-09-15)

Sin cambios en `schema.sql`. Portado desde D:\MyBrain (misma sesión que
v0.7.4): completa la elección de proveedor en el último punto que
faltaba, la síntesis de "Buscar".

- **OpenRouter como proveedor de síntesis en "Buscar"**: Configuración →
  "Síntesis por defecto en Buscar" ahora ofrece OpenRouter junto a Ollama
  Cloud y Gemini (`lib/synthesize.mjs`, `/api/available-providers`,
  reutiliza `config/openrouter-models.json`).
- **Fix: `callOpenRouter()` forzaba siempre `response_format:json_object`**,
  correcto para los clasificadores pero no para síntesis en prosa libre
  -- el modelo truncaba la respuesta a un objeto JSON vacío en vez de
  contestar la pregunta. Se agrega `opts.json` (default `true`, `false`
  en `synthesize.mjs`) para permitir prosa cuando el llamador la
  necesita. Hallazgo en vivo, probado end-to-end en el dashboard.

## v0.7.4 (2026-09-15)

Sin cambios en `schema.sql`. Portado desde D:\MyBrain (misma sesión que
v0.7.3): completa la elección de proveedor extendiéndola también a la
extracción de registros.

- **OpenRouter como proveedor para extracción**: `extract-records.mjs` y
  `extract-page-records.mjs` aceptan `--provider openrouter`, con su
  propia lista de respaldo (`config/openrouter-models.json`, editable
  desde el dashboard en la sección "Modelos", junto a Gemini y Ollama
  Cloud). Por defecto solo lista modelos gratuitos
  (`nvidia/nemotron-3-*:free`).
- **Fix: OpenRouter puede devolver un error del proveedor upstream (ej.
  502 "Service temporarily overloaded") dentro de un body HTTP 200**, no
  como error HTTP real. El fallback automático a otro modelo de la lista
  no disparaba porque solo se chequeaba `res.ok`. Ahora se detecta
  `body?.error` explícitamente y se trata `429`/`502`/`503` como
  reintentable (mismo fix aplicado en `lib/openrouter.mjs`, usado por los
  clasificadores).

## v0.7.3 (2026-09-15)

Sin cambios en `schema.sql`. Portado desde D:\MyBrain (misma sesión que
v0.7.1/v0.7.2): darle al usuario posibilidad real de elegir proveedor,
más allá de Ollama/Gemini.

- **OpenRouter como proveedor alternativo de reranking**:
  `RERANK_PROVIDER` en `.env` (`voyage` por defecto, o `openrouter`,
  modelo `nvidia/llama-nemotron-rerank-vl-1b-v2:free`, gratis). Motivo:
  Voyage da 200M tokens gratis para rerank, pero se agotan con el tiempo,
  y además exige tarjeta en la cuenta para un límite de tasa cómodo -- no
  todos los usuarios de 2oBrain van a querer poner tarjeta en ningún lado.
- **OpenRouter elegible para `classifiers`/`deepSweep`**: los 7
  clasificadores baratos del sistema (duplicados, memoria, alias,
  resolución de compromisos, relaciones de mención y de barrido profundo)
  ganan OpenRouter como proveedor alternativo a Ollama Cloud, elegible
  desde el dashboard ("Modelos por tarea") o a mano en
  `config/task-models.json` con el prefijo `openrouter::` (sin prefijo
  sigue siendo Ollama, ningún config existente necesita migrarse). Los dos
  clasificadores que ya soportaban Gemini como segunda opinión
  (relaciones de mención y de barrido profundo) mantienen su orden de
  escalación empírico intacto, OpenRouter se agrega como tercera opción
  explícita, no reemplaza nada.

## v0.7.2 (2026-09-15)

Sin cambios en `schema.sql`. Corrige un hueco real de usabilidad para
usuarios sin conocimientos de programación (caso real: prueba de
instalación con un usuario no técnico).

- **Fix: el procedimiento de actualización podía exponer un comando
  técnico al usuario final.** El punto 3 de "Mantenimiento: revisar e
  instalar actualizaciones" (`CLAUDE.md`) decía que había que parar y
  pedir confirmación antes de aplicar un cambio de `schema.sql`, pero no
  decía explícitamente que la IA corre el comando por su cuenta una vez
  el usuario confirma. Un usuario sin experiencia técnica no sabe qué
  hacer con `node scripts/db/apply-schema.mjs`. Ahora el punto 3 deja
  explícito: la confirmación es una pregunta en español corriente, sin
  jerga, y la ejecución del comando es un detalle interno de la IA que
  asiste al usuario, nunca algo que el usuario deba ver, entender o
  escribir él mismo.

## v0.7.1 (2026-09-15)

**Cambia `schema.sql`** -- corre `node scripts/db/apply-schema.mjs`
después de actualizar. Portado desde D:\MyBrain (misma sesión).

- **Nuevo: complemento estructural (`records.complements`)**: el
  clasificador de duplicados de `remember.mjs` ganaba un caso real de
  pérdida silenciosa de información -- marcaba "supersedes" con
  confianza alta cuando el registro nuevo en realidad solo agregaba un
  dato sobre el mismo asunto de uno viejo, sin repetir todo lo que ese
  viejo ya decía (el viejo quedaba retractado y su información única se
  perdía, detectado y corregido a mano 3 veces en la sesión que motivó
  este cambio). Ahora el clasificador tiene un tercer veredicto,
  "complements": el registro nuevo queda como fila propia, ligado al
  que complementa vía la nueva columna `records.complements`, sin
  reemplazarlo ni mutar su texto (evita reproducir, registro por
  registro, la misma dilución semántica que un recuerdo con temas
  mezclados). `records_search`/`memory_match_records` anexan siempre el
  complemento de cualquier registro que entre al resultado, sin importar
  su propio ranking de similitud; `search.mjs` agrega un respaldo en JS
  por si el rerank por relevancia a la pregunta lo deja fuera del corte
  pese a que el SQL ya lo trajo al pool. `remember.mjs` gana
  `--complements <id>` explícito, además de la auto-resolución.

## v0.7.0 (2026-09-14)

Sin cambios en `schema.sql`. Portado desde D:\UAObrain (misma sesión de
comparación 2nd-brain vs. LightRAG) más un fix propio de este repo.

- **Multi-salto sobre `memory_links`**: la tool `search` de MyMCP detecta
  cuando la pregunta nombra 2-4 recuerdos a la vez y agrega el camino que
  los conecta en el grafo (BFS no dirigido, hasta 4 saltos), sin necesitar
  una tool `traverse` separada -- riesgo de que un LLM llamador externo
  nunca la eligiera para una pregunta relacional. `scripts/db/traverse.mjs`
  nuevo para uso directo desde shell.
- **Extracción automática en segundo plano**: el hook `Stop` ahora lanza
  `extract-records.mjs` desacoplado (spawn detached + unref) sobre la
  ventana de turnos desde la última extracción, sin bloquear el cierre de
  turno. Los candidatos se muestran para que `remember.mjs` decida, nunca
  se insertan solos.
- **Botón "Reiniciar servidor" en el dashboard**: soluciona el caso real de
  un proceso del dashboard quedado obsoleto/colgado tras editar código,
  directo desde la UI, sin depender de la terminal.
- **Fix: caché de embeddings de `load-pages.mjs` invalidada por line
  endings**: el hash de contenido no normalizaba CRLF/LF antes de
  hashear, causando re-embeddings innecesarios contra Voyage AI cuando el
  único cambio real era el line-ending.
- **Fix: el router de recuerdos de MyMCP fallaba en silencio**:
  `memory_match_records` se llamaba con el parámetro nombrado
  `node_names`, pero la función SQL lo define como `memory_names` -- typo
  presente desde el scaffold original. De paso, sus registros ahora se
  reordenan por relevancia real a la pregunta (mismo reranker que
  `records_search`) en vez de solo por fecha, evitando que un recuerdo que
  agrupa temas sin relación entre sí llene el cupo mostrado con ruido.

## v0.6.5 (2026-09-13)

Ajuste visual del dashboard, sin cambios en `schema.sql`.

- **Aprovecha todo el ancho de la ventana**: se quita el `max-width: 900px`
  de `main`, ensancha `.sidebar`/`.header-brand` de 190px a 200px, y suma
  `max-width` generosos (1200-1400px) a tarjetas, tablas y bloques de
  salida en vez de un tope fijo angosto.
- **Grafo de verdad responsivo**: medía el ancho/alto del contenedor real
  en vez de un `1100x700` fijo, y se re-renderiza solo al cambiar el
  tamaño de la ventana (debounce de 250ms). El gráfico d3 de Timeline
  también mide su contenedor real para el eje de tiempo.
- Ajustes menores de padding/tamaño en varios componentes (botones,
  tarjetas, tooltips, paginación de Timeline) para que se sientan
  proporcionados al nuevo ancho.

## v0.6.4 (2026-09-12)

Ajuste visual del dashboard, sin cambios de comportamiento ni en `schema.sql`.

- **Cabecera fija de dos columnas**: el logo vivía dentro de `.sidebar`,
  arriba del menú, así que un menú largo lo empujaba fuera de vista al
  hacer scroll (`.layout` usaba `min-height`, no `height`, nada tenía
  scroll propio). Ahora el logo y el título/badge quedan en una franja
  superior fija, alineada en las mismas dos columnas que el cuerpo (logo
  sobre el ancho del sidebar, título+badge sobre el ancho del contenido).
  `.sidebar` (solo el menú) y el contenido tienen cada uno su propio
  scroll, independientes entre sí y de la cabecera.
- **Logo y título más grandes**: se veían pequeños en la cabecera nueva
  (logo 38px→76px, título 16px→32px, subtítulo 11.5px→20px).
- **Badge recortado a "solo local"**: la IP (`127.0.0.1`) era ruido, la
  restricción real ya la dice el texto sin ella.

## v0.6.3 (2026-09-11)

`doctor.mjs` pasa de diagnóstico puro a diagnóstico + tratamiento. Sin
cambios en `schema.sql`.

- **`doctor.mjs --fix`**: aplica sin preguntar los chequeos donde el
  estado correcto es determinista y no hay una segunda respuesta válida
  (RLS apagado, `superseded_by` sin `valid_until`, `memory_links`/
  `memory_pair_checks` huérfanos por una fusión de recuerdos). Lo que sí
  requiere decidir algo (qué fecha es la correcta, a qué recuerdo
  pertenece un registro, quién se queda con un alias en disputa) se queda
  como diagnóstico, con el comando manual impreso.
- **`doctor.mjs --json`**: salida estructurada (`{ ok, fixed, warnings,
  checks: [...] }`), pensada para que el dashboard renderice tarjetas en
  vez de texto plano.
- **Dashboard, sección Doctor rehecha**: botón "Corregir" que aplica lo
  mecánico de una sola llamada, y una tarjeta por caso individual para lo
  que requiere tu decisión (fecha correcta, recuerdo a asignar, alias en
  disputa), cada una con su control, motivo y botón de aplicar.
- **Retirados los 3 chequeos de páginas del vault** ("Páginas con
  embedding", "Embeddings al día", "Contenido duplicado entre páginas"):
  `pages`/`load-pages.mjs` es una particularidad de la instalación
  personal de quien construyó 2oBrain (indexa carpetas de su propio vault
  vía un hook de git), 2oBrain no distribuye esa carpeta ni ese flujo a
  ningún usuario, así que esos chequeos eran ruido permanente, nunca un
  caso real que alguien fuera a atender.

## v0.6.2 (2026-09-10)

Corrige un bug real de instalación. Sin cambios en `schema.sql`.

- **"Buscar" ya no fuerza Ollama si el usuario no lo configuró**: quien
  elige solo Gemini durante la instalación se topaba con "falta
  OLLAMA_API_KEY" la primera vez que usaba "Buscar", sin saber que había
  un selector de proveedor escondido en Configuración. Nuevo endpoint
  `/api/available-providers` (nunca expone las keys en sí, solo si
  existen) usado una sola vez al cargar el dashboard para corregir el
  default guardado, solo si el usuario nunca hizo una elección explícita.
  Mensaje de error de síntesis también mejorado, apunta directo a la
  sección de Configuración.
- Paridad menor: agregada la regla `select { accent-color }` que había
  quedado solo en la copia interna (inofensiva, ayuda en navegadores que
  la respeten para el desplegable nativo).

## v0.6.1 (2026-09-10)

Corrige un bug real de usabilidad. Sin cambios en `schema.sql`.

- **Zona horaria configurable (`TIMEZONE`), en vez de `America/Bogota`
  fija**: `remember.mjs`, `remember-batch.mjs` y los dos servidores MCP
  (Supabase Edge Function, Deno Deploy) calculaban "hoy" siempre en
  `America/Bogota` para validar `--date`/`confirmDate`, lo que bloqueaba
  cualquier registro con la fecha real de hoy para alguien en otra zona
  horaria. Ahora leen `TIMEZONE` (nombre IANA, ej. `Europe/Madrid`) de
  `.env` en los scripts, o de la variable de entorno del servidor
  desplegado en los MCP, con `America/Bogota` como default si no está
  puesta, para no romper instalaciones existentes. Documentado en
  `.env.example`.

## v0.6.0 (2026-09-10)

Corrige un vacío real de instalación y documenta un patrón de acceso
nuevo. Sin cambios en `schema.sql`; sí toca la Fase 8 de `CLAUDE.md`.

- **Fase 8 nunca documentaba cómo configurar el secreto `MCP_ACCESS_KEY`**
  del servidor MCP desplegado: el código lo exige
  (`Deno.env.get('MCP_ACCESS_KEY')!`), pero ni Supabase ni Deno Deploy lo
  reciben automáticamente al desplegar, así que cualquier instalación
  quedaba con un servidor desplegado y verificado por `deploy_edge_function`
  pero roto en la primera llamada real. Agregados los pasos concretos:
  generar la clave, escribirla en `.env`, y configurarla como secreto en
  el destino elegido (`supabase secrets set` para Supabase; Project
  Settings → Environment Variables de dash.deno.com para Deno Deploy, no
  automatizable).
- **Acceso "universal" vía CLI para LLMs sin cliente MCP nativo**
  (probado con Ollama CLI): nueva sección en Fase 8 que genera
  `2oBrain.bat`/`2oBrain.sh`, un puente stdio↔SSE vía `supergateway` hacia
  el endpoint ya desplegado, sin tocar código de ningún lado. Documentado
  también en README.md/README_SP.md.

## v0.5.6 (2026-09-09)

Corrige una regresión, sin cambios en `schema.sql` ni en `mcp-server` --
no requiere redespliegue.

- **Restaura la sección "Acerca de"**: se había perdido por completo (HTML
  y los endpoints `/api/version`, `/api/check-for-updates`,
  `/api/feedback-config`) en el commit `326ede0` (2026-09-07,
  "actualización UI timeline"), al reemplazar el archivo por una versión
  sincronizada con MyBrain sin revisar qué se perdía en el camino.
  Restaurada palabra por palabra desde el último commit donde existía
  (`3d0a1c2`): versión instalada, botón "Buscar actualizaciones", y envío
  de comentarios por correo a una dirección de contacto configurable.
  Esta sección es específica de 2oBrain (depende de `VERSION` y
  `check-for-updates.mjs`, que MyBrain no tiene ni necesita), así que no
  se replica hacia allá.

## v0.5.5 (2026-09-09)

Cambio visual, sin cambios en `schema.sql` ni en `mcp-server` -- no
requiere redespliegue.

- **Checkboxes/radios y menú contextual usan el color de acento**: los
  checkboxes y radios se pintaban con el azul nativo del navegador,
  distinto del color de acento del tema (`--accent`), y el hover del menú
  contextual del grafo usaba un gris neutro en vez de un tinte de acento
  como el resto de estados interactivos del dashboard. Ambos corregidos
  para mantener un solo lenguaje visual en toda la página.

## v0.5.4 (2026-09-09)

Cambio de texto en el dashboard, sin cambios en código funcional ni en
`schema.sql`/`mcp-server` -- no requiere redespliegue.

- **Textos de sección sin jerga interna**: las descripciones bajo cada
  encabezado del dashboard (Doctor, Grafo, Fusionar recuerdos, Crear
  categoría/subcategoría, Alias, Relaciones, Candidatos de categoría,
  Extraer de sesión, Extraer de página) mencionaban nombres internos de
  la base de datos y del código (RLS, memory_links, pertenece_a, slug,
  kebab-case, la tabla "pages") sin sentido para alguien que instala su
  propia copia de 2oBrain sin haber visto el desarrollo del proyecto.
  Reescritos en lenguaje llano.

## v0.5.3 (2026-09-08)

Corrige un bug real, sin cambios en `schema.sql` ni en `mcp-server` -- no
requiere redespliegue.

- **Timeout de Ollama en extracción, de 60s a 120s**: `nemotron-3-ultra`
  (550B, el más pesado de los modelos que se pueden elegir en
  `config/task-models.json`) abortaba con "This operation was aborted" al
  extraer una página de apenas ~6200 caracteres. 120s deja margen sin
  penalizar artificialmente al modelo más grande de los seis disponibles.

## v0.5.2 (2026-09-08)

Corrige un bug real, sin cambios en `schema.sql` ni en `mcp-server` -- no
requiere redespliegue.

- **Grafo roto tras fusionar un recuerdo con aristas propias**:
  `merge-memories.mjs` nunca redirigía `memory_links` al fusionar (solo
  `record_memories` y alias), así que una arista que apuntaba al recuerdo
  fusionado quedaba huérfana: el nodo desaparece de `/api/graph` por tener
  `merged_into`, pero `memory_links` la seguía referenciando, y d3-force
  tronaba con "node not found" al armar el grafo interactivo (arrastrar
  cualquier recuerdo después también fallaba). Ahora `merge-memories.mjs`
  redirige `memory_links` igual que ya hacía con `record_memories`, y
  `graph.mjs` resuelve en lectura cualquier arista que aún apunte a un
  recuerdo fusionado, así que un grafo ya roto por un merge anterior se
  autosana solo con actualizar, sin migración de reparación.

## v0.5.1 (2026-09-08)

Cambio de comportamiento (`CLAUDE.md`), sin cambios en código. Sin
cambios en `schema.sql` ni en `mcp-server` -- no requiere redespliegue.

- **Commits locales automáticos, sin pedir permiso**: nueva sección
  "Comitear localmente (sin preguntar, sin push)". Hallazgo real de una
  instalación de prueba: la usuaria, que no es usuaria de git, no
  entendía para qué serviría comitear si su copia está desconectada del
  repo público (`origin` se quita a propósito al clonar). Sin commits
  locales, el mecanismo de actualización (`git diff HEAD FETCH_HEAD`, ver
  sección de Mantenimiento) queda contaminado con cambios locales sin
  comitear, y el usuario no tiene ningún punto de rollback. Mismo
  protocolo de seguridad de siempre: nunca push (no hay `origin`), nunca
  `git add -A` a ciegas, nunca comitear `.env`/`settings.local.json` ni
  datos personales sin revisar el diff primero.

## v0.5.0 (2026-09-08)

Sin cambios en `schema.sql` ni en `mcp-server` -- no requiere redespliegue.

- **Selección explícita de modelo Ollama por grupo de tarea**: nuevo
  `config/task-models.json` + `lib/task-models.mjs`, y nueva sección
  "Modelos por tarea" en el dashboard (Opciones avanzadas), con un
  selector por grupo (classifiers/extraction/synthesis/deepSweep). A
  diferencia de "Modelos" (lista de respaldo con fallback automático en
  503), esto fija UN modelo por grupo, sin reintento: pensado para
  comparar calidad entre modelos de Ollama Cloud (gpt-oss:20b/120b,
  gemma4:31b, familia nemotron-3) en la práctica, no para resiliencia.
  El mecanismo de respaldo de Gemini queda intacto.

## v0.4.14 (2026-09-08)

Cambio visual, solo repo local. Sin cambios en `schema.sql` ni en
`mcp-server` -- no requiere redespliegue.

- **Favicon con fondo negro fijo**: el ícono es solo trazo, sin relleno,
  y sobre transparente se veía débil en la pestaña según el tema del
  navegador. Se agrega un `rect` negro de fondo, siempre, sin depender de
  `prefers-color-scheme`.

## v0.4.13 (2026-09-08)

Cambio visual, solo repo local. Sin cambios en `schema.sql` ni en
`mcp-server` -- no requiere redespliegue.

- **Favicon del dashboard**: reemplaza el globo genérico del navegador
  por el ícono de 2oBrain en la pestaña, inline como SVG data URI (mismo
  `assets/2obrain-icon.svg`), sin pedir un archivo aparte al servidor.

## v0.4.12 (2026-09-08)

Cambio visual, solo repo local. Sin cambios en `schema.sql` ni en
`mcp-server` -- no requiere redespliegue.

- **Logo de 2oBrain**: nuevo `assets/2obrain-logo.svg` (ícono + wordmark)
  en el encabezado de `README.md`/`README_SP.md`, y `assets/2obrain-icon.svg`
  (solo el ícono, recortado del mismo vector) apilado en la barra lateral
  del dashboard -- ícono al 50% del ancho de la barra, "2oBrain" y
  "dashboard" como texto debajo, separado del nav por una línea. El
  header superior queda solo con el badge "solo local".

## v0.4.11 (2026-09-08)

Nueva funcionalidad, solo repo local. Sin cambios en `schema.sql` ni en
`mcp-server` -- no requiere redespliegue.

- **Cierre automático de compromisos resueltos**: cada `remember.mjs`
  ahora revisa por su cuenta los compromisos abiertos (`kind='commitment'`)
  del recuerdo del registro nuevo (sin depender de similitud de embedding
  como filtro, ver `lib/classify-commitment-resolution.mjs`, nuevo) y
  decide si el registro nuevo los resuelve total, parcial, o nada. Total:
  el compromiso queda `superseded_by` el registro nuevo, mismo `kind`,
  misma trazabilidad que cualquier otro supersede. Parcial: mismo cierre +
  aviso explícito para crear el compromiso que sigue pendiente (nunca se
  redacta solo). Verificado en vivo con casos de prueba desechables.
- **Nueva herramienta `supersede-record.mjs`**: vincula dos registros que
  YA EXISTEN en una relación de reemplazo -- ni `remember.mjs
  --supersedes` (solo al insertar) ni `forget.mjs` (retracta sin apuntar a
  un reemplazo) cubrían este caso. Es la pieza que necesita el respaldo
  diario de `commitments-check` para poder actuar sobre lo que detecte, no
  solo reportarlo.
- **`segundo-cerebro-capture` (ambas copias)**: actualizado para reflejar
  que el cierre de compromisos ya es automático dentro de `remember.mjs`;
  el chequeo manual (`list-commitments.mjs --memory` + `supersede-record.mjs`)
  queda documentado solo para `remember-batch.mjs` y otras vías que no
  pasan por `remember.mjs`.

## v0.4.10 (2026-09-08)

Cierra los 3 huecos reales de la Fase 2 (Base de datos) que quedaron
pendientes tras la prueba de instalación de una usuaria: solo repo local
(guión de instalación), sin cambios en `schema.sql` ni en `mcp-server`.

- **Nuevo tercer camino en Fase 2**: "sin MCP de Supabase pero con
  navegador controlable" -- antes solo existían "con MCP" (automático) y
  "sin MCP" (guía manual completa al usuario). Ahora, si hay navegador
  controlable, Claude inicia sesión con la cuenta que el usuario acaba de
  crear, navega la creación del proyecto, genera él mismo la contraseña de
  la base de datos, y extrae URL/llaves/connection string directo del
  dashboard -- el usuario solo inicia sesión, no copia ni pega nada.
- **Modo "Session pooler" del connection string, ahora explícito en los
  tres caminos**: confirmado necesario (falló el modo por defecto en dos
  instalaciones distintas), antes `CLAUDE.md` no lo mencionaba en absoluto
  y `test-connection.mjs` fallaba sin pista de la causa real.
- **Verificación explícita de `get_publishable_keys`** en el camino "con
  MCP": nunca se confirmó en vivo si esa herramienta entrega
  `SUPABASE_SERVICE_ROLE_KEY` completa o vacía (el nombre "publishable"
  sugiere que podría distinguir la llave pública de la secreta a
  propósito). Sin confirmación posible por ahora, se agregó un chequeo
  fail-safe: si la llave queda vacía o con pinta de placeholder, cae a la
  vía del navegador (si hay) o se le pide al usuario directo, en vez de
  seguir asumiendo que quedó bien.

## v0.4.9 (2026-09-08)

Nueva funcionalidad, solo repo local. Sin cambios en `schema.sql` ni en
`mcp-server` -- no requiere redespliegue.

- **`list-commitments.mjs` gana `--memory <nombre>`**: acota los
  compromisos abiertos a un solo recuerdo. Nace de un caso real: un
  compromiso con dos partes quedó vigente sin cerrarse aunque una de las
  partes ya se había resuelto días antes, porque nadie cruzó el registro
  nuevo contra el compromiso viejo del mismo recuerdo.
- **`segundo-cerebro-capture` (ambas copias)**: nueva sección "Cerrar
  compromisos que este registro resuelve" -- al guardar un registro ligado
  a un recuerdo, correr `list-commitments.mjs --memory` y actuar si
  resuelve algo abierto (completo: `edit-record.mjs --kind fact`; parcial:
  mismo cambio a `fact` sin tocar el `claim` original + un `remember.mjs
  --kind commitment` nuevo acotado a lo que falta).
- **`HEARTBEAT.md`**: `commitments-check` gana un pase de respaldo,
  cruzar cada compromiso abierto contra registros más recientes del mismo
  recuerdo, para lo que se le escape al chequeo de captura.

## v0.4.8 (2026-09-08)

Nueva funcionalidad, solo repo local. Sin cambios en `schema.sql` ni en
`mcp-server` -- no requiere redespliegue.

- **Nueva sección de dashboard "Crear categoría/subcategoría"** (Opciones
  avanzadas): expone directamente `create-memory.mjs` (ya existía, usado
  antes solo desde "Candidatos de categoría"). "Categoría padre" opcional
  -- vacío crea una categoría de nivel superior, con valor crea una
  subcategoría ligada vía `pertenece_a` en el mismo paso.
- **Nueva herramienta "Editar registro"** (Opciones avanzadas): corrige
  claim/date/kind/source/memory de un registro existente en un solo paso,
  sin retractar y reinsertar. `edit-record.mjs` (nuevo) recalcula el
  embedding si cambia el claim, y reemplaza la lista completa de recuerdos
  ligados si cambia memory. `get-records.mjs` gana `--json` (necesario
  para que el dashboard precargue los valores actuales antes de editar).
  La sección solo envía al backend lo que realmente cambió respecto a lo
  cargado.
- **`HEARTBEAT.md`**: la instrucción de ejecutar la lista de chequeos al
  arrancar sesión estaba enterrada bajo un párrafo sobre el ritual de
  habilitación (algo que ya pasó, no una instrucción activa) -- separada
  en su propia sección "Enabling a new check", con la instrucción de
  ejecución ahora en negrita y sola. De paso, "job" (vocabulario sin
  sentido en esta arquitectura de registros/recuerdos) renombrado a
  "check" en `HEARTBEAT.md`, `CLAUDE.md` y `MEMORY.md`.

## v0.4.7 (2026-09-07)

Corrección de bug, solo repo local. Sin cambios en `schema.sql` ni en
`mcp-server` -- no requiere redespliegue.

- **`gemini-page-extractor-system-prompt.md` pedía a Gemini una clave JSON
  llamada `node`**, desfasada con el rediseño de vocabulario nodes->memories
  (este repo ya había renombrado `remember-batch.mjs` y la skill
  `extract-code-records` a `memory`/`createMemory`, pero el prompt de este
  extractor específico se quedó atrás). Renombrada a `memory` en el schema
  de salida y en la prosa del prompt. `extract-page-records.mjs` (único
  consumidor directo, en sus 2 rutas de lectura del JSON crudo de Gemini,
  `--json` y `--review`) actualizado a leer `f.memory` en vez de `f.node`.
  Sin este fix, el campo llegaba siempre vacío y cada candidato caía en el
  recuerdo por defecto aunque el contenido de la página indicara claramente
  otro. `preference` como valor de `kind` ya no aparecía en ningún prompt
  ni script de este repo -- ese descarte ya estaba hecho aquí.

## v0.4.6 (2026-09-07)

Sin cambios en `schema.sql` ni en `mcp-server` -- no requiere redespliegue.
Incluye dos commits directos sobre `main` (`326ede0`, `10bbce8`) que
quedaron sin su propia entrada aquí cuando se hicieron -- documentados
retroactivamente en esta versión.

- **Timeline con vista visual** (antes: lista plana de texto sin más).
  Ahora tiene estadísticas (registros/vigentes/reemplazados), una franja
  de densidad por mes, agrupación colapsable Año -> Mes (con paginación
  por bloques, no pinta cientos de registros de un tirón), hilos de
  versión (con "Incluir reemplazados", una cadena de reemplazos se ve
  como una sola entrada vigente con "Ver evolución" desplegable en vez de
  N entradas sueltas), un filtro/resaltado en cliente sobre lo ya
  cargado (texto libre o `kind:evento`/`kind:commitment`/`kind:fact`), una
  vista "Gráfico" con d3 (carriles por tipo, zoom con rueda/arrastre,
  tooltip envuelto a 80 caracteres), y una vista "Heatmap" estilo GitHub
  (clic en un día lleva a la lista filtrada a ese día).
- **"Extraer de página" no tenía forma de avanzar cuando un candidato
  traía una fecha real (extraída del texto) distinta de hoy**:
  `remember-batch.mjs` rechaza (exit 1) cualquier fecha así sin
  `--confirm-date`, pero esta sección nunca construía ese flag ni ofrecía
  la casilla para marcarlo -- a diferencia de "Guardar registro" y
  "Guardar lote", que sí la tienen. El botón "Insertar aprobados" quedaba
  sin ninguna forma de reintentar, solo el `[EXIT:1]` crudo del script.
  Corregido: misma casilla y mismo patrón que las otras dos secciones,
  aparece solo cuando algún candidato incluido tiene fecha distinta de
  hoy, y un aviso claro en cliente si se intenta insertar sin marcarla.

## v0.4.5 (2026-09-07)

Corrección de bug, solo repo local. Sin cambios en `schema.sql` ni en
`mcp-server` -- no requiere redespliegue.

- **"Buscar candidatos" en "Candidatos de categoría" del dashboard fallaba
  siempre con `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`**:
  `list-category-candidates.mjs` llamaba `process.exit(0)` justo después
  de que `suggestCategoryName()` usara `fetch()` para pedirle a Ollama
  Cloud el nombre sugerido de la categoría. En Windows, un exit forzado
  mientras libuv todavía está cerrando el handle async del fetch revienta
  con ese assert: el proceso sale con status distinto de cero aunque ya
  había escrito el JSON/texto correcto a stdout, y el dashboard (que solo
  mira el exit code) lo reportaba como error aunque la búsqueda sí había
  funcionado. Mismo patrón ya visto y corregido antes en `create-node.mjs`.
  Corregido: ninguna rama del script llama `process.exit()` ya, deja que
  termine solo tras `client.end()`.

## v0.4.4 (2026-09-06)

Corrección de proceso sobre v0.4.3, mismo día. Sin cambios en `schema.sql`
ni en `mcp-server`.

- **La sección "Mantenimiento: revisar e instalar actualizaciones" no
  decía qué hacer cuando una actualización toca
  `supabase/functions/mcp-server/` o `deno-deploy/mcp-server/`**: ese
  código corre desplegado, aparte del repo local, así que actualizar el
  archivo no aplica el fix en vivo. Hallazgo real: v0.4.3 corregía
  justo ese código (bug de `node`/`memory` en MyMCP) y, sin este aviso,
  una actualización habría quedado "aplicada" en el repo pero seguía
  rota en producción. Agregado un paso 5 explícito: redesplegar con la
  misma ruta de la Fase 8, y confirmarlo en el resumen final en vez de
  darlo por hecho solo con actualizar el archivo.

## v0.4.3 (2026-09-06)

Corrección crítica sobre v0.4.2, mismo día, encontrada en vivo durante otra
instalación real de prueba usando MyMCP desde una sesión de ChatGPT. Sin
cambios en `schema.sql`. **Requiere redesplegar el servidor MCP** (ver
"Mantenimiento" en `CLAUDE.md`), a diferencia de las anteriores, esta sí
toca código que ya corre desplegado, no solo el repo local.

- **El tool `remember` de MyMCP nunca aceptaba `node`/`createNode`, ni
  `memory`/`createMemory`, para vincular un registro a un recuerdo**: el
  schema expuesto al cliente (Supabase Edge Function y Deno Deploy)
  declaraba el parámetro como `node`/`createNode`, pero el handler ya
  leía `args.memory`/`args.createMemory` desde el rename de vocabulario
  (nunca se completó ahí). Cualquier llamada real -- pasara lo que
  pasara el cliente -- caía siempre en "No se pasó node", sin insertar
  nada. Corregido: schema, tipos y textos de error ahora usan
  `memory`/`createMemory` de forma consistente, igual que
  `remember-batch.mjs`.
- Mismo bug en `extract-page-records.mjs --review` (modo CLI, no el
  dashboard): armaba el batch hacia `remember-batch.mjs` con
  `node`/`createNode` en vez de `memory`/`createMemory`. El modo
  `--json`/dashboard no tenía este problema, `index.html` ya traducía el
  campo antes de enviarlo.
- Quitado `preference` (kind ya retirado, el CHECK de la base ya no lo
  admite) de los tres prompts de extracción con Gemini y de
  `extract-records.mjs`, donde seguía ofrecido como valor válido.

## v0.4.2 (2026-09-06)

Correcciones urgentes surgidas en vivo durante una instalación real de
prueba. Sin cambios en `schema.sql`.

- **Skills nunca eran invocables**: `.claude/skills/` no existía en el
  repo -- Claude Code solo descubre skills ahí, nunca bajo `skills/` en
  la raíz, así que ni `/extract-code-records` ni la captura de
  `segundo-cerebro-capture` funcionaron nunca como comando real en
  ninguna instalación de 2oBrain hasta ahora. Corregido: carpeta
  `skills/extract-code-facts` renombrada a `extract-code-records` (no
  coincidía con su propio frontmatter), `.claude/skills/` creado con
  copia de ambas skills, `CLAUDE.md` instruye replicarlo en cada
  instalación futura -- y avisarle al usuario que además debe cargarlas
  desde su propia pantalla de "Configuración", copiar el archivo no
  basta.
- **`remember-batch.mjs`/`extract-code-records` seguían usando
  `node`/`createNode`** en el JSON de entrada, residuo del rename de
  vocabulario que nunca tocó este contrato externo. Renombrado a
  `memory`/`createMemory` en el script, ambas copias del `SKILL.md`, y
  la sección "Extraer de página" del dashboard (mandaba el mismo
  payload). No se tocaron nombres internos (`nodeVerdict`,
  `classifyNode`, etc.), solo el contrato externo.
- Fase 8 (MCP): agregada instrucción de decirle al usuario que debe
  registrar el servidor manualmente en "Configuración" de cada cliente,
  no bastaba con desplegarlo.
- Quitado `preference` (kind ya retirado) que seguía en ambos
  `SKILL.md`, y quitada la justificación interna de mailto-vs-GitHub del
  texto de "Enviar comentarios".
- Fase 5: la escalera de niveles de proactividad del hook `Stop` ya no
  narra historia interna irrelevante ("ya se probó y resultó costoso"),
  solo dice qué hace cada nivel; silencioso/no silencioso quedó como
  pregunta aparte explícita.

## v0.4.1 (2026-09-06)

Precisión sobre v0.4.0, mismo día. Sin cambios en `schema.sql`.

- **El testigo del modo `SILENT` incluye conteo**: no es un ícono fijo,
  es `"(N🧠)"` con N = cuántos registros se guardaron de verdad en esa
  revisión, antepuesto a la siguiente respuesta normal. Cero registros,
  cero testigo (decisión de Oscar sobre v0.4.0, que solo dejaba un 🧠 sin
  número).

## v0.4.0 (2026-09-06)

Sin cambios en `schema.sql`.

- **Hook `Stop` rediseñado con "niveles de proactividad"** (decisión de
  Oscar, motivada por un hueco real encontrado en `D:\UAObrain`: el
  cooldown de 2h no volvía a dispararse durante un tramo de trabajo denso
  con varios commits/decisiones en poco tiempo real). El cooldown por
  TIEMPO se reemplaza por un contador de TURNOS -- agnóstico de dominio a
  propósito (no cuenta commits de git, para no sesgar el mecanismo a
  sesiones de código, generaliza igual a una conversación sobre hábitos o
  la planeación de un campamento). Niveles configurables en el propio
  script (`LEVEL`): 4 = cada turno, 3 = cada 5, 2 = cada 10, 1 = cada 20, 0
  = nunca (solo captura bajo pedido explícito, no engancha el hook).
- **Segundo eje independiente: `SILENT`**. Mismo contrato de silencio que
  ya rige `HEARTBEAT.md`: si está activo, la revisión sigue con la misma
  cadencia pero no narra nada salvo un testigo "🧠" al inicio de la
  siguiente respuesta si de verdad se guardó algo.
- Fase 5 y Fase 9 actualizadas: la entrevista ahora pregunta nivel +
  preferencia de silencio, y la activación exige probar el contador a
  mano (la cantidad de veces que corresponda al nivel elegido) antes de
  enganchar el hook de verdad.
- Límite conocido, documentado en el propio script: `Stop` dispara una vez
  por turno EXTERNO completo, sin importar cuántas herramientas corran
  adentro -- una sesión con pocos turnos pero cada uno enorme puede seguir
  subestimándose. Sin ajuste sin sesgar a un dominio, se acepta como
  límite del respaldo (el mecanismo principal sigue siendo el juicio
  proactivo, no este hook).

## v0.3.2 (2026-09-06)

Precisión sobre v0.3.1, mismo día. Sin cambios en `schema.sql`.

- **El criterio de `usuario` no es una lista cerrada de "nombre y rol"**,
  es "factual y estable, no dinámico" -- nombre y rol son el ejemplo típico
  y lo que pregunta la Fase 5, pero cualquier otro dato igual de permanente
  que el usuario comparta más adelante (fecha de nacimiento, grupo
  sanguíneo, lo que sea) aplica igual, y se guarda ahí cuando surja en el
  día a día. Lo que sigue excluido es lo dinámico (proyectos, actividad,
  valores, setup técnico), ese diagnóstico de v0.3.1 no cambió.

## v0.3.1 (2026-09-06)

Corrección sobre v0.3.0, mismo día, antes de que nadie instalara todavía.
Sin cambios en `schema.sql`.

- **`usuario` se acota a nombre y rol(es), exclusivamente** (decisión de
  Oscar): la v0.3.0 original guardaba ahí también proyectos, valores,
  setup técnico y contexto vigente -- todo eso es dinámico, y ya se cubre
  con la captura normal de registros (`remember.mjs` día a día) o con
  recuerdos propios más específicos (ej. una tesis va en `tesis-uao`, no
  repetida en `usuario`). Un resumen de identidad que también intenta ser
  un resumen de actividad se desactualiza en silencio.
- **Fase 5 simplificada**: una sola pregunta (nombre + rol), sin pedir
  proyectos activos. El ofrecimiento de enriquecer con documentos/notas
  dispersas/correo se movió a la Fase 6 (es contenido de proyectos, no de
  identidad, ahí tiene mejor casa).

## v0.3.0 (2026-09-06)

**Cambio de arquitectura, no un fix**. Sin cambios en `schema.sql` -- segura
de aplicar al código, pero requiere migrar contenido si ya instalaste
versiones previas (ver abajo).

- **Se retiran `SOUL.md`/`USER.md`**: solo se cargaban vía el `@import` de
  `CLAUDE.md`, invisibles en Chat/Cowork/móvil vía el servidor MCP que este
  mismo repo despliega -- justo las superficies que "Access it from
  anywhere" (README) promete cubrir. Un archivo de identidad que solo
  funciona en una de las cuatro superficies no cumplía esa promesa.
- **Lo que decía CÓMO comportarse** (voz, honestidad, juicio) ahora vive
  directo en `CLAUDE.md`, sección "Cómo trabajar con el usuario" -- la
  Fase 5 la reescribe en el lugar en vez de escribir un archivo aparte.
- **Lo que decía QUIÉN es el usuario** (nombre, contexto, proyectos) ahora
  se guarda como `records` reales bajo una categoría `usuario`, alcanzable
  con `search`/`memory-status.mjs` desde cualquier cliente MCP. La Fase 0
  ("YA_INSTALADO") corre `memory-status.mjs usuario` al arrancar sesión en
  vez de depender de un archivo estático siempre cargado.
- **Si ya instalaste una versión anterior**: `SOUL.md`/`USER.md` en tu
  copia siguen funcionando (nadie los borra por ti), pero no se benefician
  de este cambio hasta que migres a mano -- crea la categoría `usuario`,
  guarda como registros el contenido de `USER.md`, y copia el contenido de
  `SOUL.md` a la sección "Cómo trabajar con el usuario" de tu propio
  `CLAUDE.md`. No hay migración automática todavía.
- **Mecanismo de actualizaciones ajustado**: `CLAUDE.md` deja de ser
  seguro de sobreescribir completo en una actualización (mezcla guion de
  instalación con la personalización real del usuario) -- ver
  "Mantenimiento: revisar e instalar actualizaciones" en `CLAUDE.md`.

## v0.2.1 (2026-09-06)

Sin cambios en `scripts/db/schema.sql` -- segura de aplicar sin tocar la
base de datos.

- **"Candidatos de categoría" ahora propone enlazar/anidar en la jerarquía
  existente**, no solo crear una categoría nueva: si un huérfano (o un
  cluster de huérfanos) encaja con una categoría/subcategoría ya existente
  (por parecido con sus hijos actuales), la tarjeta lo propone así --
  siempre editable, revisión humana obligatoria intacta.
- **Corrige bug real**: la detección de "huérfano" solo contaba enlaces
  `pertenece_a`, así que un recuerdo con cualquier otro tipo de relación
  (`colabora_con`, `usado_para_calificar`, etc.) salía como huérfano en
  esta herramienta aunque ya estuviera conectado según la sección Grafo.
  Ahora cuenta cualquier `memory_link`, mismo criterio que Grafo.
- **Aviso para instalaciones existentes**: si tu `relation` de jerarquía
  tiene algún typo (ej. `'pertenece a'` con espacio en vez de guion bajo),
  ese enlace queda invisible tanto para el chequeo de huérfanos como para
  el encaje contra categorías existentes -- revisa `select distinct
  relation from memory_links` si algo no encaja como esperas.

## v0.2.0 (2026-09-06)

Sin cambios en `scripts/db/schema.sql` -- segura de aplicar sin tocar la
base de datos.

- **Nuevo: "Cambiar tipo de registro"** (`set-record-kind.mjs` + sección
  en el dashboard, Opciones avanzadas): cambia la etiqueta hecho/evento/
  compromiso de un registro sin tocar su recuerdo ni retractarlo. Antes
  no existía ninguna herramienta para esto, ni de dashboard ni de CLI.
- **Corrige bug real**: varias secciones del dashboard (Estado de
  recuerdo, Guardar registro, Timeline, Alias, Recategorizar registro)
  seguían mandando la clave `node` al backend en vez de `memory`/
  `record` desde el rename de vocabulario -- el backend las ignoraba en
  silencio. El más grave: "Guardar registro" nunca había ligado el
  recuerdo asignado a un registro nuevo.
- **Corrige bug real**: el navegador embebido de Claude Desktop no
  muestra `window.confirm()` (vuelve `false` en silencio), así que
  cualquier acción irreversible (Retractar, Borrar registro/recuerdo,
  Cambiar tipo) parecía "cancelada por el usuario" sin que nadie tocara
  nada. Reemplazado por un modal de confirmación propio en DOM/CSS puro.
- **"Candidatos de categoría"** ahora lista cada recuerdo huérfano
  individual como su propia tarjeta accionable, no solo un conteo
  cuando ninguno forma cluster con otro. Los nombres de categoría
  sugeridos son más cortos (2-3 palabras, patrón `<tipo>-<contexto>`
  como `reuniones-trabajo`) en vez de frases completas.
- **Convención nueva**: todo campo de texto/fecha/número/select
  editable lleva un tinte del color de acento al 18% de fondo, para
  distinguirlo a simple vista de un valor de solo lectura.
- Se quitó `preference` de los selectores de tipo (el enum de `kind` ya
  no la admite), y varios errores de concordancia de género en
  "categoría" quedaron corregidos.

## v0.1.0 (2026-09-05)

Primera versión etiquetada. Punto de partida para el mecanismo de
actualizaciones (`check-for-updates.mjs`, job `check-2obrain-updates` en
`HEARTBEAT.md`) y de feedback (sección "Acerca de" del dashboard).
