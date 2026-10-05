import { describe, expect, it } from 'vitest';
import { InMemoryEventLog } from '../events/log.js';
import { ConversationStore } from './conversation.js';

describe('conversation memory', () => {
  it('records turns per key and returns them as history', () => {
    const log = new InMemoryEventLog();
    const store = new ConversationStore();
    store.record(log, 'discord:dm:u1', { role: 'user', content: 'hola' });
    store.record(log, 'discord:dm:u1', { role: 'assistant', content: 'qué tal' });
    store.record(log, 'discord:guild:g1', { role: 'user', content: 'otro' });

    expect(store.history('discord:dm:u1')).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'qué tal' },
    ]);
    expect(store.history('discord:guild:g1')).toEqual([{ role: 'user', content: 'otro' }]);
    expect(store.history('missing')).toEqual([]);
  });

  it('persists turns to the log and hydrates a fresh store', () => {
    const log = new InMemoryEventLog();
    const store = new ConversationStore();
    store.record(log, 'k', { role: 'user', content: 'a' });
    store.record(log, 'k', { role: 'assistant', content: 'b' });

    const rebuilt = new ConversationStore();
    rebuilt.hydrate(log);
    expect(rebuilt.history('k')).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });

  it('bounds the window by turns', () => {
    const log = new InMemoryEventLog();
    const store = new ConversationStore(3);
    for (let index = 0; index < 5; index += 1) {
      store.record(log, 'k', { role: 'user', content: `m${index}` });
    }
    expect(store.history('k').map((turn) => turn.content)).toEqual(['m2', 'm3', 'm4']);
  });

  it('bounds the window by characters', () => {
    const log = new InMemoryEventLog();
    const store = new ConversationStore(20, 10);
    store.record(log, 'k', { role: 'user', content: 'aaaaaaaa' });
    store.record(log, 'k', { role: 'user', content: 'bbbbbbbb' });
    expect(store.history('k').map((turn) => turn.content)).toEqual(['bbbbbbbb']);
  });
});
