# CHANGELOG

Versiones etiquetadas de 2oBrain. `scripts/db/check-for-updates.mjs`
compara el `VERSION` local contra el último tag de `oscampo/2oBrain` --
lee esto antes de aplicar una actualización para saber qué esperar, no
asumas que es solo un número.

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
