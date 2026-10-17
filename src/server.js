import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { google } from 'googleapis';
import { checkCalendarAccess, checkMeshAccess } from './access.js';
import {
  DEFAULT_PORT,
  authClientForConfig,
  consentUrl,
  forgetAccountTokens,
  loadClientCredentials,
  loadTokens,
  newOAuthClient,
  readServiceAccountKey,
  redirectUri,
  saveClientCredentials,
  storeAccountTokens,
} from './auth.js';
import { createCalendarClient } from './calendar.js';
import {
  DEFAULT_CONFIG,
  expandPairs,
  isServiceAccountMode,
  loadConfig,
  mirrorTarget,
  saveConfig,
  validateConfig,
} from './config.js';
import { installSchedule, scheduleStatus, uninstallSchedule } from './cron.js';
import { log } from './log.js';
import { ensureHomeDir, files } from './paths.js';
import { readJson } from './store.js';
import { runSync } from './sync.js';
import { errorMessage } from './util.js';

const MIRROR_CALENDAR_SUMMARY = 'Synced (gcal-sync)';
const MEMBER_IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_BODY_BYTES = 256 * 1024;

function currentConfig() {
  return loadConfig() || { ...DEFAULT_CONFIG };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The setup screen can authorise accounts and write files, so it must not be
 * reachable from a web page the user happens to have open. Two guards: the Host
 * header has to be loopback (blocks DNS rebinding), and every call has to carry
 * the per-process token that we only ever print to this terminal.
 */
function hostIsLoopback(req, port) {
  const host = req.headers.host;
  if (!host) return false;
  return ['localhost', '127.0.0.1', '[::1]'].some(
    (name) => host === name || host === `${name}:${port}`,
  );
}

function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
      .unref();
  } catch {
    // The URL is printed to the terminal too; opening is a convenience.
  }
}

function nextMemberId(config) {
  const used = new Set(config.members.map((m) => m.id));
  for (const letter of MEMBER_IDS) if (!used.has(letter)) return letter;
  for (let n = 1; ; n += 1) if (!used.has(`M${n}`)) return `M${n}`;
}

