/**
 * Conversational schedules: recurring routines the agent creates on the user's
 * behalf ("envíame el resumen de mis correos todos los días a las 6 am").
 *
 * Event-sourced like the reminder service: every change is a `schedule_*`
 * event, so a restart rebuilds the active set from the log. Firing runs the
 * stored prompt through the agent — the routine itself is whatever the prompt
 * says, not code — and the result lands in the Doty chat (the run's events)
 * plus a Discord DM when configured.
 */

import { randomUUID } from 'node:crypto';
import type { EventLog } from '../events/log.js';
import { dayTimeEpoch, localDateString, nextDailyRun, parseTimeOfDay, resolveTimeZone, shiftDateString } from '../time.js';

export type ScheduleDelivery = 'both' | 'doty';

export interface Schedule {
  id: string;
  /** Full instruction executed at every occurrence. */
  prompt: string;
  /** Daily local wall-clock time, `HH:MM`. */
  time: string;
  /** IANA zone the time is written in. */
  timeZone: string;
  /** `both` (Doty chat + Discord DM) or `doty` (chat only). */
  deliver: ScheduleDelivery;
  /** Agent conversation that receives the run (defaults to the desktop). */
  conversationKey: string;
  createdAt: number;
}

export interface ScheduleInput {
  prompt: string;
  time: string;
  timeZone?: string;
  deliver?: ScheduleDelivery;
  conversationKey?: string;
}

export interface ScheduleRunResult {
  answer?: string;
  error?: string;
}

export interface ScheduleServiceOptions {
  log: EventLog;
  /** Runs one occurrence; the same runner used by chat (in production, OpenCode). */
  run: (prompt: string, conversationKey: string) => Promise<ScheduleRunResult>;
  /** Discord DM delivery; omitted when Discord is not configured. */
  deliverDiscord?: (text: string) => Promise<void>;
  logger?: (message: string) => void;
  now?: () => number;
}

const CREATED = 'schedule_created';
const CANCELLED = 'schedule_cancelled';
const FIRED = 'schedule_fired';

// Node timers clamp at 2^31-1 ms (~24.8 days); re-arm instead of overflowing.
const MAX_TIMEOUT_MS = 2_147_483_647;

export class ScheduleService {
  readonly #byId = new Map<string, Schedule>();
  /** Local day (`YYYY-MM-DD` per schedule zone) of the last run. */
  readonly #lastRun = new Map<string, string>();
  readonly #log: EventLog;
  readonly #run: ScheduleServiceOptions['run'];
  readonly #deliverDiscord: ScheduleServiceOptions['deliverDiscord'];
  readonly #logger: (message: string) => void;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #firing = false;

  constructor(options: ScheduleServiceOptions) {
    this.#log = options.log;
    this.#run = options.run;
    this.#deliverDiscord = options.deliverDiscord;
    this.#logger = options.logger ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
  }

  /** Rebuild the active set from persisted events, then arm the timer. */
  hydrate(): void {
    for (const event of this.#log.since(0)) {
      const data = asRecord(event.data);
      if (!data) continue;
      if (event.type === CREATED) {
        const schedule = readSchedule(data);
        if (schedule) this.#byId.set(schedule.id, schedule);
      } else if (event.type === CANCELLED) {
        if (typeof data.id === 'string') this.#byId.delete(data.id);
      } else if (event.type === FIRED) {
        if (typeof data.id === 'string' && typeof data.day === 'string') {
          this.#lastRun.set(data.id, data.day);
        }
      }
    }
    this.#arm();
  }

  create(input: ScheduleInput): Schedule {
    const prompt = input.prompt?.trim();
    if (!prompt || prompt.length > 4_000) throw new Error('Schedule prompt is required (max 4000 chars)');
    const time = parseTimeOfDay(input.time ?? '');
    if (!time) throw new Error('Schedule time must be HH:MM (24h)');
    const schedule: Schedule = {
      id: randomUUID(),
      prompt,
      time,
      timeZone: resolveTimeZone(input.timeZone),
      deliver: input.deliver === 'doty' ? 'doty' : 'both',
      conversationKey: input.conversationKey?.trim() || 'desktop',
      createdAt: this.#now(),
    };
    this.#byId.set(schedule.id, schedule);
    this.#log.append({ type: CREATED, data: { ...schedule } });
    this.#arm();
    return schedule;
  }

