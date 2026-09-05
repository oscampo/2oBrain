# CLAUDE.md

@SOUL.md
@USER.md
@MEMORY.md

Este archivo es un guion de entrevista, no documentación de referencia. La
primera vez que alguien abre este repo en Claude Code, tu trabajo es guiar
la instalación completa, fase por fase, EN ORDEN, sin saltar ninguna ni
avanzar sin confirmación explícita del usuario. Una vez instalado, este
mismo archivo sigue siendo tu identidad operativa de todos los días (ver
Fase 10), no lo borres ni lo reduzcas después de instalar.

**Principio rector: el trabajo lo haces tú, no el usuario.** Ejecuta cada
comando tú mismo con tus propias herramientas (Bash, MCP conectados,
navegador si tienes uno controlable). Pídele al usuario únicamente lo que
GENUINAMENTE solo él puede hacer: crear una cuenta en un proveedor externo,
pagar algo, pegar una llave/contraseña que solo él puede generar, o decidir
entre opciones. Nunca le des una instrucción tipo "ve a tal sitio y haz
clic en tal botón" cuando exista una herramienta que lo haga por ti, si no
la tienes, entonces sí, guíalo paso a paso, pero verifícalo después en vez
de asumir que lo hizo bien.

Si estás leyendo este archivo sin haber clonado el repo todavía (ej. lo
leíste en remoto de la URL que te pasaron, antes de tener una carpeta
local), clónalo tú primero -- `git clone
https://github.com/oscampo/2oBrain.git`, instalando `git` primero si hace
falta, mismo criterio de la Fase 1 -- y desconéctalo de este repo
(`git remote remove origin`, dentro de la carpeta nueva): un clon queda
apuntando a `oscampo/2oBrain` por defecto, y esta copia es del usuario,
no debería quedar como una tentación de empujar de vuelta aquí. Sigue
desde ahí. Todo lo que sigue en este archivo asume que ya estás dentro de
la carpeta clonada y ya desconectada.

## Fase 0: Detección de estado

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

## Fase 1: Bienvenida y entorno

Muestra esto exacto:

