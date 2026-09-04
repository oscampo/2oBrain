-- Fase 1: esquema mínimo. Solo texto + slug + tipo, sin extracción todavía.
-- pgvector se habilita ahora para no tener que migrar en Fase 2, pero la
-- columna embedding queda nula hasta entonces.

create extension if not exists vector;

create table if not exists pages (
  id bigint generated always as identity primary key,
  slug text unique not null,
  type text not null,
  title text,
  content text not null,
  tags text[] not null default '{}',
  embedding vector(1024),
  source_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pages_type_idx on pages (type);
create index if not exists pages_tags_idx on pages using gin (tags);

-- Fase 2b (2026-08-22, retroactiva): la regla dura de "fuente obligatoria"
-- que el plano original pedía para TODO recall (principio 3) solo se había
-- aplicado a `facts`, no a `pages` — `source_path` era nullable, así que
-- search_pages() podía devolver una página sin saber de dónde salió. Se
-- verificó que las 30 páginas cargadas hoy ya traían source_path (lo pone
-- load-pages.mjs siempre), así que la constraint no rompe nada existente,
-- solo cierra la puerta a que alguien inserte una página sin fuente en el
-- futuro (a mano, vía SQL directo, saltándose el loader).

alter table pages alter column source_path set not null;

-- 2026-08-22: `embed-pages.mjs` re-embebía las 30 páginas completas en
-- cada corrida, sin importar si el contenido había cambiado. Con Ollama
-- local eso era gratis; con Voyage (Etapa 7) cada corrida manda texto real
-- a una API de pago sin necesidad. `embedded_at` deja re-embeber solo lo
-- que cambió desde el último embed (comparado contra `updated_at`, que a
-- su vez load-pages.mjs ya no toca si el contenido no cambió de verdad).
alter table pages add column if not exists embedded_at timestamptz;

-- Fase 2: búsqueda híbrida (vector + texto completo), fusionada con
-- Reciprocal Rank Fusion (RRF, k=60) — sin necesidad de afinar pesos a mano.
-- Sin reranker: a esta escala (decenas de páginas) la búsqueda híbrida sola
-- alcanza, y así funciona igual desde cualquier dispositivo, incluido el
-- celular, sin depender de un modelo corriendo en una máquina específica.

alter table pages add column if not exists content_tsv tsvector
  generated always as (to_tsvector('spanish', coalesce(title, '') || ' ' || content)) stored;

create index if not exists pages_content_tsv_idx on pages using gin (content_tsv);

-- Migración a Voyage AI (2026-08-22): nomic-embed-text vía Ollama era local
-- y solo inglés/multilingüe-mediocre; voyage-4-lite es multilingüe de
-- verdad, gratis (200M tokens), y se llama por HTTPS desde cualquier lado,
-- incluida la futura Fase 4 (MCP alojado en la nube). Dimensión distinta
-- (1024, no 768), así que no pueden convivir dos modelos en la misma
-- columna: se pone en null y se re-embebe todo (30 páginas, pocos hechos,
-- escala pequeña, migración barata) en vez de mantener dos espacios
-- vectoriales.

do $$
declare
  current_type text;
begin
  select format_type(atttypid, atttypmod) into current_type
  from pg_attribute
  where attrelid = 'pages'::regclass and attname = 'embedding' and not attisdropped;
  if current_type is distinct from 'vector(1024)' then
    execute 'alter table pages alter column embedding type vector(1024) using null';
  end if;
end $$;

drop function if exists search_pages(vector(768), text, int);
drop function if exists search_pages(vector(1024), text, int);

-- 2026-08-28: exclude_slug opcional (default null, no rompe llamadores
-- existentes) para que las páginas de bitácora de construcción (ej.
-- projects/segundo-cerebro-dashboard-log) no compitan en búsquedas
-- normales — un hecho meta que menciona textualmente una pregunta real de
-- prueba puede rankear más alto que el contenido real sobre ese tema
-- (hallazgo en vivo, dashboard "Buscar" + síntesis, 28-ago-2026).
create or replace function search_pages(
  query_embedding vector(1024),
  query_text text,
  match_count int default 10,
  exclude_slug text default null
)
returns table (
  slug text,
  type text,
  title text,
  content text,
  source_path text,
  updated_at timestamptz,
  score float
)
language sql stable as $$
  with vector_ranked as (
    select id, row_number() over (order by embedding <=> query_embedding) as rnk
    from pages
    where embedding is not null and source_path is not null
      and (exclude_slug is null or slug is distinct from exclude_slug)
    order by embedding <=> query_embedding
    limit 50
  ),
  text_ranked as (
    select id, row_number() over (order by ts_rank(content_tsv, plainto_tsquery('spanish', query_text)) desc) as rnk
    from pages
    where content_tsv @@ plainto_tsquery('spanish', query_text) and source_path is not null
      and (exclude_slug is null or slug is distinct from exclude_slug)
    limit 50
  ),
  fused as (
    select coalesce(v.id, t.id) as id,
           coalesce(1.0 / (60 + v.rnk), 0) + coalesce(1.0 / (60 + t.rnk), 0) as score
    from vector_ranked v
    full outer join text_ranked t on v.id = t.id
  )
  select p.slug, p.type, p.title, p.content, p.source_path, p.updated_at, f.score
  from fused f
  join pages p on p.id = f.id
  order by f.score desc
  limit match_count;
$$;

-- Rediseño node (2026-08-29, ver PLAN-nodos.md y hecho #289 de
-- segundo-cerebro): `pages` es herencia literal de gbrain y quedó divorciada
-- de `facts` (4 casos de estudio reales lo confirmaron el mismo día). `nodes`
-- reemplaza a `page_slug` como mecanismo de agrupación: clave natural en
-- texto (no id numérico, "más fácil de identificar humanamente" — decisión
-- del usuario), sin `content` propio — el "contenido" de un nodo es la suma de
-- sus hechos vigentes, nunca una prosa mantenida a mano que se puede
-- desactualizar. `merged_into` deja fusionar nodos sin borrar nada (mismo
-- principio de `valid_until`/`superseded_by` en `facts`): un nodo fusionado
-- sigue existiendo como fila, solo apunta a su reemplazo.
create table if not exists nodes (
  name text primary key,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  merged_into text references nodes(name)
);

-- Nodo "meta" (2026-09-02): sobre el propio segundo cerebro (ej. el nodo que
-- registra la construcción del sistema), no sobre un tema/proyecto de
-- dominio. Verificado en vivo que arruina la minería de relaciones: al
-- registrar TODO lo que pasa en el sistema, "se relaciona" trivialmente con
-- cualquier otro nodo (tautología), e infla el costo de cualquier barrido
-- porque aparece en todos los pares. list-edge-candidates*.mjs lo excluyen
-- siempre. Se marca a mano, nunca se infiere.
alter table nodes add column if not exists is_meta boolean not null default false;

-- Tabla de unión many-to-many: un hecho puede pertenecer a varios nodos (ej.
-- algo sobre Jane Doe que también es sobre atlas-2026), decisión
-- 2026-08-29 tras notar que un `node` de columna única forzaría elegir uno
-- solo. FK real en ambos lados (a diferencia de un `text[]` suelto, que
-- Postgres no puede validar elemento por elemento).
create table if not exists fact_nodes (
  fact_id bigint not null references facts(id) on delete cascade,
  node_name text not null references nodes(name),
  primary key (fact_id, node_name)
);

create index if not exists fact_nodes_node_idx on fact_nodes (node_name);

-- Relación nodo-a-nodo persistente (2026-09-02): distinta de fact_nodes, que
-- conecta nodos solo indirectamente cuando UN hecho puntual menciona a
-- ambos (capacidad que existe desde el diseño de arriba pero que en la
-- práctica nunca se ha usado — 0 hechos con 2+ nodos hasta hoy). node_edges
-- es la conexión declarada explícitamente entre dos nodos que existen
-- independientemente ("John colabora en Atlas", "Atlas está reportado en
-- el plan 2026-2"), sin depender de que algún hecho los mencione juntos.
-- `relation` es texto libre (no un enum fijo) a propósito: la variedad de
-- relaciones humanas reales (colabora_con, parte_de, reportado_en,
-- contacto_de...) no cabe bien en una lista cerrada, y fijarla de antemano
-- solo generaría el mismo problema que un `kind` demasiado rígido. Se crea
-- siempre a mano (node-link.mjs), nunca inferida automáticamente — mismo
-- criterio fail-closed que fusionar nodos: una relación equivocada
-- contamina cualquier future consulta de "qué se conecta con X".
create table if not exists node_edges (
  from_node text not null references nodes(name),
  to_node text not null references nodes(name),
  relation text not null,
  source text not null,
  date date not null,
  created_at timestamptz not null default now(),
  primary key (from_node, to_node, relation),
  check (from_node <> to_node)
);

create index if not exists node_edges_to_idx on node_edges (to_node);

alter table node_edges enable row level security;

-- Memoria de qué pares de nodos ya se compararon con el LLM buscando
-- relaciones no literales (list-edge-candidates-deep.mjs, 2026-09-02) — sin
-- esto, cada corrida futura repetiría TODOS los pares desde cero, y el
-- costo crecería cuadráticamente con el número de nodos. Con esto, solo se
-- re-evalúa un par si algún lado tiene hechos nuevos desde el último check
-- (fact_count_a/b guardan el conteo al momento de revisar). node_a/node_b
-- siempre en orden alfabético (mismo par sin importar el orden de entrada),
-- para no duplicar el registro.
create table if not exists node_pair_checks (
  node_a text not null references nodes(name),
  node_b text not null references nodes(name),
  fact_count_a int not null,
  fact_count_b int not null,
  edges_found int not null default 0,
  model text not null,
  checked_at timestamptz not null default now(),
  primary key (node_a, node_b),
  check (node_a < node_b)
);

alter table node_pair_checks enable row level security;

alter table fact_nodes enable row level security;

-- RLS deny-all (ninguna política) para los roles anon/authenticated de
-- PostgREST — nuestro propio acceso (scripts vía SUPABASE_DB_URL, MCP vía
-- supabase-js con service_role) no pasa por esos roles, así que esto no
-- rompe nada propio, solo cierra el hueco de exposición pública. `pages` y
-- `facts` la tenían desde el incidente real de la Etapa 15 (2026-08-25,
-- alerta CRITICAL de Supabase) pero nunca quedó escrita aquí — se agrega
-- retroactivamente para que schema.sql sea la fuente de verdad completa,
-- no solo lo nuevo. Idempotente: alter...enable no falla si ya estaba.
alter table pages enable row level security;
alter table facts enable row level security;
alter table nodes enable row level security;

-- Fase 3: hechos atómicos con fecha y fuente OBLIGATORIAS (nunca nullable) —
-- la fecha se captura al momento de escribir, nunca se adivina después
-- sobre texto libre (principio 2 del plano), y ningún hecho existe sin
-- saber de dónde salió (principio 3).

create table if not exists facts (
  id bigint generated always as identity primary key,
  page_slug text references pages(slug) on delete set null,
  claim text not null,
  kind text not null default 'fact',
  date date not null,
  source text not null,
  confidence real not null default 1.0,
  created_at timestamptz not null default now()
);

create index if not exists facts_page_slug_idx on facts (page_slug);
create index if not exists facts_date_idx on facts (date);

-- Fase 4: detección de contradicciones al momento de escribir un hecho —
-- no basta con confiar en que quien capture recuerde buscar antes, el gate
-- vive en remember.mjs mismo, así que corre sin importar qué sesión llame.
-- `valid_until` null = hecho vigente; uno reemplazado apunta a su reemplazo
-- vía `superseded_by`, sin borrar nada (historial completo queda consultable
-- con `--all` en timeline.mjs).

alter table facts add column if not exists embedding vector(1024);
alter table facts add column if not exists valid_until timestamptz;
alter table facts add column if not exists superseded_by bigint references facts(id);

alter table facts add column if not exists content_tsv tsvector
  generated always as (to_tsvector('spanish', claim)) stored;

create index if not exists facts_content_tsv_idx on facts using gin (content_tsv);
create index if not exists facts_live_idx on facts (valid_until) where valid_until is null;

do $$
declare
  current_type text;
begin
  select format_type(atttypid, atttypmod) into current_type
  from pg_attribute
  where attrelid = 'facts'::regclass and attname = 'embedding' and not attisdropped;
  if current_type is distinct from 'vector(1024)' then
    execute 'alter table facts alter column embedding type vector(1024) using null';
  end if;
end $$;

-- Fase 5: búsqueda general sobre `facts`, independiente de `pages` — la
-- misma pregunta debe encontrar un hecho vigente aunque la página asociada
-- (si existe) no rankee bien, y sin importar de qué carpeta venga (people/,
-- projects/, guides/, daily/, wiki/): la fricción pages-vs-facts no es un
-- problema de people/, es un problema de tener dos dominios separados, y
-- se cierra a nivel de búsqueda, no carpeta por carpeta.

drop function if exists facts_search(vector(768), text, int);
drop function if exists facts_search(vector(1024), text, int);

-- Rediseño node (2026-08-29): exclude_page_slug -> exclude_node, filtra
-- contra fact_nodes en vez de la columna page_slug (retirada más adelante
-- en esta misma etapa). page_slug era una relación 1:1, node es N:N, así
-- que la columna de salida cambia de `page_slug text` a `nodes text`
-- (agregados con string_agg) — mismo motivo por el que hace falta el
-- `drop function` primero (create or replace no permite cambiar el tipo
-- de retorno, ver Etapa 2b/7).
drop function if exists facts_search(vector(1024), text, int, text);

-- Hallazgo 2026-08-31: una pregunta que nombra un proyecto por su nodo (ej.
-- "estado del proyecto Atlas") puede no encontrar nada, aunque node-status.mjs
-- sí resuelve ese mismo nodo sin problema — porque content_tsv solo indexa
-- `claim`, y la palabra "Atlas" (o cualquier alias del nodo) puede no
-- aparecer literalmente en ningún hecho vigente (ver atlas-2026: sus
-- hechos hablan de Jane Doe/la universidad socia/el pitch, nunca dicen "Atlas"). Se
-- agrega una tercera rama de RRF que compara el nombre/alias del nodo
-- ligado a cada hecho contra la consulta, para que el nombre del proyecto
-- sea, por sí solo, una señal de búsqueda válida.
drop function if exists facts_search(vector(1024), text, int, text);

create or replace function facts_search(
  query_embedding vector(1024),
  query_text text,
  match_count int default 10,
  exclude_node text default null
)
returns table (
  id bigint,
  claim text,
  date date,
  source text,
  kind text,
  nodes text,
  score float
)
language sql stable as $$
  with vector_ranked as (
    select id, row_number() over (order by embedding <=> query_embedding) as rnk
    from facts
    where embedding is not null and valid_until is null
      and (exclude_node is null or not exists (
        select 1 from fact_nodes fn where fn.fact_id = facts.id and fn.node_name = exclude_node
      ))
    order by embedding <=> query_embedding
    limit 50
  ),
  text_ranked as (
    select id, row_number() over (order by ts_rank(content_tsv, plainto_tsquery('spanish', query_text)) desc) as rnk
    from facts
    where content_tsv @@ plainto_tsquery('spanish', query_text) and valid_until is null
      and (exclude_node is null or not exists (
        select 1 from fact_nodes fn where fn.fact_id = facts.id and fn.node_name = exclude_node
      ))
    limit 50
  ),
  node_ranked as (
    select id, row_number() over (order by best_rank desc) as rnk
    from (
      select fn.fact_id as id,
             max(ts_rank(
               to_tsvector('spanish', replace(n.name, '-', ' ') || ' ' || coalesce(array_to_string(n.aliases, ' '), '')),
               -- OR entre términos, no AND: plainto_tsquery exige los DOS
               -- términos ("proyecto" Y "coil"), pero el nombre/alias de un
               -- nodo nunca va a contener palabras genéricas como
               -- "proyecto" — basta con que UNO matchee (ver hallazgo
               -- 2026-08-31 arriba).
               to_tsquery('spanish', replace(plainto_tsquery('spanish', query_text)::text, ' & ', ' | '))
             )) as best_rank
      from fact_nodes fn
      join nodes n on n.name = fn.node_name
      join facts f on f.id = fn.fact_id
      where f.valid_until is null
        and to_tsvector('spanish', replace(n.name, '-', ' ') || ' ' || coalesce(array_to_string(n.aliases, ' '), ''))
              @@ to_tsquery('spanish', replace(plainto_tsquery('spanish', query_text)::text, ' & ', ' | '))
        and (exclude_node is null or not exists (
          select 1 from fact_nodes fn2 where fn2.fact_id = fn.fact_id and fn2.node_name = exclude_node
        ))
      group by fn.fact_id
    ) best
    limit 50
  ),
  fused as (
    -- node_ranked usa 1/rnk (no 1/(60+rnk) como las otras dos): un match
    -- literal de nombre/alias de nodo es una señal mucho más fuerte y
    -- confiable que similitud de vector o de texto genérico (mismo criterio
    -- de prioridad léxica que classify-node.mjs, Etapa 2) — con la
    -- constante 60 quedaba diluido casi a cero (0.016 vs ~0.03-0.05 de los
    -- matches genuinos) y nunca entraba en el pool de match_count antes del
    -- rerank, aunque sí aparecía si se pedían cientos de candidatos.
    select coalesce(v.id, t.id, n.id) as id,
           coalesce(1.0 / (60 + v.rnk), 0) + coalesce(1.0 / (60 + t.rnk), 0) + coalesce(1.0 / n.rnk, 0) as score
    from vector_ranked v
    full outer join text_ranked t on v.id = t.id
    full outer join node_ranked n on coalesce(v.id, t.id) = n.id
  )
  select f.id, f.claim, f.date, f.source, f.kind,
         (select string_agg(node_name, ', ' order by node_name) from fact_nodes where fact_id = f.id) as nodes,
         fu.score
  from fused fu
  join facts f on f.id = fu.id
  order by fu.score desc
  limit match_count;
$$;

-- Fase 4 del plan (MCP propio, 2026-08-22): remember.mjs hace este chequeo
-- de similitud con SQL crudo vía pg, pero el Edge Function del MCP solo
-- tiene el cliente supabase-js (RPC, no SQL arbitrario) — se expone la
-- misma lógica como función para que ambos caminos (CLI y MCP) compartan
-- exactamente el mismo criterio, no una reimplementación aparte.

-- Rediseño node (2026-08-29): esta se quedó sin migrar en la primera pasada
-- de schema.sql porque solo la usan los dos servidores MCP (nadie más la
-- llama, ver grep), no scripts/db/*.mjs — page_slug -> nodes, mismo patrón
-- que facts_search/facts_timeline.
drop function if exists facts_similar(vector(1024), int);

create or replace function facts_similar(query_embedding vector(1024), match_count int default 5)
returns table (
  id bigint,
  claim text,
  date date,
  source text,
  kind text,
  nodes text,
  similarity float
)
language sql stable as $$
  select f.id, f.claim, f.date, f.source, f.kind,
         (select string_agg(node_name, ', ' order by node_name) from fact_nodes where fact_id = f.id) as nodes,
         1 - (f.embedding <=> query_embedding) as similarity
  from facts f
  where f.valid_until is null and f.embedding is not null
  order by f.embedding <=> query_embedding
  limit match_count;
$$;

-- Etapa 2 (PLAN-nodos.md, 2026-08-29): desambiguación de nodos vía búsqueda
-- vectorial en vez de comparar nombres o mandar todos los claims de cada
-- nodo a un LLM. No hay `nodes.embedding` que mantener (evita recalcular un
-- centroide cada vez que se agrega/retracta un hecho): se compara el claim
-- nuevo contra los embeddings de hechos individuales ya existentes (que ya
-- se generan siempre), se agrupa por nodo vía fact_nodes, y se rankea por
-- nodo según su mejor (más similar) hecho. Barato, siempre actualizado sin
-- mantenimiento aparte. Un nodo fusionado (merged_into) no debería aparecer
-- nunca aquí: merge-nodes.mjs reasigna sus fact_nodes al nodo destino, así
-- que uno vacío simplemente no compite.
--
-- 2026-08-30: un solo ejemplo por nodo (el mejor) demostró en producción no
-- alcanzar — si el mejor hecho vigente de un nodo resulta ser de un subtema
-- distinto al que realmente coincide, el LLM se deja llevar por la
-- similitud temática del ejemplo mostrado y elige el nodo equivocado (caso
-- real documentado en PLAN-nodos.md Etapa 2). Ahora se devuelven hasta
-- `examples_per_node` ejemplos (los más similares) por nodo candidato, para
-- que el clasificador vea el patrón del nodo, no un solo punto de datos.
-- 2026-08-30, segunda vuelta: los 3 ejemplos tampoco alcanzaron para el caso
-- DB1/DB2 -- diagnóstico correcto esta vez: ningún ejemplo cubre el subtema
-- del hecho nuevo (infraestructura genérica de GitHub que no diferencia los
-- cursos), así que ni el retrieval ni el LLM tienen señal temática real. La
-- única señal que sí distingue es el nombre literal del curso en el texto,
-- y `nodes.aliases` (existe desde la Etapa 1, nunca poblado) es justo para
-- esto: se agrega al resultado para que el clasificador pueda buscar
-- coincidencia léxica explícita, no solo similitud de embeddings.
drop function if exists nodes_similar(vector(1024), int, int);

create or replace function nodes_similar(query_embedding vector(1024), match_count int default 5, examples_per_node int default 3)
returns table (
  node_name text,
  similarity float,
  examples text[],
  aliases text[]
)
language sql stable as $$
  with ranked as (
    select fn.node_name, f.claim,
           1 - (f.embedding <=> query_embedding) as similarity,
           row_number() over (partition by fn.node_name order by f.embedding <=> query_embedding) as rnk
    from fact_nodes fn
    join facts f on f.id = fn.fact_id
    where f.valid_until is null and f.embedding is not null
  ),
  per_node as (
    select node_name,
           max(similarity) filter (where rnk = 1) as similarity,
           array_agg(claim order by rnk) filter (where rnk <= examples_per_node) as examples
    from ranked
    group by node_name
  )
  select pn.node_name, pn.similarity, pn.examples, n.aliases
  from per_node pn
  join nodes n on n.name = pn.node_name
  order by pn.similarity desc
  limit match_count;
$$;

-- Rediseño node (2026-08-29): p_slug -> p_node, filtra contra fact_nodes;
-- page_slug -> nodes (agregada). Mismo drop-first que facts_search, cambia
-- el tipo de retorno.
drop function if exists facts_timeline(text, int, boolean);

create or replace function facts_timeline(p_node text default null, match_count int default 20, p_all boolean default false)
returns table (
  id bigint,
  date date,
  claim text,
  kind text,
  source text,
  confidence real,
  nodes text,
  valid_until timestamptz,
  superseded_by bigint
)
language sql stable as $$
  select f.id, f.date, f.claim, f.kind, f.source, f.confidence,
         (select string_agg(node_name, ', ' order by node_name) from fact_nodes where fact_id = f.id) as nodes,
         f.valid_until, f.superseded_by
  from facts f
  where (p_node is null or exists (
    select 1 from fact_nodes fn where fn.fact_id = f.id and fn.node_name = p_node
  ))
    and (p_all or f.valid_until is null)
  order by f.date desc, f.created_at desc
  limit match_count;
$$;

-- Router de nodos (hallazgo 2026-08-31, ver PLAN-nodos.md): dado un
-- conjunto de nombres de nodo ya resueltos (matching por nombre/alias
-- corre en JS/TS del lado del llamador — search.mjs y los dos servidores
-- MCP), trae TODOS sus hechos vigentes, no solo los que sobrevivan
-- RRF/rerank de facts_search. total_count (vía count(*) over()) permite
-- al llamador avisar cuántos quedaron fuera del límite sin una segunda
-- consulta.
drop function if exists node_match_facts(text[], int);

create or replace function node_match_facts(
  node_names text[],
  match_count int default 15
)
returns table (
  id bigint,
  claim text,
  date date,
  source text,
  kind text,
  nodes text,
  total_count bigint
)
language sql stable as $$
  with matched as (
    select distinct f.id, f.claim, f.date, f.source, f.kind
    from facts f
    join fact_nodes fn on fn.fact_id = f.id
    where fn.node_name = any(node_names) and f.valid_until is null
  )
  select m.id, m.claim, m.date, m.source, m.kind,
         (select string_agg(node_name, ', ' order by node_name) from fact_nodes where fact_id = m.id) as nodes,
         count(*) over () as total_count
  from matched m
  order by m.date desc
  limit match_count;
$$;
