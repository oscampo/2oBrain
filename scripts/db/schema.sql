-- Fase 1: esquema minimo. Solo texto + slug + tipo, sin extraccion todavia.
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
-- que el plano original pedia para TODO recall (principio 3) solo se habia
-- aplicado a `records`, no a `pages` -- `source_path` era nullable, asi que
-- search_pages() podia devolver una pagina sin saber de donde salio. Se
-- verifico que las 30 paginas cargadas hoy ya traian source_path (lo pone
-- load-pages.mjs siempre), asi que la constraint no rompe nada existente,
-- solo cierra la puerta a que alguien inserte una pagina sin fuente en el
-- futuro (a mano, via SQL directo, saltandose el loader).

alter table pages alter column source_path set not null;

-- 2026-08-22: `embed-pages.mjs` re-embebia las 30 paginas completas en
-- cada corrida, sin importar si el contenido habia cambiado. Con Ollama
-- local eso era gratis; con Voyage (Etapa 7) cada corrida manda texto real
-- a una API de pago sin necesidad. `embedded_at` deja re-embeber solo lo
-- que cambio desde el ultimo embed (comparado contra `updated_at`, que a
-- su vez load-pages.mjs ya no toca si el contenido no cambio de verdad).
alter table pages add column if not exists embedded_at timestamptz;

-- Fase 2: busqueda hibrida (vector + texto completo), fusionada con
-- Reciprocal Rank Fusion (RRF, k=60), sin necesidad de afinar pesos a mano.
-- Sin reranker: a esta escala (decenas de paginas) la busqueda hibrida sola
-- alcanza, y asi funciona igual desde cualquier dispositivo, incluido el
-- celular, sin depender de un modelo corriendo en una maquina especifica.

alter table pages add column if not exists content_tsv tsvector
  generated always as (to_tsvector('spanish', coalesce(title, '') || ' ' || content)) stored;

create index if not exists pages_content_tsv_idx on pages using gin (content_tsv);

-- Migracion a Voyage AI (2026-08-22): nomic-embed-text via Ollama era local
-- y solo ingles/multilingue-mediocre; voyage-4-lite es multilingue de
-- verdad, gratis (200M tokens), y se llama por HTTPS desde cualquier lado,
-- incluida la futura Fase 4 (MCP alojado en la nube). Dimension distinta
-- (1024, no 768), asi que no pueden convivir dos modelos en la misma
-- columna: se pone en null y se re-embebe todo (30 paginas, pocos registros,
-- escala pequena, migracion barata) en vez de mantener dos espacios
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
-- existentes) para que las paginas de bitacora de construccion (ej.
-- projects/segundo-cerebro-dashboard-log) no compitan en busquedas
-- normales -- un registro meta que menciona textualmente una pregunta real de
-- prueba puede rankear mas alto que el contenido real sobre ese tema
-- (hallazgo en vivo, dashboard "Buscar" + sintesis, 28-ago-2026).
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

-- Rediseno memory (2026-08-29, ver PLAN-recuerdos.md y registro #289 de
-- segundo-cerebro): `pages` es herencia literal de gbrain y quedo divorciada
-- de `records` (4 casos de estudio reales lo confirmaron el mismo dia).
-- `memories` reemplaza a `page_slug` como mecanismo de agrupacion: clave
-- natural en texto (no id numerico, "mas facil de identificar humanamente",
-- decision del usuario), sin `content` propio -- el "contenido" de una
-- recuerdo es la suma de sus registros vigentes, nunca una prosa mantenida a
-- mano que se puede desactualizar. `merged_into` deja fusionar recuerdos sin
-- borrar nada (mismo principio de `valid_until`/`superseded_by` en
-- `records`): un recuerdo fusionado sigue existiendo como fila, solo apunta
-- a su reemplazo.
--
-- Terminologia (2026-09-05): "recuerdo" (tabla `memories` en el codigo, en
-- ingles para el scaffold generico) es el equivalente conceptual de lo que
-- antes se llamaba "nodo" -- una entidad/tema que agrupa registros
-- (hecho/evento/compromiso, ahora "registro") a lo largo del tiempo.
-- "Categoria" y "subcategoria" (antes "supernodo"/"sub-supernodo") NO son
-- una tabla aparte: son recuerdos comunes, conectados a sus hijos por
-- convencion via `memory_links` (nunca forzado por FK), a proposito -- ver
-- el comentario de `memory_links` mas abajo sobre por que la jerarquia no
-- se fuerza en el schema.
create table if not exists memories (
  name text primary key,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  merged_into text references memories(name)
);