function accountIdForEmail(config, email) {
  const existing = config.accounts.find((a) => a.email === email);
  if (existing) return existing.id;
  const base = `acct-${email.split('@')[0].replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
  const used = new Set(config.accounts.map((a) => a.id));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Fill in every directed pair so `labels` always covers the whole mesh. */
function normaliseLabels(config) {
  const labels = {};
  for (const pair of expandPairs(config)) {
    const explicit = config.labels?.[pair.id];
    labels[pair.id] = explicit && explicit.trim() ? explicit : config.defaultLabel;
  }
  return labels;
}

function clientFactory(config) {
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

async function clientForAccount(accountId) {
  return clientFactory(currentConfig())(accountId);
}

async function ensureMirrorCalendar(client, { sourceTimeZone }) {
  const existing = await client.listCalendars();
  const found = existing.find((c) => c.summary === MIRROR_CALENDAR_SUMMARY);
  if (found) return { id: found.id, created: false };
  const created = await client.createCalendar({
    summary: MIRROR_CALENDAR_SUMMARY,
    timeZone: sourceTimeZone,
  });
  return { id: created.id, created: true };
}

export async function startSetupServer({ port = DEFAULT_PORT } = {}) {
  ensureHomeDir();
  const token = crypto.randomBytes(24).toString('base64url');
  const uiHtml = fs.readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
  /** state -> true, so a callback can only complete a flow we started. */
  const pendingAuth = new Map();

  const handlers = {
    'GET /api/state': async () => {
      const config = currentConfig();
      const tokens = loadTokens();
      const { errors, warnings } = validateConfig(config);
      let serviceAccount = null;
      if (isServiceAccountMode(config) && config.auth.keyFile) {
        try {
          const key = readServiceAccountKey(config.auth.keyFile);
          serviceAccount = { path: key.path, clientEmail: key.clientEmail, ok: true };
        } catch (err) {
          serviceAccount = { path: config.auth.keyFile, error: errorMessage(err), ok: false };
        }
      }
      return {
        authMode: config.auth?.mode || 'oauth',
        serviceAccount,
        hasClientCredentials: Boolean(loadClientCredentials()),
        config: { ...config, labels: normaliseLabels(config) },
        pairs: expandPairs(config).map((p) => ({
          id: p.id,
          source: p.source.id,
          target: p.target.id,
          label: p.label,
        })),
        accounts: config.accounts.map((a) => ({
          ...a,
          authorised: Boolean(tokens[a.id]?.refresh_token),
        })),
        members: config.members.map((m) => ({ ...m, mirrorTarget: mirrorTarget(m) })),
        validation: { errors, warnings },
        schedule: scheduleStatus(),
        lastRun: readJson(files.lastRun()),
        configPath: files.config(),
        redirectUri: redirectUri(port),
      };
    },

    'POST /api/auth-mode': async (body) => {
      const mode = body.mode === 'service-account' ? 'service-account' : 'oauth';
      const config = currentConfig();
      config.auth = { ...config.auth, mode };
      saveConfig(config);
      return { ok: true, mode };
    },

    'POST /api/service-account': async (body) => {
      const keyFile = String(body.keyFile || '').trim();
      if (!keyFile) throw new Error('Path to the service account JSON key is required.');
      // Validate before saving, so a typo cannot leave the config unusable.
      const key = readServiceAccountKey(keyFile);
      const config = currentConfig();
      config.auth = { mode: 'service-account', keyFile };
      saveConfig(config);
      return { ok: true, clientEmail: key.clientEmail, path: key.path };
    },

    'POST /api/doctor': async () => {
      const config = currentConfig();
      const { errors } = validateConfig(config);
      if (errors.length) throw new Error(errors.join(' / '));
      return await checkMeshAccess(config, clientFactory(config));
    },

    'POST /api/client': async (body) => {
      const clientId = String(body.clientId || '').trim();
      const clientSecret = String(body.clientSecret || '').trim();
      if (!clientId || !clientSecret) throw new Error('Both client ID and secret are required.');
      saveClientCredentials({ clientId, clientSecret });
      return { ok: true };
    },

    'POST /api/accounts/start': async () => {
      const client = newOAuthClient({ port });
      const state = crypto.randomBytes(16).toString('base64url');
      pendingAuth.set(state, true);
      const url = consentUrl(client, {});
      return { url: `${url}&state=${encodeURIComponent(state)}` };
    },

    'POST /api/accounts/remove': async (body) => {
      const config = currentConfig();
      const accountId = String(body.accountId || '');
      config.accounts = config.accounts.filter((a) => a.id !== accountId);
      config.members = config.members.filter((m) => m.accountId !== accountId);
      config.labels = normaliseLabels(config);
      saveConfig(config);
      forgetAccountTokens(accountId);
      return { ok: true };
    },

    'GET /api/calendars': async (_body, url) => {
      const accountId = url.searchParams.get('accountId');
      if (!accountId) throw new Error('accountId is required.');
      const client = await clientForAccount(accountId);
      const calendars = await client.listCalendars();
      return {
        calendars: calendars
          .filter((c) => c.summary !== MIRROR_CALENDAR_SUMMARY)
          .map((c) => ({
            id: c.id,
            summary: c.summary,
            primary: Boolean(c.primary),
            accessRole: c.accessRole,
            timeZone: c.timeZone,
          })),
      };
    },

    'POST /api/members': async (body) => {
      const config = currentConfig();
      const serviceAccount = isServiceAccountMode(config);
      const sourceCalendarId = String(body.sourceCalendarId || '').trim();
      if (!sourceCalendarId) throw new Error('A source calendar is required.');

      const accountId = serviceAccount ? null : String(body.accountId || '');
      if (!serviceAccount && !config.accounts.some((a) => a.id === accountId)) {
        throw new Error(`Unknown account "${accountId}".`);
      }
      if (
        config.members.some(
          (m) => m.sourceCalendarId === sourceCalendarId && m.accountId === accountId,
        )
      ) {
        throw new Error('That calendar is already part of the mesh.');
      }

      const client = await clientForAccount(accountId);
      const source = await client.getCalendar(sourceCalendarId);

      let writeMode = body.writeMode === 'primary' ? 'primary' : 'subcalendar';
      let mirrorCalendarId = 'primary';
      let createdCalendar = false;

      if (serviceAccount) {
        // A service account can only create calendars in its own account, not
        // the user's, so the mirror calendar has to be made and shared by hand.
        mirrorCalendarId = String(body.mirrorCalendarId || '').trim();
        if (!mirrorCalendarId) {
          throw new Error(
            'In service-account mode, create the mirror calendar yourself, share it with ' +
              'the service account, and paste its calendar id here.',
          );
        }
        if (mirrorCalendarId === sourceCalendarId) {
          writeMode = 'primary';
        }
        // Fail now rather than at the first scheduled sync.
        const access = await checkCalendarAccess(client, mirrorCalendarId, { needWrite: true });
        if (!access.ok) {
          throw new Error(`Cannot write to ${mirrorCalendarId}: ${access.error}`);
        }
      } else if (writeMode === 'subcalendar') {
        const mirror = await ensureMirrorCalendar(client, { sourceTimeZone: source.timeZone });
        mirrorCalendarId = mirror.id;
        createdCalendar = mirror.created;
      }

      const member = {
        id: nextMemberId(config),
        label: String(body.label || source.summary || sourceCalendarId).slice(0, 60),
        accountId,
        sourceCalendarId,
        writeMode,
        mirrorCalendarId,
        enabled: true,
      };
      config.members.push(member);
      config.labels = normaliseLabels(config);
      saveConfig(config);
      return { member, createdCalendar };
    },

    'POST /api/members/remove': async (body) => {
      const config = currentConfig();
      const id = String(body.id || '');
      config.members = config.members.filter((m) => m.id !== id);
      // Drop labels for pairs that no longer exist.
      config.labels = normaliseLabels(config);
      saveConfig(config);
      return { ok: true };
    },

    'POST /api/members/toggle': async (body) => {
      const config = currentConfig();
      const member = config.members.find((m) => m.id === String(body.id || ''));
      if (!member) throw new Error('Unknown calendar.');
      member.enabled = member.enabled === false;
      config.labels = normaliseLabels(config);
      saveConfig(config);
      return { ok: true, enabled: member.enabled };
    },

    'POST /api/config': async (body) => {
      const config = currentConfig();
      if (body.defaultLabel !== undefined) {
        config.defaultLabel = String(body.defaultLabel).trim() || DEFAULT_CONFIG.defaultLabel;
      }
      if (body.labels) {
        const valid = new Set(expandPairs(config).map((p) => p.id));
        const labels = {};
        for (const [id, value] of Object.entries(body.labels)) {
          if (!valid.has(id)) continue;
          const text = String(value).trim();
          labels[id] = text || config.defaultLabel;
        }
        config.labels = labels;
      }
      if (body.filters) {
        config.filters = {
          ...config.filters,
          skipAllDay: Boolean(body.filters.skipAllDay),
          skipDeclined: Boolean(body.filters.skipDeclined),
          skipTransparent: Boolean(body.filters.skipTransparent),
          skipWorkingLocation: Boolean(body.filters.skipWorkingLocation),
          minDurationMinutes: Math.max(0, Number(body.filters.minDurationMinutes) || 0),
        };
      }
      if (body.window?.futureMonths !== undefined) {
        const months = Number(body.window.futureMonths);
        if (!Number.isInteger(months) || months < 1 || months > 24) {
          throw new Error('Sync window must be between 1 and 24 months.');
        }
        config.window = { ...config.window, futureMonths: months };
      }
      if (body.syncIntervalMinutes !== undefined) {
        const minutes = Number(body.syncIntervalMinutes);
        if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
          throw new Error('Sync interval must be between 5 and 1440 minutes.');
        }
        config.syncIntervalMinutes = minutes;
      }
      if (body.annotateDescription !== undefined) {
        config.annotateDescription = Boolean(body.annotateDescription);
      }
      config.labels = normaliseLabels(config);
      saveConfig(config);
      const { errors, warnings } = validateConfig(config);
      return { ok: true, validation: { errors, warnings } };
    },

    'POST /api/sync': async (body) => {
      const config = currentConfig();
      const { errors } = validateConfig(config);
      if (errors.length) throw new Error(errors.join(' / '));
      const result = await runSync({
        config,
        clientFor: clientForAccount,
        dryRun: Boolean(body.dryRun),
        allowEmptySource: Boolean(body.allowEmptySource),
      });
      return { result };
    },

    'POST /api/schedule': async (body) => {
      const config = currentConfig();
      if (body.install === false) return { ...uninstallSchedule(), status: scheduleStatus() };
      const outcome = installSchedule({ intervalMinutes: config.syncIntervalMinutes || 15 });
      return { ...outcome, status: scheduleStatus() };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const route = `${req.method} ${url.pathname}`;

    if (!hostIsLoopback(req, port)) {
      return html(res, 403, '<h1>403</h1><p>Only reachable via localhost.</p>');
    }

    // Google redirects the browser here, so the token travels in `state`.
    if (route === 'GET /oauth/callback') {
      return handleOAuthCallback({ url, res, port, pendingAuth });
    }

    if (route === 'GET /' || route === 'GET /index.html') {
      if (url.searchParams.get('t') !== token) {
        return html(
          res,
          403,
          '<h1>403</h1><p>Open the URL printed by <code>gcal-sync setup</code> ' +
            '(it carries a one-time token).</p>',
        );
      }
      return html(res, 200, uiHtml.replace('__TOKEN__', token));
    }

    const handler = handlers[route];
    if (!handler) return json(res, 404, { error: `No route for ${route}` });

    if (req.headers['x-gcs-token'] !== token) {
      return json(res, 403, { error: 'Bad or missing session token. Reload the setup page.' });
    }

    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      return json(res, 200, await handler(body, url));
    } catch (err) {
      log.warn(`${route}: ${errorMessage(err)}`);
      return json(res, 400, { error: errorMessage(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: never expose the setup screen on the network.
    server.listen(port, '127.0.0.1', resolve);
  });

  const url = `http://localhost:${port}/?t=${token}`;
  log.info(`Setup screen: ${url}`);
  log.info('Press Ctrl+C when you are done.');
  openBrowser(url);

  await new Promise((resolve) => {
    const stop = () => {
      server.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  log.info('Setup server stopped.');
}

async function handleOAuthCallback({ url, res, port, pendingAuth }) {
  const page = (title, detail) =>
    html(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        '<body style="font:16px/1.6 system-ui;padding:3rem;max-width:34rem;margin:auto">' +
        `<h1 style="font-size:1.2rem">${title}</h1><p>${detail}</p>` +
        '<p>You can close this tab and return to the setup screen.</p>' +
        '<script>setTimeout(()=>window.close(),2500)</script>',
    );

  const state = url.searchParams.get('state');
  if (!state || !pendingAuth.has(state)) {
    return page('Unexpected callback', 'This authorisation flow was not started here.');
  }
  pendingAuth.delete(state);

  const error = url.searchParams.get('error');
  if (error) return page('Authorisation cancelled', `Google returned: ${error}`);

  const code = url.searchParams.get('code');
  if (!code) return page('Authorisation failed', 'No authorisation code was returned.');

  try {
    const client = newOAuthClient({ port });
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      return page(
        'No refresh token',
        'Google did not return a refresh token, so unattended syncing would not work. ' +
          'Remove this app at myaccount.google.com/permissions and authorise again.',
      );
    }
    client.setCredentials(tokens);

    // The primary calendar's id is the account's address, so we learn which
    // account this is without asking for any profile scope.
    const api = google.calendar({ version: 'v3', auth: client });
    const primary = await api.calendars.get({ calendarId: 'primary' });
    const email = primary.data.id;

    const config = currentConfig();
    const accountId = accountIdForEmail(config, email);
    if (!config.accounts.some((a) => a.id === accountId)) {
      config.accounts.push({ id: accountId, email });
      saveConfig(config);
    }
    storeAccountTokens(accountId, {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expiry_date: tokens.expiry_date,
    });

    log.info(`Authorised ${email} as "${accountId}".`);
    return page('Connected', `<strong>${email}</strong> is now authorised.`);
  } catch (err) {
    log.error(`OAuth exchange failed: ${errorMessage(err)}`);
    return page('Authorisation failed', errorMessage(err));
  }
}
