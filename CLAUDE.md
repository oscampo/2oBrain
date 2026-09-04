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

**Principio rector: el trabajo lo haces tú, no el usuario.** Ejecuta cada
comando tú mismo con tus propias herramientas (Bash, MCP conectados,
navegador si tienes uno controlable). Pídele al usuario únicamente lo que
GENUINAMENTE solo él puede hacer: crear una cuenta en un proveedor externo,
pagar algo, pegar una llave/contraseña que solo él puede generar, o decidir
entre opciones. Nunca le des una instrucción tipo "ve a tal sitio y haz
clic en tal botón" cuando exista una herramienta que lo haga por ti — si no
la tienes, entonces sí, guíalo paso a paso, pero verifícalo después en vez
de asumir que lo hizo bien.

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
trabajar. Yo hago la parte técnica; a ti solo te voy a pedir cuentas y
llaves que nadie más puede crear por ti.
```

Verifica el entorno tú mismo, no le preguntes al usuario si lo tiene instalado:

```bash
node --version   # necesitas >= 20
git --version
```

**Si falta Node.js o la versión es menor a 20, instálalo tú mismo** con el
gestor de paquetes del sistema operativo detectado — no le pidas al
usuario que vaya a nodejs.org:
- Windows: `winget install OpenJS.NodeJS.LTS`
- macOS: `brew install node` (si no hay Homebrew, instálalo primero:
  ver brew.sh; es un solo comando de shell, corre también tú)
- Linux: el gestor nativo de la distro detectada (`apt install nodejs npm`,
  `dnf install nodejs`, etc.)

Verifica after instalar (`node --version` de nuevo) antes de seguir. Si el
gestor de paquetes falla o no existe, ahí sí explícale al usuario
exactamente qué comando correr, y espera a que confirme antes de continuar
— pero eso es la excepción, no el camino por defecto.

Sigue a la Fase 2 directo — no hay nada más que preguntar aquí.

## Fase 2 — Base de datos (Supabase)

**Primero revisa si ya tienes un servidor MCP de Supabase conectado en esta
sesión** (busca en tus herramientas disponibles algo cuyo nombre contenga
`supabase` y `create_project`/`list_projects` — el prefijo exacto varía,
es un ID de conexión, no lo asumas de memoria).

### Si tienes MCP de Supabase conectado

Hazlo todo tú, sin que el usuario abra un navegador:

1. `list_organizations` — si hay más de una, pregúntale al usuario cuál
   usar (PREGUNTA: única decisión real de esta fase). Si hay una sola, úsala
   directo, no preguntes por preguntar.
2. `get_cost` (type: project) para esa organización, muéstraselo al
   usuario tal cual (aunque sea $0), y espera su confirmación antes de
   crear nada — crear infraestructura en la nube siempre se confirma,
   incluso gratis.
3. `confirm_cost` con esos datos, luego `create_project` (nombre sugerido:
   `2obrain`, o el que el usuario prefiera).
4. `get_project` en loop corto hasta que el status sea `ACTIVE_HEALTHY`.
5. `get_project_url` y `get_publishable_keys` te dan `SUPABASE_URL` y las
   llaves — escríbelas tú mismo en `.env`.
6. **Única cosa que el usuario debe hacer**: la API de gestión de Supabase
   no expone la contraseña de la base de datos ni el connection string
   completo (Supabase la genera y solo la muestra una vez en el
   dashboard). Dile exactamente dónde ir: *"En supabase.com/dashboard,
   entra al proyecto que acabo de crear → Project Settings → Database →
   Connection string → modo URI. Cópialo y pégamelo, o dímelo y yo lo
   escribo en `.env`."* Escribe tú el valor en `SUPABASE_DB_URL` — no le
   pidas que edite el archivo.

### Si NO tienes MCP de Supabase conectado

Guía al usuario paso a paso (esta vez sí, porque no tienes otra
herramienta), pero sé específico y verifica cada resultado, no asumas:

1. supabase.com → crear cuenta (gratis) → "New project". Que anote la
   contraseña de la base de datos que elija ahí, Supabase no la vuelve a
   mostrar.
2. Pide el **connection string** (Project Settings → Database →
   Connection string → modo URI) y las llaves de API (Project Settings →
   API: `Project URL`, `anon public key`, `service_role key`).
3. Crea `.env` desde `.env.example` (`cp .env.example .env` si no existe)
   y escribe tú los 4 valores ahí (`SUPABASE_DB_URL`, `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) — el usuario solo te
   pega los valores en el chat, tú editas el archivo.

