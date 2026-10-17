import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCalendarAccess, checkMeshAccess } from '../src/access.js';
import { isServiceAccountMode, validateConfig, withDefaults } from '../src/config.js';
import { runSync } from '../src/sync.js';
import { isMirror } from '../src/mirror.js';
import { fakeGoogle, timedEvent } from './helpers.js';

const NOW = new Date(2026, 9, 18, 13, 30, 0);
const KEY = '/tmp/does-not-need-to-exist.json';

/** Service account mesh: no accounts, explicit calendar ids everywhere. */
function saConfig(overrides = {}) {
  return withDefaults({
    auth: { mode: 'service-account', keyFile: KEY },
    defaultLabel: '予定あり',
    accounts: [],
    members: [
      {
        id: 'A',
        label: '仕事',
        sourceCalendarId: 'a@example.com',
        writeMode: 'subcalendar',
        mirrorCalendarId: 'mirror-a@group.calendar.google.com',
      },
      {
        id: 'B',
        label: 'プライベート',
        sourceCalendarId: 'b@example.com',
        writeMode: 'subcalendar',
        mirrorCalendarId: 'mirror-b@group.calendar.google.com',
      },
    ],
    labels: { 'A->B': '秘密の予定', 'B->A': 'プライベートの予定' },
    ...overrides,
  });
}

function event(id, day = 20) {
  return timedEvent({
    id,
    start: `2026-11-${day}T14:00:00+09:00`,
    end: `2026-11-${day}T15:00:00+09:00`,
    summary: `real ${id}`,
  });
}

/**
 * Under a service account every member shares one credential, so the fake is
 * keyed on a single identity and calendar ids must be globally distinct.
 */
function saGoogle(calendars, options = {}) {
  const prefixed = Object.fromEntries(
    Object.entries(calendars).map(([id, events]) => [`sa:${id}`, events]),
  );
  const google = fakeGoogle({
    calendars: prefixed,
    failListFor: (options.failListFor || []).map((id) => `sa:${id}`),
  });
  const base = google.clientFor;
  return { ...google, clientFor: async () => base('sa') };
}

test('service account mode is detected from the config', () => {
  assert.equal(isServiceAccountMode(saConfig()), true);
  assert.equal(isServiceAccountMode(withDefaults({})), false);
});

test('a service account mesh validates without any accounts', () => {
  const { ok, errors } = validateConfig(saConfig());
  assert.equal(ok, true, errors.join('; '));
});

test('service account mode requires a key file', () => {
  const { ok, errors } = validateConfig(saConfig({ auth: { mode: 'service-account' } }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('requires auth.keyFile')));
});

test('an unknown auth mode is rejected', () => {
  const { errors } = validateConfig(withDefaults({ auth: { mode: 'magic' } }));
  assert.ok(errors.some((e) => e.includes('auth.mode must be')));
});

test('"primary" is rejected as a calendar id under a service account', () => {
  // "primary" would resolve to the service account's own empty calendar,
  // silently syncing nothing, so it has to be a hard error.
  const bySource = validateConfig(
    saConfig({
      members: saConfig().members.map((m) =>
        m.id === 'A' ? { ...m, sourceCalendarId: 'primary' } : m,
      ),
    }),
  );
  assert.equal(bySource.ok, false);
  assert.ok(bySource.errors.some((e) => e.includes('not "primary"')));

  const byMirror = validateConfig(
    saConfig({
      members: saConfig().members.map((m) =>
        m.id === 'A' ? { ...m, writeMode: 'primary', mirrorCalendarId: 'primary' } : m,
      ),
    }),
  );
  assert.equal(byMirror.ok, false);
  assert.ok(byMirror.errors.some((e) => e.includes('real mirrorCalendarId')));
});

test('OAuth mode still accepts "primary"', () => {
  const config = withDefaults({
    accounts: [{ id: 'acct-a', email: 'a@example.com' }, { id: 'acct-b', email: 'b@example.com' }],
    members: [
      { id: 'A', accountId: 'acct-a', sourceCalendarId: 'primary', mirrorCalendarId: 'm-a' },
      { id: 'B', accountId: 'acct-b', sourceCalendarId: 'primary', mirrorCalendarId: 'm-b' },
    ],
  });
  assert.equal(validateConfig(config).ok, true);
});

test('duplicate source calendars are caught without account ids', () => {
  const config = saConfig({
    members: saConfig().members.map((m) => ({ ...m, sourceCalendarId: 'same@example.com' })),
  });
  const { errors } = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('already syncs this calendar')));
});

test('a source that is another member mirror store is warned about', () => {
  const config = saConfig({
    members: saConfig().members.map((m) =>
      m.id === 'A' ? { ...m, sourceCalendarId: 'mirror-b@group.calendar.google.com' } : m,
    ),
  });
  const { warnings } = validateConfig(config);
  assert.ok(warnings.some((w) => w.includes('writes mirrors into')));
});

