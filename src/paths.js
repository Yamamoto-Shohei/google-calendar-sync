import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Everything the tool persists lives in one hidden directory, mode 0700.
 * GCAL_SYNC_HOME exists so tests (and anyone running several independent
 * meshes) can point at a throwaway directory.
 */
export function homeDir() {
  return process.env.GCAL_SYNC_HOME || path.join(os.homedir(), '.google-calendar-sync');
}

export const files = {
  config: () => path.join(homeDir(), 'config.json'),
  tokens: () => path.join(homeDir(), 'tokens.json'),
  client: () => path.join(homeDir(), 'client.json'),
  lastRun: () => path.join(homeDir(), 'last-run.json'),
  lock: () => path.join(homeDir(), 'sync.lock'),
  log: () => path.join(homeDir(), 'sync.log'),
};

export function ensureHomeDir() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync honours `mode` only on create, so fix up a pre-existing directory.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Non-fatal: a directory we cannot chmod is still usable.
  }
  return dir;
}
