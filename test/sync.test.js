import assert from 'node:assert/strict';
import test from 'node:test';
import { isMirror } from '../src/mirror.js';
import { runSync, syncWindow } from '../src/sync.js';
import { fakeGoogle, makeConfig, timedEvent } from './helpers.js';

const NOW = new Date(2026, 9, 18, 13, 30, 0);

function event(id, day = 20, hour = 14) {
  return timedEvent({
    id,
    start: `2026-10-${day}T${String(hour).padStart(2, '0')}:00:00+09:00`,
    end: `2026-10-${day}T${String(hour + 1).padStart(2, '0')}:00:00+09:00`,
    summary: `real ${id}`,
  });
}

/** Mirrors written into one calendar, newest state from the fake's store. */
function mirrorsIn(google, key) {
  return (google.store.get(key) || []).filter(isMirror);
}

function summaries(google, key) {
  return mirrorsIn(google, key)
    .map((e) => e.summary)
    .sort();
}

test('syncWindow starts at local midnight today and runs N months ahead', () => {
  const { timeMin, timeMax } = syncWindow({ now: NOW, futureMonths: 3 });
  const min = new Date(timeMin);
  const max = new Date(timeMax);

  assert.equal(min.getFullYear(), 2026);
  assert.equal(min.getMonth(), 9);
  assert.equal(min.getDate(), 18);
  assert.equal(min.getHours(), 0);
  assert.equal(min.getMinutes(), 0);
  // Past events are out of scope: the window never reaches behind today.
  assert.ok(min <= NOW);
  assert.equal(max.getMonth(), 0);
  assert.equal(max.getFullYear(), 2027);
});

test("A's event reaches B and C with the label configured for each", async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [],
      'acct-c:primary': [],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
  });

  const result = await runSync({ config, clientFor: google.clientFor, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.totals.created, 2);
  assert.deepEqual(summaries(google, 'acct-b:mirror-b'), ['秘密の予定']);
  assert.deepEqual(summaries(google, 'acct-c:mirror-c'), ['プライベートの予定']);
  // The source calendar itself is never written to.
  assert.equal(mirrorsIn(google, 'acct-a:primary').length, 0);
});

test('a second run is a no-op: mirrors never propagate or multiply', async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [event('b1', 21)],
      'acct-c:primary': [event('c1', 22)],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
  });

  const first = await runSync({ config, clientFor: google.clientFor, now: NOW });
  // 3 real events x 2 destinations each.
  assert.equal(first.totals.created, 6);

  const second = await runSync({ config, clientFor: google.clientFor, now: NOW });
  assert.equal(second.totals.created, 0);
  assert.equal(second.totals.updated, 0);
  assert.equal(second.totals.deleted, 0);
  assert.equal(second.totals.unchanged, 6);

  const third = await runSync({ config, clientFor: google.clientFor, now: NOW });
  assert.equal(third.totals.created, 0);
  // Each member holds exactly (N-1) mirrors: one per other calendar, forever.
  for (const key of ['acct-a:mirror-a', 'acct-b:mirror-b', 'acct-c:mirror-c']) {
    assert.equal(mirrorsIn(google, key).length, 2, key);
  }
});

test('primary-direct mode stays stable even though mirrors sit beside real events', async () => {
  // Every member reads and writes the same calendar, so each source list comes
  // back containing foreign mirrors. Only the gcsMirror marker keeps this sane.
  const config = makeConfig({
    members: makeConfig().members.map((m) => ({
      ...m,
      writeMode: 'primary',
      mirrorCalendarId: 'primary',
    })),
  });
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [event('b1', 21)],
      'acct-c:primary': [event('c1', 22)],
    },
  });

  await runSync({ config, clientFor: google.clientFor, now: NOW });
  for (const key of ['acct-a:primary', 'acct-b:primary', 'acct-c:primary']) {
    assert.equal(mirrorsIn(google, key).length, 2, key);
  }

  // Now the source lists genuinely contain mirrors. Two more passes must not
  // mirror them again, and must not delete the real events either.
  const second = await runSync({ config, clientFor: google.clientFor, now: NOW });
  assert.equal(second.totals.created, 0);
  assert.equal(second.totals.deleted, 0);

  await runSync({ config, clientFor: google.clientFor, now: NOW });
  for (const key of ['acct-a:primary', 'acct-b:primary', 'acct-c:primary']) {
    assert.equal(mirrorsIn(google, key).length, 2, key);
    assert.equal((google.store.get(key) || []).filter((e) => !isMirror(e)).length, 1, key);
  }
});

test('an edited source event is patched in place on the next run', async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1', 20, 14)],
      'acct-b:primary': [],
      'acct-c:primary': [],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
  });

  await runSync({ config, clientFor: google.clientFor, now: NOW });
  const idBefore = mirrorsIn(google, 'acct-b:mirror-b')[0].id;

  google.store.set('acct-a:primary', [event('a1', 20, 17)]);
  const result = await runSync({ config, clientFor: google.clientFor, now: NOW });

  assert.equal(result.totals.updated, 2);
  assert.equal(result.totals.created, 0);
  const after = mirrorsIn(google, 'acct-b:mirror-b');
  assert.equal(after.length, 1);
  assert.equal(after[0].id, idBefore, 'patched in place rather than recreated');
  assert.equal(after[0].start.dateTime, '2026-10-20T17:00:00+09:00');
});