  /** Cancel by full id or a unique id prefix. */
  cancel(idOrPrefix: string): Schedule | undefined {
    const target = idOrPrefix.trim();
    if (!target) return undefined;
    for (const schedule of this.#byId.values()) {
      if (schedule.id === target || schedule.id.startsWith(target)) {
        this.#byId.delete(schedule.id);
        this.#log.append({ type: CANCELLED, data: { id: schedule.id } });
        this.#arm();
        return schedule;
      }
    }
    return undefined;
  }

  list(): Schedule[] {
    return [...this.#byId.values()].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  }

  /** Next occurrence of one schedule, epoch ms. */
  nextRunAt(schedule: Schedule): number {
    return nextDailyRun(schedule.time, schedule.timeZone, this.#now());
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Run every schedule whose daily occurrence is due and not yet fired today.
   * Called by the timer; exposed for deterministic tests.
   */
  async fireDue(at = this.#now()): Promise<number> {
    if (this.#stopped || this.#firing) return 0;
    this.#firing = true;
    const fired: Schedule[] = [];
    try {
      for (const schedule of [...this.#byId.values()]) {
        const day = localDateString(at, schedule.timeZone);
        if (this.#lastRun.get(schedule.id) === day) continue;
        if (dayTimeEpoch(day, schedule.time, schedule.timeZone) > at) continue;
        this.#lastRun.set(schedule.id, day);
        fired.push(schedule);
      }
      for (const schedule of fired) {
        this.#log.append({ type: FIRED, data: { id: schedule.id, day: localDateString(at, schedule.timeZone), firedAt: at } });
      }
      if (fired.length > 0) this.#logger(`schedules: fired ${fired.length}`);
      for (const schedule of fired) await this.#execute(schedule);
    } finally {
      this.#firing = false;
      this.#arm();
    }
    return fired.length;
  }

  async #execute(schedule: Schedule): Promise<void> {
    let text: string;
    try {
      const result = await this.#run(schedule.prompt, schedule.conversationKey);
      text = result.answer?.trim()
        || (result.error ? `⚠️ No pude completar la rutina: ${result.error}` : '⚠️ La rutina terminó sin respuesta.');
    } catch (error) {
      text = `⚠️ No pude completar la rutina: ${error instanceof Error ? error.message : 'error desconocido'}`;
    }
    if (schedule.deliver !== 'doty') {
      if (!this.#deliverDiscord) {
        this.#logger('schedules: discord delivery skipped (Discord is not configured)');
        return;
      }
      try {
        await this.#deliverDiscord(text);
      } catch (error) {
        this.#logger(`schedules: discord delivery failed (${error instanceof Error ? error.name : 'unknown'})`);
      }
    }
  }

  /** Epoch of the soonest upcoming occurrence (now or later), if any. */
  #nextDueAt(): number | undefined {
    const now = this.#now();
    let best: number | undefined;
    for (const schedule of this.#byId.values()) {
      const today = localDateString(now, schedule.timeZone);
      let runAt = dayTimeEpoch(today, schedule.time, schedule.timeZone);
      if (runAt <= now && this.#lastRun.get(schedule.id) === today) {
        runAt = dayTimeEpoch(shiftDateString(today, 1), schedule.time, schedule.timeZone);
      }
      if (best === undefined || runAt < best) best = runAt;
    }
    return best;
  }

  #arm(): void {
    if (this.#stopped) return;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const next = this.#nextDueAt();
    if (next === undefined) return;
    const delay = Math.max(0, Math.min(next - this.#now(), MAX_TIMEOUT_MS));
    this.#timer = setTimeout(() => void this.fireDue(), delay);
    this.#timer.unref?.();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readSchedule(data: Record<string, unknown>): Schedule | null {
  const { id, prompt, time, timeZone, deliver, conversationKey, createdAt } = data;
  if (typeof id !== 'string' || typeof prompt !== 'string' || typeof time !== 'string') return null;
  if (typeof timeZone !== 'string' || typeof conversationKey !== 'string') return null;
  return {
    id,
    prompt,
    time,
    timeZone,
    deliver: deliver === 'doty' ? 'doty' : 'both',
    conversationKey,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
  };
}
