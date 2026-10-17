import assert from 'node:assert/strict';
import test from 'node:test';
import { expandPairs, pairId } from '../src/config.js';
import { PROP, renderMirror } from '../src/mirror.js';
import { planPair } from '../src/planner.js';
import { makeConfig, mirrorEvent, timedEvent } from './helpers.js';

function pairFor(config, from, to) {
  return expandPairs(config).find((p) => p.id === pairId(from, to));
}

function sourceEvent(id, hour = 14) {
  return timedEvent({
    id,
    start: `2026-10-20T${String(hour).padStart(2, '0')}:00:00+09:00`,
    end: `2026-10-20T${String(hour + 1).padStart(2, '0')}:00:00+09:00`,
    summary: `source ${id}`,
  });
}

/** A mirror that is already in sync with the given source event. */
function syncedMirror(config, pair, event, id = `m-${event.id}`) {
  const { fingerprint } = renderMirror({ pair, event, config });
  return mirrorEvent({ id, pair: pair.id, sourceEventId: event.id, fingerprint });
}

test('new source events become creates', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const plan = planPair({
    pair,
    sourceEvents: [sourceEvent('e1'), sourceEvent('e2', 16)],
    mirrorEvents: [],
    config,
  });

  assert.equal(plan.creates.length, 2);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.creates[0].body.summary, '秘密の予定');
});

test('an unchanged event produces no writes at all', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const event = sourceEvent('e1');
  const plan = planPair({
    pair,
    sourceEvents: [event],
    mirrorEvents: [syncedMirror(config, pair, event)],
    config,
  });

  assert.equal(plan.unchanged, 1);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.deletes.length, 0);
});

test('a moved source event produces an update, not a duplicate', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const before = sourceEvent('e1', 14);
  const after = sourceEvent('e1', 16);

  const plan = planPair({
    pair,
    sourceEvents: [after],
    mirrorEvents: [syncedMirror(config, pair, before)],
    config,
  });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.updates[0].eventId, 'm-e1');
  assert.equal(plan.updates[0].body.start.dateTime, '2026-10-20T16:00:00+09:00');
});

test('changing the label in config updates existing mirrors', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const event = sourceEvent('e1');
  const existing = syncedMirror(config, pair, event);

  const relabelled = makeConfig({ labels: { 'A->B': '非公開' } });
  const plan = planPair({
    pair: pairFor(relabelled, 'A', 'B'),
    sourceEvents: [event],
    mirrorEvents: [existing],
    config: relabelled,
  });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].body.summary, '非公開');
});

test('a mirror whose source is gone is deleted', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const kept = sourceEvent('e1');
  const removed = sourceEvent('e2', 16);

  const plan = planPair({
    pair,
    sourceEvents: [kept],
    mirrorEvents: [syncedMirror(config, pair, kept), syncedMirror(config, pair, removed)],
    config,
  });

  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].eventId, 'm-e2');
  assert.equal(plan.deletes[0].reason, 'orphan');
});

test('an event filtered out of scope has its mirror removed', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const event = sourceEvent('e1');
  const mirror = syncedMirror(config, pair, event);

  // The user marks the event as free; skipTransparent is on by default.
  const plan = planPair({
    pair,
    sourceEvents: [{ ...event, transparency: 'transparent' }],
    mirrorEvents: [mirror],
    config,
    allowEmptySource: true,
  });

  assert.equal(plan.skipped.free, 1);
  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].eventId, 'm-e1');
});

test('mirrors present in the source list are never re-mirrored', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const real = sourceEvent('e1');
  // Primary-direct mode: A's calendar holds its real event plus a mirror that
  // C wrote into it. Only the real event may propagate.
  const foreignMirror = mirrorEvent({
    id: 'from-c',
    pair: 'C->A',
    sourceEventId: 'c-evt',
    fingerprint: 'whatever',
    start: '2026-10-21T10:00:00+09:00',
    end: '2026-10-21T11:00:00+09:00',
  });

  const plan = planPair({
    pair,
    sourceEvents: [real, foreignMirror],
    mirrorEvents: [],
    config,
  });

  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].sourceEventId, 'e1');
  assert.equal(plan.skipped.mirror, 1);
});