test('the mesh syncs end to end on a single shared credential', async () => {
  const config = saConfig();
  const google = saGoogle({
    'a@example.com': [event('a1')],
    'b@example.com': [event('b1', 21)],
    'mirror-a@group.calendar.google.com': [],
    'mirror-b@group.calendar.google.com': [],
  });

  const first = await runSync({ config, clientFor: google.clientFor, now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.totals.created, 2);
  assert.equal(
    google.store.get('sa:mirror-b@group.calendar.google.com').filter(isMirror)[0].summary,
    '秘密の予定',
  );
  assert.equal(
    google.store.get('sa:mirror-a@group.calendar.google.com').filter(isMirror)[0].summary,
    'プライベートの予定',
  );

  // Same idempotency guarantee as OAuth mode.
  const second = await runSync({ config, clientFor: google.clientFor, now: NOW });
  assert.equal(second.totals.created, 0);
  assert.equal(second.totals.unchanged, 2);
});

/** Minimal client exposing just what checkCalendarAccess touches. */
function accessClient({ listEntry, listThrows, getThrows, insertThrows }) {
  return {
    async getCalendarListEntry() {
      if (listThrows) throw Object.assign(new Error('nope'), { response: { status: 403 } });
      return listEntry ?? null;
    },
    async addToCalendarList() {
      if (insertThrows) throw new Error('cannot add');
      return listEntry ?? null;
    },
    async getCalendar() {
      if (getThrows) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      return { summary: 'Read only calendar' };
    },
  };
}

test('writer and owner satisfy a write requirement', async () => {
  for (const role of ['writer', 'owner']) {
    const result = await checkCalendarAccess(
      accessClient({ listEntry: { accessRole: role, summary: 'cal' } }),
      'x@example.com',
      { needWrite: true },
    );
    assert.equal(result.ok, true, role);
    assert.equal(result.error, null);
  }
});

test('reader access fails a write requirement with a clear reason', async () => {
  const result = await checkCalendarAccess(
    accessClient({ listEntry: { accessRole: 'reader', summary: 'cal' } }),
    'x@example.com',
    { needWrite: true },
  );
  assert.equal(result.ok, false);
  assert.equal(result.role, 'reader');
  assert.ok(result.error.includes('writer'));
});

test('reader access satisfies a read-only requirement', async () => {
  const result = await checkCalendarAccess(
    accessClient({ listEntry: { accessRole: 'reader' } }),
    'x@example.com',
    { needWrite: false },
  );
  assert.equal(result.ok, true);
});

test('a calendar absent from the list falls back to a plain read', async () => {
  const result = await checkCalendarAccess(
    accessClient({ listEntry: null, insertThrows: true }),
    'x@example.com',
    { needWrite: true },
  );
  // Visible, but we could not confirm write, so it is not reported as OK.
  assert.equal(result.ok, false);
  assert.equal(result.role, 'unknown');
  assert.equal(result.summary, 'Read only calendar');
});

test('an unreachable calendar reports the API error', async () => {
  const result = await checkCalendarAccess(
    accessClient({ listThrows: true, insertThrows: true, getThrows: true }),
    'x@example.com',
    { needWrite: false },
  );
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('checkMeshAccess requires write on mirrors and read on sources', async () => {
  const roles = {
    'a@example.com': 'reader',
    'b@example.com': 'reader',
    'mirror-a@group.calendar.google.com': 'writer',
    'mirror-b@group.calendar.google.com': 'reader',
  };
  const clientFor = async () => ({
    async getCalendarListEntry(calendarId) {
      return { accessRole: roles[calendarId], summary: calendarId };
    },
    async addToCalendarList() {
      return null;
    },
    async getCalendar(calendarId) {
      return { summary: calendarId };
    },
  });

  const report = await checkMeshAccess(saConfig(), clientFor);
  assert.equal(report.mode, 'service-account');
  assert.equal(report.checks.length, 4);
  assert.equal(report.ok, false, 'mirror-b is only readable');

  const byCalendar = Object.fromEntries(report.checks.map((c) => [c.calendarId, c]));
  // Sources only need read, so reader is fine for them.
  assert.equal(byCalendar['a@example.com'].ok, true);
  assert.equal(byCalendar['mirror-a@group.calendar.google.com'].ok, true);
  assert.equal(byCalendar['mirror-b@group.calendar.google.com'].ok, false);
});

test('primary-direct mode is checked once, with the write requirement', async () => {
  const config = saConfig({
    members: saConfig().members.map((m) =>
      m.id === 'A'
        ? { ...m, writeMode: 'primary', mirrorCalendarId: 'a@example.com' }
        : m,
    ),
  });
  const clientFor = async () => ({
    async getCalendarListEntry(calendarId) {
      return { accessRole: calendarId === 'a@example.com' ? 'reader' : 'writer' };
    },
    async addToCalendarList() {
      return null;
    },
    async getCalendar() {
      return {};
    },
  });

  const report = await checkMeshAccess(config, clientFor);
  const forA = report.checks.filter((c) => c.memberId === 'A');
  assert.equal(forA.length, 1, 'one calendar, one check');
  assert.equal(forA[0].kind, 'source+mirror');
  // Reader is not enough once the same calendar also stores mirrors.
  assert.equal(forA[0].ok, false);
});
