import { files } from './paths.js';
import { readJson, writeJson } from './store.js';

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  /**
   * "oauth"            - consent per account; can auto-create mirror calendars.
   * "service-account"  - one key for every calendar shared with it; no consent
   *                      screen, and no 7-day refresh token expiry to manage.
   */
  auth: { mode: 'oauth', keyFile: null },
  window: { futureMonths: 3 },
  syncIntervalMinutes: 15,
  /** Pre-fills empty cells in the setup grid; `labels` is what sync actually reads. */
  defaultLabel: '予定あり',
  accounts: [],
  members: [],
  labels: {},
  filters: {
    skipAllDay: false,
    skipDeclined: true,
    skipTransparent: true,
    skipWorkingLocation: true,
    minDurationMinutes: 0,
  },
  visibility: 'private',
  reminders: 'none',
  /** Graphite, so mirrors are visually distinct when written into a primary calendar. */
  mirrorColorId: '8',
  safety: { maxDeletesPerPairPerRun: 100 },
};

/** Directed pair id, e.g. `A->B`. This is the value stored in `gcsPair`. */
export function pairId(sourceId, targetId) {
  return `${sourceId}->${targetId}`;
}

export function loadConfig() {
  const raw = readJson(files.config());
  if (!raw) return null;
  return withDefaults(raw);
}

export function saveConfig(config) {
  writeJson(files.config(), { ...config, version: CONFIG_VERSION });
}

export function withDefaults(raw) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    auth: { ...DEFAULT_CONFIG.auth, ...(raw.auth || {}) },
    window: { ...DEFAULT_CONFIG.window, ...(raw.window || {}) },
    filters: { ...DEFAULT_CONFIG.filters, ...(raw.filters || {}) },
    safety: { ...DEFAULT_CONFIG.safety, ...(raw.safety || {}) },
    accounts: raw.accounts || [],
    members: (raw.members || []).map((m) => ({
      enabled: true,
      writeMode: 'subcalendar',
      ...m,
    })),
    labels: raw.labels || {},
  };
}

export function enabledMembers(config) {
  return config.members.filter((m) => m.enabled !== false);
}

/**
 * Full mesh: every enabled member mirrors into every other enabled member.
 * N members produce N*(N-1) directed pairs.
 */
export function expandPairs(config) {
  const members = enabledMembers(config);
  const pairs = [];
  for (const source of members) {
    for (const target of members) {
      if (source.id === target.id) continue;
      const id = pairId(source.id, target.id);
      pairs.push({ id, source, target, label: labelFor(config, id) });
    }
  }
  return pairs;
}

export function labelFor(config, id) {
  const label = config.labels?.[id];
  return label && label.trim() ? label : config.defaultLabel;
}

/** The calendar a member's incoming mirrors get written to. */
export function mirrorTarget(member) {
  return member.mirrorCalendarId || 'primary';
}

export function isServiceAccountMode(config) {
  return config.auth?.mode === 'service-account';
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const serviceAccount = isServiceAccountMode(config);

  if (!['oauth', 'service-account'].includes(config.auth?.mode)) {
    errors.push('auth.mode must be "oauth" or "service-account".');
  }
  // keyFile is optional on purpose: left unset it resolves to the standard
  // path inside the config directory, which keeps config.json free of
  // machine-specific absolute paths so it can be committed and reused on CI.
  // A service account reaches every calendar shared with it, so there are no
  // per-account authorisations to collect.
  if (!serviceAccount && !config.accounts.length) {
    errors.push('No Google accounts connected. Run `gcal-sync setup`.');
  }

  const members = enabledMembers(config);
  if (members.length < 2) {
    errors.push(`Need at least 2 enabled calendars to sync, found ${members.length}.`);
  }

  const accountIds = new Set(config.accounts.map((a) => a.id));
  const seenIds = new Set();
  const seenSources = new Set();

  for (const m of config.members) {
    const where = `member "${m.id || '(no id)'}"`;
    if (!m.id) errors.push(`${where}: missing id.`);
    if (m.id?.includes('->')) errors.push(`${where}: id must not contain "->".`);
    if (m.id && seenIds.has(m.id)) errors.push(`${where}: duplicate id.`);
    if (m.id) seenIds.add(m.id);

    if (!serviceAccount && !accountIds.has(m.accountId)) {
      errors.push(`${where}: unknown accountId "${m.accountId}".`);
    }
    if (!m.sourceCalendarId) errors.push(`${where}: missing sourceCalendarId.`);
    if (!['subcalendar', 'primary'].includes(m.writeMode)) {
      errors.push(`${where}: writeMode must be "subcalendar" or "primary".`);
    }
    if (m.writeMode === 'subcalendar' && !m.mirrorCalendarId) {
      errors.push(`${where}: writeMode "subcalendar" requires mirrorCalendarId.`);
    }

    // "primary" resolves relative to whoever is authenticated. Under a service
    // account that is the service account's own empty calendar, never the
    // user's, so every calendar has to be named explicitly.
    if (serviceAccount) {
      if (m.sourceCalendarId === 'primary') {
        errors.push(
          `${where}: service-account mode needs the calendar's real id, not "primary" ` +
            '(e.g. you@example.com or xxx@group.calendar.google.com).',
        );
      }
      if (mirrorTarget(m) === 'primary') {
        errors.push(`${where}: service-account mode needs a real mirrorCalendarId, not "primary".`);
      }
    }

    const sourceKey = serviceAccount ? m.sourceCalendarId : `${m.accountId} ${m.sourceCalendarId}`;
    if (seenSources.has(sourceKey)) {
      errors.push(`${where}: another member already syncs this calendar.`);
    }
    seenSources.add(sourceKey);
  }

  // A member whose own source and mirror target coincide is the documented
  // primary-direct mode: mirrors land beside real events and are kept apart by
  // the gcsMirror marker alone. Allowed, but worth saying out loud.
  for (const m of config.members) {
    if (m.sourceCalendarId && mirrorTarget(m) === m.sourceCalendarId) {
      warnings.push(
        `member "${m.id}": mirrors are written into the same calendar it syncs from ` +
          '(primary-direct mode). Loop prevention relies on the gcsMirror marker only.',
      );
    }
  }

  // Cross-member overlap is almost always a mistake: one member reading another
  // member's mirror store means its real events and foreign mirrors get mixed.
  for (const a of config.members) {
    for (const b of config.members) {
      if (a.id === b.id) continue;
      // Calendar ids are globally unique, so under a service account the id
      // match alone is conclusive; under OAuth it must be the same account.
      const sameOwner = serviceAccount || a.accountId === b.accountId;
      if (sameOwner && a.sourceCalendarId === mirrorTarget(b)) {
        warnings.push(
          `member "${a.id}" syncs from the calendar that member "${b.id}" writes mirrors into.`,
        );
      }
    }
  }

  for (const { id } of expandPairs(config)) {
    if (!config.labels?.[id]?.trim()) {
      warnings.push(`No label set for ${id}; falling back to "${config.defaultLabel}".`);
    }
  }

  const months = config.window?.futureMonths;
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    errors.push('window.futureMonths must be an integer between 1 and 24.');
  }

  return { errors, warnings, ok: errors.length === 0 };
}
