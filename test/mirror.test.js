import assert from 'node:assert/strict';
import test from 'node:test';
import { expandPairs, labelFor, pairId, validateConfig } from '../src/config.js';
import { PROP, isMirror, renderLabel, renderMirror, skipReason } from '../src/mirror.js';
import { allDayEvent, makeConfig, timedEvent } from './helpers.js';

function pairFor(config, from, to) {
  return expandPairs(config).find((p) => p.id === pairId(from, to));
}

test('full mesh expands to N*(N-1) directed pairs', () => {
  const pairs = expandPairs(makeConfig());
  assert.equal(pairs.length, 6);
  assert.deepEqual(
    pairs.map((p) => p.id).sort(),
    ['A->B', 'A->C', 'B->A', 'B->C', 'C->A', 'C->B'],
  );
});

test('labels resolve per directed pair and fall back to the default', () => {
  const config = makeConfig();
  assert.equal(labelFor(config, 'A->B'), '秘密の予定');
  assert.equal(labelFor(config, 'A->C'), 'プライベートの予定');
  // Not set in config.labels, so the default fills in.
  assert.equal(labelFor(config, 'B->A'), '予定あり');
  assert.equal(labelFor(config, 'C->B'), '予定あり');
});

test('a mirror carries the marker and is recognised as one', () => {
  const config = makeConfig();
  const event = timedEvent({
    id: 'evt1',
    start: '2026-10-20T14:00:00+09:00',
    end: '2026-10-20T15:00:00+09:00',
    summary: '〇〇社と商談',
  });
  const { body } = renderMirror({ pair: pairFor(config, 'A', 'B'), event, config });

  assert.equal(body.extendedProperties.private[PROP.MARKER], '1');
  assert.equal(body.extendedProperties.private[PROP.PAIR], 'A->B');
  assert.equal(body.extendedProperties.private[PROP.SOURCE_ID], 'evt1');
  assert.ok(isMirror(body));
});

test('mirrors carry the label only, never the source content', () => {
  const config = makeConfig();
  const event = timedEvent({
    id: 'evt1',
    start: '2026-10-20T14:00:00+09:00',
    end: '2026-10-20T15:00:00+09:00',
    summary: '〇〇社と商談',
    description: '機密の議題',
    location: '東京本社',
    attendees: [{ email: 'someone@example.com' }, { email: 'me@example.com', self: true }],
    conferenceData: { conferenceId: 'abc' },
  });
  const { body } = renderMirror({ pair: pairFor(config, 'A', 'B'), event, config });

  assert.equal(body.summary, '秘密の予定');
  assert.equal(body.visibility, 'private');
  assert.equal(body.location, undefined);
  assert.equal(body.attendees, undefined);
  assert.equal(body.conferenceData, undefined);
  // The only description is our own fixed note, not the source's.
  assert.ok(!body.description.includes('機密の議題'));
  assert.deepEqual(body.reminders, { useDefault: false, overrides: [] });
  assert.deepEqual(body.start, { dateTime: '2026-10-20T14:00:00+09:00', timeZone: 'Asia/Tokyo' });
});

test('the same source lands in B and C with different labels', () => {
  const config = makeConfig();
  const event = timedEvent({
    id: 'evt1',
    start: '2026-10-20T14:00:00+09:00',
    end: '2026-10-20T15:00:00+09:00',
  });
  const toB = renderMirror({ pair: pairFor(config, 'A', 'B'), event, config });
  const toC = renderMirror({ pair: pairFor(config, 'A', 'C'), event, config });

  assert.equal(toB.body.summary, '秘密の予定');
  assert.equal(toC.body.summary, 'プライベートの予定');
  assert.notEqual(toB.fingerprint, toC.fingerprint);
});

test('fingerprint changes when the time moves', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const before = renderMirror({
    pair,
    event: timedEvent({ id: 'e', start: '2026-10-20T14:00:00+09:00', end: '2026-10-20T15:00:00+09:00' }),
    config,
  });
  const after = renderMirror({
    pair,
    event: timedEvent({ id: 'e', start: '2026-10-20T16:00:00+09:00', end: '2026-10-20T17:00:00+09:00' }),
    config,
  });
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test('fingerprint changes when the configured label changes', () => {
  const event = timedEvent({ id: 'e', start: '2026-10-20T14:00:00+09:00', end: '2026-10-20T15:00:00+09:00' });
  const before = renderMirror({
    pair: pairFor(makeConfig(), 'A', 'B'),
    event,
    config: makeConfig(),
  });
  const relabelled = makeConfig({ labels: { 'A->B': '非公開' } });
  const after = renderMirror({ pair: pairFor(relabelled, 'A', 'B'), event, config: relabelled });

  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(after.body.summary, '非公開');
});

test('fingerprint is stable for an unchanged event', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const event = timedEvent({ id: 'e', start: '2026-10-20T14:00:00+09:00', end: '2026-10-20T15:00:00+09:00' });
  assert.equal(
    renderMirror({ pair, event, config }).fingerprint,
    renderMirror({ pair, event, config }).fingerprint,
  );
});

test('label tokens expand, including the source calendar name', () => {
  const event = timedEvent({
    id: 'e',
    start: '2026-10-20T14:00:00+09:00',
    end: '2026-10-20T15:30:00+09:00',
    summary: '商談',
  });
  const sourceMember = { id: 'A', label: '仕事' };
  assert.equal(renderLabel('{calendarName}の予定', { event, sourceMember }), '仕事の予定');
  assert.equal(renderLabel('{durationMinutes}分', { event, sourceMember }), '90分');
  assert.equal(renderLabel('{summary}', { event, sourceMember }), '商談');
  // Unknown tokens are left verbatim rather than turning into "undefined".
  assert.equal(renderLabel('{nope}', { event, sourceMember }), '{nope}');
});

