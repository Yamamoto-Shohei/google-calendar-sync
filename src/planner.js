import { PROP, isMirror, renderMirror, skipReason } from './mirror.js';

/**
 * Decide what to create / patch / delete for one directed pair.
 *
 * Pure: no API calls, no clock reads. Everything that makes the bidirectional
 * mesh safe is decided here, so it can be tested without touching Google.
 */
export function planPair({
  pair,
  sourceEvents,
  mirrorEvents,
  config,
  sourceOk = true,
  allowEmptySource = false,
}) {
  const plan = {
    pairId: pair.id,
    creates: [],
    updates: [],
    deletes: [],
    unchanged: 0,
    skipped: {},
    warnings: [],
    /** True when we refused to act on this pair at all. */
    blocked: false,
  };

  // A failed source fetch is indistinguishable from "the source is empty" by
  // looking at the data, and acting on that guess would delete every mirror.
  // So a pair whose source did not load is skipped entirely.
  if (!sourceOk) {
    plan.blocked = true;
    plan.warnings.push(
      `${pair.id}: source calendar could not be read; skipping this pair (no writes, no deletes).`,
    );
    return plan;
  }

  const desired = new Map();
  for (const event of sourceEvents) {
    const reason = skipReason(event, config.filters);
    if (reason) {
      plan.skipped[reason] = (plan.skipped[reason] || 0) + 1;
      continue;
    }
    desired.set(event.id, renderMirror({ pair, event, config }));
  }

  // Only ever consider events carrying our marker *and* this pair's id. Anything
  // else in the target calendar -- real events, mirrors owned by another pair --
  // is invisible to this plan and can never be deleted by it.
  const bySource = new Map();
  const duplicates = [];
  for (const event of mirrorEvents) {
    const props = event.extendedProperties?.private || {};
    if (!isMirror(event) || props[PROP.PAIR] !== pair.id) continue;
    const sourceId = props[PROP.SOURCE_ID];
    if (!sourceId) {
      duplicates.push({ eventId: event.id, reason: 'no-source-id' });
      continue;
    }
    if (bySource.has(sourceId)) {
      // Can happen if the event was duplicated in the Google Calendar UI.
      duplicates.push({ eventId: event.id, reason: 'duplicate' });
      continue;
    }
    bySource.set(sourceId, event);
  }

  for (const [sourceId, rendered] of desired) {
    const existing = bySource.get(sourceId);
    if (!existing) {
      plan.creates.push({ sourceEventId: sourceId, body: rendered.body, label: rendered.label });
      continue;
    }
    const current = existing.extendedProperties?.private?.[PROP.FINGERPRINT];
    if (current === rendered.fingerprint) {
      plan.unchanged += 1;
      continue;
    }
    plan.updates.push({
      eventId: existing.id,
      sourceEventId: sourceId,
      body: rendered.body,
      label: rendered.label,
    });
  }

  const orphans = [];
  for (const [sourceId, event] of bySource) {
    if (desired.has(sourceId)) continue;
    orphans.push({ eventId: event.id, sourceEventId: sourceId, reason: 'orphan' });
  }

  plan.deletes = [...duplicates, ...orphans];

  // Second valve: the source loaded fine but came back empty while mirrors
  // exist. Legitimate if the user really cleared their calendar, suspicious
  // otherwise, so require an explicit flag rather than guessing.
  if (desired.size === 0 && plan.deletes.length > 0 && !allowEmptySource) {
    plan.warnings.push(
      `${pair.id}: source has no syncable events but ${plan.deletes.length} mirror(s) exist. ` +
        'Refusing to delete. Re-run with --allow-empty-source if this is intended.',
    );
    plan.deletes = [];
    return plan;
  }

  // Third valve: a bounded blast radius for any bug in the logic above.
  const cap = config.safety?.maxDeletesPerPairPerRun ?? 100;
  if (plan.deletes.length > cap) {
    plan.warnings.push(
      `${pair.id}: ${plan.deletes.length} deletions exceed safety cap of ${cap}. ` +
        'Refusing to delete. Inspect with --dry-run, then raise safety.maxDeletesPerPairPerRun.',
    );
    plan.deletes = [];
  }

  return plan;
}
