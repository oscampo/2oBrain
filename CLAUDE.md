# CLAUDE.md

@SOUL.md
@USER.md
@MEMORY.md

Este archivo es un guion de entrevista, no documentación de referencia. La
primera vez que alguien abre este repo en Claude Code, tu trabajo es guiar
la instalación completa, fase por fase, EN ORDEN, sin saltar ninguna ni
avanzar sin confirmación explícita del usuario. Una vez instalado, este
mismo archivo sigue siendo tu identidad operativa de todos los días (ver
Fase 9) — no lo borres ni lo reduzcas después de instalar.

## Fase 0 — Detección de estado

Antes de saludar, revisa si esto ya está instalado:

```bash
test -f .env && grep -q "^SUPABASE_DB_URL=.\+" .env && echo "YA_INSTALADO" || echo "INSTALACION_NUEVA"
```

- **INSTALACION_NUEVA**: sigue con la Fase 1.
- **YA_INSTALADO**: no repitas la entrevista. Saluda brevemente, confirma
  que el sistema está operativo (`node scripts/db/test-connection.mjs`,
  `node scripts/db/doctor.mjs`), y sigue el resto de tu comportamiento
  normal desde `SOUL.md`/`USER.md`/`MEMORY.md`. El resto de este archivo no
  aplica a una sesión normal, solo a la instalación.

## Fase 1 — Bienvenida y entorno

Muestra esto exacto:

```
2oBrain — instalación guiada
Voy a configurar tu segundo cerebro: base de datos (Supabase), llaves de
IA, y tu propia identidad para que yo sepa quién eres y cómo prefieres
trabajar. Toma unos 15-20 minutos, la mayoría esperando a que crees cuentas.
```

Verifica el entorno y reporta qué falta (no asumas que algo está instalado):

```bash
node --version   # >= 20
git --version
```

Si falta Node.js, dile al usuario que lo instale desde nodejs.org antes de
seguir — no continúes sin él.

**PREGUNTA 1**: ¿Ya tienes una cuenta y un proyecto en Supabase, o necesitas
crear uno?
- Si NO tiene cuenta: dirígelo a supabase.com, crear cuenta gratis, "New
  project" — pídele que anote la contraseña de la base de datos que elija
  ahí (la va a necesitar en el paso siguiente, Supabase no la vuelve a
  mostrar).
- Si SÍ: continúa.

## Fase 2 — Base de datos

Pide al usuario que copie su **connection string** de Postgres: en el
dashboard de Supabase, Project Settings → Database → Connection string →
modo "URI". Debe verse como
`postgresql://postgres:[password]@[host]:5432/postgres`.

Crea `.env` a partir de `.env.example` (`cp .env.example .env` si no existe
todavía) y escribe ese valor en `SUPABASE_DB_URL`.

Luego pide, del mismo Project Settings → API: `Project URL`, `anon public
key`, `service_role key` — van en `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` respectivamente. Explica antes de pedirla que
`service_role` tiene acceso total sin restricciones de RLS y nunca debe
salir de `.env` (no se pega en el chat, no se comitea).

Con las 4 variables en `.env`, instala dependencias y aplica el esquema:

```bash
cd scripts/db && npm install
node test-connection.mjs
node apply-schema.mjs
```

Si `test-connection.mjs` falla, el problema casi siempre es la contraseña
o el host en `SUPABASE_DB_URL` — revisa con el usuario antes de seguir.

**Fase 2 completada** — la base existe y tiene el esquema (`pages`,
`facts`, `nodes`, `fact_nodes`, `node_edges`, `node_pair_checks`).

## Fase 3 — Llaves de IA

Tres proveedores, cada uno con un rol distinto — pide las llaves una por
una, explicando para qué sirve cada una antes de pedirla:

1. **Voyage AI** (`VOYAGE_API_KEY`, dash.voyageai.com) — embeddings
   (`voyage-4-lite`). Sin esto, `search.mjs` no puede hacer búsqueda
   semántica (solo texto completo).
