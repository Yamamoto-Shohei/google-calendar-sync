#!/usr/bin/env node
import { createRequire } from 'node:module';
import { checkMeshAccess } from './access.js';
import {
  authClientForConfig,
  detectServiceAccountKey,
  isAuthError,
  loadClientCredentials,
  loadTokens,
  readServiceAccountKey,
} from './auth.js';
import { createCalendarClient } from './calendar.js';
import {
  expandPairs,
  isServiceAccountMode,
  loadConfig,
  mirrorTarget,
  validateConfig,
} from './config.js';
import { installSchedule, scheduleStatus, uninstallSchedule } from './cron.js';
import { acquireLock } from './lock.js';
import { log } from './log.js';
import { files } from './paths.js';
import { readJson, writeJson } from './store.js';
import { runSync } from './sync.js';
import { errorMessage } from './util.js';

const EXIT = { OK: 0, PARTIAL: 1, CONFIG: 2 };

const USAGE = `gcal-sync - mirror busy time blocks between Google Calendars

Usage
  gcal-sync setup                    Open the local setup screen (connect accounts, set labels)
  gcal-sync sync [options]           Run one sync pass
  gcal-sync status                   Show configuration, schedule and last run
  gcal-sync doctor                   Check that every calendar is reachable and writable
  gcal-sync install-cron             Schedule the sync (launchd on macOS, crontab elsewhere)
  gcal-sync uninstall-cron           Remove the schedule

Sync options
  --dry-run                          Show the diff without writing anything
  --allow-empty-source               Permit deletions when a source has no events
  --only <id>                        Limit to one pair or one calendar. Quote pair ids so the
                                     shell does not read "->" as a redirect: --only 'A->B'
  --json                             Print the run result as JSON
  --verbose                          Verbose logging

Files
  Config and tokens live in ~/.google-calendar-sync (override with GCAL_SYNC_HOME).
`;

function parseArgs(argv) {
  const flags = { only: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') {
      flags.only = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--only=')) {
      flags.only = arg.slice('--only='.length);
    } else if (arg.startsWith('--')) {
      flags[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], flags };
}

/**
 * Caches one authorised client per account for the whole run. Under a service
 * account every member shares a single credential, so the cache collapses to
 * one entry.
 */
export function makeClientFactory(config) {
  const cache = new Map();
  const shared = isServiceAccountMode(config);
  return async (accountId) => {
    const key = shared ? '__service-account__' : accountId;
    if (!cache.has(key)) {
      cache.set(key, createCalendarClient(authClientForConfig(config, accountId)));
    }
    return cache.get(key);
  };
}

function requireValidConfig() {
  const config = loadConfig();
  if (!config) {
    log.error(`No configuration found at ${files.config()}. Run \`gcal-sync setup\` first.`);
    process.exit(EXIT.CONFIG);
  }
  const { errors, warnings, ok } = validateConfig(config);
  for (const w of warnings) log.warn(w);
  if (!ok) {
    for (const e of errors) log.error(e);
    process.exit(EXIT.CONFIG);
  }
  return config;
}

function printRun(result) {
  const { totals } = result;
  log.info(
    `Window ${result.window.timeMin.slice(0, 10)} → ${result.window.timeMax.slice(0, 10)}` +
      `${result.dryRun ? '  (dry run)' : ''}`,
  );
  for (const pair of result.pairs) {
    const skipped = Object.entries(pair.skipped)
      .map(([reason, n]) => `${reason}:${n}`)
      .join(' ');
    const bits = [
      `+${pair.created}`,
      `~${pair.updated}`,
      `-${pair.deleted}`,
      `=${pair.unchanged}`,
    ].join(' ');
    log.info(`  ${pair.pairId.padEnd(12)} ${bits}${skipped ? `  skipped[${skipped}]` : ''}`);
    if (pair.plan) {
      for (const line of pair.plan.creates) log.info(`      create  ${line}`);
      for (const line of pair.plan.updates) log.info(`      update  ${line}`);
      for (const line of pair.plan.deletes) log.info(`      delete  ${line}`);
    }
    for (const w of pair.warnings) log.warn(w);
    for (const e of pair.errors) log.error(`${pair.pairId}: ${e}`);
  }
  log.info(
    `Total: ${totals.created} created, ${totals.updated} updated, ${totals.deleted} deleted, ` +
      `${totals.unchanged} unchanged` +
      (totals.blocked ? `, ${totals.blocked} pair(s) skipped` : '') +
      (totals.errors ? `, ${totals.errors} error(s)` : ''),
  );
}