```
2oBrain, instalación guiada
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
gestor de paquetes del sistema operativo detectado, no le pidas al
usuario que vaya a nodejs.org:
- Windows: `winget install OpenJS.NodeJS.LTS`
- macOS: `brew install node` (si no hay Homebrew, instálalo primero:
  ver brew.sh; es un solo comando de shell, corre también tú)
- Linux: el gestor nativo de la distro detectada (`apt install nodejs npm`,
  `dnf install nodejs`, etc.)

Verifica después de instalar (`node --version` de nuevo) antes de seguir. Si el
gestor de paquetes falla o no existe, ahí sí explícale al usuario
exactamente qué comando correr, y espera a que confirme antes de continuar,
esto es la excepción, no el camino por defecto.

Sigue a la Fase 2 directo, no hay nada más que preguntar aquí.

## Fase 2: Base de datos (Supabase)

**Primero revisa si ya tienes un servidor MCP de Supabase conectado en esta
sesión** (busca en tus herramientas disponibles algo cuyo nombre contenga
`supabase` y `create_project`/`list_projects`, el prefijo exacto varía,
es un ID de conexión, no lo asumas de memoria).

### Si tienes MCP de Supabase conectado

Hazlo todo tú, sin que el usuario abra un navegador:

1. `list_organizations`, si hay más de una, pregúntale al usuario cuál
   usar (PREGUNTA: única decisión real de esta fase). Si hay una sola, úsala
   directo, no preguntes por preguntar.
2. `get_cost` (type: project) para esa organización, muéstraselo al
   usuario tal cual (aunque sea $0), y espera su confirmación antes de
   crear nada, crear infraestructura en la nube siempre se confirma,
   incluso gratis.
3. `confirm_cost` con esos datos, luego `create_project` (nombre sugerido:
   `2obrain`, o el que el usuario prefiera).
4. `get_project` en loop corto hasta que el status sea `ACTIVE_HEALTHY`.
5. `get_project_url` y `get_publishable_keys` te dan `SUPABASE_URL` y las
   llaves, escríbelas tú mismo en `.env`.
6. **Única cosa que el usuario debe hacer**: la API de gestión de Supabase
   no expone la contraseña de la base de datos ni el connection string
   completo (Supabase la genera y solo la muestra una vez en el
   dashboard). Dile exactamente dónde ir: *"En supabase.com/dashboard,
   entra al proyecto que acabo de crear → Project Settings → Database →
   Connection string → modo URI. Cópialo y pégamelo, o dímelo y yo lo
   escribo en `.env`."* Escribe tú el valor en `SUPABASE_DB_URL`, no le
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
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), el usuario solo te
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

**Fase 2 completada**, la base existe y tiene el esquema (`pages`,
`facts`, `nodes`, `fact_nodes`, `node_edges`, `node_pair_checks`).

## Fase 3: Llaves de IA

Tres proveedores externos. Crear la cuenta y generar la llave es lo único
que, por diseño, nadie más que el usuario puede hacer (nunca crees cuentas
en servicios externos en su nombre), todo lo demás (guardar la llave,
probarla) lo haces tú.

Si tienes un navegador controlable en esta sesión, **ábrele tú la página
exacta de cada proveedor** en vez de solo nombrarla, para que no tenga que
buscarla:

1. **Voyage AI** (`VOYAGE_API_KEY`, dash.voyageai.com), embeddings
   (`voyage-4-lite`). **Obligatoria, no opcional**: `search.mjs`,
   `remember.mjs`, `create-node.mjs` y varios más llaman a `embed()` sin
   ningún manejo de error ni camino alterno de "solo texto completo" (no
   existe ese fallback en el código, aunque el nombre pueda sonar a
   búsqueda híbrida) -- sin esta llave el sistema no arranca, punto.
2. **Ollama Cloud** (`OLLAMA_API_KEY`, ollama.com/settings/keys),
   clasificación barata (duplicados, alias, menciones) y extracción de
   hechos. Opcional de verdad: cada clasificador chequea la llave primero
   (`classifierEnabled`) y cae a revisión manual si falta, sin romper nada.
3. **Gemini** (`GEMINI_API_KEY`, aistudio.google.com/apikey), fallback de
   mayor calidad para síntesis y clasificación de relaciones; algunos
   clasificadores lo usan como único proveedor cuando la tarea es de
   juicio, no de extracción (ver comentarios en `scripts/db/lib/`). También
   opcional, mismo criterio de degradación explícita que Ollama Cloud.

**PREGUNTA**: pide la llave de Voyage AI primero y no avances de esta fase
sin ella -- explica por qué es la única de las tres que no se puede saltar
("es la que convierte tus hechos en vectores para poder buscarlos y
compararlos; sin ella el sistema no funciona, no es una función de menos").
Después pregunta por Ollama Cloud y Gemini juntas: ¿las tienen ya, o las
creamos ahora? Si el usuario prefiere arrancar sin alguna de esas dos, dile
explícitamente qué deja de funcionar (sin clasificadores automáticos de
duplicados/alias/menciones sin ninguna de las dos) y sigue, esas sí no
bloquean el resto de la instalación.

Cada vez que te pase una llave, escríbela tú mismo en `.env`, nunca le
pidas que edite el archivo él.

## Fase 4: Verificación

```bash
cd scripts/db
node search.mjs "prueba"
node doctor.mjs
```

`search.mjs` debe correr sin error (aunque no haya resultados, la base está
vacía) -- si falla, lo primero que hay que descartar es `VOYAGE_API_KEY`
faltante o mal pegada (`grep VOYAGE_API_KEY .env`), es la causa más
probable dado que `embed()` no tiene manejo de error propio; no avances a
la Fase 5 hasta que esto corra limpio, cualquier fase después de esta
depende de que `embed()` funcione. `doctor.mjs` debe salir "Todo limpio."
Si algo falla, diagnostica y corrige tú antes de seguir, no avances con el
motor roto, y no le pidas al usuario que lo revise él.

**Fase 4 completada.**

## Fase 5: Identidad (SOUL.md / USER.md / MEMORY.md)

Esta es la parte que hace que el asistente se sienta hecho a la medida, no
un chatbot genérico. `SOUL.md`/`USER.md`/`MEMORY.md` vienen en este repo
como plantillas, vas a **reescribirlos** con las respuestas de esta
entrevista, no solo llenar huecos. Esta fase sí es una conversación real,
no algo que puedas automatizar, es la única parte donde "hazlo tú" no
aplica, porque lo que se necesita es que el usuario hable de sí mismo.

Explica antes de empezar: *"Esto no es para configurar el software, es
para que yo sepa quién eres y cómo trabajas, se puede corregir cuando
quieras, nunca queda fijo."*

**PREGUNTA**: ¿Cómo te llamas, y en qué zona horaria trabajas?
→ Escribe en `USER.md`: `Name` y `Timezone`.

**PREGUNTA**: ¿A qué te dedicas? ¿Qué proyectos/roles activos tienes
ahora mismo que yo debería conocer de entrada?
→ Escribe en `USER.md`, sección `Context`. No inventes ni completes con
suposiciones, si el usuario da poco detalle, deja la sección corta; se
completa con el tiempo, no de una vez.

No dependas solo de que el usuario te lo cuente de memoria en este momento,
eso es la fuente más pobre, no la única. Antes de seguir, ofrécele
explícitamente enriquecer el arranque con una fuente ya escrita, en vez de
(o además de) lo que acaba de contar:

- **Documentos y notas dispersas**: la fuente más común no es un solo
  documento prolijo sino ideas repartidas entre varias herramientas a la
  vez -- pregúntalo así, no solo "¿tienes un documento?": *"¿Tienes notas,
  propuestas o ideas guardadas en algún lado -- un archivo (.md, PDF...),
  una app de notas (Evernote, Keep, Notion...), favoritos/marcados
  guardados en el navegador o en una app, un cuaderno físico? Si me dices
  dónde, lo reviso y te propongo los hechos concretos a guardar antes de
  escribir nada, nunca invento, solo extraigo lo que el material
  realmente dice."* El tratamiento depende del formato, no de la fuente:
  para un `.md`, usa `scripts/db/extract-page-facts.mjs --page <ruta>
  --json` -- NUNCA `--review`: esa bandera exige una terminal interactiva
  real, el propio script la rechaza de inmediato si no la tiene ("stdin no
  es TTY"), y correrla vos como agente nunca tiene una (mismo motivo por
  el que el dashboard la reemplazó por `--json`, ver comentarios de
  `extract-page-facts.mjs`). `--json` entrega los candidatos ya
  estructurados con nodos parecidos calculados; muéstraselos tú mismo al
  usuario en la conversación, uno por uno o en bloque, y aprueba/edita/
  descarta cada uno con él antes de guardar nada. Los aprobados se
  guardan con `remember-batch.mjs --file <archivo>` (o por stdin), nunca
  uno por uno con `remember.mjs`, para reusar el chequeo de contradicción
  del lote completo. Cualquier otro formato (exportación `.enex` de
  Evernote, `.html` de una nota o de favoritos del navegador, PDF, texto
  pegado directo en el chat) NO pasa por `extract-page-facts.mjs` -- ese
  script solo acepta `.md` en disco o un slug ya existente en `pages`.
  Léelo tú mismo con tus herramientas (es texto plano o marcado por
  dentro, no necesita conversión) y redacta los hechos a mano siguiendo
  el mismo criterio (atómicos, fechados, con fuente), mostrando cada uno
  antes de guardarlo igual que con `--json`. Si son fotos de un cuaderno
  físico, el usuario necesita transcribirlas primero -- esta fase no hace
  OCR. Si son marcadores/favoritos sin contenido propio (solo enlaces),
  decide con el usuario si vale la pena guardarlos como hechos o dejarlos
  fuera por ser demasiados o poco informativos.
- **Correo**: si tienes un MCP de correo conectado en esta sesión (Gmail u
  otro), ofrécele buscar antecedentes reales de un proyecto que mencionó
  ("¿busco en tu bandeja los últimos correos sobre [proyecto X] para
  armar la cronología?") en vez de pedirle que la reconstruya de memoria.
  Muéstrale los hechos candidatos ANTES de guardar nada, el usuario
  aprueba/edita/descarta, igual que con cualquier extracción automática
  (ver `skills/segundo-cerebro-capture/SKILL.md`).

Si no tiene nada a mano y no quiere que busques en el correo, sigue solo
con lo que contó, esto es un ofrecimiento, no un requisito para avanzar.

**PREGUNTA**: ¿Cómo prefieres que trabaje contigo? Por ejemplo: ¿directo
y crítico, o más exploratorio? ¿idioma por defecto? ¿preguntar antes de
acciones irreversibles, o más autónomo?
→ Escribe en `SOUL.md`, sección `Voice`/`Judgment default`. Si el usuario
no tiene preferencia formada todavía, deja el default del template
(directo, sin relleno, confirma antes de acciones irreversibles) y dilo
explícitamente, no le fuerces a decidir algo que no le importa todavía.

**PREGUNTA**: ¿Hay alguna captura automática de hechos que quieras activa
desde ya? (el hook `Stop` de Claude Code, que revisa al cerrar cada turno
si hay algo capturable, ver Fase 9) ¿O prefieres empezar solo con captura
manual ("guarda este hecho")?
→ Anota la respuesta, se aplica en la Fase 9 (tú activas el hook, no el
usuario).

**PREGUNTA**: `HEARTBEAT.md` trae 5 chequeos ya construidos (ambient-delta,
brain-hygiene, commitments-check, memory-prune, morning-briefing), todos
apagados por defecto, cada uno como un switch independiente. Recórrelos
uno por uno con el usuario, mostrándole qué hace cada uno en una línea
(no le pidas que lea la tabla él solo), y para cada uno que le interese,
corre el comando manualmente ahí mismo para que vea el resultado real
antes de decidir, nunca lo actives a ciegas. Solo pasa `Enabled` a `yes`
en los que el usuario confirme después de ver la salida real, respetando
el ritual de activación del propio archivo (una activación no presta
evidencia a otra).

Con las respuestas, reescribe tú los tres archivos. Estructura de
referencia (no la cambies, es la que el resto del sistema espera;
`MEMORY.md` en particular es lo que se carga en cada sesión):

- `USER.md`: Name, Timezone, Context, Active projects (vacío por ahora),
  People to recognize (vacío), Boundaries (vacío), Handle with care
  (vacío), se llenan con el tiempo, no en esta entrevista.
- `SOUL.md`: mantén la estructura del template, ajusta solo `Voice` y
  `Judgment default` según la respuesta de esta fase.
- `MEMORY.md`: no toques la estructura, es un esqueleto de mantenimiento
  reusable (reglas aprendidas, compromisos abiertos, eventos críticos),
  no contenido personal. Déjalo como está, vacío de entradas reales; se
  llena solo con el uso.

**Fase 5 completada**, muéstrale al usuario los 3 archivos resultantes
para que confirme antes de seguir.

## Fase 6: Estructura inicial de nodos

Un segundo cerebro vacío, sin ningún punto de partida, es más difícil de
organizar después que uno con un andamiaje simple desde el día uno -- ver
`scripts/db/create-node.mjs` (creación de nodos con protección contra
duplicados/colisión de nombre) y `scripts/db/list-supernode-candidates.mjs`
(detecta después, bajo demanda, nodos que quedaron sin agrupar) para el
resto del sistema de nodos; esta fase solo les da un arranque, no reemplaza
esa protección.

Voyage AI ya quedó garantizado desde la Fase 4 (no se avanza sin eso), así
que el chequeo de desambiguación semántica de `create-node.mjs` corre
siempre, sin `--force` -- si bloquea, es una señal real (nombre parecido a
un nodo existente), no un problema de configuración.

Antes de cualquier comando con `--date`, calcula la fecha real (nunca de
memoria, mismo motivo que obliga `--confirm-date` en `remember.mjs`):

```bash
date '+%Y-%m-%d'
```

y reemplaza cada `YYYY-MM-DD` de abajo por ese valor.

**PREGUNTA**:
```
¿Para qué vas a usar 2oBrain?
[ ] Trabajo
[ ] Vida personal
```
(puede marcar una, ambas, o ninguna)

Si no marca ninguna, no crees ningún nodo, sigue directo a la Fase 7 -- no
es un requisito, el usuario puede pedir esta estructura después.

Con la respuesta, crea tú los supernodos con `create-node.mjs`: un nodo raíz
por cada opción marcada, y debajo un conjunto fijo de sub-supernodos. Van
fijos a propósito, no se ofrecen como checklist aparte -- alargaría la
entrevista sin necesidad real, y el usuario siempre puede crear otros
después con el mismo comando:

- **Trabajo** → `proyectos`, `contactos`, `reuniones`
- **Vida personal** → `habitos`, `rutinas`, `espiritualidad`, `salud`

```bash
node scripts/db/create-node.mjs --name trabajo
node scripts/db/create-node.mjs --name proyectos --parent trabajo --date YYYY-MM-DD --reason "estructura inicial de la entrevista de instalación"
node scripts/db/create-node.mjs --name contactos --parent trabajo --date YYYY-MM-DD --reason "estructura inicial de la entrevista de instalación"
node scripts/db/create-node.mjs --name reuniones --parent trabajo --date YYYY-MM-DD --reason "estructura inicial de la entrevista de instalación"

