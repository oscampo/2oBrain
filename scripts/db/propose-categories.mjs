// Propone recuerdos NUEVOS (categorías) con su padre, a partir de registros ya guardados
// (flujo "nombre, padre"). Para cada registro:
//   1. el modelo da un nombre SIN conocer los recuerdos existentes (3 corridas, se exige
//      que 2 coincidan: la inestabilidad entre corridas es señal de que el nombre no vale);
//   2. se descarta si ya existe un recuerdo o alias con ese nombre;
//      (y, tras el apoyo, el juez de cobertura lib/judge-coverage.mjs descarta lo que un recuerdo
//      existente ya cubre; medido contra las 20 marcas: atrapa 8 de 13 "existe" y deja pasar 3 de 5 "buena", en la misma muestra con que se afinó el prompt);
//   3. "apoyo": de los 10 registros vigentes más cercanos al NOMBRE, cuántos están también
//      entre los 20 más cercanos al registro (0 a 10). Un nombre que solo describe un
//      artefacto aislado no encuentra vecinos y queda fuera;
//   4. los registros que convergen en el mismo nombre (--min-records) forman una propuesta, y
//      se le piden los tres padres candidatos (lib/propose-parent.mjs). Convergen también los de
//      corridas anteriores: con --queue cada registro que pasó 1-3 deja su (nombre, registro) en
//      blind_name_sightings y cuenta durante --memory-days días : antes un nombre de
//      un solo registro se perdía al terminar la corrida y dos registros de días distintos
//      nunca se juntaban con la ventana diaria del heartbeat).
// Con --queue la propuesta queda en parent_proposals (is_new); aceptarla crea el recuerdo,
// etiqueta los registros que la originaron y enlaza al padre elegido. Nada se aplica solo.
//
// ADVERTENCIA: los umbrales (--min-support 7, --min-records 2) salen de ajustarse a 20
// nombres mirando los mismos datos; NO están calibrados contra un criterio externo. Por eso la
// simulación es el modo por defecto y conviene mirar la salida antes de usar --queue.
//
// Uso:
//   node propose-categories.mjs --records 1841,1842,1882     esos registros
//   node propose-categories.mjs --since 7 --limit 20         los últimos 7 días, hasta 20 registros
//   --min-support N (7)   --min-records N (2)   --queue   --no-judge (omite el juez de cobertura)
//   --memory-days N (14)  días que cuenta un nombre visto antes (0 = sin memoria)
//
// Un fallo en un registro (embedding, modelo, base) lo omite y sigue; el resumen final cuenta los
// errores y la salida queda en código 1 si hubo alguno.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { embed, toVectorLiteral } from './lib/embed.mjs';
import { judgeCoverage } from './lib/judge-coverage.mjs';
import { suggestBlindName, proposeParents, parentProposerEnabled, normName, PARENT_MODEL } from './lib/propose-parent.mjs';

const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const queue = args.includes('--queue');
const useJudge = !args.includes('--no-judge');
const minSupport = Number(opt('--min-support', 7));
const minRecords = Number(opt('--min-records', 2));
const since = Number(opt('--since', 7));
const limit = Number(opt('--limit', 20));
const memoryDays = Number(opt('--memory-days', 14));
const ids = opt('--records', null)?.split(',').map((s) => Number(s.trim())).filter(Number.isInteger) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUNS = 3;
// Un nombre o alias de menos caracteres solo cuenta por igualdad exacta: "CAD" no puede dar por
// existente (ni por "ya registrado") a todo nombre que lo contenga por casualidad ("cadera-...").
const MIN_CONTAINED = 5;

if (!parentProposerEnabled) { console.error('El clasificador no está disponible (falta la clave del proveedor).'); process.exit(1); }
const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

