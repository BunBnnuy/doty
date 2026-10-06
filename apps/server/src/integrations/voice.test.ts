import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from './voice.js';

describe('voice command parsing', () => {
  it('parses commands and strips leading trigger words', () => {
    expect(parseVoiceCommand('play https://youtu.be/x')).toEqual({ cmd: 'play', arg: 'https://youtu.be/x' });
    expect(parseVoiceCommand('doty play lofi beats')).toEqual({ cmd: 'play', arg: 'lofi beats' });
    expect(parseVoiceCommand('bot skip')).toEqual({ cmd: 'skip' });
    expect(parseVoiceCommand('DOTY STOP')).toEqual({ cmd: 'stop' });
    expect(parseVoiceCommand('doty bot pausa')).toEqual({ cmd: 'pause' });
    expect(parseVoiceCommand('queue')).toEqual({ cmd: 'queue' });
    expect(parseVoiceCommand('@doty reproduce algo', ['@doty'])).toEqual({ cmd: 'play', arg: 'algo' });
  });

  it('returns null for non-commands', () => {
    expect(parseVoiceCommand('hola doty')).toBeNull();
    expect(parseVoiceCommand('')).toBeNull();
    expect(parseVoiceCommand('playlist')).toBeNull();
  });
});
