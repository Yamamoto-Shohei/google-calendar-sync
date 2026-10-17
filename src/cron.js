import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, homeDir } from './paths.js';

export const LAUNCHD_LABEL = 'com.googlecalendarsync.sync';
const CRON_MARKER = '# google-calendar-sync';

function cliPath() {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}

/** Exported for tests, so plist generation can be checked without installing it. */
export function buildPlist({ intervalMinutes }) {
  // Pass GCAL_SYNC_HOME through: launchd starts with a minimal environment, so
  // a non-default config directory would otherwise be invisible to the batch.
  const env = { GCAL_SYNC_HOME: homeDir() };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(cliPath())}</string>
    <string>sync</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(files.log())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(files.log())}</string>
</dict>
</plist>
`;
}

function launchctl(args) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function installLaunchd({ intervalMinutes }) {
  const target = plistPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buildPlist({ intervalMinutes }), { mode: 0o644 });

  const domain = `gui/${process.getuid()}`;
  launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`]);
  const ok =
    launchctl(['bootstrap', domain, target]) || launchctl(['load', '-w', target]);

  return {
    installed: ok,
    path: target,
    hint: ok
      ? `Runs every ${intervalMinutes} min. Logs: ${files.log()}`
      : `Wrote ${target} but launchctl failed. Load it manually:\n  launchctl bootstrap ${domain} ${target}`,
  };
}

function uninstallLaunchd() {
  const target = plistPath();
  launchctl(['bootout', `gui/${process.getuid()}/${LAUNCHD_LABEL}`]) ||
    launchctl(['unload', target]);
  const existed = fs.existsSync(target);
  fs.rmSync(target, { force: true });
  return { removed: existed, path: target };
}

function readCrontab() {
  try {
    return execFileSync('crontab', ['-l'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return '';
  }
}

function writeCrontab(content) {
  execFileSync('crontab', ['-'], { input: content.endsWith('\n') ? content : `${content}\n` });
}

function stripOurLines(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes(CRON_MARKER))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function installCron({ intervalMinutes }) {
  const schedule =
    intervalMinutes >= 60
      ? `0 */${Math.round(intervalMinutes / 60)} * * *`
      : `*/${intervalMinutes} * * * *`;
  const line =
    `${schedule} GCAL_SYNC_HOME=${homeDir()} ${process.execPath} ${cliPath()} sync ` +
    `>> ${files.log()} 2>&1 ${CRON_MARKER}`;

  const next = `${stripOurLines(readCrontab()).trimEnd()}\n${line}\n`.trimStart();
  try {
    writeCrontab(next);
    return {
      installed: true,
      path: 'crontab',
      hint: `Runs every ${intervalMinutes} min. Logs: ${files.log()}`,
    };
  } catch (err) {
    return {
      installed: false,
      path: 'crontab',
      hint: `Could not update crontab (${err.message}). Add this line yourself:\n  ${line}`,
    };
  }
}

function uninstallCron() {
  const current = readCrontab();
  if (!current.includes(CRON_MARKER)) return { removed: false, path: 'crontab' };
  writeCrontab(stripOurLines(current));
  return { removed: true, path: 'crontab' };
}

export function installSchedule({ intervalMinutes = 15 } = {}) {
  return process.platform === 'darwin'
    ? installLaunchd({ intervalMinutes })
    : installCron({ intervalMinutes });
}

export function uninstallSchedule() {
  return process.platform === 'darwin' ? uninstallLaunchd() : uninstallCron();
}

export function scheduleStatus() {
  if (process.platform === 'darwin') {
    const target = plistPath();
    if (!fs.existsSync(target)) return { installed: false, detail: 'no launchd plist' };
    const loaded = launchctl(['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`]);
    return { installed: true, detail: loaded ? `loaded (${target})` : `plist present but not loaded (${target})` };
  }
  const has = readCrontab().includes(CRON_MARKER);
  return { installed: has, detail: has ? 'crontab entry present' : 'no crontab entry' };
}
