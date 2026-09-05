// Compara la versión local (archivo VERSION en la raíz del repo) contra el
// último tag publicado en oscampo/2oBrain, vía `git ls-remote --tags`. No
// necesita ningún remote configurado (el clon de un usuario final no tiene
// `origin`, a propósito, ver CLAUDE.md) ni token (repo público) -- se le
// pasa la URL directo. Nunca aplica nada, solo informa; ver la sección
// "Mantenimiento: revisar e instalar actualizaciones" de CLAUDE.md para el
// procedimiento real de traer una versión nueva.
//
// Uso:
//   node check-for-updates.mjs [--json]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO_URL = 'https://github.com/oscampo/2oBrain.git';
const json = process.argv.includes('--json');

function currentVersion() {
  try {
    return readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function output(result, text) {
  console.log(json ? JSON.stringify(result) : text);
}

let tagsOutput;
try {
  tagsOutput = execFileSync('git', ['ls-remote', '--tags', REPO_URL], {
    encoding: 'utf8',
    timeout: 10_000,
  });
} catch (err) {
  const result = { ok: false, error: `No se pudo revisar actualizaciones (¿sin conexión?): ${err.message}` };
  output(result, result.error);
  process.exit(0); // informational, nunca un fallo duro
}

// Cada tag anotado aparece dos veces (refs/tags/vX.Y.Z y
// refs/tags/vX.Y.Z^{} apuntando al commit pelado) -- el lookahead negativo
// descarta la segunda para no contar el mismo tag dos veces.
const tagPattern = /refs\/tags\/(v\d+\.\d+\.\d+)(?!\^\{\})/g;
let latestTag = null;
for (const match of tagsOutput.matchAll(tagPattern)) {
  const parsed = parseSemver(match[1]);
  if (!parsed) continue;
  if (!latestTag || compareSemver(parsed, parseSemver(latestTag)) > 0) latestTag = match[1];
}

const local = currentVersion();
const localParsed = parseSemver(local) ?? [0, 0, 0];
const remoteParsed = latestTag ? parseSemver(latestTag) : null;
const hasUpdate = Boolean(remoteParsed && compareSemver(remoteParsed, localParsed) > 0);
const latestVersion = latestTag ? latestTag.replace(/^v/, '') : local;

const result = { ok: true, currentVersion: local, latestVersion, hasUpdate };

if (hasUpdate) {
  output(
    result,
    `Hay una versión nueva disponible: ${latestVersion} (tienes ${local}). Ver CHANGELOG.md o https://github.com/oscampo/2oBrain/releases -- para aplicarla, sigue "Mantenimiento: revisar e instalar actualizaciones" en CLAUDE.md, nunca aplica cambios de esquema (schema.sql) sola.`,
  );
} else {
  output(result, `Estás al día (versión ${local}).`);
}