2. **Ollama Cloud** (`OLLAMA_API_KEY`, ollama.com/settings/keys) —
   clasificación barata (duplicados, alias, menciones) y extracción de
   hechos.
3. **Gemini** (`GEMINI_API_KEY`, aistudio.google.com/apikey) — fallback de
   mayor calidad para síntesis y clasificación de relaciones; algunos
   clasificadores lo usan como único proveedor cuando la tarea es de
   juicio, no de extracción (ver comentarios en `scripts/db/lib/`).

**PREGUNTA 2**: ¿Tienes ya alguna de estas tres, o las creamos ahora las
tres? Todas tienen capa gratis funcional para empezar. Si el usuario
prefiere arrancar con menos de las tres, dile explícitamente qué deja de
funcionar sin cada una (búsqueda semántica sin Voyage, sin clasificadores
automáticos de duplicados/alias sin ninguna de las dos de LLM) y sigue —
no lo bloquees a tener las tres para poder probar el sistema.

## Fase 4 — Verificación

```bash
cd scripts/db
node search.mjs "prueba"
node doctor.mjs
```

`search.mjs` debe correr sin error (aunque no haya resultados, la base está
vacía). `doctor.mjs` debe salir "Todo limpio." Si algo falla, diagnostica
antes de seguir — no avances con el motor roto.

**Fase 4 completada.**

## Fase 5 — Identidad (SOUL.md / USER.md / MEMORY.md)

Esta es la parte que hace que el asistente se sienta hecho a la medida, no
un chatbot genérico. `SOUL.md`/`USER.md`/`MEMORY.md` vienen en este repo
como plantillas — vas a **reescribirlos** con las respuestas de esta
entrevista, no solo llenar huecos.

Explica antes de empezar: *"Esto no es para configurar el software, es
para que yo sepa quién eres y cómo trabajas — se puede corregir cuando
quieras, nunca queda fijo."*

**PREGUNTA 3**: ¿Cómo te llamas, y en qué zona horaria trabajas?
→ Escribe en `USER.md`: `Name` y `Timezone`.

**PREGUNTA 4**: ¿A qué te dedicas? ¿Qué proyectos/roles activos tienes
ahora mismo que yo debería conocer de entrada?
→ Escribe en `USER.md`, sección `Context`. No inventes ni completes con
suposiciones — si el usuario da poco detalle, deja la sección corta; se
completa con el tiempo, no de una vez.

**PREGUNTA 5**: ¿Cómo prefieres que trabaje contigo? Por ejemplo: ¿directo
y crítico, o más exploratorio? ¿idioma por defecto? ¿preguntar antes de
acciones irreversibles, o más autónomo?
→ Escribe en `SOUL.md`, sección `Voice`/`Judgment default`. Si el usuario
no tiene preferencia formada todavía, deja el default del template
(directo, sin relleno, confirma antes de acciones irreversibles) y dilo
explícitamente — no le fuerces a decidir algo que no le importa todavía.

**PREGUNTA 6**: ¿Hay alguna captura automática de hechos que quieras activa
desde ya? (el hook `Stop` de Claude Code, que revisa al cerrar cada turno
si hay algo capturable — ver Fase 8) ¿O prefieres empezar solo con captura
manual ("guarda este hecho")?
→ Anota la respuesta, se aplica en la Fase 8.

Con las respuestas, reescribe los tres archivos. Estructura de referencia
(no la cambies, es la que el resto del sistema espera — `MEMORY.md` en
particular es lo que se carga en cada sesión):

- `USER.md`: Name, Timezone, Context, Active projects (vacío por ahora),
  People to recognize (vacío), Boundaries (vacío), Handle with care
  (vacío) — se llenan con el tiempo, no en esta entrevista.
- `SOUL.md`: mantén la estructura del template, ajusta solo `Voice` y
  `Judgment default` según la Pregunta 5.
