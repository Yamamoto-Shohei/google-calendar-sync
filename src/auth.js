import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import { files, homeDir } from './paths.js';
import { readJson, writeJson } from './store.js';

/**
 * One scope for everything. `calendar.events` would cover the sync itself, but
 * creating the mirror sub-calendar during setup needs `calendar`.
 */
export const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export const DEFAULT_PORT = Number(process.env.GCAL_SYNC_PORT || 4765);

/**
 * The loopback IP rather than "localhost" on purpose: localhost can resolve to
 * ::1 first, and the setup server listens on 127.0.0.1 only, so the browser
 * would be redirected to an address nothing is bound to. Google's own guidance
 * for installed apps prefers the literal loopback address for this reason.
 */
export function redirectUri(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}/oauth/callback`;
}

/**
 * OAuth client credentials, shared by every connected account.
 * Env vars win so CI and throwaway setups don't need a file on disk.
 */
export function loadClientCredentials() {
  const fromEnv = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
  if (fromEnv.clientId && fromEnv.clientSecret) return fromEnv;

  const stored = readJson(files.client());
  if (!stored) return null;
  // Accept the credentials file exactly as downloaded from Google Cloud.
  const inner = stored.installed || stored.web || stored;
  const clientId = inner.client_id || inner.clientId;
  const clientSecret = inner.client_secret || inner.clientSecret;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function saveClientCredentials({ clientId, clientSecret }) {
  writeJson(files.client(), { installed: { client_id: clientId, client_secret: clientSecret } });
}

export function requireClientCredentials() {
  const creds = loadClientCredentials();
  if (!creds) {
    throw new Error(
      'No OAuth client credentials. Run `gcal-sync setup` and paste your Google Cloud ' +
        `client ID/secret, or write them to ${files.client()}.`,
    );
  }
  return creds;
}

export function loadTokens() {
  return readJson(files.tokens(), {});
}

export function saveTokens(tokens) {
  writeJson(files.tokens(), tokens);
}

export function storeAccountTokens(accountId, tokens) {
  const all = loadTokens();
  all[accountId] = { ...(all[accountId] || {}), ...tokens };
  saveTokens(all);
}

export function forgetAccountTokens(accountId) {
  const all = loadTokens();
  delete all[accountId];
  saveTokens(all);
}

export function newOAuthClient({ port = DEFAULT_PORT } = {}) {
  const { clientId, clientSecret } = requireClientCredentials();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri(port));
}

export function consentUrl(client, { loginHint } = {}) {
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    // Without this an already-authorised account returns no refresh token,
    // which would make the batch run unable to work unattended.
    prompt: 'consent',
    include_granted_scopes: true,
    login_hint: loginHint,
  });
}

/**
 * An authorised client for one account, with refreshed tokens written back so
 * subsequent runs skip the refresh round-trip.
 */
export function authClientForAccount(accountId) {
  const stored = loadTokens()[accountId];
  if (!stored?.refresh_token) {
    throw new Error(`Account "${accountId}" is not authorised. Run \`gcal-sync setup\`.`);
  }
  const client = newOAuthClient();
  client.setCredentials({
    refresh_token: stored.refresh_token,
    access_token: stored.access_token,
    expiry_date: stored.expiry_date,
  });
  client.on('tokens', (tokens) => {
    const next = {};
    if (tokens.refresh_token) next.refresh_token = tokens.refresh_token;
    if (tokens.access_token) next.access_token = tokens.access_token;
    if (tokens.expiry_date) next.expiry_date = tokens.expiry_date;
    if (Object.keys(next).length) storeAccountTokens(accountId, next);
  });
  return client;
}

/** Where scripts/setup-gcp.sh writes the key by default. */
export function defaultServiceAccountKeyPath() {
  return path.join(homeDir(), 'service-account.json');
}

/**
 * Look for a key at the default path, so a fresh setup-gcp.sh run does not
 * make the user retype a path the script just printed.
 */
export function detectServiceAccountKey() {
  const candidate = defaultServiceAccountKeyPath();
  if (!fs.existsSync(candidate)) return null;
  try {
    return readServiceAccountKey(candidate);
  } catch {
    return null;
  }
}

export function expandHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return path.resolve(filePath);
}

/**
 * Read a service account key file, returning the bits we need to describe it.
 * The private key itself is never returned -- only GoogleAuth sees it.
 */
export function readServiceAccountKey(keyFile) {
  const resolved = expandHome(keyFile);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Service account key not found: ${resolved}`);
    throw new Error(`Could not read service account key ${resolved}: ${err.message}`);
  }
  if (parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      `${resolved} is not a service account key. Download the JSON key from ` +
        'Google Cloud (IAM > Service Accounts > Keys).',
    );
  }
  // Parse the key now. Otherwise a truncated or re-encoded file only surfaces
  // at sync time as a bare OpenSSL "DECODER routines::unsupported".
  try {
    crypto.createPrivateKey(parsed.private_key);
  } catch (err) {
    throw new Error(
      `The private key in ${resolved} could not be parsed (${err.message}). ` +
        'The file is likely truncated or re-encoded; download a fresh key.',
    );
  }
  return { path: resolved, clientEmail: parsed.client_email, projectId: parsed.project_id };
}

/**
 * Authorised client for service account mode.
 *
 * One key covers every calendar that has been shared with the service account,
 * so unlike OAuth there is nothing per-account to look up.
 */
export function serviceAccountAuthClient(keyFile) {
  const { path: resolved } = readServiceAccountKey(keyFile);
  return new google.auth.GoogleAuth({ keyFile: resolved, scopes: SCOPES });
}

/** Dispatch on the configured auth mode. Accounts only matter under OAuth. */
export function authClientForConfig(config, accountId) {
  if (config.auth?.mode === 'service-account') {
    return serviceAccountAuthClient(config.auth.keyFile);
  }
  return authClientForAccount(accountId);
}

/** Distinguish "the refresh token is dead" from transient failures. */
export function isAuthError(err) {
  const status = err?.response?.status ?? err?.code;
  if (status === 401) return true;
  const reason = err?.response?.data?.error;
  return reason === 'invalid_grant' || reason === 'unauthorized_client';
}
