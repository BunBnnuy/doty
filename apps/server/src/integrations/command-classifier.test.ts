import { describe, expect, it } from 'vitest';
import { classifyVoiceIntent, parseIntentReply } from './command-classifier.js';

describe('command classifier', () => {
  it('parses a valid intent JSON, ignoring prose and code fences', () => {
    expect(parseIntentReply('```json\n{"command":"play","arg":"bachata"}\n```')).toEqual({ cmd: 'play', arg: 'bachata' });
    expect(parseIntentReply('Sure: {"command":"stop"}')).toEqual({ cmd: 'stop' });
    expect(parseIntentReply('{"command":"none"}')).toBeNull();
    expect(parseIntentReply('{"command":"bogus"}')).toBeNull();
    expect(parseIntentReply('not json')).toBeNull();
  });

  it('asks the model and returns the command', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"command":"stop"}' } }] }), { status: 200 });
    expect(await classifyVoiceIntent('salite de voice', { baseUrl: 'http://x', model: 'm' }, fake))
      .toEqual({ cmd: 'stop' });
  });

  it('returns null on a failed request', async () => {
    const fake: typeof fetch = async () => new Response('nope', { status: 400 });
    expect(await classifyVoiceIntent('hola', { baseUrl: 'http://x', model: 'm' }, fake)).toBeNull();
  });
});
