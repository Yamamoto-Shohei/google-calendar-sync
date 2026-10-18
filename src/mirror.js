import crypto from 'node:crypto';

/**
 * Keys written into the mirror event's extendedProperties.private.
 *
 * MARKER is deliberately separate from PAIR: "is this event one of ours?" has to
 * be answerable without knowing which directed pair it belongs to, because that
 * single question is what stops a bidirectional mesh from re-mirroring mirrors.
 */
export const PROP = {
  MARKER: 'gcsMirror',
  PAIR: 'gcsPair',
  SOURCE_ID: 'gcsSourceEventId',
  FINGERPRINT: 'gcsFingerprint',
};

export const MARKER_VALUE = '1';

/**
 * Third-party blocking services (Lynx and the like) tag their holds with this.
 * Not our marker, so without an explicit check their blocks look like ordinary
 * meetings and get mirrored -- and because such a service writes a block onto
 * every account in parallel, one real meeting turns into nine entries across
 * three calendars: the original, two blocks, and six mirrors of those.
 */
const EXTERNAL_BLOCK_PROP = 'block_event_type';
const EXTERNAL_BLOCK_VALUE = 'block';

const MIRROR_NOTE =
  'google-calendar-sync が自動作成した予定です。手で編集しても次回の同期で上書きされます。';

/** True for events this tool created. Mirrors must never be used as a sync source. */
export function isMirror(event) {
  return event?.extendedProperties?.private?.[PROP.MARKER] === MARKER_VALUE;
}

/** True for a hold written by another calendar-blocking service. */
export function isExternalBlock(event) {
  return event?.extendedProperties?.private?.[EXTERNAL_BLOCK_PROP] === EXTERNAL_BLOCK_VALUE;
}

function isAllDay(event) {
  return Boolean(event?.start?.date);
}

/** Minutes the event occupies; all-day events count as whole days. */
export function durationMinutes(event) {
  if (isAllDay(event)) {
    const start = Date.parse(`${event.start.date}T00:00:00Z`);
    const end = Date.parse(`${event.end?.date || event.start.date}T00:00:00Z`);
    return Math.max(0, Math.round((end - start) / 60000));
  }
  const start = Date.parse(event?.start?.dateTime);
  const end = Date.parse(event?.end?.dateTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 60000));
}

function selfResponse(event) {
  const me = (event.attendees || []).find((a) => a.self);
  return me?.responseStatus;
}

/**
 * Returns a reason string when the event must not be mirrored, else null.
 * Mirrors are rejected here too, as a safety net independent of the caller.
 */
export function skipReason(event, filters) {
  if (isMirror(event)) return 'mirror';
  // Defaults on, and tolerant of a partial filters object: the whole point is
  // to hold even when nobody thought to enable it.
  if (filters.skipExternalBlocks !== false && isExternalBlock(event)) return 'external-block';
  if (event.status === 'cancelled') return 'cancelled';
  if (!event.start || !event.end) return 'no-time';
  if (filters.skipWorkingLocation && event.eventType === 'workingLocation') {
    return 'working-location';
  }
  if (filters.skipAllDay && isAllDay(event)) return 'all-day';
  if (filters.skipTransparent && event.transparency === 'transparent') return 'free';
  if (filters.skipDeclined && selfResponse(event) === 'declined') return 'declined';
  const min = filters.minDurationMinutes || 0;
  if (min > 0 && durationMinutes(event) < min) return 'too-short';
  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatLocal(event, which) {
  if (isAllDay(event)) {
    if (which === 'end') {
      // Google stores an exclusive end date for all-day events; show the
      // inclusive last day instead, which is what a human expects to read.
      const ms = Date.parse(`${event.end?.date || event.start.date}T00:00:00Z`) - 86400000;
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    return event.start.date;
  }
  const iso = which === 'end' ? event.end?.dateTime : event.start?.dateTime;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Expand the label template. Plain text with no tokens is the normal case --
 * tokens exist for people who do want some of the original event to show.
 */
export function renderLabel(template, { event, sourceMember }) {
  const tokens = {
    summary: event.summary || '',
    start: formatLocal(event, 'start'),
    end: formatLocal(event, 'end'),
    durationMinutes: String(durationMinutes(event)),
    calendarName: sourceMember?.label || sourceMember?.id || '',
  };
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
    key in tokens ? tokens[key] : match,
  );
}

function copyTime(time) {
  if (!time) return undefined;
  if (time.date) return { date: time.date };
  return time.timeZone ? { dateTime: time.dateTime, timeZone: time.timeZone } : { dateTime: time.dateTime };
}

function fingerprintOf(fields) {
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 32);
}

/**
 * Build the mirror event body for one source event.
 *
 * The fingerprint covers every field we write, so any change -- the source
 * moving, or the label being edited in the setup screen -- shows up as a diff
 * on the next run and gets patched.
 */
export function renderMirror({ pair, event, config }) {
  const label = renderLabel(pair.label, { event, sourceMember: pair.source });
  const start = copyTime(event.start);
  const end = copyTime(event.end);
  const transparency = event.transparency === 'transparent' ? 'transparent' : 'opaque';
  const description = config.annotateDescription === false ? undefined : MIRROR_NOTE;
  // Only tint mirrors that share a calendar with real events; a dedicated
  // sub-calendar already carries its own colour.
  const colorId = pair.target.writeMode === 'primary' ? config.mirrorColorId : undefined;

  const fingerprint = fingerprintOf({
    summary: label,
    description: description ?? null,
    start,
    end,
    transparency,
    visibility: config.visibility,
    colorId: colorId ?? null,
    reminders: config.reminders,
  });

  const body = {
    summary: label,
    start,
    end,
    transparency,
    visibility: config.visibility,
    reminders:
      config.reminders === 'none'
        ? { useDefault: false, overrides: [] }
        : { useDefault: true },
    extendedProperties: {
      private: {
        [PROP.MARKER]: MARKER_VALUE,
        [PROP.PAIR]: pair.id,
        [PROP.SOURCE_ID]: event.id,
        [PROP.FINGERPRINT]: fingerprint,
      },
    },
  };
  if (description !== undefined) body.description = description;
  if (colorId) body.colorId = colorId;

  return { body, fingerprint, sourceEventId: event.id, label };
}