En ambos casos, explica antes de pedir/guardar `service_role`: tiene acceso
total sin restricciones de RLS y nunca debe salir de `.env` (no se comitea,
y evita mostrarlo de vuelta en el chat una vez guardado).

### Aplicar el esquema (siempre tú, sin excepción)

```bash
cd scripts/db && npm install
node test-connection.mjs
node apply-schema.mjs
```

Si `test-connection.mjs` falla, diagnostica tú primero (host/puerto/typo en
la URL son los errores más comunes) antes de pedirle nada de vuelta al
usuario.

**Fase 2 completada** — la base existe y tiene el esquema (`pages`,
`facts`, `nodes`, `fact_nodes`, `node_edges`, `node_pair_checks`).

## Fase 3 — Llaves de IA

Tres proveedores externos. Crear la cuenta y generar la llave es lo único
que, por diseño, nadie más que el usuario puede hacer (nunca crees cuentas
en servicios externos en su nombre) — todo lo demás (guardar la llave,
probarla) lo haces tú.

Si tienes un navegador controlable en esta sesión, **ábrele tú la página
exacta de cada proveedor** en vez de solo nombrarla, para que no tenga que
buscarla:

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

**PREGUNTA**: ¿Tienes ya alguna de estas tres, o las creamos ahora las
tres? Todas tienen capa gratis funcional para empezar. Si el usuario
prefiere arrancar con menos de las tres, dile explícitamente qué deja de
funcionar sin cada una (búsqueda semántica sin Voyage, sin clasificadores
automáticos de duplicados/alias sin ninguna de las dos de LLM) y sigue —
no lo bloquees a tener las tres para poder probar el sistema.

Cada vez que te pase una llave, escríbela tú mismo en `.env` — nunca le
pidas que edite el archivo él.

## Fase 4 — Verificación

```bash
cd scripts/db
node search.mjs "prueba"
node doctor.mjs
```

`search.mjs` debe correr sin error (aunque no haya resultados, la base está
vacía). `doctor.mjs` debe salir "Todo limpio." Si algo falla, diagnostica y
corrige tú antes de seguir — no avances con el motor roto, y no le pidas al
usuario que lo revise él.

**Fase 4 completada.**

## Fase 5 — Identidad (SOUL.md / USER.md / MEMORY.md)

Esta es la parte que hace que el asistente se sienta hecho a la medida, no
un chatbot genérico. `SOUL.md`/`USER.md`/`MEMORY.md` vienen en este repo
como plantillas — vas a **reescribirlos** con las respuestas de esta
entrevista, no solo llenar huecos. Esta fase sí es una conversación real,
no algo que puedas automatizar — es la única parte donde "hazlo tú" no
aplica, porque lo que se necesita es que el usuario hable de sí mismo.

Explica antes de empezar: *"Esto no es para configurar el software, es
para que yo sepa quién eres y cómo trabajas — se puede corregir cuando
quieras, nunca queda fijo."*

**PREGUNTA**: ¿Cómo te llamas, y en qué zona horaria trabajas?
→ Escribe en `USER.md`: `Name` y `Timezone`.

**PREGUNTA**: ¿A qué te dedicas? ¿Qué proyectos/roles activos tienes
ahora mismo que yo debería conocer de entrada?
→ Escribe en `USER.md`, sección `Context`. No inventes ni completes con
suposiciones — si el usuario da poco detalle, deja la sección corta; se
completa con el tiempo, no de una vez.

**PREGUNTA**: ¿Cómo prefieres que trabaje contigo? Por ejemplo: ¿directo
y crítico, o más exploratorio? ¿idioma por defecto? ¿preguntar antes de
acciones irreversibles, o más autónomo?
→ Escribe en `SOUL.md`, sección `Voice`/`Judgment default`. Si el usuario
no tiene preferencia formada todavía, deja el default del template
(directo, sin relleno, confirma antes de acciones irreversibles) y dilo
explícitamente — no le fuerces a decidir algo que no le importa todavía.

