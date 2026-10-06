import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { InMemoryEventLog } from '../events/log.js';
import { registerScheduleRoutes } from '../routes/schedules.js';
import { dayRange, localDateString, nextDailyRun, parseDateBound, parseTimeOfDay } from '../time.js';
import { ScheduleService } from './schedules.js';

describe('time helpers', () => {
  const tz = 'America/Mexico_City';
  // 2026-10-06T15:00:00Z == 09:00 in Mexico City (UTC-6, no DST).
  const instant = Date.UTC(2026, 9, 6, 15, 0);

  it('formats local dates and day ranges', () => {
    expect(localDateString(instant, tz)).toBe('2026-10-06');
    const range = dayRange('2026-10-05', tz);
    expect(new Date(range.since).toISOString()).toBe('2026-10-05T06:00:00.000Z');
    expect(new Date(range.until).toISOString()).toBe('2026-10-06T06:00:00.000Z');
  });

  it('computes the next daily run', () => {
    expect(new Date(nextDailyRun('06:00', tz, instant)).toISOString()).toBe(
      '2026-10-07T12:00:00.000Z',
    );
    expect(new Date(nextDailyRun('06:00', tz, Date.UTC(2026, 9, 6, 11, 0))).toISOString()).toBe(
      '2026-10-06T12:00:00.000Z',
    );
  });

  it('parses date bounds', () => {
    expect(new Date(parseDateBound('yesterday', tz, instant) ?? 0).toISOString()).toBe(
      '2026-10-05T06:00:00.000Z',
    );
    expect(new Date(parseDateBound('today', tz, instant) ?? 0).toISOString()).toBe(
      '2026-10-06T06:00:00.000Z',
    );
    expect(new Date(parseDateBound('2026-10-05', tz) ?? 0).toISOString()).toBe(
      '2026-10-05T06:00:00.000Z',
    );
    expect(new Date(parseDateBound('2026-10-05T14:30', tz) ?? 0).toISOString()).toBe(
      '2026-10-05T20:30:00.000Z',
    );
    expect(parseDateBound('nope', tz)).toBeUndefined();
  });

  it('validates times of day', () => {
    expect(parseTimeOfDay('6:00')).toBe('06:00');
    expect(parseTimeOfDay('23:59')).toBe('23:59');
    expect(parseTimeOfDay('24:00')).toBeUndefined();
    expect(parseTimeOfDay('6')).toBeUndefined();
  });
});

describe('ScheduleService', () => {
  it('creates, fires once per day and delivers the result', async () => {
    let now = Date.UTC(2026, 9, 6, 11, 0); // 05:00 local; next run 06:00 local (12:00Z)
    const log = new InMemoryEventLog();
    const run = vi.fn(async () => ({ answer: 'Resumen listo' }));
    const deliver = vi.fn(async () => {});
    const service = new ScheduleService({ log, run, deliverDiscord: deliver, now: () => now });
    service.hydrate();

    const schedule = service.create({ prompt: 'Resume los correos de ayer', time: '6:00' });
    expect(schedule.time).toBe('06:00');
    expect(service.list()).toHaveLength(1);
    expect(new Date(service.nextRunAt(schedule)).toISOString()).toBe('2026-10-06T12:00:00.000Z');

    expect(await service.fireDue(Date.UTC(2026, 9, 6, 11, 59))).toBe(0);
    expect(await service.fireDue(Date.UTC(2026, 9, 6, 12, 0))).toBe(1);
    expect(run).toHaveBeenCalledWith('Resume los correos de ayer', 'desktop');
    expect(deliver).toHaveBeenCalledWith('Resumen listo');
    // Same day again: no double fire.
    expect(await service.fireDue(Date.UTC(2026, 9, 6, 13, 0))).toBe(0);
    // Next day fires again.
    expect(await service.fireDue(Date.UTC(2026, 9, 7, 12, 0))).toBe(1);
    service.stop();
  });

  it('hydrates from the event log and cancels by id prefix', () => {
    const log = new InMemoryEventLog();
    const options = { log, run: vi.fn(async () => ({ answer: 'x' })), now: () => 0 };
    const first = new ScheduleService(options);
    const schedule = first.create({ prompt: 'Rutina', time: '06:00', deliver: 'doty' });
    first.stop();

    const second = new ScheduleService(options);
    second.hydrate();
    expect(second.list().map((s) => s.id)).toEqual([schedule.id]);
    expect(second.cancel(schedule.id.slice(0, 8))?.id).toBe(schedule.id);
    second.stop();

    const third = new ScheduleService(options);
    third.hydrate();
    expect(third.list()).toHaveLength(0);
    third.stop();
  });

  it('reports run failures to Discord', async () => {
    let now = Date.UTC(2026, 9, 6, 12, 0);
    const log = new InMemoryEventLog();
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const deliver = vi.fn(async () => {});
    const service = new ScheduleService({ log, run, deliverDiscord: deliver, now: () => now });
    service.create({ prompt: 'X', time: '06:00' });
    now = Date.UTC(2026, 9, 6, 12, 1);
    expect(await service.fireDue()).toBe(1);
    expect(deliver).toHaveBeenCalledWith(expect.stringContaining('boom'));
    service.stop();
  });
});

describe('schedule routes', () => {
  function buildService() {
    return {
      list: vi.fn(() => []),
      create: vi.fn((input: { prompt: string; time: string; timeZone?: string; deliver?: 'both' | 'doty' }) => ({
        id: 's1',
        prompt: input.prompt,
        time: input.time,
        timeZone: input.timeZone ?? 'America/Mexico_City',
        deliver: input.deliver === 'doty' ? ('doty' as const) : ('both' as const),
        conversationKey: 'desktop',
        createdAt: 1,
      })),
      cancel: vi.fn(() => undefined),
      nextRunAt: vi.fn(() => 123),
    };
  }

  it('guards, validates and serves the schedule API', async () => {
    const service = buildService();
    const { app } = buildApp({ token: 'test-token' });
    registerScheduleRoutes(app, service);
    try {
      expect((await app.inject({ method: 'GET', url: '/schedules' })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'DELETE', url: '/schedules/s1' })).statusCode,
      ).toBe(401);

      const list = await app.inject({
        method: 'GET',
        url: '/schedules',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ schedules: [] });

      const created = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: { authorization: 'Bearer test-token' },
        payload: { prompt: 'Resume el correo de ayer', time: '6:00' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().schedule.id).toBe('s1');
      expect(service.create).toHaveBeenCalledWith({ prompt: 'Resume el correo de ayer', time: '6:00' });

      const badTime = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: { authorization: 'Bearer test-token' },
        payload: { prompt: 'X', time: '99:99' },
      });
      expect(badTime.statusCode).toBe(400);
      expect(badTime.json().error).toBe('invalid_time');

      const missingPrompt = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: { authorization: 'Bearer test-token' },
        payload: { time: '06:00' },
      });
      expect(missingPrompt.statusCode).toBe(400);

      const unknown = await app.inject({
        method: 'DELETE',
        url: '/schedules/nope',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
