import { describe, expect, it, vi } from 'vitest';
import { decideDiscordRoute, DIRECT_AI_INSTRUCTION, IMAGE_ROUTE_INSTRUCTION } from './discord-routing.js';
import { parseDiscordIntentJev } from './command-classifier.js';

const jev = { baseUrl: 'https://jev.example', apiKey: 'fixture' };
const options = { triggerWords: ['doty'], webAvailable: true, jev };

describe('one Discord routing decision', () => {
  it.each(['ai', 'web', 'image', 'join'] as const)('uses a single typed JEV choice for %s', async choice => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ answers: { command: { choice } } })));
    const route = await decideDiscordRoute('a natural-language request', options, fetchImpl);
    expect(route).toEqual(choice === 'join' ? { kind: 'command', command: { cmd: 'join' } } : { kind: choice });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body.questions)).toEqual(['command']);
    expect(body.questions.command.criteria).toMatchObject({ ai: expect.stringContaining('DEFAULT'), web: expect.stringContaining('EXISTING'), image: expect.stringContaining('CREATE'), play: expect.any(String) });
  });
  it('keeps explicit music commands ahead of JEV, with their arguments', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await decideDiscordRoute('doty play bachata', options, fetchImpl)).toEqual({ kind: 'command', command: { cmd: 'play', arg: 'bachata' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not override a valid AI choice with the old command fallback', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"answers":{"command":{"choice":"ai"}}}'));
    expect(await decideDiscordRoute('como funciona esto?', { ...options, classifier: { baseUrl: 'https://fallback.example', model: 'fixture' } }, fetchImpl)).toEqual({ kind: 'ai' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('defaults to direct AI on failure and preserves the owner-only browser boundary', async () => {
    expect(await decideDiscordRoute('hola', options, async () => { throw new Error('offline'); })).toEqual({ kind: 'ai' });
    expect(await decideDiscordRoute('search a site', { ...options, webAvailable: false }, async () => new Response('{"answers":{"command":{"choice":"web"}}}'))).toEqual({ kind: 'ai' });
    for (const body of [null, { answers: { command: { choice: 'bash' } } }, { answers: { command: 'image' } }]) expect(parseDiscordIntentJev(body)).toBeNull();
    expect(DIRECT_AI_INSTRUCTION).toContain('Earlier browser or image routing instructions do not apply');
    expect(IMAGE_ROUTE_INSTRUCTION).toContain('do not browse');
  });
});