-- Recuerdo "meta" (2026-09-02): sobre el propio segundo cerebro (ej. el
-- recuerdo que registra la construccion del sistema), no sobre un
-- tema/proyecto de dominio. Verificado en vivo que arruina la mineria de
-- relaciones: al registrar TODO lo que pasa en el sistema, "se relaciona"
-- trivialmente con cualquier otro recuerdo (tautologia), e infla el costo de
-- cualquier barrido porque aparece en todos los pares. list-link-candidates*.mjs
-- lo excluyen siempre. Se marca a mano, nunca se infiere.
alter table memories add column if not exists is_meta boolean not null default false;

-- Tabla de union many-to-many: un registro puede pertenecer a varias
-- recuerdos (ej. algo sobre Jane Doe que tambien es sobre atlas-2026),
-- decision 2026-08-29 tras notar que un recuerdo de columna unica forzaria
-- elegir una sola. FK real en ambos lados (a diferencia de un `text[]`
-- suelto, que Postgres no puede validar elemento por elemento).
create table if not exists record_memories (
  record_id bigint not null references records(id) on delete cascade,
  memory_name text not null references memories(name),
  primary key (record_id, memory_name)
);

create index if not exists record_memories_memory_idx on record_memories (memory_name);

-- Relacion recuerdo-a-recuerdo persistente (2026-09-02): distinta de
-- record_memories, que conecta recuerdos solo indirectamente cuando UN
-- registro puntual menciona a ambas (capacidad que existe desde el diseno
-- de arriba pero que en la practica nunca se ha usado -- 0 registros con
-- 2+ recuerdos hasta hoy). `memory_links` es la conexion declarada
-- explicitamente entre dos recuerdos que existen independientemente ("John
-- colabora en Atlas", "Atlas esta reportado en el plan 2026-2"), sin
-- depender de que algun registro las mencione juntas. Tambien es el
-- mecanismo de la jerarquia categoria > subcategoria > recuerdo (2026-09-05):
-- una categoria/subcategoria es un recuerdo comun conectado a sus hijos por
-- una fila aqui (`relation` como 'pertenece_a' o similar), nunca una
-- columna/FK dedicada -- la jerarquia existe por convencion, no forzada por
-- el schema, a proposito (ver `relation` abajo).
-- `relation` es texto libre (no un enum fijo) a proposito: la variedad de
-- relaciones humanas reales (colabora_con, parte_de, reportado_en,
-- contacto_de, pertenece_a...) no cabe bien en una lista cerrada, y fijarla
-- de antemano solo generaria el mismo problema que un `kind` demasiado
-- rigido. Se crea siempre a mano (memory-link.mjs), nunca inferida
-- automaticamente, mismo criterio fail-closed que fusionar recuerdos: una
-- relacion equivocada contamina cualquier futura consulta de "que se
-- conecta con X".
create table if not exists memory_links (
  from_memory text not null references memories(name),
  to_memory text not null references memories(name),
  relation text not null,
  source text not null,
  date date not null,
  created_at timestamptz not null default now(),
  primary key (from_memory, to_memory, relation),
  check (from_memory <> to_memory)
);

create index if not exists memory_links_to_idx on memory_links (to_memory);

alter table memory_links enable row level security;

-- Memoria (en sentido literal de cache, no de la tabla de recuerdos) de que
-- pares de recuerdos ya se compararon con el LLM buscando relaciones no
-- literales (list-link-candidates-deep.mjs, 2026-09-02), sin esto, cada
-- corrida futura repetiria TODOS los pares desde cero, y el costo creceria
-- cuadraticamente con el numero de recuerdos. Con esto, solo se re-evalua un
-- par si algun lado tiene registros nuevos desde el ultimo check
-- (record_count_a/b guardan el conteo al momento de revisar). memory_a/memory_b
-- siempre en orden alfabetico (mismo par sin importar el orden de entrada),
-- para no duplicar el registro.
create table if not exists memory_pair_checks (
  memory_a text not null references memories(name),
  memory_b text not null references memories(name),
  record_count_a int not null,
  record_count_b int not null,
  links_found int not null default 0,
  model text not null,
  checked_at timestamptz not null default now(),
  primary key (memory_a, memory_b),
  check (memory_a < memory_b)
);

alter table memory_pair_checks enable row level security;

alter table record_memories enable row level security;

-- RLS deny-all (ninguna politica) para los roles anon/authenticated de
-- PostgREST -- nuestro propio acceso (scripts via SUPABASE_DB_URL, MCP via
-- supabase-js con service_role) no pasa por esos roles, asi que esto no
-- rompe nada propio, solo cierra el hueco de exposicion publica. `pages` y
-- `records` la tenian desde el incidente real de la Etapa 15 (2026-08-25,
-- alerta CRITICAL de Supabase) pero nunca quedo escrita aqui, se agrega
-- retroactivamente para que schema.sql sea la fuente de verdad completa,
-- no solo lo nuevo. Idempotente: alter...enable no falla si ya estaba.
alter table pages enable row level security;
alter table records enable row level security;
alter table memories enable row level security;

-- Fase 3: registros atomicos con fecha y fuente OBLIGATORIAS (nunca
-- nullable), la fecha se captura al momento de escribir, nunca se adivina
-- despues sobre texto libre (principio 2 del plano), y ningun registro
-- existe sin saber de donde salio (principio 3).

create table if not exists records (
  id bigint generated always as identity primary key,
  page_slug text references pages(slug) on delete set null,
  claim text not null,
  kind text not null default 'fact',
  date date not null,
  source text not null,
  confidence real not null default 1.0,
  created_at timestamptz not null default now()
);

create index if not exists records_page_slug_idx on records (page_slug);
create index if not exists records_date_idx on records (date);

-- Fase 4: deteccion de contradicciones al momento de escribir un registro,
-- no basta con confiar en que quien capture recuerde buscar antes, el gate
-- vive en remember.mjs mismo, asi que corre sin importar que sesion llame.
-- `valid_until` null = registro vigente; uno reemplazado apunta a su
-- reemplazo via `superseded_by`, sin borrar nada (historial completo queda
-- consultable con `--all` en timeline.mjs).

alter table records add column if not exists embedding vector(1024);
alter table records add column if not exists valid_until timestamptz;
alter table records add column if not exists superseded_by bigint references records(id);

alter table records add column if not exists content_tsv tsvector
  generated always as (to_tsvector('spanish', claim)) stored;

create index if not exists records_content_tsv_idx on records using gin (content_tsv);
create index if not exists records_live_idx on records (valid_until) where valid_until is null;

do $$
declare
  current_type text;
begin
  select format_type(atttypid, atttypmod) into current_type
  from pg_attribute
  where attrelid = 'records'::regclass and attname = 'embedding' and not attisdropped;
  if current_type is distinct from 'vector(1024)' then
    execute 'alter table records alter column embedding type vector(1024) using null';
  end if;
end $$;

-- Fase 5: busqueda general sobre `records`, independiente de `pages`, la
-- misma pregunta debe encontrar un registro vigente aunque la pagina
-- asociada (si existe) no rankee bien, y sin importar de que carpeta venga
-- (people/, projects/, guides/, daily/, wiki/): la friccion pages-vs-records
-- no es un problema de people/, es un problema de tener dos dominios
-- separados, y se cierra a nivel de busqueda, no carpeta por carpeta.

drop function if exists facts_search(vector(768), text, int);
drop function if exists facts_search(vector(1024), text, int);

-- Rediseno memory (2026-08-29): exclude_page_slug -> exclude_node, filtra
-- contra fact_nodes en vez de la columna page_slug (retirada mas adelante en
-- esta misma etapa). page_slug era una relacion 1:1, node era N:N, asi que
-- la columna de salida cambia de `page_slug text` a `nodes text` (agregados
-- con string_agg), mismo motivo por el que hace falta el `drop function`
-- primero (create or replace no permite cambiar el tipo de retorno, ver
-- Etapa 2b/7).
drop function if exists facts_search(vector(1024), text, int, text);

-- Renombrado (2026-09-05): facts_search -> records_search, exclude_node ->
-- exclude_memory, fact_nodes -> record_memories, nodes -> memories, mismo
-- drop-first (cambia nombre de funcion Y tipo de retorno).
drop function if exists facts_search(vector(1024), text, int, text);

-- Hallazgo 2026-08-31: una pregunta que nombra un proyecto por su recuerdo
-- (ej. "estado del proyecto Atlas") puede no encontrar nada, aunque
-- memory-status.mjs si resuelve ese mismo recuerdo sin problema, porque
-- content_tsv solo indexa `claim`, y la palabra "Atlas" (o cualquier alias
-- del recuerdo) puede no aparecer literalmente en ningun registro vigente
-- (ver atlas-2026: sus registros hablan de Jane Doe/la universidad
-- socia/el pitch, nunca dicen "Atlas"). Se agrega una tercera rama de RRF
-- que compara el nombre/alias del recuerdo ligado a cada registro contra
-- la consulta, para que el nombre del proyecto sea, por si solo, una senal
-- de busqueda valida.
create or replace function records_search(
  query_embedding vector(1024),
  query_text text,
  match_count int default 10,
  exclude_memory text default null
)
returns table (
  id bigint,
  claim text,
  date date,
  source text,
  kind text,
  memories text,
  score float
)
language sql stable as $$
  with vector_ranked as (
    select id, row_number() over (order by embedding <=> query_embedding) as rnk
    from records
    where embedding is not null and valid_until is null
      and (exclude_memory is null or not exists (
        select 1 from record_memories rm where rm.record_id = records.id and rm.memory_name = exclude_memory
      ))
    order by embedding <=> query_embedding
    limit 50
  ),
  text_ranked as (
    select id, row_number() over (order by ts_rank(content_tsv, plainto_tsquery('spanish', query_text)) desc) as rnk
    from records
    where content_tsv @@ plainto_tsquery('spanish', query_text) and valid_until is null
      and (exclude_memory is null or not exists (
        select 1 from record_memories rm where rm.record_id = records.id and rm.memory_name = exclude_memory
      ))
    limit 50
  ),
  memory_ranked as (
    select id, row_number() over (order by best_rank desc) as rnk
    from (
      select rm.record_id as id,
             max(ts_rank(
               to_tsvector('spanish', replace(m.name, '-', ' ') || ' ' || coalesce(array_to_string(m.aliases, ' '), '')),
               -- OR entre terminos, no AND: plainto_tsquery exige los DOS
               -- terminos ("proyecto" Y "coil"), pero el nombre/alias de una
               -- recuerdo nunca va a contener palabras genericas como
               -- "proyecto", basta con que UNO matchee (ver hallazgo
               -- 2026-08-31 arriba).
               to_tsquery('spanish', replace(plainto_tsquery('spanish', query_text)::text, ' & ', ' | '))
             )) as best_rank
      from record_memories rm
      join memories m on m.name = rm.memory_name
      join records r on r.id = rm.record_id
      where r.valid_until is null
        and to_tsvector('spanish', replace(m.name, '-', ' ') || ' ' || coalesce(array_to_string(m.aliases, ' '), ''))
              @@ to_tsquery('spanish', replace(plainto_tsquery('spanish', query_text)::text, ' & ', ' | '))
        and (exclude_memory is null or not exists (
          select 1 from record_memories rm2 where rm2.record_id = rm.record_id and rm2.memory_name = exclude_memory
        ))
      group by rm.record_id
    ) best
    limit 50
  ),
  fused as (
    -- memory_ranked usa 1/rnk (no 1/(60+rnk) como las otras dos): un match
    -- literal de nombre/alias de recuerdo es una senal mucho mas fuerte y
    -- confiable que similitud de vector o de texto generico (mismo criterio
    -- de prioridad lexica que classify-memory.mjs, Etapa 2), con la
    -- constante 60 quedaba diluido casi a cero (0.016 vs ~0.03-0.05 de los
    -- matches genuinos) y nunca entraba en el pool de match_count antes del
    -- rerank, aunque si aparecia si se pedian cientos de candidatos.
    select coalesce(v.id, t.id, n.id) as id,
           coalesce(1.0 / (60 + v.rnk), 0) + coalesce(1.0 / (60 + t.rnk), 0) + coalesce(1.0 / n.rnk, 0) as score
    from vector_ranked v
    full outer join text_ranked t on v.id = t.id
    full outer join memory_ranked n on coalesce(v.id, t.id) = n.id
  )
  select r.id, r.claim, r.date, r.source, r.kind,
         (select string_agg(memory_name, ', ' order by memory_name) from record_memories where record_id = r.id) as memories,
         fu.score
  from fused fu
  join records r on r.id = fu.id
  order by fu.score desc
  limit match_count;
$$;

-- Fase 4 del plan (MCP propio, 2026-08-22): remember.mjs hace este chequeo
-- de similitud con SQL crudo via pg, pero el Edge Function del MCP solo
-- tiene el cliente supabase-js (RPC, no SQL arbitrario), se expone la
-- misma logica como funcion para que ambos caminos (CLI y MCP) compartan
-- exactamente el mismo criterio, no una reimplementacion aparte.

-- Rediseno memory (2026-08-29): esta se quedo sin migrar en la primera
-- pasada de schema.sql porque solo la usan los dos servidores MCP (nadie
-- mas la llama, ver grep), no scripts/db/*.mjs, page_slug -> nodes, mismo
-- patron que facts_search/facts_timeline.
drop function if exists facts_similar(vector(1024), int);

-- Renombrado (2026-09-05): facts_similar -> records_similar, nodes -> memories.
drop function if exists facts_similar(vector(1024), int);

create or replace function records_similar(query_embedding vector(1024), match_count int default 5)
returns table (
  id bigint,
  claim text,
  date date,
  source text,
  kind text,
  memories text,
  similarity float
)
language sql stable as $$
  select r.id, r.claim, r.date, r.source, r.kind,
         (select string_agg(memory_name, ', ' order by memory_name) from record_memories where record_id = r.id) as memories,
         1 - (r.embedding <=> query_embedding) as similarity
  from records r
  where r.valid_until is null and r.embedding is not null
  order by r.embedding <=> query_embedding
  limit match_count;
$$;

-- Etapa 2 (PLAN-recuerdos.md, 2026-08-29): desambiguacion de recuerdos via
-- busqueda vectorial en vez de comparar nombres o mandar todos los claims
-- de cada recuerdo a un LLM. No hay `memories.embedding` que mantener (evita
-- recalcular un centroide cada vez que se agrega/retracta un registro): se
-- compara el claim nuevo contra los embeddings de registros individuales ya
-- existentes (que ya se generan siempre), se agrupa por recuerdo via
-- record_memories, y se rankea por recuerdo segun su mejor (mas similar)
-- registro. Barato, siempre actualizado sin mantenimiento aparte. Una
-- recuerdo fusionado (merged_into) no deberia aparecer nunca aqui:
-- merge-memories.mjs reasigna sus record_memories al recuerdo destino, asi
-- que una vacia simplemente no compite.
--
-- 2026-08-30: un solo ejemplo por recuerdo (el mejor) demostro en produccion
-- no alcanzar, si el mejor registro vigente de un recuerdo resulta ser de un
-- subtema distinto al que realmente coincide, el LLM se deja llevar por la
-- similitud tematica del ejemplo mostrado y elige el recuerdo equivocado
-- (caso real documentado en PLAN-recuerdos.md Etapa 2). Ahora se devuelven
-- hasta `examples_per_memory` ejemplos (los mas similares) por recuerdo
-- candidata, para que el clasificador vea el patron del recuerdo, no un
-- solo punto de datos.
-- 2026-08-30, segunda vuelta: los 3 ejemplos tampoco alcanzaron para el caso
-- DB1/DB2, diagnostico correcto esta vez: ningun ejemplo cubre el subtema
-- del registro nuevo (infraestructura generica de GitHub que no diferencia
-- los cursos), asi que ni el retrieval ni el LLM tienen senal tematica
-- real. La unica senal que si distingue es el nombre literal del curso en
-- el texto, y `memories.aliases` (existe desde la Etapa 1, nunca poblado)
-- es justo para esto: se agrega al resultado para que el clasificador
-- pueda buscar coincidencia lexica explicita, no solo similitud de
-- embeddings.
drop function if exists nodes_similar(vector(1024), int, int);

create or replace function memories_similar(query_embedding vector(1024), match_count int default 5, examples_per_memory int default 3)
returns table (
  memory_name text,
  similarity float,
  examples text[],
  aliases text[]
)
language sql stable as $$
  with ranked as (
    select rm.memory_name, r.claim,
           1 - (r.embedding <=> query_embedding) as similarity,
           row_number() over (partition by rm.memory_name order by r.embedding <=> query_embedding) as rnk
    from record_memories rm
    join records r on r.id = rm.record_id
    where r.valid_until is null and r.embedding is not null
  ),
  per_memory as (
    select memory_name,
           max(similarity) filter (where rnk = 1) as similarity,
           array_agg(claim order by rnk) filter (where rnk <= examples_per_memory) as examples
    from ranked
    group by memory_name
  )
  select pm.memory_name, pm.similarity, pm.examples, m.aliases
  from per_memory pm
  join memories m on m.name = pm.memory_name
  order by pm.similarity desc
  limit match_count;
$$;

-- Rediseno memory (2026-08-29): p_slug -> p_node, filtra contra fact_nodes;
-- page_slug -> nodes (agregada). Mismo drop-first que facts_search, cambia
-- el tipo de retorno.
drop function if exists facts_timeline(text, int, boolean);

-- Renombrado (2026-09-05): facts_timeline -> records_timeline, p_node ->
-- p_memory, fact_nodes -> record_memories.
drop function if exists facts_timeline(text, int, boolean);

create or replace function records_timeline(p_memory text default null, match_count int default 20, p_all boolean default false)
returns table (
  id bigint,
  date date,
  claim text,
  kind text,
  source text,
  confidence real,
  memories text,
  valid_until timestamptz,
  superseded_by bigint
)
language sql stable as $$
  select r.id, r.date, r.claim, r.kind, r.source, r.confidence,
         (select string_agg(memory_name, ', ' order by memory_name) from record_memories where record_id = r.id) as memories,
         r.valid_until, r.superseded_by
  from records r
  where (p_memory is null or exists (
    select 1 from record_memories rm where rm.record_id = r.id and rm.memory_name = p_memory
  ))
    and (p_all or r.valid_until is null)
  order by r.date desc, r.created_at desc
  limit match_count;
$$;

-- Router de recuerdos (hallazgo 2026-08-31, ver PLAN-recuerdos.md): dado un
-- conjunto de nombres de recuerdo ya resueltos (matching por nombre/alias
-- corre en JS/TS del lado del llamador, search.mjs y los dos servidores
-- MCP), trae TODOS sus registros vigentes, no solo los que sobrevivan
-- RRF/rerank de records_search. total_count (via count(*) over()) permite
-- al llamador avisar cuantos quedaron fuera del limite sin una segunda
-- consulta.
drop function if exists node_match_facts(text[], int);

create or replace function memory_match_records(
  memory_names text[],
  match_count int default 15
)
returns table (
  id bigint,
  claim text,
  date date,
  source text,
  kind text,
  memories text,
  total_count bigint
)
language sql stable as $$
  with matched as (
    select distinct r.id, r.claim, r.date, r.source, r.kind
    from records r
    join record_memories rm on rm.record_id = r.id
    where rm.memory_name = any(memory_names) and r.valid_until is null
  )
  select m.id, m.claim, m.date, m.source, m.kind,
         (select string_agg(memory_name, ', ' order by memory_name) from record_memories where record_id = m.id) as memories,
         count(*) over () as total_count
  from matched m
  order by m.date desc
  limit match_count;
$$;
