import { describe, expect, it } from 'vitest';
import { PgEventLog, type PgEventQuery } from './pg-log.js';

interface StoredRow {
  seq: number;
  type: string;
  ts: Date;
  data: unknown;
}

class FakePg implements PgEventQuery {
  readonly rows: StoredRow[] = [];

  async query(sql: string, values: unknown[] = []): Promise<{ rows: StoredRow[] }> {
    if (sql.startsWith('INSERT INTO')) {
      const [seq, type, ts, data] = values as [number, string, Date, unknown];
      this.rows.push({ seq, type, ts, data });
      return { rows: [] };
    }
    if (sql.includes('WHERE seq >')) {
      const after = Number(values[0]);
      return { rows: this.rows.filter((row) => row.seq > after).sort((a, b) => a.seq - b.seq) };
    }
    return { rows: [...this.rows].sort((a, b) => a.seq - b.seq) };
  }
}

describe('PgEventLog', () => {
  it('hydrates replay history and persists/fans out new events', async () => {
    const pg = new FakePg();
    pg.rows.push(
      { seq: 1, type: 'first', ts: new Date(100), data: { n: 1 } },
      { seq: 2, type: 'second', ts: new Date(200), data: { n: 2 } },
    );
    const log = new PgEventLog(pg);
    await log.ready;
    expect(log.cursor).toBe(2);
    expect(log.since(1).map((event) => event.seq)).toEqual([2]);

    const live: number[] = [];
    log.subscribe((event) => live.push(event.seq));
    const event = log.append({ type: 'third', data: { n: 3 }, ts: 300 });
    expect(event.seq).toBe(3);
    expect(live).toEqual([3]);
    await log.flush();
    expect(pg.rows.at(-1)).toMatchObject({ seq: 3, type: 'third', data: { n: 3 } });
    await log.close();
  });

  it('fans out rows written by another process during polling', async () => {
    const pg = new FakePg();
    pg.rows.push({ seq: 1, type: 'first', ts: new Date(100), data: null });
    const log = new PgEventLog(pg);
    await log.ready;
    const received: number[] = [];
    log.subscribe((event) => received.push(event.seq));

    pg.rows.push({ seq: 2, type: 'external', ts: new Date(200), data: { from: 'other' } });
    await log.pollNow();

    expect(received).toEqual([2]);
    expect(log.since(1).map((event) => event.type)).toEqual(['external']);
    await log.close();
  });
});
