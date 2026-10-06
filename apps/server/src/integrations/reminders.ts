/**
 * Scheduled reminders for the Discord bot.
 *
 * A reminder is a durable "at <time>, post <text> to <channel>" record. The
 * service keeps the active set in memory, persists every change as an event
 * (`reminder_created` / `reminder_fired` / `reminder_cancelled`) so reminders
 * survive restarts, and arms a single timer for the next due one.
 *
 * Times are parsed as wall-clock in `timeZone` (env `DOTY_TZ`) and stored as
 * epoch milliseconds (UTC). Nothing here talks to Discord; delivery is injected
 * through `onDue`.
 */

import { randomUUID } from 'node:crypto';
import type { EventLog } from '../events/log.js';

/** Default time zone for parsing wall-clock times. Overridable via `DOTY_TZ`. */
export const DEFAULT_TIME_ZONE = 'America/Mexico_City';

export interface Reminder {
  id: string;
  /** Absolute due time, epoch ms. */
  dueAt: number;
  /** Discord channel to post to (a DM channel or a guild channel). */
  channelId: string;
  userId: string;
  /** When set, the delivery mentions the user (`<@id>`) — i.e. a guild channel. */
  guildId?: string;
  /** Memory scope of the conversation that created it (`discord:dm:<id>` …). */
  conversationKey: string;
  text: string;
  createdAt: number;
}

export interface ReminderServiceOptions {
  log: EventLog;
  /** Called when a reminder comes due. Errors are caught and logged. */
  onDue: (reminder: Reminder) => void | Promise<void>;
  /** Metadata-only logger (never pass reminder text to logs if avoidable). */
  logger?: (message: string) => void;
  now?: () => number;
}

// Node timers clamp at 2^31-1 ms (~24.8 days); re-arm instead of overflowing.
const MAX_TIMEOUT_MS = 2_147_483_647;
const CREATED = 'reminder_created';
const FIRED = 'reminder_fired';
const CANCELLED = 'reminder_cancelled';

/**
 * Durable reminder queue. Single process; the event log is the source of truth,
 * so a restart rebuilds the pending set via {@link ReminderService.hydrate}.
 */
