#!/usr/bin/env node
/**
 * Entrypoint for the Cloud Run job.
 *
 * Secret Manager hands the configuration over as environment variables, but the
 * tool reads files from GCAL_SYNC_HOME. This writes them out, runs one sync and
 * exits with the sync's own status code.
 *
 * Doing it in Node rather than a shell wrapper keeps the credentials out of any
 * command line: a JSON blob with a quote in it cannot break an argument list
 * that does not exist.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = process.env.GCAL_SYNC_HOME || '/tmp/gcal-sync';
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** Env var -> file name. config is required; the rest depend on the auth mode. */
const FILES = [
  ['GCAL_CONFIG', 'config.json', true],
  ['GCAL_TOKENS', 'tokens.json', false],
  ['GCAL_CLIENT', 'client.json', false],
  ['GCAL_SERVICE_ACCOUNT', 'service-account.json', false],
];

function materialise() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });

  for (const [envVar, fileName, required] of FILES) {
    const value = process.env[envVar];
    if (!value) {
      if (required) {
        console.error(`error: ${envVar} is not set. Re-run scripts/setup-cloud-run.sh.`);
        process.exit(2);
      }
      continue;
    }
    try {
      JSON.parse(value);
    } catch (err) {
      // Fail here rather than with a confusing parse error mid-sync.
      console.error(`error: ${envVar} is not valid JSON (${err.message}).`);
      process.exit(2);
    }
    fs.writeFileSync(path.join(HOME, fileName), value, { mode: 0o600 });
  }
}

materialise();

const result = spawnSync(process.execPath, [CLI, 'sync', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, GCAL_SYNC_HOME: HOME },
});

// The task's filesystem dies with it, but do not make that the only thing
// standing between a crash and a readable token on disk.
fs.rmSync(HOME, { recursive: true, force: true });

if (result.error) {
  console.error(`error: could not start the sync (${result.error.message}).`);
  process.exit(1);
}
process.exit(result.status ?? 1);