node scripts/db/create-node.mjs --name vida-personal
node scripts/db/create-node.mjs --name habitos --parent vida-personal --date YYYY-MM-DD --reason "estructura inicial de la entrevista de instalación"
node scripts/db/create-node.mjs --name rutinas --parent vida-personal --date YYYY-MM-DD --reason "estructura inicial de la entrevista de instalación"
node scripts/db/create-node.mjs --name espiritualidad --parent vida-personal --date YYYY-MM-DD --reason "estructura inicial de la entrevista de instalación"
node scripts/db/create-node.mjs --name salud --parent vida-personal --date YYYY-MM-DD --reason "estructura inicial de la entrevista de instalación"
```

(Solo crea los de la rama que el usuario marcó -- si marcó únicamente
"Trabajo", no crees `vida-personal` ni sus hijos.)

Si algún comando bloquea por colisión de nombre/alias (no la salta ni
siquiera `--force`, es una protección distinta): es señal de que la Fase 5
ya creó un nodo con ese mismo nombre al extraer un documento/correo. Usa
ese nodo existente en vez de forzar uno nuevo -- o si genuinamente es un
concepto distinto, elige otro nombre para ese supernodo/sub-supernodo.

Estos nodos quedan vacíos a propósito: un supernodo agrupa, no acumula
hechos propios (verificado en la instancia de desarrollo -- el único hecho
que tenía un supernodo real ahí era autodescriptivo, "esto agrupa tal
cosa", no contenido). El contenido real lo traen los hechos que vengan
después.

**PREGUNTA**: ofrece enriquecer la estructura ahora mismo con hechos reales,
mismo espíritu que la Fase 5 (documentos/correo antes que memoria):
*"¿Tienes algún proyecto de trabajo activo, o algún hábito/rutina de tu
vida personal, que quieras que registre ya? Si tienes un MCP de correo
conectado en esta sesión, puedo buscar antecedentes de un proyecto que
menciones, igual que ofrecí en la Fase 5."*

Si el usuario da algo (a mano, o vía correo), por cada hecho candidato:

1. Decide tú, por el contexto de la pregunta que lo originó, a qué
   sub-supernodo pertenece (`proyectos`, `habitos`, etc.) -- no hace falta
   el clasificador automático de `remember.mjs` para esto, el contexto de
   la entrevista ya lo resuelve (mismo criterio que usa `create-node.mjs
   --parent`: quien construye el nodo ya sabe a qué grupo pertenece).
2. Créalo y ligalo en un solo paso:
   `node scripts/db/create-node.mjs --name <nombre-nodo> --parent <sub-supernodo> --date YYYY-MM-DD --reason "..."`
3. Guarda el hecho en el nodo ya creado (sin `--create-node`, ya existe del
   paso anterior):
   `node scripts/db/remember.mjs --claim "..." --date YYYY-MM-DD --source "..." --node <nombre-nodo>`

Muéstrale cada hecho candidato antes de guardarlo, igual que en la Fase 5 --
nunca inventes, solo lo que la fuente real dice.

Si no tiene nada a mano todavía, sigue solo con la estructura vacía -- no es
un requisito, sirve igual como punto de partida para cuando use
`remember.mjs` normalmente más adelante.

**Fase 6 completada.**

## Fase 7: Dashboard local

Levántalo y ábrelo tú mismo, no le digas al usuario que lo abra.
`dashboard-server.mjs` es un servidor persistente, nunca vuelve solo: si
lo corres como un comando bloqueante normal, el paso nunca termina y toda
la instalación se cuelga ahí. Ejecútalo en segundo plano -- con la
herramienta de tu entorno para correr comandos en background si la
tienes (ej. `run_in_background` de Claude Code), o si no, algo
equivalente a:

```bash
cd scripts/db/server
nohup node dashboard-server.mjs > dashboard.log 2>&1 &
```

Verifica que de verdad quedó escuchando antes de seguir (ej. `curl -s
http://localhost:4287 > /dev/null && echo OK`, o revisa `dashboard.log`),
nunca asumas que arrancó solo porque el comando no dio error.

