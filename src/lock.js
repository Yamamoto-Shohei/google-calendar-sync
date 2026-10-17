import fs from 'node:fs';
import { ensureHomeDir, files } from './paths.js';
import { log } from './log.js';

const STALE_AFTER_MS = 60 * 60 * 1000;

function processAlive(pid) {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Prevent two syncs from racing (a slow run plus the next cron tick), which
 * would double-create mirrors for the same source event.
 *
 * Returns a release function, or null when another run holds the lock.
 */
export function acquireLock({ now = Date.now() } = {}) {
  ensureHomeDir();
  const file = files.lock();

  const write = () => {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }));
    fs.closeSync(fd);
  };

  try {
    write();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    const held = readLock(file);
    const age = held?.startedAt ? now - Date.parse(held.startedAt) : Infinity;
    const alive = held?.pid ? processAlive(held.pid) : false;
    // A lock left behind by a killed process must not block every future run.
    if (alive && age < STALE_AFTER_MS) return null;

    log.warn(`Removing stale lock (pid ${held?.pid ?? '?'}, age ${Math.round(age / 1000)}s).`);
    fs.rmSync(file, { force: true });
    try {
      write();
    } catch {
      return null;
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fs.rmSync(file, { force: true });
  };
  return release;
}