test('real events and other pairs mirrors in the target are untouchable', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const realEventInTarget = timedEvent({
    id: 'b-own',
    start: '2026-10-20T09:00:00+09:00',
    end: '2026-10-20T10:00:00+09:00',
    summary: "B's own meeting",
  });
  const otherPairsMirror = mirrorEvent({
    id: 'from-c',
    pair: 'C->B',
    sourceEventId: 'c-evt',
    fingerprint: 'x',
  });

  const plan = planPair({
    pair,
    sourceEvents: [],
    mirrorEvents: [realEventInTarget, otherPairsMirror],
    config,
    allowEmptySource: true,
  });

  // Nothing belongs to A->B, so there is nothing to delete.
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.creates.length, 0);
});

test('a duplicated mirror is pruned to one', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const event = sourceEvent('e1');

  const plan = planPair({
    pair,
    sourceEvents: [event],
    mirrorEvents: [
      syncedMirror(config, pair, event, 'm-1'),
      syncedMirror(config, pair, event, 'm-2'),
    ],
    config,
  });

  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].eventId, 'm-2');
  assert.equal(plan.deletes[0].reason, 'duplicate');
  assert.equal(plan.unchanged, 1);
});

test('a mirror missing its source id is cleaned up', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const broken = syncedMirror(config, pair, sourceEvent('e1'), 'm-broken');
  delete broken.extendedProperties.private[PROP.SOURCE_ID];

  const plan = planPair({
    pair,
    sourceEvents: [sourceEvent('e9', 9)],
    mirrorEvents: [broken],
    config,
  });

  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].reason, 'no-source-id');
});

test('safety valve: a failed source read blocks the pair entirely', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const plan = planPair({
    pair,
    sourceEvents: [],
    mirrorEvents: [syncedMirror(config, pair, sourceEvent('e1'))],
    config,
    sourceOk: false,
  });

  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.creates, []);
  assert.ok(plan.warnings[0].includes('could not be read'));
});

test('safety valve: an empty source will not wipe existing mirrors', () => {
  const config = makeConfig();
  const pair = pairFor(config, 'A', 'B');
  const mirrors = [
    syncedMirror(config, pair, sourceEvent('e1'), 'm-1'),
    syncedMirror(config, pair, sourceEvent('e2', 16), 'm-2'),
  ];

  const guarded = planPair({ pair, sourceEvents: [], mirrorEvents: mirrors, config });
  assert.deepEqual(guarded.deletes, []);
  assert.ok(guarded.warnings[0].includes('Refusing to delete'));

  const forced = planPair({
    pair,
    sourceEvents: [],
    mirrorEvents: mirrors,
    config,
    allowEmptySource: true,
  });
  assert.equal(forced.deletes.length, 2);
});

test('safety valve: deletions beyond the cap are refused', () => {
  const config = makeConfig({ safety: { maxDeletesPerPairPerRun: 2 } });
  const pair = pairFor(config, 'A', 'B');
  const mirrors = [1, 2, 3, 4].map((n) =>
    syncedMirror(config, pair, sourceEvent(`gone-${n}`, 8 + n), `m-${n}`),
  );

  const plan = planPair({
    pair,
    // One surviving event, so the empty-source valve does not fire first.
    sourceEvents: [sourceEvent('alive')],
    mirrorEvents: mirrors,
    config,
  });

  assert.deepEqual(plan.deletes, []);
  assert.ok(plan.warnings[0].includes('exceed safety cap of 2'));
  // Creates still go through; only deletion is held back.
  assert.equal(plan.creates.length, 1);
});
