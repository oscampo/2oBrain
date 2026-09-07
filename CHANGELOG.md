# CHANGELOG

Versiones etiquetadas de 2oBrain. `scripts/db/check-for-updates.mjs`
compara el `VERSION` local contra el último tag de `oscampo/2oBrain` --
lee esto antes de aplicar una actualización para saber qué esperar, no
asumas que es solo un número.

## v0.4.2 (2026-09-06)

Correcciones urgentes surgidas en vivo durante la instalación real con
una usuaria de prueba. Sin cambios en `schema.sql`.

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