async function cmdSync(flags) {
  if (flags.verbose) process.env.GCAL_SYNC_LOG_LEVEL = 'debug';
  const config = requireValidConfig();

  const release = flags.dryRun ? () => {} : acquireLock();
  if (!release) {
    log.error('Another sync is already running. Nothing to do.');
    return EXIT.PARTIAL;
  }

  try {
    const result = await runSync({
      config,
      clientFor: makeClientFactory(config),
      dryRun: Boolean(flags.dryRun),
      allowEmptySource: Boolean(flags.allowEmptySource),
      only: flags.only,
    });

    if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printRun(result);

    if (!flags.dryRun) writeJson(files.lastRun(), result);
    return result.ok ? EXIT.OK : EXIT.PARTIAL;
  } catch (err) {
    if (isAuthError(err)) {
      log.error(
        `Authorisation failed: ${errorMessage(err)}\n` +
          'Re-authorise with `gcal-sync setup`. Note that while the Google OAuth consent ' +
          'screen is in "Testing", refresh tokens expire after 7 days.',
      );
      return EXIT.CONFIG;
    }
    log.error(errorMessage(err));
    if (flags.verbose) log.error(err.stack || '');
    return EXIT.PARTIAL;
  } finally {
    release();
  }
}

async function cmdStatus() {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json');
  log.info(`gcal-sync ${version}`);
  log.info(`Config dir: ${files.config().replace(/\/config\.json$/, '')}`);

  const config = loadConfig();
  if (!config) {
    // Point at whichever credential is already on disk, rather than reporting
    // the OAuth client as missing when a service account key is sitting there.
    const detected = detectServiceAccountKey();
    if (detected) {
      log.info('Service account key found, not yet registered:');
      log.info(`  key:     ${detected.path}`);
      log.info(`  address: ${detected.clientEmail}`);
    } else {
      log.info(`OAuth client: ${loadClientCredentials() ? 'configured' : 'MISSING - run setup'}`);
    }
    log.info('Config: none yet. Run `gcal-sync setup`.');
    return EXIT.CONFIG;
  }

  const { errors, warnings } = validateConfig(config);

  if (isServiceAccountMode(config)) {
    log.info('Auth mode: service account');
    try {
      const key = readServiceAccountKey(config.auth.keyFile);
      log.info(`  key:     ${key.path}`);
      log.info(`  address: ${key.clientEmail}`);
      log.info('  Each calendar below must be shared with that address.');
    } catch (err) {
      log.error(`  ${errorMessage(err)}`);
    }
  } else {
    log.info('Auth mode: OAuth');
    log.info(`  client: ${loadClientCredentials() ? 'configured' : 'MISSING - run setup'}`);
    const tokens = loadTokens();
    log.info(`\nAccounts (${config.accounts.length}):`);
    for (const account of config.accounts) {
      const authorised = Boolean(tokens[account.id]?.refresh_token);
      log.info(
        `  ${account.id}  ${account.email}  ${authorised ? 'authorised' : 'NOT AUTHORISED'}`,
      );
    }
  }

  log.info(`\nCalendars (${config.members.length}):`);
  for (const m of config.members) {
    const owner = isServiceAccountMode(config) ? '' : `account=${m.accountId}  `;
    log.info(
      `  ${m.id}  ${m.label || '(no name)'}  ${owner}` +
        `source=${m.sourceCalendarId}  mirrors→${mirrorTarget(m)} [${m.writeMode}]` +
        `${m.enabled === false ? '  DISABLED' : ''}`,
    );
  }

  const pairs = expandPairs(config);
  log.info(`\nDirected pairs (${pairs.length}):`);
  for (const pair of pairs) log.info(`  ${pair.id}  →  "${pair.label}"`);

  log.info(`\nWindow: today → +${config.window.futureMonths} month(s), past is never synced`);
  const schedule = scheduleStatus();
  log.info(`Schedule: ${schedule.installed ? schedule.detail : 'not installed'} ` +
    `(interval ${config.syncIntervalMinutes} min)`);

  const last = readJson(files.lastRun());
  if (last) {
    log.info(
      `\nLast run: ${last.finishedAt} - ${last.totals.created} created, ` +
        `${last.totals.updated} updated, ${last.totals.deleted} deleted, ` +
        `${last.totals.errors} error(s)${last.dryRun ? ' (dry run)' : ''}`,
    );
  } else {
    log.info('\nLast run: never');
  }

  for (const w of warnings) log.warn(w);
  for (const e of errors) log.error(e);
  return errors.length ? EXIT.CONFIG : EXIT.OK;
}