let errores = 0;
try {
  const { rows: recs } = ids
    ? await client.query(`select id, claim from records where id = any($1::bigint[]) and valid_until is null and embedding is not null order by id`, [ids])
    : await client.query(
        `select id, claim from records where valid_until is null and embedding is not null and kind = 'fact'
           and length(claim) between 120 and 1200 and date >= current_date - $1::int
           -- registros solo de recuerdos "meta" (sobre el propio sistema) no generan categorías nuevas
           and not coalesce((select bool_and(m.is_meta) from record_memories rm join memories m on m.name = rm.memory_name where rm.record_id = records.id), false)
         order by id desc limit $2`,
        [since, limit],
      );
  // registros y nombres ya decididos (aceptados o descartados) no se vuelven a proponer: el flujo diario
  // del heartbeat mira ventanas que se traslapan
  const { rows: decididas } = await client.query(`select memory_name, record_ids from parent_proposals where is_new and status <> 'pending'`);
  const nombresDecididos = new Set(decididas.map((d) => d.memory_name));
  const registrosDecididos = new Set(decididas.flatMap((d) => (d.record_ids ?? []).map(String)));
  const { rows: mems } = await client.query(`select name, aliases from memories where merged_into is null`);
  const known = new Map();
  for (const m of mems) for (const n of [m.name, ...(m.aliases ?? [])]) known.set(normName(n), m.name);
  // Igualdad, o contención por palabras completas (el nombre ciego "obsidian-tema-lcars" contiene el
  // alias "tema LCARS" de obsidian-vault-config). Solo se miran claves de MIN_CONTAINED o más
  // caracteres para que un alias corto no descarte cualquier cosa.
  const coincide = (k, name) =>
    k === name || (k.length >= MIN_CONTAINED && (`-${name}-`.includes(`-${k}-`) || `-${k}-`.includes(`-${name}-`)));
  const yaExiste = (name) => {
    if (known.has(name)) return known.get(name);
    for (const [k, v] of known) if (coincide(k, name)) return v;
    return null;
  };
  console.log(`Registros a examinar: ${recs.length}. Umbrales: apoyo >= ${minSupport}, registros que convergen >= ${minRecords} (sin calibrar).${queue ? '' : ' [simulación, sin escribir]'}\n`);

  // 1-3: nombre ciego estable, no existente, con apoyo
  const porNombre = new Map();
  let memoriaNoDisponible = false;
  for (const r of recs) {
    try {
      if (registrosDecididos.has(String(r.id))) { console.log(`#${r.id}: ya está en una propuesta decidida, se omite`); continue; }
      const votos = new Map();
      for (let k = 0; k < RUNS; k++) {
        const s = await suggestBlindName([r.claim]);
        if (s) votos.set(s.name, (votos.get(s.name) ?? 0) + 1);
        await sleep(500);
      }
      const [name, n] = [...votos.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      if (!name || n < 2) { console.log(`#${r.id}: nombre inestable (${[...votos.keys()].join(' | ') || 'sin respuesta'}), se omite`); continue; }
      if (nombresDecididos.has(name)) { console.log(`#${r.id}: "${name}" ya fue propuesta y decidida, se omite`); continue; }
      const existente = yaExiste(name);
      if (existente) { console.log(`#${r.id}: "${name}" ya existe como "${existente}", se omite`); continue; }
      const label = name.replace(/-/g, ' ');
      const vec = toVectorLiteral(await embed(label, 'query'));
      const { rows: porNom } = await client.query(
        `select id from records where valid_until is null and embedding is not null and id <> $1 and superseded_by is distinct from $1 order by embedding <=> $2::vector limit 10`,
        [r.id, vec],
      );
      const { rows: porReg } = await client.query(
        `select b.id from records a, records b where a.id = $1 and b.valid_until is null and b.embedding is not null and b.id <> a.id and b.superseded_by is distinct from a.id order by b.embedding <=> a.embedding limit 20`,
        [r.id],
      );
      const cerca = new Set(porReg.map((x) => String(x.id)));
      const apoyo = porNom.filter((x) => cerca.has(String(x.id))).length;
      console.log(`#${r.id}: "${name}" (${n}/${RUNS} corridas), apoyo ${apoyo}${apoyo >= minSupport ? '' : ' < ' + minSupport + ', se omite'}`);
      if (apoyo < minSupport) continue;
      if (useJudge) {
        const j = await judgeCoverage(client, { name, claims: [r.claim], recordIds: [r.id] });
        if (!j) { console.log(`   juez de cobertura sin respuesta, se omite (falla cerrada)`); continue; }
        if (j.verdict === 'alias') {
          // no hay cola de alias: en las 5 salidas "alias" de la muestra del 8-oct el alias ya estaba registrado
          // (p. ej. un proyecto y su sigla); solo se avisa si es realmente nuevo
          const { rows: [m] } = await client.query(`select aliases from memories where name = $1`, [j.memory]);
          const yaEs = [j.memory, ...(m?.aliases ?? [])].some((a) => coincide(normName(a), name));
          console.log(yaEs
            ? `   juez: alias de ${j.memory}, ya registrado, se omite`
            : `   juez: ALIAS NUEVO sugerido "${label}" para ${j.memory} (${j.reasoning}). Si lo apruebas: node set-memory-aliases.mjs --memory ${j.memory} --aliases "${label}" --reason "propuesto por el juez de cobertura"`);
          continue;
        }
        if (j.verdict !== 'nuevo') { console.log(`   juez: ${j.verdict} ${j.memory}, se omite (${j.reasoning})`); continue; }
      }
      const juez = useJudge ? 'nuevo' : 'sin juez';
      if (!porNombre.has(name)) porNombre.set(name, []);
      porNombre.get(name).push({ id: r.id, claim: r.claim, apoyo, juez });
      if (queue && memoryDays > 0) {
        // la memoria es un extra: si la tabla no existe todavía, el registro sigue contando en esta corrida
        try {
          await client.query(
            `insert into blind_name_sightings (memory_name, record_id, apoyo, juez) values ($1, $2, $3, $4)
             on conflict (memory_name, record_id) do update set apoyo = excluded.apoyo, juez = excluded.juez, seen_at = now()`,
            [name, r.id, apoyo, juez],
          );
        } catch (err) {
          if (!memoriaNoDisponible) console.log(`   (memoria de nombres no disponible, ¿se aplicó schema.sql?: ${err.message})`);
          memoriaNoDisponible = true;
        }
      }
    } catch (err) {
      errores++;
      console.log(`#${r.id}: error (${err.message}), se omite`);
    }
  }

  // 4: convergencia y padre
  console.log('');
  let creadas = 0;
  let proponibles = 0;
  for (const [name, hoy] of porNombre) {
    try {
      // nombres vistos en corridas anteriores: mismos registros vigentes, aún no decididos, dentro de la ventana
      let previos = [];
      if (memoryDays > 0 && !memoriaNoDisponible) {
        try {
          const { rows } = await client.query(
            `select s.record_id id, r.claim, s.apoyo, s.juez from blind_name_sightings s join records r on r.id = s.record_id
             where s.memory_name = $1 and s.seen_at >= now() - $2::int * interval '1 day' and r.valid_until is null
               and s.record_id <> all($3::bigint[])
             order by s.record_id`,
            [name, memoryDays, hoy.map((m) => m.id)],
          );
          previos = rows.filter((x) => !registrosDecididos.has(String(x.id))).map((x) => ({ id: Number(x.id), claim: x.claim, apoyo: x.apoyo, juez: x.juez }));
        } catch (err) {
          console.log(`"${name}": no se pudo leer la memoria de nombres (${err.message}), solo cuentan los de esta corrida`);
        }
      }
      const miembros = [...previos, ...hoy];
      if (miembros.length < minRecords) { console.log(`"${name}": solo ${miembros.length} registro(s) convergen (se piden ${minRecords}), no se propone`); continue; }
      proponibles++;
      const res = await proposeParents(client, { name, claims: miembros.map((m) => m.claim) });
      console.log(`PROPUESTA "${name}" desde ${miembros.map((m) => '#' + m.id).join(', ')} (apoyo ${miembros.map((m) => m.apoyo).join('/')})${previos.length ? `, ${previos.length} de corridas anteriores` : ''}`);
      if (!res) { console.log('   sin padre propuesto\n'); continue; }
      res.candidates.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));
      console.log(`   razón: ${res.reasoning}\n`);
      if (queue) {
        await client.query(
          `insert into parent_proposals (memory_name, is_new, record_ids, candidates, reasoning, model) values ($1, true, $2::bigint[], $3::jsonb, $4, $5)
           on conflict (memory_name) where status = 'pending' do update set record_ids = (select array_agg(distinct x) from unnest(parent_proposals.record_ids || excluded.record_ids) x)`,
          [name, miembros.map((m) => m.id), JSON.stringify(res.candidates.map((p) => ({ parent: p }))), `${res.reasoning} [calibración: apoyo ${miembros.map((m) => m.apoyo).join('/')}, juez ${miembros[0].juez}, ${miembros.length} registros${previos.length ? `, ${previos.length} de corridas anteriores` : ''}]`, res.model ?? PARENT_MODEL],
        );
        creadas++;
      }
    } catch (err) {
      errores++;
      console.log(`"${name}": error (${err.message}), se omite`);
    }
  }
  console.log(queue ? `Propuestas de categoría nueva dejadas pendientes: ${creadas}. Para decidir: node garden.mjs --parent-proposals` : `Simulación terminada. Con --queue se dejarían pendientes ${proponibles} propuesta(s).`);
  if (errores > 0) { console.log(`Errores: ${errores} (registros o nombres omitidos, ver arriba).`); process.exitCode = 1; }
} catch (err) {
  console.error(`propose-categories falló: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
