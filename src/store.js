import fs from 'node:fs';
import path from 'node:path';
import { ensureHomeDir } from './paths.js';

/** Read JSON, returning `fallback` when the file does not exist. */
export function readJson(file, fallback = null) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

/**
 * Write JSON at mode 0600 via temp-file-and-rename, so a crash mid-write
 * cannot leave a half-written config or token file behind.
 */
export function writeJson(file, value) {
  ensureHomeDir();
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Non-fatal.
  }
}