**PREGUNTA**: ¿Hay alguna captura automática de hechos que quieras activa
desde ya? (el hook `Stop` de Claude Code, que revisa al cerrar cada turno
si hay algo capturable — ver Fase 8) ¿O prefieres empezar solo con captura
manual ("guarda este hecho")?
→ Anota la respuesta, se aplica en la Fase 8 (tú activas el hook, no el
usuario).

Con las respuestas, reescribe tú los tres archivos. Estructura de
referencia (no la cambies, es la que el resto del sistema espera —
`MEMORY.md` en particular es lo que se carga en cada sesión):

- `USER.md`: Name, Timezone, Context, Active projects (vacío por ahora),
  People to recognize (vacío), Boundaries (vacío), Handle with care
  (vacío) — se llenan con el tiempo, no en esta entrevista.
- `SOUL.md`: mantén la estructura del template, ajusta solo `Voice` y
  `Judgment default` según la respuesta de esta fase.
- `MEMORY.md`: no toques la estructura — es un esqueleto de mantenimiento
  reusable (reglas aprendidas, compromisos abiertos, eventos críticos),
  no contenido personal. Déjalo como está, vacío de entradas reales; se
  llena solo con el uso.

**Fase 5 completada** — muéstrale al usuario los 3 archivos resultantes
para que confirme antes de seguir.

## Fase 6 — Dashboard local

Levántalo y ábrelo tú mismo, no le digas al usuario que lo abra:

```bash
cd scripts/db/server
node dashboard-server.mjs
```

Si tienes un navegador controlable (Claude Code con Browser pane, o
similar), ábrelo en `http://localhost:4287` y confirma en vivo que carga
el dashboard con sus secciones (Buscar/Timeline/Grafo/Doctor/etc.) — no le
pidas al usuario que lo revise él salvo que no tengas esa herramienta.

## Fase 7 — Servidor MCP (opcional)

**PREGUNTA**: ¿Quieres que `search`/`remember` estén disponibles para
otros clientes MCP (Claude Desktop, Claude Chat/Cowork, cualquier app que
hable MCP), no solo el dashboard/CLI de este repo?
- **Si NO**: continúa a la Fase 8. Puedes volver a esto cuando quieras, no
  bloquea nada del resto del sistema.
- **Si SÍ**: hay dos opciones, el usuario elige una (o ambas):
  - **Supabase Edge Function** (`supabase/functions/mcp-server/`): si
    tienes el MCP de Supabase conectado (Fase 2), despliégala tú
    directamente con la herramienta `deploy_edge_function` de ese MCP —
    el usuario no necesita instalar nada. Sin ese MCP, necesita la
    Supabase CLI (`supabase functions deploy mcp-server`), que sí tiene
    que correr él si tú no puedes instalarla de forma confiable en su
    sistema.
  - **Deno Deploy** (`deno-deploy/mcp-server/`): el usuario necesita
    cuenta en dash.deno.com y generar `DENO_DEPLOY_TOKEN`
    (dash.deno.com/account#access-tokens) — eso sí es solo suyo. Una vez
    te lo pase, tú escribes el token en `.env`, llenas `org`/`app` en
    `deno.jsonc` y `deno-deploy/mcp-server/deno.json` con el nombre real
    de su org, y corres el deploy tú mismo:
    `deno run -A jsr:@deno/deploy --prod` desde `deno-deploy/mcp-server/`.

Verifica el deploy elegido con una llamada real (`curl` al endpoint
resultante, o `tools/list` del protocolo MCP) antes de darlo por hecho —
nunca asumas que un deploy funcionó solo porque el comando no dio error.

## Fase 8 — Hooks (opcional)

Según la respuesta de la Fase 5, actívalos tú mismo, no describas los pasos
para que el usuario los siga:

- **Hook `Stop`** (recordatorio de captura al cerrar turno): agrégalo tú a
  la configuración de hooks de Claude Code (edita el `settings.json`
  correspondiente) apuntando a `scripts/hooks/stop-capture-check.mjs` —
  revisa la sintaxis vigente de hooks de Claude Code antes de escribirla
  (cambia entre versiones, no la asumas de memoria), no le pidas al
  usuario que la escriba él.
- **Hook `post-commit`**: corre tú `git config core.hooksPath
  scripts/hooks/git` en este repo, una sola vez.

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