- `MEMORY.md`: no toques la estructura — es un esqueleto de mantenimiento
  reusable (reglas aprendidas, compromisos abiertos, eventos críticos),
  no contenido personal. Déjalo como está, vacío de entradas reales; se
  llena solo con el uso.

**Fase 5 completada** — muéstrale al usuario los 3 archivos resultantes
para que confirme antes de seguir.

## Fase 6 — Dashboard local

```bash
cd scripts/db/server
node dashboard-server.mjs
```

Abre `http://localhost:4287` — debe verse el dashboard con las secciones
Buscar/Timeline/Grafo/Doctor/etc. Si tienes acceso a un navegador
controlable (Claude Code con Browser pane, o similar), ábrelo y confírmalo
en vivo en vez de solo indicarle al usuario que lo revise.

## Fase 7 — Servidor MCP (opcional)

**PREGUNTA 7**: ¿Quieres que `search`/`remember` estén disponibles para
otros clientes MCP (Claude Desktop, Claude Chat/Cowork, cualquier app que
hable MCP), no solo el dashboard/CLI de este repo?
- **Si NO**: continúa a la Fase 8. Puedes volver a esto cuando quieras, no
  bloquea nada del resto del sistema.
- **Si SÍ**: hay dos opciones equivalentes, el usuario elige una (o ambas):
  - **Deno Deploy** (`deno-deploy/mcp-server/`): más simple si nunca ha
    usado Supabase Edge Functions. Requiere cuenta en dash.deno.com,
    `DENO_DEPLOY_TOKEN` (dash.deno.com/account#access-tokens) en `.env`, y
    llenar `org`/`app` en `deno.jsonc` y `deno-deploy/mcp-server/deno.json`
    con el nombre real de su org de Deno Deploy. Deploy:
    `deno run -A jsr:@deno/deploy --prod` desde `deno-deploy/mcp-server/`.
  - **Supabase Edge Function** (`supabase/functions/mcp-server/`): vive en
    el mismo proyecto que ya creó en la Fase 2, sin cuenta adicional.
    Requiere la Supabase CLI (`supabase functions deploy mcp-server`).

Verifica el deploy elegido con una llamada real (`curl` a `/` del endpoint
resultante, o `tools/list` del protocolo MCP) antes de darlo por hecho.

## Fase 8 — Hooks (opcional)

Según la Pregunta 6:

- **Hook `Stop`** (recordatorio de captura al cerrar turno): agrégalo a la
  configuración de hooks de Claude Code apuntando a
  `scripts/hooks/stop-capture-check.mjs` (ver la documentación de hooks de
  Claude Code para la sintaxis exacta de `settings.json` — cambia entre
  versiones, no la asumas de memoria, revísala).
- **Hook `post-commit`** (recarga `pages`/embeddings cuando cambia un
  `.md` en `daily/guides/people/projects/wiki`): `git config
  core.hooksPath scripts/hooks/git` una vez, en este repo.

Si el usuario no quiere ninguno de los dos, sigue sin ellos — no son
obligatorios para que el resto del sistema funcione.

## Fase 9 — Cierre

Muestra esto exacto:

```
Instalación completa. Desde ahora:
- node scripts/db/remember.mjs — guarda un hecho
- node scripts/db/search.mjs "pregunta" — busca
- http://localhost:4287 — dashboard (búsqueda, grafo, mantenimiento)
- node scripts/db/doctor.mjs — chequeo de salud, cuando quieras
Ver skills/segundo-cerebro-capture/SKILL.md para el detalle de cómo y
cuándo capturar hechos.
```

De aquí en adelante, tu comportamiento diario lo definen
`SOUL.md`/`USER.md`/`MEMORY.md` (recién escritos en la Fase 5), no este
archivo — la Fase 0 es la que decide, en cada sesión futura, que ya no hay
que repetir nada de esto.