test('all-day events copy the date form and report the inclusive end', () => {
  const config = makeConfig();
  const event = allDayEvent({ id: 'e', date: '2026-10-20', endDate: '2026-10-22' });
  const { body } = renderMirror({ pair: pairFor(config, 'A', 'B'), event, config });
  assert.deepEqual(body.start, { date: '2026-10-20' });
  assert.deepEqual(body.end, { date: '2026-10-22' });
  assert.equal(renderLabel('{start}〜{end}', { event, sourceMember: {} }), '2026-10-20〜2026-10-21');
});

test('primary write mode tints mirrors, sub-calendar mode does not', () => {
  const config = makeConfig({
    members: makeConfig().members.map((m) =>
      m.id === 'B' ? { ...m, writeMode: 'primary', mirrorCalendarId: 'primary' } : m,
    ),
  });
  const event = timedEvent({ id: 'e', start: '2026-10-20T14:00:00+09:00', end: '2026-10-20T15:00:00+09:00' });
  assert.equal(renderMirror({ pair: pairFor(config, 'A', 'B'), event, config }).body.colorId, '8');
  assert.equal(renderMirror({ pair: pairFor(config, 'A', 'C'), event, config }).body.colorId, undefined);
});

test('skipReason rejects mirrors, cancelled and filtered events', () => {
  const { filters } = makeConfig();
  const base = { start: { dateTime: '2026-10-20T14:00:00+09:00' }, end: { dateTime: '2026-10-20T15:00:00+09:00' } };

  assert.equal(skipReason({ ...base, status: 'confirmed' }, filters), null);
  assert.equal(skipReason({ ...base, status: 'cancelled' }, filters), 'cancelled');
  assert.equal(
    skipReason({ ...base, extendedProperties: { private: { [PROP.MARKER]: '1' } } }, filters),
    'mirror',
  );
  assert.equal(skipReason({ ...base, transparency: 'transparent' }, filters), 'free');
  assert.equal(
    skipReason({ ...base, attendees: [{ self: true, responseStatus: 'declined' }] }, filters),
    'declined',
  );
  assert.equal(skipReason({ ...base, eventType: 'workingLocation' }, filters), 'working-location');
  assert.equal(skipReason({ status: 'confirmed' }, filters), 'no-time');
});

test('holds written by another blocking service are not mirrored', () => {
  const { filters } = makeConfig();
  const base = { start: { dateTime: '2026-10-20T14:00:00+09:00' }, end: { dateTime: '2026-10-20T15:00:00+09:00' } };
  const block = { ...base, extendedProperties: { private: { block_event_type: 'block' } } };

  assert.equal(skipReason(block, filters), 'external-block');
  // Mirroring these is what turns one meeting into nine entries across three
  // calendars, so the guard holds even for a filters object that predates it.
  assert.equal(skipReason(block, {}), 'external-block');
  assert.equal(skipReason(block, { ...filters, skipExternalBlocks: false }), null);
  // A private property of some other name must not trip it.
  assert.equal(
    skipReason({ ...base, extendedProperties: { private: { block_event_type: 'focus' } } }, filters),
    null,
  );
});

test('duration and all-day filters are honoured when enabled', () => {
  const filters = { skipAllDay: true, minDurationMinutes: 60 };
  assert.equal(skipReason(allDayEvent({ id: 'e', date: '2026-10-20', endDate: '2026-10-21' }), filters), 'all-day');
  assert.equal(
    skipReason(timedEvent({ id: 'e', start: '2026-10-20T14:00:00+09:00', end: '2026-10-20T14:30:00+09:00' }), filters),
    'too-short',
  );
  assert.equal(
    skipReason(timedEvent({ id: 'e', start: '2026-10-20T14:00:00+09:00', end: '2026-10-20T15:00:00+09:00' }), filters),
    null,
  );
});

test('validateConfig accepts the example mesh and warns on unset labels', () => {
  const { ok, errors, warnings } = validateConfig(makeConfig());
  assert.equal(ok, true, errors.join('; '));
  // B->A, B->C, C->A, C->B have no explicit label.
  assert.equal(warnings.filter((w) => w.includes('No label set')).length, 4);
});

test('validateConfig rejects a single-member mesh and unknown accounts', () => {
  const one = validateConfig(makeConfig({ members: [makeConfig().members[0]] }));
  assert.equal(one.ok, false);
  assert.ok(one.errors.some((e) => e.includes('at least 2')));

  const bad = validateConfig(
    makeConfig({ members: makeConfig().members.map((m) => ({ ...m, accountId: 'nope' })) }),
  );
  assert.ok(bad.errors.some((e) => e.includes('unknown accountId')));
});

test('validateConfig warns when a source calendar is another member mirror store', () => {
  const config = makeConfig({
    members: makeConfig().members.map((m) =>
      m.id === 'A' ? { ...m, accountId: 'acct-b', sourceCalendarId: 'mirror-b' } : m,
    ),
  });
  const { warnings } = validateConfig(config);
  assert.ok(warnings.some((w) => w.includes('writes mirrors into')));
});

test('validateConfig flags primary-direct mode as relying on the marker', () => {
  const config = makeConfig({
    members: makeConfig().members.map((m) =>
      m.id === 'B' ? { ...m, writeMode: 'primary', mirrorCalendarId: 'primary' } : m,
    ),
  });
  const { ok, warnings } = validateConfig(config);
  assert.equal(ok, true);
  assert.ok(warnings.some((w) => w.includes('primary-direct mode')));
});
