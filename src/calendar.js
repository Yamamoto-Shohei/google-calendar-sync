import { google } from 'googleapis';
import { log } from './log.js';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 16000;
const MAX_PAGES = 100;

const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
  'internalError',
  'quotaExceeded',
]);

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
]);

function httpStatus(err) {
  return err?.response?.status ?? (typeof err?.code === 'number' ? err.code : undefined);
}

function errorReasons(err) {
  const errors = err?.response?.data?.error?.errors || err?.errors || [];
  return errors.map((e) => e.reason).filter(Boolean);
}

export function isRetryable(err) {
  const status = httpStatus(err);
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // 403 is overloaded: rate limiting is retryable, missing permission is not.
  if (status === 403) return errorReasons(err).some((r) => RETRYABLE_REASONS.has(r));
  if (typeof err?.code === 'string' && RETRYABLE_CODES.has(err.code)) return true;
  return false;
}

export function isNotFound(err) {
  const status = httpStatus(err);
  return status === 404 || status === 410;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      // Full jitter, so several pairs backing off at once don't resynchronise.
      const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      const delay = Math.round(Math.random() * ceiling);
      log.debug(`${label}: ${httpStatus(err) ?? err.code} - retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Thin wrapper over the Calendar v3 API: retries, pagination, and "already
 * gone" normalisation. Tests substitute an object with the same shape.
 */
export function createCalendarClient(auth) {
  const api = google.calendar({ version: 'v3', auth });

  return {
    async listCalendars() {
      const out = [];
      let pageToken;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res = await withRetry('calendarList.list', () =>
          api.calendarList.list({ maxResults: 250, pageToken, showHidden: true }),
        );
        out.push(...(res.data.items || []));
        pageToken = res.data.nextPageToken;
        if (!pageToken) break;
      }
      return out;
    },

    async getCalendar(calendarId) {
      const res = await withRetry('calendars.get', () => api.calendars.get({ calendarId }));
      return res.data;
    },

    async createCalendar({ summary, timeZone }) {
      const res = await withRetry('calendars.insert', () =>
        api.calendars.insert({ requestBody: { summary, timeZone } }),
      );
      return res.data;
    },

    /**
     * The calendarList entry carries `accessRole`, which is the only cheap way
     * to learn whether we may write. Returns null when the calendar is not in
     * this identity's list -- common for a service account, which sees shared
     * calendars only after they are added.
     */
    async getCalendarListEntry(calendarId) {
      try {
        const res = await withRetry('calendarList.get', () =>
          api.calendarList.get({ calendarId }),
        );
        return res.data;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    /** Register a shared calendar so it appears in calendarList with its role. */
    async addToCalendarList(calendarId) {
      const res = await withRetry('calendarList.insert', () =>
        api.calendarList.insert({ requestBody: { id: calendarId } }),
      );
      return res.data;
    },

    async listEvents({
      calendarId,
      timeMin,
      timeMax,
      singleEvents = true,
      privateExtendedProperty,
    }) {
      const out = [];
      let pageToken;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res = await withRetry(`events.list(${calendarId})`, () =>
          api.events.list({
            calendarId,
            timeMin,
            timeMax,
            singleEvents,
            // orderBy is only valid alongside singleEvents.
            orderBy: singleEvents ? 'startTime' : undefined,
            showDeleted: false,
            maxResults: 2500,
            privateExtendedProperty,
            pageToken,
          }),
        );
        out.push(...(res.data.items || []));
        pageToken = res.data.nextPageToken;
        if (!pageToken) break;
      }
      return out;
    },

    async insertEvent({ calendarId, body }) {
      const res = await withRetry('events.insert', () =>
        api.events.insert({ calendarId, requestBody: body, sendUpdates: 'none' }),
      );
      return res.data;
    },

    async patchEvent({ calendarId, eventId, body }) {
      try {
        const res = await withRetry('events.patch', () =>
          api.events.patch({ calendarId, eventId, requestBody: body, sendUpdates: 'none' }),
        );
        return res.data;
      } catch (err) {
        // The mirror was removed behind our back; the next run re-creates it.
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async deleteEvent({ calendarId, eventId }) {
      try {
        await withRetry('events.delete', () =>
          api.events.delete({ calendarId, eventId, sendUpdates: 'none' }),
        );
        return true;
      } catch (err) {
        if (isNotFound(err)) return true;
        throw err;
      }
    },
  };
}
