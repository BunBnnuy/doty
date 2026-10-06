import { describe, expect, it } from 'vitest';
import { classifyVoiceIntent, classifyVoiceIntentJev, parseIntentReply, parseJevAnswer } from './command-classifier.js';

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

describe('jev classifier', () => {
  it('reads a typed choice answer', () => {
    expect(parseJevAnswer({ answers: { command: { type: 'choice', choice: 'stop', confidence: 1 } } }))
      .toEqual({ cmd: 'stop' });
    expect(parseJevAnswer({ answers: { command: { choice: 'none' } } })).toBeNull();
    expect(parseJevAnswer({ answers: { command: { choice: 'bogus' } } })).toBeNull();
    expect(parseJevAnswer(null)).toBeNull();
  });

  it('posts a state + choice question and reads the command', async () => {
    let body: Record<string, unknown> | undefined;
    const fake: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ answers: { command: { choice: 'play' } } }), { status: 200 });
    };
    expect(await classifyVoiceIntentJev('pon bachata', { baseUrl: 'http://x', apiKey: 'k' }, fake))
      .toEqual({ cmd: 'play' });
    expect(body?.state).toBe('pon bachata');
    expect((body?.questions as { command: { type: string } }).command.type).toBe('choice');
  });
});
