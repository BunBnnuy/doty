import { describe, expect, it } from 'vitest';
import { InMemoryEventLog } from '../events/log.js';
import { SessionStore } from './sessions.js';

describe('session store', () => {
  it('maps a conversation key to a session id and persists it', () => {
    const log = new InMemoryEventLog();
    const store = new SessionStore();
    store.set(log, 'discord:dm:u1', 'ses_1');
    expect(store.get('discord:dm:u1')).toBe('ses_1');
    expect(store.get('missing')).toBeUndefined();

    const rebuilt = new SessionStore();
    rebuilt.hydrate(log);
    expect(rebuilt.get('discord:dm:u1')).toBe('ses_1');
  });
});
