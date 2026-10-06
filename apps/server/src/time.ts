/**
 * Time-zone helpers for schedules and date-bounded email queries.
 *
 * All conversions go through `Intl` (no date library): wall clock in a zone →
 * epoch and back, two-pass DST-safe. Mexico City has no DST today, but keeping
 * the math generic means `DOTY_TZ` can move without surprises.
 */

export const DEFAULT_TIME_ZONE = 'America/Mexico_City';

/** Validate an IANA zone, falling back to UTC when unknown. */
export function resolveTimeZone(raw: string | undefined): string {
  const candidate = raw?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Calendar parts of an instant, as seen in `tz`. */
export function partsInTz(ms: number, tz: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

function tzOffsetMs(tz: string, utcMs: number): number {
  const parts = partsInTz(utcMs, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

/** Convert a wall-clock time in `tz` to epoch ms (two-pass DST-safe). */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMs(tz, guess);
  let ts = guess - offset1;
  const offset2 = tzOffsetMs(tz, ts);
  if (offset2 !== offset1) ts = guess - offset2;
  return ts;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` for an instant, as seen in `tz`. */
export function localDateString(ms: number, tz: string): string {
  const parts = partsInTz(ms, tz);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Shift a `YYYY-MM-DD` string by whole days (calendar-safe). */
export function shiftDateString(dateString: string, days: number): string {
  const [year, month, day] = dateString.split('-').map(Number);
  const base = Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days);
  const date = new Date(base);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Local day bounds: `[start of day, start of next day)`, epoch ms. */
export function dayRange(dateString: string, tz: string): { since: number; until: number } {
  return {
    since: startOfDay(dateString, tz),
    until: startOfDay(shiftDateString(dateString, 1), tz),
  };
}

/** Local midnight of a `YYYY-MM-DD` date, epoch ms. */
export function startOfDay(dateString: string, tz: string): number {
  const [year, month, day] = dateString.split('-').map(Number);
  return zonedTimeToUtc(tz, year ?? 1970, month ?? 1, day ?? 1, 0, 0);
}

/** Local wall-clock `HH:MM` on a `YYYY-MM-DD`, epoch ms. */
export function dayTimeEpoch(dateString: string, time: string, tz: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hour = match ? Number(match[1]) : 0;
  const minute = match ? Number(match[2]) : 0;
  const [year, month, day] = dateString.split('-').map(Number);
  return zonedTimeToUtc(tz, year ?? 1970, month ?? 1, day ?? 1, hour, minute);
}

/** Next occurrence of a daily wall-clock time, strictly after `now`. */
export function nextDailyRun(time: string, tz: string, now: number): number {
  const today = localDateString(now, tz);
  const todayRun = dayTimeEpoch(today, time, tz);
  if (todayRun > now) return todayRun;
  return dayTimeEpoch(shiftDateString(today, 1), time, tz);
}

/** Normalize/validate a `HH:MM` wall-clock time; `undefined` when invalid. */
export function parseTimeOfDay(raw: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * Resolve a tool-facing date bound to epoch ms.
 *
 * Accepts `yesterday`/`ayer`, `today`/`hoy` (start of that local day), a
 * `YYYY-MM-DD` date (local midnight) or an ISO date-time. `undefined` means
 * the value could not be parsed — callers reject it.
 */
export function parseDateBound(raw: string, tz: string, now = Date.now()): number | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'yesterday' || value === 'ayer') {
    return startOfDay(shiftDateString(localDateString(now, tz), -1), tz);
  }
  if (value === 'today' || value === 'hoy') return startOfDay(localDateString(now, tz), tz);
  const date = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (date) return zonedTimeToUtc(tz, Number(date[1]), Number(date[2]), Number(date[3]), 0, 0);
  const dateTime = /^(\d{4})-(\d{1,2})-(\d{1,2})[t ](\d{1,2}):(\d{2})/.exec(value);
  if (dateTime) {
    return zonedTimeToUtc(
      tz,
      Number(dateTime[1]),
      Number(dateTime[2]),
      Number(dateTime[3]),
      Number(dateTime[4]),
      Number(dateTime[5]),
    );
  }
  return undefined;
}

/** Human-readable instant in `tz` (for confirmations and listings). */
export function formatInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('es', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' })
    .format(new Date(ms));
}
