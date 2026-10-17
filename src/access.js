import { enabledMembers, isServiceAccountMode, mirrorTarget } from './config.js';
import { errorMessage } from './util.js';

const WRITABLE_ROLES = new Set(['owner', 'writer']);

/**
 * Can we reach this calendar, and may we write to it?
 *
 * Service account mode makes this worth checking up front: access depends on
 * the user having shared each calendar by hand, and a missing share otherwise
 * only shows up as a failed sync.
 */
export async function checkCalendarAccess(client, calendarId, { needWrite }) {
  try {
    // Try the calendarList first -- it is the only response that states the role.
    let entry = await client.getCalendarListEntry(calendarId);
    if (!entry) {
      // Not in the list. Registering it is harmless and makes the role visible.
      try {
        entry = await client.addToCalendarList(calendarId);
      } catch {
        entry = null;
      }
    }
    if (entry) {
      const role = entry.accessRole;
      const canWrite = WRITABLE_ROLES.has(role);
      return {
        calendarId,
        ok: needWrite ? canWrite : Boolean(role),
        role,
        summary: entry.summary,
        needWrite,
        error: canWrite || !needWrite
          ? null
          : `access is "${role}"; "writer" or "owner" is required to write mirrors`,
      };
    }

    // Fall back to a plain read, which at least proves the calendar is visible.
    const calendar = await client.getCalendar(calendarId);
    return {
      calendarId,
      ok: !needWrite,
      role: 'unknown',
      summary: calendar.summary,
      needWrite,
      error: needWrite ? 'readable, but the write permission could not be confirmed' : null,
    };
  } catch (err) {
    return {
      calendarId,
      ok: false,
      role: null,
      summary: null,
      needWrite,
      error: errorMessage(err),
    };
  }
}

/**
 * Check every calendar the mesh touches. Sources need read access, mirror
 * stores need write access.
 */
export async function checkMeshAccess(config, clientFor) {
  const checks = [];
  for (const member of enabledMembers(config)) {
    const client = await clientFor(member.accountId);
    const target = mirrorTarget(member);

    // `kind` is what the calendar is used for; `role` is Google's accessRole.
    // Keeping the names apart matters: spreading the check result over a
    // field also called `role` silently overwrote the usage label.
    if (target === member.sourceCalendarId) {
      // Primary-direct mode: one calendar serving both ends, so a single check
      // against the stricter of the two requirements.
      checks.push({
        ...(await checkCalendarAccess(client, target, { needWrite: true })),
        memberId: member.id,
        kind: 'source+mirror',
      });
      continue;
    }

    checks.push({
      ...(await checkCalendarAccess(client, member.sourceCalendarId, { needWrite: false })),
      memberId: member.id,
      kind: 'source',
    });
    checks.push({
      ...(await checkCalendarAccess(client, target, { needWrite: true })),
      memberId: member.id,
      kind: 'mirror',
    });
  }
  return {
    mode: isServiceAccountMode(config) ? 'service-account' : 'oauth',
    checks,
    ok: checks.every((c) => c.ok),
  };
}