/**
 * Verify we can actually reach every calendar before trusting a schedule.
 * Mostly for service account mode, where access depends on manual sharing.
 */
async function cmdDoctor() {
  const config = requireValidConfig();

  if (isServiceAccountMode(config)) {
    const key = readServiceAccountKey(config.auth.keyFile);
    log.info(`Service account: ${key.clientEmail}`);
    log.info('Share each calendar below with that address ("Make changes to events").\n');
  }

  const report = await checkMeshAccess(config, makeClientFactory(config));
  for (const check of report.checks) {
    const mark = check.ok ? 'OK  ' : 'FAIL';
    const want = check.needWrite ? 'write' : 'read';
    log.info(
      `  ${mark} ${check.memberId} ${check.kind.padEnd(13)} ${check.calendarId}` +
        `  (need ${want}, have ${check.role === 'unknown' ? '?' : check.role || '-'})`,
    );
    if (check.summary) log.info(`         name: ${check.summary}`);
    if (check.error) log.error(`         ${check.error}`);
  }

  if (report.ok) {
    log.info('\nAll calendars reachable with the access the sync needs.');
    return EXIT.OK;
  }
  log.error('\nSome calendars are not usable yet. Fix the sharing above, then re-run.');
  return EXIT.CONFIG;
}

async function cmdSetup() {
  const { startSetupServer } = await import('./server.js');
  await startSetupServer();
  return EXIT.OK;
}

async function cmdInstallCron() {
  const config = loadConfig();
  const intervalMinutes = config?.syncIntervalMinutes || 15;
  const result = installSchedule({ intervalMinutes });
  log.info(result.installed ? `Scheduled: ${result.path}` : `Not scheduled: ${result.path}`);
  log.info(result.hint);
  return result.installed ? EXIT.OK : EXIT.PARTIAL;
}

async function cmdUninstallCron() {
  const result = uninstallSchedule();
  log.info(result.removed ? `Removed schedule (${result.path}).` : 'No schedule was installed.');
  return EXIT.OK;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'sync':
      return cmdSync(flags);
    case 'status':
      return cmdStatus();
    case 'doctor':
      return cmdDoctor();
    case 'setup':
      return cmdSetup();
    case 'install-cron':
      return cmdInstallCron();
    case 'uninstall-cron':
      return cmdUninstallCron();
    case undefined:
    case 'help':
      process.stdout.write(USAGE);
      return EXIT.OK;
    default:
      log.error(`Unknown command: ${command}`);
      process.stdout.write(USAGE);
      return EXIT.CONFIG;
  }
}

main().then(
  (code) => process.exit(code ?? EXIT.OK),
  (err) => {
    log.error(errorMessage(err));
    log.error(err?.stack || '');
    process.exit(EXIT.PARTIAL);
  },
);
