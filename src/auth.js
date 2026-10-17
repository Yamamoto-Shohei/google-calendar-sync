import { google } from 'googleapis';
import { files } from './paths.js';
import { readJson, writeJson } from './store.js';

/**
 * One scope for everything. `calendar.events` would cover the sync itself, but
 * creating the mirror sub-calendar during setup needs `calendar`.
 */
export const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export const DEFAULT_PORT = Number(process.env.GCAL_SYNC_PORT || 4765);

export function redirectUri(port = DEFAULT_PORT) {
  return `http://localhost:${port}/oauth/callback`;
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

/** Distinguish "the refresh token is dead" from transient failures. */
export function isAuthError(err) {
  const status = err?.response?.status ?? err?.code;
  if (status === 401) return true;
  const reason = err?.response?.data?.error;
  return reason === 'invalid_grant' || reason === 'unauthorized_client';
}
