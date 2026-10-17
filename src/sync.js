import { expandPairs, mirrorTarget } from './config.js';
import { log } from './log.js';
import { MARKER_VALUE, PROP } from './mirror.js';
import { planPair } from './planner.js';
import { errorMessage, mapLimit } from './util.js';

const WRITE_CONCURRENCY = 4;

/**
 * Rolling window: today 00:00 local through N months ahead. The past is never
 * synced, so a mirror that falls behind "today" simply ages out of the window
 * and is left alone as history.
 */
export function syncWindow({ now = new Date(), futureMonths = 3 } = {}) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(end.getMonth() + futureMonths);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function selectPairs(config, only) {
  const pairs = expandPairs(config);
  if (!only) return pairs;
  const wanted = new Set(Array.isArray(only) ? only : [only]);
  return pairs.filter(
    (p) => wanted.has(p.id) || wanted.has(p.source.id) || wanted.has(p.target.id),
  );
}

/**
 * Run one full pass over every directed pair.
 *
 * `clientFor(accountId)` returns a calendar client; injecting it keeps this
 * function testable with a fake and lets clients be shared across pairs.
 */
export async function runSync({
  config,
  clientFor,
  now = new Date(),
  dryRun = false,
  allowEmptySource = false,
  only = null,
}) {
  const window = syncWindow({ now, futureMonths: config.window.futureMonths });
  const pairs = selectPairs(config, only);
  const result = {
    startedAt: now.toISOString(),
    finishedAt: null,
    dryRun,
    window,
    pairs: [],
    totals: { created: 0, updated: 0, deleted: 0, unchanged: 0, blocked: 0, errors: 0, warnings: 0 },
    ok: true,
  };

  if (!pairs.length) {
    result.finishedAt = new Date().toISOString();
    return result;
  }

  // One fetch per source calendar, reused by the (N-1) pairs that read it.
  const sources = new Map();
  for (const pair of pairs) {
    if (sources.has(pair.source.id)) continue;
    sources.set(pair.source.id, loadSource(pair.source, { clientFor, window }));
  }
  // Likewise one fetch per mirror store: every marker-bearing event in the
  // target, grouped per pair later by the planner.
  const mirrors = new Map();
  for (const pair of pairs) {
    if (mirrors.has(pair.target.id)) continue;
    mirrors.set(pair.target.id, loadMirrors(pair.target, { clientFor, window }));
  }

  for (const [id, promise] of sources) sources.set(id, await promise);
  for (const [id, promise] of mirrors) mirrors.set(id, await promise);

  for (const [id, loaded] of sources) {
    if (loaded.error) log.warn(`source "${id}": ${loaded.error}`);
  }
  for (const [id, loaded] of mirrors) {
    if (loaded.error) log.warn(`mirror store "${id}": ${loaded.error}`);
  }

  for (const pair of pairs) {
    const source = sources.get(pair.source.id);
    const mirror = mirrors.get(pair.target.id);
    const entry = await syncOnePair({
      pair,
      source,
      mirror,
      config,
      clientFor,
      dryRun,
      allowEmptySource,
    });
    result.pairs.push(entry);
    result.totals.created += entry.created;
    result.totals.updated += entry.updated;
    result.totals.deleted += entry.deleted;
    result.totals.unchanged += entry.unchanged;
    result.totals.warnings += entry.warnings.length;
    result.totals.errors += entry.errors.length;
    if (entry.blocked) result.totals.blocked += 1;
  }

  result.ok = result.totals.errors === 0 && result.totals.blocked === 0;
  result.finishedAt = new Date().toISOString();
  return result;
}

async function loadSource(member, { clientFor, window }) {
  try {
    const client = await clientFor(member.accountId);
    const events = await client.listEvents({
      calendarId: member.sourceCalendarId,
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      singleEvents: true,
    });
    return { ok: true, events, error: null };
  } catch (err) {
    return { ok: false, events: [], error: errorMessage(err) };
  }
}

async function loadMirrors(member, { clientFor, window }) {
  try {
    const client = await clientFor(member.accountId);
    const events = await client.listEvents({
      calendarId: mirrorTarget(member),
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      singleEvents: true,
      privateExtendedProperty: [`${PROP.MARKER}=${MARKER_VALUE}`],
    });
    return { ok: true, events, error: null };
  } catch (err) {
    return { ok: false, events: [], error: errorMessage(err) };
  }
}

async function syncOnePair({ pair, source, mirror, config, clientFor, dryRun, allowEmptySource }) {
  const entry = {
    pairId: pair.id,
    label: pair.label,
    targetCalendarId: mirrorTarget(pair.target),
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    skipped: {},
    warnings: [],
    errors: [],
    blocked: false,
  };

  // Without the target's current mirrors we cannot tell a create from an
  // update, and every existing mirror would look absent. Skip, don't guess.
  if (!mirror.ok) {
    entry.blocked = true;
    entry.warnings.push(
      `${pair.id}: mirror calendar could not be read; skipping this pair (no writes, no deletes).`,
    );
    return entry;
  }

  const plan = planPair({
    pair,
    sourceEvents: source.events,
    mirrorEvents: mirror.events,
    config,
    sourceOk: source.ok,
    allowEmptySource,
  });

  entry.skipped = plan.skipped;
  entry.unchanged = plan.unchanged;
  entry.warnings.push(...plan.warnings);
  entry.blocked = plan.blocked;

  if (plan.blocked) return entry;

  if (dryRun) {
    entry.created = plan.creates.length;
    entry.updated = plan.updates.length;
    entry.deleted = plan.deletes.length;
    entry.plan = describePlan(plan);
    return entry;
  }

  const calendarId = mirrorTarget(pair.target);
  const client = await clientFor(pair.target.accountId);

  await mapLimit(plan.creates, WRITE_CONCURRENCY, async (item) => {
    try {
      await client.insertEvent({ calendarId, body: item.body });
      entry.created += 1;
    } catch (err) {
      entry.errors.push(`create ${item.sourceEventId}: ${errorMessage(err)}`);
    }
  });

  await mapLimit(plan.updates, WRITE_CONCURRENCY, async (item) => {
    try {
      await client.patchEvent({ calendarId, eventId: item.eventId, body: item.body });
      entry.updated += 1;
    } catch (err) {
      entry.errors.push(`update ${item.eventId}: ${errorMessage(err)}`);
    }
  });

  await mapLimit(plan.deletes, WRITE_CONCURRENCY, async (item) => {
    try {
      await client.deleteEvent({ calendarId, eventId: item.eventId });
      entry.deleted += 1;
    } catch (err) {
      entry.errors.push(`delete ${item.eventId}: ${errorMessage(err)}`);
    }
  });

  return entry;
}

function describePlan(plan) {
  const when = (body) => body.start?.dateTime || body.start?.date || '?';
  return {
    creates: plan.creates.map((c) => `${when(c.body)}  ${c.label}`),
    updates: plan.updates.map((u) => `${when(u.body)}  ${u.label}`),
    deletes: plan.deletes.map((d) => `${d.eventId} (${d.reason})`),
  };
}
