import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-sync-test-'));
process.env.GCAL_SYNC_HOME = sandbox;

const { isNotFound, isRetryable } = await import('../src/calendar.js');
const { acquireLock } = await import('../src/lock.js');
const { buildPlist } = await import('../src/cron.js');
const { ensureHomeDir, files } = await import('../src/paths.js');
const { readJson, writeJson } = await import('../src/store.js');

function apiError(status, reason) {
  const err = new Error(`HTTP ${status}`);
  err.response = { status, data: { error: { errors: reason ? [{ reason }] : [] } } };
  return err;
}

test('rate limiting is retried but a permission failure is not', () => {
  assert.equal(isRetryable(apiError(429)), true);
  assert.equal(isRetryable(apiError(500)), true);
  assert.equal(isRetryable(apiError(503)), true);
  // 403 is overloaded, so the reason decides.
  assert.equal(isRetryable(apiError(403, 'rateLimitExceeded')), true);
  assert.equal(isRetryable(apiError(403, 'userRateLimitExceeded')), true);
  assert.equal(isRetryable(apiError(403, 'insufficientPermissions')), false);
  assert.equal(isRetryable(apiError(404)), false);
  assert.equal(isRetryable(apiError(401)), false);
  assert.equal(isRetryable(apiError(400)), false);

  const reset = new Error('socket hang up');
  reset.code = 'ECONNRESET';
  assert.equal(isRetryable(reset), true);
});

test('a deleted event reads as not-found so cleanup can be idempotent', () => {
  assert.equal(isNotFound(apiError(404)), true);
  assert.equal(isNotFound(apiError(410)), true);
  assert.equal(isNotFound(apiError(500)), false);
});

test('config and token files are written user-only', () => {
  ensureHomeDir();
  writeJson(files.config(), { secret: 'value' });
  assert.deepEqual(readJson(files.config()), { secret: 'value' });

  const fileMode = fs.statSync(files.config()).mode & 0o777;
  assert.equal(fileMode, 0o600, `expected 0600, got ${fileMode.toString(8)}`);
  const dirMode = fs.statSync(sandbox).mode & 0o777;
  assert.equal(dirMode, 0o700, `expected 0700, got ${dirMode.toString(8)}`);

  fs.rmSync(files.config(), { force: true });
});

test('readJson returns the fallback for a missing file', () => {
  assert.equal(readJson(path.join(sandbox, 'nope.json'), null), null);
  assert.deepEqual(readJson(path.join(sandbox, 'nope.json'), { a: 1 }), { a: 1 });
});

test('readJson reports which file is malformed', () => {
  const bad = path.join(sandbox, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.throws(() => readJson(bad), /bad\.json is not valid JSON/);
  fs.rmSync(bad);
});

test('the lock keeps a second sync from running concurrently', () => {
  const release = acquireLock();
  assert.ok(release, 'first run takes the lock');
  assert.equal(acquireLock(), null, 'second run is turned away');

  release();
  const again = acquireLock();
  assert.ok(again, 'lock is free once released');
  again();
  assert.equal(fs.existsSync(files.lock()), false);
});

test('releasing twice is harmless', () => {
  const release = acquireLock();
  release();
  release();
  assert.equal(fs.existsSync(files.lock()), false);
});

test('a lock left by a dead process is reclaimed', () => {
  ensureHomeDir();
  // PID 2^22 is above the maximum on Linux and macOS, so it cannot be live.
  fs.writeFileSync(
    files.lock(),
    JSON.stringify({ pid: 4194304, startedAt: new Date().toISOString() }),
  );

  const release = acquireLock();
  assert.ok(release, 'a dead holder does not block future runs');
  release();
});

test('a stale lock from a live process is reclaimed after the timeout', () => {
  ensureHomeDir();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    files.lock(),
    JSON.stringify({ pid: process.pid, startedAt: twoHoursAgo }),
  );

  const release = acquireLock();
  assert.ok(release, 'an hours-old lock is treated as abandoned');
  release();
});

test('a fresh lock from a live process is respected', () => {
  ensureHomeDir();
  fs.writeFileSync(
    files.lock(),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );

  assert.equal(acquireLock(), null);
  fs.rmSync(files.lock(), { force: true });
});

test('the launchd plist carries the interval, config dir and log path', () => {
  const plist = buildPlist({ intervalMinutes: 15 });
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.googlecalendarsync\.sync<\/string>/);
  assert.ok(plist.includes('<string>sync</string>'));
  // launchd starts with a minimal environment, so the config dir must be passed.
  assert.ok(plist.includes('GCAL_SYNC_HOME'));
  assert.ok(plist.includes(sandbox));
  assert.ok(plist.includes(files.log()));
  assert.ok(plist.includes(process.execPath));
});

test('plist values are XML-escaped', () => {
  process.env.GCAL_SYNC_HOME = '/tmp/a&b<c>';
  const plist = buildPlist({ intervalMinutes: 30 });
  assert.ok(plist.includes('/tmp/a&amp;b&lt;c&gt;'));
  assert.ok(!plist.includes('/tmp/a&b<c>'));
  process.env.GCAL_SYNC_HOME = sandbox;
});

test.after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});
