---
name: segundo-cerebro-capture
description: Registrar un hecho fechado con fuente en la memoria compartida (Supabase) cuando se cierra una decisión, se resuelve un bug real, o se aprende algo durable en la conversación. Úsalo en vez de dejarlo solo en el chat o en un archivo local.
---

# Captura de hechos: segundo cerebro (Supabase)

La memoria persistente de este proyecto es un backend Supabase (`pages`,
`facts`, `nodes`/`fact_nodes`): `pages` son documentos completos, cargados
desde los `.md` del repo vía `scripts/db/load-pages.mjs`; `facts` son hechos
atómicos, fechados, con fuente obligatoria; `nodes`/`fact_nodes` agrupan
hechos por tema (proyecto, persona, colaboración) de forma N:N.

## Cuándo capturar un hecho

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
  --claim "texto claro y autocontenido del hecho" \
  --date YYYY-MM-DD \
  --source "de dónde salió: sesión de tal fecha, verificación en vivo, correo, etc." \
  --kind fact \
  --node nodo-si-aplica
```

`--date` y `--source` son obligatorios, el esquema de la base los exige
(`NOT NULL`), el script rechaza la llamada si faltan o si la fecha no tiene
formato `YYYY-MM-DD`. No hay forma de guardar un hecho sin ambos.

`--kind` acepta `fact` (default), `event`, `preference`, `commitment`.

`--node` es opcional (uno o varios separados por coma), agrupa el hecho
bajo un nodo existente en la tabla `nodes` (ver `node scripts/db/list-nodes.mjs`
para la lista vigente). Fail-closed: si el nodo no existe, `remember.mjs` se
niega a insertar salvo que se pase también `--create-node` (solo cuando el
nodo es genuinamente nuevo, no un typo del existente). Si el hecho no
pertenece a ningún proyecto/persona específico, se omite `--node` por
completo, no es obligatorio a nivel de esquema.

## Si el script se niega a insertar (hecho parecido detectado)

`remember.mjs` busca por embedding entre los hechos vigentes antes de
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

## Cómo consultar lo capturado

```bash
node scripts/db/timeline.mjs               # los 20 hechos vigentes más recientes
node scripts/db/timeline.mjs nombre-nodo   # solo los de ese nodo
node scripts/db/timeline.mjs --all         # incluye los reemplazados, marcados como tal
```

Para búsqueda semántica sobre hechos y páginas combinados, usar
`scripts/db/search.mjs "pregunta"`.

## Por qué existe esta regla

La fecha se captura al momento de escribir, nunca se adivina después sobre
texto libre; y cada hecho trae su fuente siempre, sin excepción, porque el
esquema lo exige, no porque alguien se acuerde de escribirla bien.
