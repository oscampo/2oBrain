---
name: segundo-cerebro-capture
description: Registrar un registro fechado con fuente en la memoria compartida (Supabase) cuando se cierra una decisión, se resuelve un bug real, o se aprende algo durable en la conversación. Úsalo en vez de dejarlo solo en el chat o en un archivo local.
---

<!-- Duplicada a propósito en .claude/skills/segundo-cerebro-capture/SKILL.md
     (2026-09-06, bug real encontrado en una instalación de prueba):
     Claude Code solo descubre skills invocables bajo .claude/skills/,
     nunca bajo skills/ en la raíz -- este archivo vive AQUÍ además como
     referencia legible/copiable a mano. Si editas el contenido, replica
     el cambio en ambas copias. -->

# Captura de registros: segundo cerebro (Supabase)

La memoria persistente de este proyecto es un backend Supabase (`pages`,
`records`, `memories`/`record_memories`): `pages` son documentos completos, cargados
desde los `.md` del repo vía `scripts/db/load-pages.mjs`; `records` son registros
atómicos, fechados, con fuente obligatoria; `memories`/`record_memories` agrupan
registros por tema (proyecto, persona, colaboración) de forma N:N.

## Cuándo capturar un registro

Al final de un turno donde se cerró una decisión real, se corrigió un bug
de producción, se verificó algo en vivo, o se acordó un próximo paso. No
captures ruido conversacional ni nada que ya esté implícito en el
contenido de una página (`pages`).

## Cómo capturar

**Nunca inventes ni infieras la fecha de texto libre después.** Pídela
explícita, la fecha real del evento si se conoce, o la fecha de hoy
(`date +%Y-%m-%d`; nunca de memoria) si no aplica una fecha distinta.

```bash
cd scripts/db
node remember.mjs \
  --claim "texto claro y autocontenido del registro" \
  --date YYYY-MM-DD \
  --source "de dónde salió: sesión de tal fecha, verificación en vivo, correo, etc." \
  --kind fact \
  --memory recuerdo-si-aplica
```

`--date` y `--source` son obligatorios, el esquema de la base los exige
(`NOT NULL`), el script rechaza la llamada si faltan o si la fecha no tiene
formato `YYYY-MM-DD`. No hay forma de guardar un registro sin ambos.

`--kind` acepta `fact` (default), `event`, `commitment`.

`--memory` es opcional (uno o varios separados por coma), agrupa el registro
bajo un recuerdo existente en la tabla `memories` (ver `node scripts/db/list-memories.mjs`
para la lista vigente). Fail-closed: si el recuerdo no existe, `remember.mjs` se
niega a insertar salvo que se pase también `--create-memory` (solo cuando el
recuerdo es genuinamente nuevo, no un typo del existente). Si el registro no
pertenece a ningún proyecto/persona específico, se omite `--memory` por
completo, no es obligatorio a nivel de esquema.

## Si el script se niega a insertar (registro parecido detectado)

`remember.mjs` busca por embedding entre los registros vigentes antes de
insertar. Si encuentra alguno con similitud alta, se niega a insertar en
silencio y muestra los candidatos con su id, hay que resolver explícito,
no hay ruta por defecto:

- **Reemplaza uno o más**: `--supersedes 12,15` (marca esos ids como
  reemplazados y los saca de las consultas por defecto).
- **Es genuinamente distinto** pese al parecido: `--distinct` (confirma
  explícitamente y lo inserta sin tocar los demás).

No hay una tercera opción de "ignorar y seguir", el gate existe
precisamente para que una contradicción no quede coexistiendo sin que
alguien la haya visto y decidido.

## Cerrar compromisos que este registro resuelve

`remember.mjs` ya lo hace solo: cada registro nuevo ligado a un recuerdo
revisa automáticamente los compromisos abiertos de ese recuerdo (sin
depender de similitud de embedding, ver `lib/classify-commitment-resolution.mjs`)
y decide si los resuelve total, parcial, o nada:

- **Resuelto por completo**: el compromiso queda marcado como reemplazado
  por el registro nuevo (`superseded_by`), conserva su `kind` original
  (sigue diciendo que fue un compromiso, ahora cerrado) y desaparece solo
  de `list-commitments.mjs`.
- **Resuelto en parte** (el compromiso tenía más de una cosa pendiente y
  esto resolvió solo una): mismo cierre automático, más un aviso en
  consola pidiendo crear un `remember.mjs --kind commitment` nuevo,
  acotado solo a lo que sigue pendiente. El texto de lo pendiente nunca se
  redacta solo, eso requiere criterio de quien captura.
- **No se relaciona**: no pasa nada, sin ruido.

**Esto solo corre dentro de `remember.mjs`.** Si insertas por
`remember-batch.mjs` o algún otro camino, revisa a mano:

```bash
node scripts/db/list-commitments.mjs --memory <ese-recuerdo>
```

y si algo quedó resuelto sin que el registro que lo resuelve exista
todavía como reemplazo formal, usa `node scripts/db/supersede-record.mjs
--old <id-compromiso> --new <id-registro-que-lo-resuelve> --reason "..."`
para vincularlos retroactivamente.

Hallazgo real que motiva esto: un compromiso con dos partes (gestionar un
trámite + presentar algo en una fecha posterior) quedó vigente sin
cerrarse pese a que la primera parte ya se había resuelto días antes --
nadie cruzó el registro nuevo contra el compromiso viejo del mismo
recuerdo hasta que se preguntó directamente por el estado del proyecto.
`commitments-check` de `HEARTBEAT.md` sigue como respaldo diario para lo
que se le escape incluso al chequeo automático.

## Cómo consultar lo capturado

```bash
node scripts/db/timeline.mjs               # los 20 registros vigentes más recientes
node scripts/db/timeline.mjs nombre-recuerdo   # solo los de ese recuerdo
node scripts/db/timeline.mjs --all         # incluye los reemplazados, marcados como tal
```

Para búsqueda semántica sobre registros y páginas combinados, usar
`scripts/db/search.mjs "pregunta"`.

## Por qué existe esta regla

La fecha se captura al momento de escribir, nunca se adivina después sobre
texto libre; y cada registro trae su fuente siempre, sin excepción, porque el
esquema lo exige, no porque alguien se acuerde de escribirla bien.