export class ReminderService {
  readonly #byId = new Map<string, Reminder>();
  readonly #log: EventLog;
  readonly #onDue: (reminder: Reminder) => void | Promise<void>;
  readonly #logger: (message: string) => void;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: ReminderServiceOptions) {
    this.#log = options.log;
    this.#onDue = options.onDue;
    this.#logger = options.logger ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
  }

  /** Rebuild the pending set from persisted events, then arm the timer. */
  hydrate(): void {
    for (const event of this.#log.since(0)) {
      const data = asRecord(event.data);
      if (!data) continue;
      if (event.type === CREATED) {
        const reminder = readReminder(data);
        if (reminder) this.#byId.set(reminder.id, reminder);
      } else if (event.type === FIRED || event.type === CANCELLED) {
        if (typeof data.id === 'string') this.#byId.delete(data.id);
      }
    }
    this.#arm();
  }

  schedule(input: Omit<Reminder, 'id' | 'createdAt'> & { id?: string }): Reminder {
    const reminder: Reminder = {
      id: input.id ?? randomUUID(),
      dueAt: input.dueAt,
      channelId: input.channelId,
      userId: input.userId,
      ...(input.guildId ? { guildId: input.guildId } : {}),
      conversationKey: input.conversationKey,
      text: input.text,
      createdAt: this.#now(),
    };
    this.#byId.set(reminder.id, reminder);
    this.#log.append({ type: CREATED, data: { ...reminder } });
    this.#arm();
    return reminder;
  }

  /** Cancel by full id or a unique id prefix. Returns the removed reminder. */
  cancel(idOrPrefix: string): Reminder | undefined {
    const target = idOrPrefix.trim();
    if (!target) return undefined;
    for (const reminder of this.#byId.values()) {
      if (reminder.id === target || reminder.id.startsWith(target)) {
        this.#byId.delete(reminder.id);
        this.#log.append({ type: CANCELLED, data: { id: reminder.id } });
        this.#arm();
        return reminder;
      }
    }
    return undefined;
  }

  /** Pending reminders, soonest first. */
  list(): Reminder[] {
    return [...this.#byId.values()].sort((a, b) => a.dueAt - b.dueAt);
  }

  pending(): number {
    return this.#byId.size;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #arm(): void {
    if (this.#stopped) return;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    let next: Reminder | undefined;
    for (const reminder of this.#byId.values()) {
      if (!next || reminder.dueAt < next.dueAt) next = reminder;
    }
    if (!next) return;
    const delay = Math.max(0, Math.min(next.dueAt - this.#now(), MAX_TIMEOUT_MS));
    this.#timer = setTimeout(() => this.#fire(), delay);
    this.#timer.unref?.();
  }

  #fire(): void {
    this.#timer = undefined;
    const now = this.#now();
    const due = [...this.#byId.values()]
      .filter((reminder) => reminder.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt);
    for (const reminder of due) {
      this.#byId.delete(reminder.id);
      this.#log.append({ type: FIRED, data: { id: reminder.id, firedAt: now } });
      try {
        void Promise.resolve(this.#onDue(reminder)).catch((error: unknown) => {
          this.#logger(`reminder: delivery failed (${error instanceof Error ? error.name : 'unknown'})`);
        });
      } catch (error) {
        this.#logger(`reminder: delivery failed (${error instanceof Error ? error.name : 'unknown'})`);
      }
    }
    if (due.length > 0) this.#logger(`reminder: fired ${due.length}`);
    this.#arm();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readReminder(data: Record<string, unknown>): Reminder | null {
  const { id, dueAt, channelId, userId, guildId, conversationKey, text, createdAt } = data;
  if (typeof id !== 'string' || typeof dueAt !== 'number' || !Number.isFinite(dueAt)
    || typeof channelId !== 'string' || typeof userId !== 'string'
    || typeof conversationKey !== 'string' || typeof text !== 'string') {
    return null;
  }
  return {
    id,
    dueAt,
    channelId,
    userId,
    ...(typeof guildId === 'string' ? { guildId } : {}),
    conversationKey,
    text,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
  };
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

export interface ReminderParseOptions {
  /** "Now" in epoch ms. Defaults to `Date.now()`. */
  now?: number;
  /** IANA zone for wall-clock input. Defaults to {@link DEFAULT_TIME_ZONE}. */
  timeZone?: string;
  /** Leading words to ignore ("doty", "bot"). */
  triggerWords?: readonly string[];
}

export type ReminderParseResult =
  | { kind: 'ok'; dueAt: number; text: string }
  | { kind: 'error'; message: string };

const NO_TIME_MESSAGE =
  'No entendí cuándo 🙂. Dime, por ejemplo: «recuérdame el 6 de octubre a las 15:00 de llamar a alguien».';

const TRIGGER_RE =
  /\b(?:recu[eé]rdame|recuerdame|record[aá]rme|recordatorio|av[ií]same|remind\s+me|set\s+a\s+reminder|reminder)\b/i;

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9,
  sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const TIME_PART = String.raw`(?:a\s+las?|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|h|hs|hrs|horas?|de\s+la\s+(?:ma[ñn]ana|tarde|noche))?`;

/** Split a raw text into a due time and the reminder body, or an error. */
export function parseReminder(text: string, options: ReminderParseOptions = {}): ReminderParseResult | null {
  const tz = resolveTimeZone(options.timeZone);
  const now = options.now ?? Date.now();
  const cleaned = stripTriggerWords(text ?? '', options.triggerWords ?? []);
  const trigger = TRIGGER_RE.exec(cleaned);
  if (!trigger) return null;

  const after = cleaned.slice(trigger.index + trigger[0].length);
  const when = parseWhen(after, now, tz);
  if (!when) return { kind: 'error', message: NO_TIME_MESSAGE };

  let rest = `${after.slice(0, when.index)} ${after.slice(when.index + when.length)}`;
  rest = rest.replace(/^[\s,.;:!¡¿?\-–—]+/, '');
  for (let i = 0; i < 3; i += 1) rest = rest.replace(/^(?:de|que|para|to|a)\b\s*/i, '');
  rest = rest.replace(/^[\s,.;:!¡¿?\-–—]+/, '').replace(/\s{2,}/g, ' ').trim();

  return { kind: 'ok', dueAt: when.dueAt, text: rest || 'Recordatorio' };
}

interface WhenMatch {
  index: number;
  length: number;
  dueAt: number;
}

function parseWhen(input: string, now: number, tz: string): WhenMatch | null {
  const text = input;
  if (!text.trim()) return null;
  const today = partsInTz(now, tz);

  // 1) ISO-ish: 2026-10-06T15:00 / 2026-10-06 15:00
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/.exec(text);
  if (iso) {
    const dueAt = zonedTimeToUtc(tz, num(iso[1]), num(iso[2]), num(iso[3]), num(iso[4]), num(iso[5]));
    return { index: iso.index, length: iso[0].length, dueAt };
  }

  // 2) "<day> de <month> [de <year>] [<time>]"
  const md = new RegExp(String.raw`\b(?:el\s+)?(\d{1,2})\s+de\s+([a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1]+)(?:\s+de\s+(\d{4}))?(?:\s+${TIME_PART})?`, 'i').exec(text);
  if (md) {
    const month = MONTHS[md[2]!.toLowerCase()];
    if (month) {
      const parsed = resolveAbsolute(today, num(md[1]), month, md[3] ? num(md[3]) : undefined,
        {...timeFrom(md[4], md[5], md[6]), defaultHour: 9}, now, tz);
      return { index: md.index, length: md[0].length, dueAt: parsed };
    }
  }

  // 3) "<day>/<month>[/<year>] [<time>]"
  const numeric = new RegExp(String.raw`\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?(?:\s+${TIME_PART})?`, 'i').exec(text);
  if (numeric) {
    const yearPart = numeric[3] ? num(numeric[3]) : undefined;
    const parsed = resolveAbsolute(today, num(numeric[1]), num(numeric[2]),
      yearPart !== undefined && yearPart < 100 ? 2000 + yearPart : yearPart,
      {...timeFrom(numeric[4], numeric[5], numeric[6]), defaultHour: 9}, now, tz);
    return { index: numeric.index, length: numeric[0].length, dueAt: parsed };
  }

  // 4) Relative: "en 5 minutos", "en media hora"
  const rel = /\ben\s+(un|una|media|\d+)\s*(segundos?|minutos?|horas?|d[ií]as?|semanas?)\b/i.exec(text);
  if (rel) {
    const amount = rel[1]!.toLowerCase() === 'media' ? 0.5 : /^\d+$/.test(rel[1]!) ? Number(rel[1]) : 1;
    const unit = rel[2]!.toLowerCase();
    const unitMs = unit.startsWith('seg') ? 1_000
      : unit.startsWith('min') ? 60_000
      : unit.startsWith('hor') ? 3_600_000
      : unit.startsWith('sem') ? 604_800_000
      : 86_400_000;
    return { index: rel.index, length: rel[0].length, dueAt: now + Math.round(amount * unitMs) };
  }

  // 5) "hoy" / "mañana" / "pasado mañana" [+ time]
  const day = new RegExp(String.raw`\b(hoy|ma[ñn]ana|pasado\s+ma[ñn]ana|today|tomorrow)\b(?:\s+${TIME_PART})?`, 'i').exec(text);
  if (day) {
    const word = day[1]!.toLowerCase();
    const offset = word.startsWith('pasado') ? 2 : word === 'hoy' || word === 'today' ? 0 : 1;
    const [year, month, date] = civilParts(Date.UTC(today.year, today.month - 1, today.day + offset));
    const t = timeFrom(day[2], day[3], day[4]);
    const dueAt = zonedTimeToUtc(tz, year, month, date, t.hour ?? 9, t.minute ?? 0);
    return { index: day.index, length: day[0].length, dueAt };
  }

  // 6) Time only: "a las 20:00" (today, or tomorrow if already past).
  const time = new RegExp(String.raw`\b${TIME_PART}`, 'i').exec(text);
  if (time) {
    const t = timeFrom(time[1], time[2], time[3]);
    let dueAt = zonedTimeToUtc(tz, today.year, today.month, today.day, t.hour ?? 0, t.minute ?? 0);
    if (dueAt <= now) {
      const [year, month, date] = civilParts(Date.UTC(today.year, today.month - 1, today.day + 1));
      dueAt = zonedTimeToUtc(tz, year, month, date, t.hour ?? 0, t.minute ?? 0);
    }
    return { index: time.index, length: time[0].length, dueAt };
  }

  return null;
}

interface TimeParts {
  hour?: number;
  minute?: number;
}

function timeFrom(hourRaw: string | undefined, minuteRaw: string | undefined, suffixRaw: string | undefined): TimeParts {
  if (!hourRaw) return {};
  let hour = Number(hourRaw);
  const minute = minuteRaw ? Number(minuteRaw) : 0;
  const suffix = (suffixRaw ?? '').toLowerCase();
  if (/^p/.test(suffix) || suffix.includes('tarde') || suffix.includes('noche')) {
    if (hour < 12) hour += 12;
  } else if (/^a/.test(suffix) || suffix.includes('mañana')) {
    if (hour === 12) hour = 0;
  }
  return { hour, minute };
}

function resolveAbsolute(
  today: { year: number; month: number; day: number },
  day: number,
  month: number,
  year: number | undefined,
  time: TimeParts & { defaultHour: number },
  now: number,
  tz: string,
): number {
  const hour = time.hour ?? time.defaultHour;
  const minute = time.minute ?? 0;
  if (year !== undefined) return zonedTimeToUtc(tz, year, month, day, hour, minute);
  let dueAt = zonedTimeToUtc(tz, today.year, month, day, hour, minute);
  if (dueAt <= now) dueAt = zonedTimeToUtc(tz, today.year + 1, month, day, hour, minute);
  return dueAt;
}

function stripTriggerWords(text: string, triggerWords: readonly string[]): string {
  let cleaned = (text ?? '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of triggerWords) {
      if (!word) continue;
      const stripped = cleaned.replace(new RegExp(`^${escapeRegExp(word)}\\b[:,]?\\s*`, 'i'), '');
      if (stripped !== cleaned) {
        cleaned = stripped;
        changed = true;
      }
    }
  }
  return cleaned.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function num(value: string | undefined): number {
  return value ? Number(value) : Number.NaN;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Calendar parts of an instant, as seen in `tz`. */
function partsInTz(ms: number, tz: string): ZonedParts {
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

/** Normalize a `Date.UTC(...)` wall-value into [year, month, day] (day overflow rolls). */
function civilParts(baseUtc: number): [number, number, number] {
  const date = new Date(baseUtc);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

function tzOffsetMs(tz: string, utcMs: number): number {
  const parts = partsInTz(utcMs, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

/** Convert a wall-clock time in `tz` to epoch ms (two-pass DST-safe). */
function zonedTimeToUtc(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMs(tz, guess);
  let ts = guess - offset1;
  const offset2 = tzOffsetMs(tz, ts);
  if (offset2 !== offset1) ts = guess - offset2;
  return ts;
}

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

/** Human-readable instant in `tz` (for confirmations and listings). */
export function formatInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('es', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' })
    .format(new Date(ms));
}

// ---------------------------------------------------------------------------
// Discord command surface
// ---------------------------------------------------------------------------

export interface ReminderCommandContext {
  channelId: string;
  userId: string;
  guildId?: string;
  conversationKey: string;
}

export interface ReminderCommandOptions {
  now?: number;
  timeZone?: string;
  triggerWords?: readonly string[];
}

const LIST_RE = /^(?:mis\s+|ver\s+|lista\s+(?:de\s+)?)?recordatorios\s*$/i;
const CANCEL_RE =
  /^(?:cancela|cancelar|borra|borrar|elimina|eliminar|quita|quitar)\s+(?:el\s+|los\s+|todos\s+los\s+|mis\s+)?recordatorios?\s+([0-9a-fA-F-]{4,})\s*$/i;

/**
 * Handle a reminder message. Returns the reply text (which suppresses the agent)
 * or `undefined` when the message is not a reminder command.
 */
export function handleReminderMessage(
  text: string,
  context: ReminderCommandContext,
  service: ReminderService,
  options: ReminderCommandOptions = {},
): string | undefined {
  const tz = resolveTimeZone(options.timeZone);
  const cleaned = stripTriggerWords(text, options.triggerWords ?? []);

  if (LIST_RE.test(cleaned)) {
    const all = service.list();
    if (all.length === 0) return 'No tienes recordatorios pendientes.';
    const lines = all.map((r) => `• ${formatInTz(r.dueAt, tz)} — ${r.text} (id ${r.id.slice(0, 8)})`);
    return `Tienes ${all.length} recordatorio(s):\n${lines.join('\n')}`;
  }

  const cancel = CANCEL_RE.exec(cleaned);
  if (cancel) {
    const removed = service.cancel(cancel[1] ?? '');
    return removed ? `🗑️ Cancelado: «${removed.text}».` : 'No encontré ese recordatorio.';
  }

  const parsed = parseReminder(cleaned, { now: options.now, timeZone: tz, triggerWords: options.triggerWords });
  if (!parsed) return undefined;
  if (parsed.kind === 'error') return parsed.message;

  const reminder = service.schedule({
    dueAt: parsed.dueAt,
    channelId: context.channelId,
    userId: context.userId,
    ...(context.guildId ? { guildId: context.guildId } : {}),
    conversationKey: context.conversationKey,
    text: parsed.text,
  });
  return `⏰ Vale, te aviso ${formatInTz(reminder.dueAt, tz)}: «${reminder.text}» (id ${reminder.id.slice(0, 8)})`;
}
