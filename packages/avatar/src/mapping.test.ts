import { describe, expect, it } from 'vitest';
import type { DotState } from '@doty/dot-state';
import {
  ACTIVITIES,
  EMOTIONS,
  activityVisual,
  blendVisual,
  clamp01,
  connectionVisual,
  deriveVisual,
  emotionVisual,
  lerp,
  speechVisual,
  stepVisual,
  visemeShape,
} from './mapping.js';

const speaking = (emotion: DotState['emotion']): DotState => ({
  activity: 'speaking',
  emotion,
  speech: { viseme: 'AA', energy: 1 },
});

describe('channel derivations', () => {
  it('produces a distinct pose for every activity', () => {
    const poses = ACTIVITIES.map((activity) => JSON.stringify(activityVisual(activity)));
    expect(new Set(poses).size).toBe(ACTIVITIES.length);
  });

  it('produces a distinct face for every emotion', () => {
    const faces = EMOTIONS.map((emotion) => JSON.stringify(emotionVisual(emotion)));
    expect(new Set(faces).size).toBe(EMOTIONS.length);
  });

  it('uses progress only while working, clamped to 0..1', () => {
    expect(activityVisual('working', 0.42).progress).toBeCloseTo(0.42, 10);
    expect(activityVisual('working', 2).progress).toBe(1);
    expect(activityVisual('working', -1).progress).toBe(0);
    expect(activityVisual('working', null).progress).toBeNull();
    // Non-working activities ignore progress entirely.
    expect(activityVisual('idle', 0.5).progress).toBeNull();
    expect(activityVisual('done', 0).progress).toBe(1);
  });

  it('maps connection states to a monotonic degrade', () => {
    const online = connectionVisual('online');
    const reconnecting = connectionVisual('reconnecting');
    const offline = connectionVisual('offline');
    expect(online.opacity).toBeGreaterThan(reconnecting.opacity);
    expect(reconnecting.opacity).toBeGreaterThan(offline.opacity);
    expect(online.desaturate).toBeLessThan(offline.desaturate);
    // Defaults to online.
    expect(connectionVisual()).toEqual(online);
  });
});

describe('viseme mapping', () => {
  it('closes the mouth on bilabials and opens it widest on open vowels', () => {
    expect(visemeShape('MBP').open).toBe(0);
    expect(visemeShape('AA').open).toBeGreaterThan(visemeShape('MBP').open);
    expect(visemeShape('O').wide).toBeLessThan(visemeShape('E').wide);
  });

  it('is case/punctuation tolerant and falls back for unknown visemes', () => {
    expect(visemeShape(' aa! ')).toEqual(visemeShape('AA'));
    const fallback = visemeShape('zzz');
    expect(fallback.open).toBeGreaterThan(0);
    expect(fallback.open).toBeLessThan(1);
  });

  it('scales mouth openness with energy', () => {
    const quiet = speechVisual({ viseme: 'AA', energy: 0 });
    const loud = speechVisual({ viseme: 'AA', energy: 1 });
    expect(loud.mouthOpen).toBeGreaterThan(quiet.mouthOpen);
    expect(loud.ripple).toBe(1);
  });

  it('rests the mouth when there is no speech', () => {
    expect(speechVisual(null)).toEqual({ mouthOpen: 0, mouthWide: 0.5, ripple: 0, viseme: null });
    expect(speechVisual(undefined)).toEqual(speechVisual(null));
  });
});

describe('axis independence (targets)', () => {
  it('an emotion change leaves activity and speech untouched', () => {
    const neutral = deriveVisual(speaking('neutral'));
    const happy = deriveVisual(speaking('happy'));
    expect(happy.activity).toEqual(neutral.activity);
    expect(happy.speech).toEqual(neutral.speech);
    expect(happy.emotion).not.toEqual(neutral.emotion);
  });

  it('a speech change leaves activity and emotion untouched', () => {
    const before = deriveVisual({ activity: 'working', emotion: 'focused', progress: 0.4, speech: { viseme: 'AA', energy: 0.5 } });
    const after = deriveVisual({ activity: 'working', emotion: 'focused', progress: 0.4, speech: { viseme: 'MBP', energy: 0.1 } });
    expect(after.activity).toEqual(before.activity);
    expect(after.emotion).toEqual(before.emotion);
    expect(after.speech).not.toEqual(before.speech);
  });

  it('an activity change leaves emotion untouched', () => {
    const a = deriveVisual({ activity: 'listening', emotion: 'concerned' });
    const b = deriveVisual({ activity: 'error', emotion: 'concerned' });
    expect(b.emotion).toEqual(a.emotion);
    expect(b.activity).not.toEqual(a.activity);
  });
});

describe('interpolation', () => {
  it('eases numeric fields toward the target and leaves unchanged channels exact', () => {
    const a = deriveVisual(speaking('neutral'));
    const b = deriveVisual(speaking('happy'));
    const current = blendVisual(a, { ...a, speech: { ...a.speech, mouthOpen: 1 } }, 1);
    expect(current.speech.mouthOpen).toBe(1);

    const afterEmotion = stepVisual(current, b, 0.1, false);
    const afterControl = stepVisual(current, a, 0.1, false);

    // Changing only emotion must not disturb the speech channel at all.
    expect(afterEmotion.speech).toEqual(afterControl.speech);
    expect(afterEmotion.activity).toEqual(afterControl.activity);
    expect(afterEmotion.speech.mouthOpen).toBeGreaterThan(b.speech.mouthOpen);
    expect(afterEmotion.speech.mouthOpen).toBeLessThanOrEqual(current.speech.mouthOpen);
    // ...but the face did move.
    expect(afterEmotion.emotion.smile).toBeGreaterThan(current.emotion.smile);
  });

  it('a speech update does not disturb activity or emotion', () => {
    const base = deriveVisual({ activity: 'working', emotion: 'focused', progress: 0.4, speech: { viseme: 'AA', energy: 0.5 } });
    const speechTarget = deriveVisual({ activity: 'working', emotion: 'focused', progress: 0.4, speech: { viseme: 'MBP', energy: 0.2 } });
    const current = blendVisual(base, base, 0.5);
    const after = stepVisual(current, speechTarget, 0.1, false);
    expect(after.activity).toEqual(current.activity);
    expect(after.emotion).toEqual(current.emotion);
    expect(after.speech.mouthOpen).toBeLessThan(current.speech.mouthOpen);
  });

  it('converges on the target after enough frames', () => {
    const current = deriveVisual({ activity: 'idle', emotion: 'neutral' });
    const target = deriveVisual({ activity: 'error', emotion: 'happy' });
    let visual = current;
    for (let i = 0; i < 240; i += 1) visual = stepVisual(visual, target, 1 / 60, false);
    expect(visual.activity.scale).toBeCloseTo(target.activity.scale, 3);
    expect(visual.emotion.smile).toBeCloseTo(target.emotion.smile, 3);
  });

  it('snaps to the target under prefers-reduced-motion', () => {
    const current = deriveVisual({ activity: 'idle', emotion: 'neutral' });
    const target = deriveVisual({ activity: 'error', emotion: 'happy' });
    expect(stepVisual(current, target, 1, true)).toEqual(target);
  });

  it('snaps when no time has elapsed', () => {
    const current = deriveVisual({ activity: 'idle', emotion: 'neutral' });
    const target = deriveVisual({ activity: 'done', emotion: 'happy' });
    expect(stepVisual(current, target, 0, false)).toEqual(target);
  });
});

describe('helpers', () => {
  it('clamps and lerps', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });
});
