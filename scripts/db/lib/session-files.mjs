// Ubica los .jsonl de sesión de Claude Code para este proyecto. Usado por
// extract-records.mjs para resolver "la sesión más reciente" cuando no se pasa
// --session explícito.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Encoding de Claude Code para el nombre de carpeta de proyecto: cada
// separador de ruta (":" o "\" en Windows) se vuelve "-".
function encodeProjectDir(cwd) {
  return cwd.replace(/[:\\/]/g, '-');
}

/** @param {string} projectRoot ruta absoluta a la raíz del repo */
export function getSessionDir(projectRoot) {
  return join(homedir(), '.claude', 'projects', encodeProjectDir(projectRoot));
}

/**
 * @param {string} projectRoot
 * @returns {{id: string, mtimeMs: number, sizeBytes: number}[]} ordenado por mtime desc
 */
export function listSessions(projectRoot) {
  const dir = getSessionDir(projectRoot);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const stat = statSync(join(dir, f));
      return { id: f.slice(0, -'.jsonl'.length), mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** @param {string} projectRoot @param {string} sessionId */
export function sessionFilePath(projectRoot, sessionId) {
  return join(getSessionDir(projectRoot), `${sessionId}.jsonl`);
}
