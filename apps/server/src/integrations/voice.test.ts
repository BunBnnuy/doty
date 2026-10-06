import { describe, expect, it } from 'vitest';
import { extractCommandArg, parseVoiceCommand, SpeechMixer } from './voice.js';

describe('voice command parsing', () => {
  it('parses commands and strips leading trigger words', () => {
    expect(parseVoiceCommand('play https://youtu.be/x')).toEqual({ cmd: 'play', arg: 'https://youtu.be/x' });
    expect(parseVoiceCommand('doty play lofi beats')).toEqual({ cmd: 'play', arg: 'lofi beats' });
    expect(parseVoiceCommand('bot skip')).toEqual({ cmd: 'skip' });
    expect(parseVoiceCommand('DOTY STOP')).toEqual({ cmd: 'stop' });
    expect(parseVoiceCommand('doty bot pausa')).toEqual({ cmd: 'pause' });
    expect(parseVoiceCommand('queue')).toEqual({ cmd: 'queue' });
    expect(parseVoiceCommand('doty join')).toEqual({ cmd: 'join' });
    expect(parseVoiceCommand('doty di hola mundo')).toEqual({ cmd: 'say', arg: 'hola mundo' });
    expect(parseVoiceCommand('@doty reproduce algo', ['@doty'])).toEqual({ cmd: 'play', arg: 'algo' });
  });

  it('returns null for non-commands', () => {
    expect(parseVoiceCommand('hola doty')).toBeNull();
    expect(parseVoiceCommand('')).toBeNull();
    expect(parseVoiceCommand('playlist')).toBeNull();
  });

  it('extracts the play/say argument when only the command type is known', () => {
    expect(extractCommandArg('Doty quiero escuchar bachata')).toBe('bachata');
    expect(extractCommandArg('doty pon lofi beats')).toBe('lofi beats');
    expect(extractCommandArg('doty decime algo lindo')).toBe('algo lindo');
  });
});

describe('SpeechMixer', () => {
  const frame = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt16LE(value, 0);
    buffer.writeInt16LE(value, 2);
    return buffer;
  };

  it('passes music through unchanged when not speaking', () => {
    const mixer = new SpeechMixer(0.5);
    const chunks: Buffer[] = [];
    mixer.on('data', (chunk: Buffer) => chunks.push(chunk));
    mixer.write(frame(1000));
    const out = Buffer.concat(chunks);
    expect(out.readInt16LE(0)).toBe(1000);
  });

  it('sums speech over ducked music while speaking', () => {
    const mixer = new SpeechMixer(0.5);
    const chunks: Buffer[] = [];
    mixer.on('data', (chunk: Buffer) => chunks.push(chunk));
    mixer.feed(frame(500));
    mixer.write(frame(1000));
    const out = Buffer.concat(chunks);
    // 1000 * 0.5 (ducked) + 500 (speech) = 1000
    expect(out.readInt16LE(0)).toBe(1000);
    expect(mixer.speaking).toBe(false);
  });
});