test('a deleted source event removes its mirrors on the next run', async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1'), event('a2', 21)],
      'acct-b:primary': [],
      'acct-c:primary': [],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
  });

  await runSync({ config, clientFor: google.clientFor, now: NOW });
  assert.equal(mirrorsIn(google, 'acct-b:mirror-b').length, 2);

  google.store.set('acct-a:primary', [event('a1')]);
  const result = await runSync({ config, clientFor: google.clientFor, now: NOW });

  assert.equal(result.totals.deleted, 2);
  assert.equal(mirrorsIn(google, 'acct-b:mirror-b').length, 1);
  assert.equal(mirrorsIn(google, 'acct-c:mirror-c').length, 1);
});

test('a source read failure blocks only the pairs that read it', async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [event('b1', 21)],
      'acct-c:primary': [event('c1', 22)],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
    failListFor: ['acct-a:primary'],
  });

  const result = await runSync({ config, clientFor: google.clientFor, now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.totals.blocked, 2, 'A->B and A->C are skipped');
  // B and C still sync to each other and into A's mirror store.
  assert.equal(result.totals.created, 4);
  assert.equal(mirrorsIn(google, 'acct-a:mirror-a').length, 2);
  // Nothing was deleted anywhere despite A looking empty.
  assert.equal(result.totals.deleted, 0);
  assert.equal(google.calls.deletes.length, 0);
});

test('a source read failure never deletes the mirrors it cannot see', async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [],
      'acct-c:primary': [],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
  });

  await runSync({ config, clientFor: google.clientFor, now: NOW });
  assert.equal(mirrorsIn(google, 'acct-b:mirror-b').length, 1);

  // A's calendar becomes unreadable, e.g. a revoked token.
  const broken = fakeGoogle({
    calendars: Object.fromEntries(google.store),
    failListFor: ['acct-a:primary'],
  });
  const result = await runSync({ config, clientFor: broken.clientFor, now: NOW });

  assert.equal(result.ok, false);
  assert.equal(broken.calls.deletes.length, 0);
  assert.equal(mirrorsIn(broken, 'acct-b:mirror-b').length, 1, 'mirror survived the outage');
});

test('a mirror-store read failure blocks writes to that target only', async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [event('b1', 21)],
      'acct-c:primary': [event('c1', 22)],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
    failListFor: ['acct-b:mirror-b'],
  });

  const result = await runSync({ config, clientFor: google.clientFor, now: NOW });

  assert.equal(result.totals.blocked, 2, 'A->B and C->B are skipped');
  assert.equal(google.store.get('acct-b:mirror-b').length, 0);
  // A and C still receive each other's events.
  assert.equal(mirrorsIn(google, 'acct-a:mirror-a').length, 2);
  assert.equal(mirrorsIn(google, 'acct-c:mirror-c').length, 2);
});

test('each calendar is read once per run regardless of pair count', async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [],
      'acct-c:primary': [],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
  });

  await runSync({ config, clientFor: google.clientFor, now: NOW });

  // 3 sources + 3 mirror stores, not 6 pairs x 2 reads.
  assert.equal(google.calls.lists.length, 6);
  const keys = google.calls.lists.map((c) => c.key).sort();
  assert.deepEqual(keys, [
    'acct-a:mirror-a',
    'acct-a:primary',
    'acct-b:mirror-b',
    'acct-b:primary',
    'acct-c:mirror-c',
    'acct-c:primary',
  ]);
});

test('dry run reports the diff and writes nothing', async () => {
  const config = makeConfig();
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [],
      'acct-c:primary': [],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
      'acct-c:mirror-c': [],
    },
  });

  const result = await runSync({ config, clientFor: google.clientFor, now: NOW, dryRun: true });

  assert.equal(result.totals.created, 2);
  assert.equal(google.calls.inserts.length, 0);
  assert.equal(google.calls.patches.length, 0);
  assert.equal(google.calls.deletes.length, 0);
  const planned = result.pairs.find((p) => p.pairId === 'A->B').plan;
  assert.equal(planned.creates.length, 1);
  assert.ok(planned.creates[0].includes('秘密の予定'));
});

test('--only limits the run to one pair or one calendar', async () => {
  const config = makeConfig();
  const calendars = {
    'acct-a:primary': [event('a1')],
    'acct-b:primary': [],
    'acct-c:primary': [],
    'acct-a:mirror-a': [],
    'acct-b:mirror-b': [],
    'acct-c:mirror-c': [],
  };

  const onePair = fakeGoogle({ calendars });
  const byPair = await runSync({
    config,
    clientFor: onePair.clientFor,
    now: NOW,
    only: 'A->B',
  });
  assert.deepEqual(byPair.pairs.map((p) => p.pairId), ['A->B']);
  assert.equal(onePair.calls.inserts.length, 1);

  const oneMember = fakeGoogle({ calendars });
  const byMember = await runSync({
    config,
    clientFor: oneMember.clientFor,
    now: NOW,
    only: 'A',
  });
  // Every pair touching A, in both directions.
  assert.deepEqual(byMember.pairs.map((p) => p.pairId).sort(), [
    'A->B',
    'A->C',
    'B->A',
    'C->A',
  ]);
});

test('a disabled calendar drops out of the mesh', async () => {
  const config = makeConfig({
    members: makeConfig().members.map((m) => (m.id === 'C' ? { ...m, enabled: false } : m)),
  });
  const google = fakeGoogle({
    calendars: {
      'acct-a:primary': [event('a1')],
      'acct-b:primary': [],
      'acct-a:mirror-a': [],
      'acct-b:mirror-b': [],
    },
  });

  const result = await runSync({ config, clientFor: google.clientFor, now: NOW });
  assert.deepEqual(result.pairs.map((p) => p.pairId).sort(), ['A->B', 'B->A']);
  assert.equal(result.totals.created, 1);
});
