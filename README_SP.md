# 2oBrain ([English](https://github.com/oscampo/2oBrain/blob/2adffe7045e5791d03098e55bd871301ba024913/README.md)/Español)
Un "segundo cerebro" de registros+recuerdos: registros atómicos, fechados y con fuente en Postgres (Supabase), agrupados en recuerdos (proyectos, personas, temas), consultables por cualquier cliente MCP (Claude o cualquier otro que hable MCP), con un panel local para búsqueda/captura/mantenimiento y un gráfico interactivo dirigido por fuerzas sobre cómo se conectan tus recuerdos.

No es una aplicación para tomar notas. No es una wiki. Cada hecho tiene una fecha y una fuente, siempre; ningún hecho se "recuerda" desde la memoria de un LLM, solo se recupera de lo que realmente se escribió.

## Accede a él desde cualquier lugar

La base de datos es la única fuente de verdad, no una aplicación o máquina en particular. Una vez desplegado el servidor MCP alojado (Fase 7 de la instalación), las mismas funciones `search`/`remember` alcanzan a cualquier cliente en el que te encuentres: Claude Code, Claude Chat, Claude Cowork, una CLI genérica que hable MCP, escritorio o móvil, sin un paso de sincronización independiente y sin configuración específica por cliente más allá de conectarse a esa única URL. Esto no es una aspiración: el mismo diseño fue verificado en vivo en esas cuatro superficies (Code, Chat, Cowork, una CLI genérica) y desde un teléfono, antes de que existiera este andamiaje. Ningún cliente recibe una ruta especial ni una degradada; el servidor MCP es la misma capa delgada para todos ellos.

## Arquitectura

* **`scripts/db/`**, el motor. Scripts de CLI, una sola tarea cada uno: `remember.mjs` escribe un hecho, `search.mjs` encuentra registros+recuerdos (búsqueda híbrida de vectores+texto completo), `timeline.mjs` lista el historial de un recuerdo, `merge-memories.mjs`/`memory-link.mjs` gestionan el gráfico de recuerdos, `doctor.mjs` verifica la integridad, y una docena más. Cada script es un CLI normal de Node, ejecútalo directamente, sin frameworks.
* **`scripts/db/server/`**, un servidor local de Hono que expone esos mismos scripts sobre HTTP para un panel web en el navegador (`scripts/db/server/public/`): búsqueda con respuestas sintetizadas por LLM, un gráfico interactivo d3-force de tus recuerdos, captura de hechos y mantenimiento de recuerdos.
* **`deno-deploy/mcp-server/`** y **`supabase/functions/mcp-server/`**, dos servidores MCP alojados e intercambiables (elige uno o ejecuta ambos) que exponen `search`/`remember` a cualquier cliente MCP a través de la red: Claude Desktop, Claude Code, Claude Chat/Cowork o cualquier otra cosa que hable MCP.
* **`scripts/hooks/`**, un hook `Stop` para Claude Code (automáticamente captura un hecho antes de cerrar un turno), un hook `UserPromptSubmit` (detecta un saludo de inicio de día y fuerza la revisión de la lista de verificación de inicio en `MEMORY.md`, de forma determinista, no esperando que Claude lo recuerde).
* **`skills/`**, `segundo-cerebro-capture` (cuándo/cómo guardar un hecho desde una sesión que tiene acceso a la BD) y `extract-code-records` (extraer registros de una sesión que *no* tiene acceso a este repositorio, otro proyecto, un contenedor remoto, como JSON que traes de vuelta e ingieres más tarde).

## Inicio rápido

**Requiere Claude Code** (terminal, la pestaña Code de la aplicación de escritorio, o una extensión de VS Code/JetBrains), en cualquier lugar con acceso real al sistema de archivos y a la terminal. Esto no funcionará desde Claude Chat (web/móvil de claude.ai) ni Cowork: ninguno de los dos tiene las herramientas para clonar un repositorio, escribir un `.env` o mantener un servidor local ejecutándose; pegar el mensaje a continuación en alguno de ellos simplemente fallará o se detendrá sin un progreso real.

En Claude Code, dile:

```
Sigue las instrucciones definidas aquí: https://github.com/oscampo/2oBrain

```

Ese único mensaje está diseñado para ser suficiente, incluso en una sesión completamente nueva sin nada clonado aún. Antes de cualquier otra cosa, el agente hará lo siguiente:

1. Comprobar si `git` está instalado (`git --version`); si no es así, instalarlo por sí mismo para el SO detectado, sin pedirte que vayas a hacerlo tú.
2. Clonar este repositorio (`git clone [https://github.com/oscampo/2oBrain.git](https://github.com/oscampo/2oBrain.git)`) en una carpeta lógica, `./2oBrain/` por defecto, a menos que colisione con algo que ya esté allí.
3. Desvincularlo de este repositorio (`git remote remove origin`), dentro de la nueva carpeta: una clonación sigue apuntando a `oscampo/2oBrain` por defecto, y tu copia está destinada a ser completamente tuya, no un fork que alguien pueda confundir con un lugar al que enviar cambios.
4. Entrar en esa carpeta y continuar desde `CLAUDE.md`, que es un script de instalación guiada, no documentación para leer de forma pasiva.

A partir de ahí, `CLAUDE.md` se encarga de todo de principio a fin: crear el proyecto de Supabase y aplicar `scripts/db/schema.sql`, rellenar el `.env` (consulta `.env.example`), elegir qué servidor MCP desplegar (o saltarte eso y usar solo el panel/CLI), y conocerte. Los hechos sobre ti van a `records` bajo la categoría `usuario` en tu propia base de datos, y cómo quieres que se comporte el asistente se escribe directamente en la sección "Cómo trabajar con el usuario" de `CLAUDE.md`.
Una vez instalado, vuelve a abrir tu agente **desde el interior de esta carpeta clonada** en futuras sesiones. Eso es lo que hace que la identidad de tu `CLAUDE.md`/`MEMORY.md` persista de un turno a otro en lugar de empezar de cero cada vez, y es lo que estarás consultando con `search`/`memory-status.mjs` desde cualquier otro cliente.

## Lo que no se incluye aquí

Tus propios registros, recuerdos y cualquier página narrativa en tu carpeta local `2oBrain` son tuyos; este repositorio se entrega vacío (ignorado por git por defecto, consulta `.gitignore`). `MEMORY.md` se incluye como una plantilla en blanco que el script de entrevista rellenará contigo, no como un ejemplo trabajado.

## Licencia

MIT, consulta `LICENSE`.
