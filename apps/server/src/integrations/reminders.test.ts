import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventLog } from '../events/log.js';
import {
  DEFAULT_TIME_ZONE,
  ReminderService,
  formatInTz,
  handleReminderMessage,
  parseReminder,
  resolveTimeZone,
  type Reminder,
} from './reminders.js';

const TZ = 'America/Mexico_City';
// 12:00 UTC == 06:00 in Mexico City (UTC-6), so "today 15:00" is still ahead.
const NOW = Date.parse('2026-10-06T12:00:00Z');

const ok = (result: ReturnType<typeof parseReminder>): { dueAt: number; text: string } => {
  if (!result || result.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
};

describe('parseReminder', () => {
  it('ignores messages without a reminder intent', () => {
    expect(parseReminder('hola doty, ¿qué tal?', { now: NOW, timeZone: TZ })).toBeNull();
  });

  it('parses a Spanish date + time and keeps the body', () => {
    const result = ok(parseReminder('recuérdame el 6 de octubre a las 15:00 de llamar a alguien', { now: NOW, timeZone: TZ }));
    expect(result.text).toBe('llamar a alguien');
    const when = formatInTz(result.dueAt, TZ);
    expect(when).toContain('6 de octubre');
    expect(when).toContain('15:00');
  });

  it('parses relative times', () => {
    const result = ok(parseReminder('recuérdame en 5 minutos comprar pan', { now: NOW, timeZone: TZ }));
    expect(result.dueAt).toBe(NOW + 5 * 60_000);
    expect(result.text).toBe('comprar pan');
  });

  it('parses an ISO timestamp', () => {
    const result = ok(parseReminder('remind me 2026-10-06T15:00 comprar pan', { now: NOW, timeZone: TZ }));
    expect(formatInTz(result.dueAt, TZ)).toContain('15:00');
    expect(result.text).toBe('comprar pan');
  });

  it('parses day words, numeric dates and 12h times', () => {
    const tomorrow = ok(parseReminder('recuérdame mañana a las 9:00 desayunar', { now: NOW, timeZone: TZ }));
    expect(formatInTz(tomorrow.dueAt, TZ)).toContain('7 de octubre');
    expect(formatInTz(tomorrow.dueAt, TZ)).toContain('9:00');

    const numeric = ok(parseReminder('recuérdame 7/10 a las 18:30 comprar', { now: NOW, timeZone: TZ }));
    expect(formatInTz(numeric.dueAt, TZ)).toContain('7 de octubre');
    expect(formatInTz(numeric.dueAt, TZ)).toContain('18:30');

    const afternoon = ok(parseReminder('recuérdame hoy a las 3 de la tarde reunión', { now: NOW, timeZone: TZ }));
    expect(formatInTz(afternoon.dueAt, TZ)).toContain('15:00');
    expect(afternoon.text).toBe('reunión');
  });

  it('rolls a passed month/day to next year', () => {
    const result = ok(parseReminder('recuérdame el 6 de octubre a las 15:00 algo', { now: Date.parse('2026-10-07T00:00:00Z'), timeZone: TZ }));
    expect(new Date(result.dueAt).getUTCFullYear()).toBe(2027);
  });

  it('asks for a time when none is given', () => {
    const result = parseReminder('recuérdame llamar a alguien', { now: NOW, timeZone: TZ });
    expect(result?.kind).toBe('error');
  });
});

describe('ReminderService', () => {
  it('fires a due reminder and records it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const log = new InMemoryEventLog();
      const fired: Reminder[] = [];
      const service = new ReminderService({ log, onDue: (r) => { fired.push(r); } });
      service.hydrate();
      service.schedule({ dueAt: NOW + 1_000, channelId: 'c1', userId: 'u1', conversationKey: 'k', text: 'beber agua' });
      expect(service.pending()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(fired).toHaveLength(1);
      expect(fired[0]?.text).toBe('beber agua');
      expect(service.pending()).toBe(0);
      expect(log.since(0).some((e) => e.type === 'reminder_fired')).toBe(true);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rehydrates pending reminders from the event log', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const log = new InMemoryEventLog();
      const first = new ReminderService({ log, onDue: () => {} });
      first.hydrate();
      first.schedule({ dueAt: NOW + 60_000, channelId: 'c', userId: 'u', conversationKey: 'k', text: 'x' });
      first.stop();

      const second = new ReminderService({ log, onDue: () => {} });
      second.hydrate();
      expect(second.pending()).toBe(1);
      expect(second.list()[0]?.text).toBe('x');
      second.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refire an already fired reminder after a restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const log = new InMemoryEventLog();
      const fired1: Reminder[] = [];
      const first = new ReminderService({ log, onDue: (r) => { fired1.push(r); } });
      first.hydrate();
      first.schedule({ dueAt: NOW, channelId: 'c', userId: 'u', conversationKey: 'k', text: 'z' });
      await vi.advanceTimersByTimeAsync(10);
      expect(fired1).toHaveLength(1);
      first.stop();

      const fired2: Reminder[] = [];
      const second = new ReminderService({ log, onDue: (r) => { fired2.push(r); } });
      second.hydrate();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fired2).toHaveLength(0);
      expect(second.pending()).toBe(0);
      second.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels by id prefix', () => {
    const log = new InMemoryEventLog();
    const service = new ReminderService({ log, onDue: () => {} });
    service.hydrate();
    const reminder = service.schedule({ dueAt: Date.now() + 1_000, channelId: 'c', userId: 'u', conversationKey: 'k', text: 'y' });
    expect(service.cancel(reminder.id.slice(0, 8))?.id).toBe(reminder.id);
    expect(service.pending()).toBe(0);
    service.stop();
  });
});

describe('handleReminderMessage', () => {
  const context = { channelId: 'c1', userId: 'u1', conversationKey: 'discord:dm:u1' };

  it('schedules a reminder and confirms', () => {
    const service = new ReminderService({ log: new InMemoryEventLog(), onDue: () => {} });
    service.hydrate();
    const reply = handleReminderMessage(
      'recuérdame el 6 de octubre a las 15:00 de llamar a alguien',
      context,
      service,
      { now: NOW, timeZone: TZ },
    );
    expect(reply).toContain('⏰');
    expect(reply).toContain('llamar a alguien');
    expect(service.pending()).toBe(1);
    service.stop();
  });

  it('returns undefined for a normal message', () => {
    const service = new ReminderService({ log: new InMemoryEventLog(), onDue: () => {} });
    service.hydrate();
    expect(handleReminderMessage('¿me pones música?', context, service, { now: NOW, timeZone: TZ })).toBeUndefined();
    service.stop();
  });

  it('lists and cancels reminders', () => {
    const service = new ReminderService({ log: new InMemoryEventLog(), onDue: () => {} });
    service.hydrate();
    const created = service.schedule({ dueAt: NOW + 60_000, channelId: 'c1', userId: 'u1', conversationKey: 'k', text: 'sacar la basura' });

    const list = handleReminderMessage('mis recordatorios', context, service, { now: NOW, timeZone: TZ });
    expect(list).toContain('sacar la basura');

    const cancelled = handleReminderMessage(`cancela recordatorio ${created.id.slice(0, 8)}`, context, service, { now: NOW, timeZone: TZ });
    expect(cancelled).toContain('Cancelado');
    expect(service.pending()).toBe(0);
    service.stop();
  });
});

describe('resolveTimeZone', () => {
  it('defaults, validates, and falls back to UTC', () => {
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone('')).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone('Europe/Madrid')).toBe('Europe/Madrid');
    expect(resolveTimeZone('Not/AZone')).toBe('UTC');
  });
});
