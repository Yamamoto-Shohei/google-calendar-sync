import { withDefaults } from '../src/config.js';
import { MARKER_VALUE, PROP } from '../src/mirror.js';

export function makeConfig(overrides = {}) {
  return withDefaults({
    defaultLabel: '予定あり',
    accounts: [
      { id: 'acct-a', email: 'a@example.com' },
      { id: 'acct-b', email: 'b@example.com' },
      { id: 'acct-c', email: 'c@example.com' },
    ],
    members: [
      {
        id: 'A',
        label: '仕事',
        accountId: 'acct-a',
        sourceCalendarId: 'primary',
        writeMode: 'subcalendar',
        mirrorCalendarId: 'mirror-a',
      },
      {
        id: 'B',
        label: '副業',
        accountId: 'acct-b',
        sourceCalendarId: 'primary',
        writeMode: 'subcalendar',
        mirrorCalendarId: 'mirror-b',
      },
      {
        id: 'C',
        label: 'プライベート',
        accountId: 'acct-c',
        sourceCalendarId: 'primary',
        writeMode: 'subcalendar',
        mirrorCalendarId: 'mirror-c',
      },
    ],
    labels: {
      'A->B': '秘密の予定',
      'A->C': 'プライベートの予定',
    },
    ...overrides,
  });
}

export function timedEvent({ id, start, end, ...rest }) {
  return {
    id,
    status: 'confirmed',
    start: { dateTime: start, timeZone: 'Asia/Tokyo' },
    end: { dateTime: end, timeZone: 'Asia/Tokyo' },
    ...rest,
  };
}

export function allDayEvent({ id, date, endDate, ...rest }) {
  return {
    id,
    status: 'confirmed',
    start: { date },
    end: { date: endDate },
    ...rest,
  };
}

/** A mirror event as it would come back from the target calendar. */
export function mirrorEvent({ id, pair, sourceEventId, fingerprint, start, end, summary }) {
  return {
    id,
    status: 'confirmed',
    summary,
    start: start ? { dateTime: start, timeZone: 'Asia/Tokyo' } : undefined,
    end: end ? { dateTime: end, timeZone: 'Asia/Tokyo' } : undefined,
    extendedProperties: {
      private: {
        [PROP.MARKER]: MARKER_VALUE,
        [PROP.PAIR]: pair,
        [PROP.SOURCE_ID]: sourceEventId,
        [PROP.FINGERPRINT]: fingerprint,
      },
    },
  };
}

/**
 * In-memory stand-in for the Calendar API.
 *
 * Calendars are keyed "<accountId>:<calendarId>" because several accounts each
 * have a calendar literally named "primary". Every write is recorded so tests
 * can assert on what the sync actually sent.
 */
export function fakeGoogle({ calendars = {}, failListFor = [] } = {}) {
  const store = new Map(Object.entries(calendars).map(([k, v]) => [k, [...v]]));
  const calls = { inserts: [], patches: [], deletes: [], lists: [] };
  let nextId = 1;

  const clientFor = async (accountId) => {
    const key = (calendarId) => `${accountId}:${calendarId}`;
    return {
      async listEvents({ calendarId, privateExtendedProperty }) {
        calls.lists.push({ key: key(calendarId), privateExtendedProperty });
        if (failListFor.includes(key(calendarId))) {
          const err = new Error(`boom: ${key(calendarId)}`);
          err.response = { status: 500 };
          throw err;
        }
        const all = store.get(key(calendarId)) || [];
        if (!privateExtendedProperty?.length) return all;
        // Mimic the server-side extendedProperties filter (AND over all terms).
        return all.filter((event) =>
          privateExtendedProperty.every((term) => {
            const [propKey, value] = term.split('=');
            return event.extendedProperties?.private?.[propKey] === value;
          }),
        );
      },
      async insertEvent({ calendarId, body }) {
        calls.inserts.push({ key: key(calendarId), body });
        const created = { ...body, id: `gen-${nextId++}` };
        if (!store.has(key(calendarId))) store.set(key(calendarId), []);
        store.get(key(calendarId)).push(created);
        return created;
      },
      async patchEvent({ calendarId, eventId, body }) {
        calls.patches.push({ key: key(calendarId), eventId, body });
        const list = store.get(key(calendarId)) || [];
        const index = list.findIndex((e) => e.id === eventId);
        if (index === -1) return null;
        list[index] = { ...list[index], ...body };
        return list[index];
      },
      async deleteEvent({ calendarId, eventId }) {
        calls.deletes.push({ key: key(calendarId), eventId });
        const list = store.get(key(calendarId)) || [];
        const index = list.findIndex((e) => e.id === eventId);
        if (index !== -1) list.splice(index, 1);
        return true;
      },
    };
  };

  return { calls, store, clientFor };
}
