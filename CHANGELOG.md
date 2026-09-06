# CHANGELOG

Versiones etiquetadas de 2oBrain. `scripts/db/check-for-updates.mjs`
compara el `VERSION` local contra el último tag de `oscampo/2oBrain` --
lee esto antes de aplicar una actualización para saber qué esperar, no
asumas que es solo un número.

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