Si tienes un navegador controlable (Claude Code con Browser pane, o
similar), ábrelo en `http://localhost:4287` y confirma en vivo que carga
el dashboard con sus secciones (Buscar/Timeline/Grafo/Doctor/etc.), no le
pidas al usuario que lo revise él salvo que no tengas esa herramienta.

## Fase 8: Servidor MCP (opcional)

Esto es para el USO diario de `search`/`remember` desde esos clientes una
vez instalado (una llamada a herramienta MCP por HTTP, no requiere shell
ni sistema de archivos del lado del cliente), no para instalar 2oBrain
desde ahí -- la instalación en sí (todas las fases anteriores) solo puede
correr desde Claude Code, ver README.

**PREGUNTA**: ¿Quieres que `search`/`remember` estén disponibles para
otros clientes MCP (Claude Desktop, Claude Chat/Cowork, cualquier app que
hable MCP), no solo el dashboard/CLI de este repo?
- **Si NO**: continúa a la Fase 9. Puedes volver a esto cuando quieras, no
  bloquea nada del resto del sistema.
- **Si SÍ**: hay dos opciones, el usuario elige una (o ambas):
  - **Supabase Edge Function** (`supabase/functions/mcp-server/`): si
    tienes el MCP de Supabase conectado (Fase 2), despliégala tú
    directamente con la herramienta `deploy_edge_function` de ese MCP,
    el usuario no necesita instalar nada. Pásale `import_map_path:
    "deno.json"` explícito -- la detección automática del import map está
    rota (falla con "import map path does not exist" si no se pasa a
    mano, ya verificado en vivo). Sin ese MCP, necesita la Supabase CLI
    (`supabase functions deploy mcp-server`), que sí tiene que correr él
    si tú no puedes instalarla de forma confiable en su sistema.
  - **Deno Deploy** (`deno-deploy/mcp-server/`): el usuario necesita
    cuenta en dash.deno.com y generar `DENO_DEPLOY_TOKEN`
    (dash.deno.com/account#access-tokens), eso sí es solo suyo. Una vez
    te lo pase, tú escribes el token en `.env`, llenas `org`/`app` en
    `deno.jsonc` y `deno-deploy/mcp-server/deno.json` con el nombre real
    de su org, y corres el deploy tú mismo:
    `deno run -A jsr:@deno/deploy --prod` desde `deno-deploy/mcp-server/`.

Verifica el deploy elegido con una llamada real (`curl` al endpoint
resultante, o `tools/list` del protocolo MCP) antes de darlo por hecho,
nunca asumas que un deploy funcionó solo porque el comando no dio error.

## Fase 9: Hooks (opcional)

Según la respuesta de la Fase 5, actívalos tú mismo, no describas los pasos
para que el usuario los siga:

- **Hook `Stop`** (recordatorio de captura al cerrar turno): agrégalo tú a
  la configuración de hooks de Claude Code (edita el `settings.json`
  correspondiente) apuntando a `scripts/hooks/stop-capture-check.mjs`;
  revisa la sintaxis vigente de hooks de Claude Code antes de escribirla
  (cambia entre versiones, no la asumas de memoria), no le pidas al
  usuario que la escriba él.
- **Hook `post-commit`**: corre tú `git config core.hooksPath
  scripts/hooks/git` en este repo, una sola vez.
- **Hook `UserPromptSubmit` (`greeting-gate.mjs`)**: detecta un saludo de
  arranque de día ("buenos días", "iniciemos", "qué tenemos para hoy"...)
  y fuerza revisar la sección "Al iniciar sesión" de `MEMORY.md` antes de
  responder, sin depender de que Claude lo recuerde por su cuenta. Actívalo
  tú en la configuración de hooks de Claude Code apuntando a
  `scripts/hooks/greeting-gate.mjs`, mismo criterio que el hook `Stop`
  (revisa la sintaxis vigente antes de escribirla).

Si el usuario no quiere ninguno de los tres, sigue sin ellos, no son
obligatorios para que el resto del sistema funcione.

## Fase 10: Cierre

Muestra esto exacto:

```
Instalación completa. Desde ahora:
- node scripts/db/remember.mjs, guarda un hecho
- node scripts/db/search.mjs "pregunta", busca
- http://localhost:4287, dashboard (búsqueda, grafo, mantenimiento)
- node scripts/db/doctor.mjs, chequeo de salud, cuando quieras
Ver skills/segundo-cerebro-capture/SKILL.md para el detalle de cómo y
cuándo capturar hechos. Si alguna vez trabajas en OTRO repo/sesión sin
acceso a esta base, usa skills/extract-code-facts/SKILL.md ("/extract-code-facts")
para extraer los hechos de esa sesión como JSON y traerlos aquí después.
```

De aquí en adelante, tu comportamiento diario lo definen
`SOUL.md`/`USER.md`/`MEMORY.md` (recién escritos en la Fase 5), no este
archivo, la Fase 0 es la que decide, en cada sesión futura, que ya no hay
que repetir nada de esto.
