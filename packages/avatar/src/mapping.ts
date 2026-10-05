/**
 * Pure state → visual mapping for the avatar.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without a DOM. `mountAvatar` in `./index.ts` is the only consumer that
 * turns these values into SVG.
 *
 * The mapping is split into four INDEPENDENT channels:
 *
 *   activity   — body shape, glow, motion, rings (activity + progress)
 *   emotion    — face shape, hue tilt (emotion)
 *   speech     — mouth shape + ripple (speech)
 *   connection — opacity / desaturation (connection)
 *
 * Because each channel is derived only from its own source field, an emotion
 * change cannot disturb speech, and a speech update cannot disturb
 * activity/emotion. `stepVisual` then interpolates channel-by-channel, so the
 * axes stay independent all the way through a transition.
 */

import type { Activity, Connection, DotState, Emotion, Speech } from '@doty/dot-state';

/** All activities, in a stable order (handy for demos + tests). */
export const ACTIVITIES: readonly Activity[] = [
  'idle',
  'listening',
  'thinking',
  'working',
  'speaking',
  'waiting_approval',
  'done',
  'error',
];

/** All emotions, in a stable order. */
export const EMOTIONS: readonly Emotion[] = ['neutral', 'happy', 'curious', 'concerned', 'focused'];

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Exponential smoothing constant. ~0.15s feels responsive but soft. */
export const VISUAL_TAU_SECONDS = 0.15;

/* -------------------------------------------------------------------------- */
/* Activity channel                                                            */
/* -------------------------------------------------------------------------- */

export interface ActivityVisual {
  /** Uniform scale of the body (1 = base radius). */
  scale: number;
  /** Horizontal stretch of the body (>1 = wider). */
  stretchX: number;
  /** Vertical stretch of the body (<1 = squashed). */
  stretchY: number;
  /** Vertical bob amplitude, as a fraction of the avatar size. */
  bob: number;
  /** Seconds per bob cycle (larger = lazier). */
  bobPeriod: number;
  /** Glow strength, 0..1. */
  glow: number;
  /** Body hue in degrees. */
  hue: number;
  /** Body saturation, 0..1. */
  saturation: number;
  /** Body lightness, 0..1. */
  lightness: number;
  /** Aura pulse rate in Hz. */
  pulseHz: number;
  /** Opacity of the breathing aura ring, 0..1. */
  aura: number;
  /** Opacity of the determinate progress ring, 0..1. */
  progressRing: number;
  /** Normalized progress 0..1, or null when not applicable. */
  progress: number | null;
  /** Opacity of the indeterminate spinner, 0..1. */
  spinner: number;
  /** Opacity of the orbiting satellite dots, 0..1. */
  orbit: number;
  /** Horizontal shake amplitude, as a fraction of the avatar size. */
  shake: number;
  /** Baseline eye openness modifier (1 = normal, >1 = wide). */
  eyeOpen: number;
  /** Extra vertical gaze, -1 (down) .. 1 (up). */
  lookY: number;
}

/**
 * Base pose per activity. Values are hand-tuned so every activity reads
 * differently at a glance: colour, size, motion and the visible ring all move.
 */
const ACTIVITY_VISUALS: Record<Activity, ActivityVisual> = {
  idle: {
    scale: 0.92,
    stretchX: 1,
    stretchY: 1,
    bob: 0.014,
    bobPeriod: 4.4,
    glow: 0.35,
    hue: 265,
    saturation: 0.7,
    lightness: 0.6,
    pulseHz: 0.35,
    aura: 0.25,
    progressRing: 0,
    progress: null,
    spinner: 0,
    orbit: 0.15,
    shake: 0,
    eyeOpen: 1,
    lookY: 0,
  },
  listening: {
    scale: 0.98,
    stretchX: 1.05,
    stretchY: 0.97,
    bob: 0.01,
    bobPeriod: 3,
    glow: 0.55,
    hue: 205,
    saturation: 0.78,
    lightness: 0.62,
    pulseHz: 0.9,
    aura: 0.55,
    progressRing: 0,
    progress: null,
    spinner: 0,
    orbit: 0.25,
    shake: 0,
    eyeOpen: 1.15,
    lookY: 0.08,
  },
  thinking: {
    scale: 0.9,
    stretchX: 0.98,
    stretchY: 1.02,
    bob: 0.022,
    bobPeriod: 2.2,
    glow: 0.5,
    hue: 250,
    saturation: 0.62,
    lightness: 0.58,
    pulseHz: 0.7,
    aura: 0.35,
    progressRing: 0,
    progress: null,
    spinner: 0.9,
    orbit: 0.45,
    shake: 0,
    eyeOpen: 0.85,
    lookY: 0.55,
  },
  working: {
    scale: 0.95,
    stretchX: 1.02,
    stretchY: 1.02,
    bob: 0.016,
    bobPeriod: 1.6,
    glow: 0.62,
    hue: 35,
    saturation: 0.92,
    lightness: 0.6,
    pulseHz: 1.2,
    aura: 0.55,
    progressRing: 1,
    progress: null,
    spinner: 0,
    orbit: 0.2,
    shake: 0,
    eyeOpen: 1,
    lookY: 0.12,
  },
  speaking: {
    scale: 1,
    stretchX: 1.05,
    stretchY: 1.05,
    bob: 0.03,
    bobPeriod: 1.1,
    glow: 0.6,
    hue: 285,
    saturation: 0.8,
    lightness: 0.64,
    pulseHz: 1.5,
    aura: 0.5,
    progressRing: 0,
    progress: null,
    spinner: 0,
    orbit: 0.3,
    shake: 0,
    eyeOpen: 1,
    lookY: 0,
  },
  waiting_approval: {
    scale: 0.88,
    stretchX: 1,
    stretchY: 1,
    bob: 0.008,
    bobPeriod: 5,
    glow: 0.45,
    hue: 45,
    saturation: 0.88,
    lightness: 0.62,
    pulseHz: 0.5,
    aura: 0.75,
    progressRing: 0,
    progress: null,
    spinner: 0,
    orbit: 0.85,
    shake: 0,
    eyeOpen: 1.05,
    lookY: -0.1,
  },
  done: {
    scale: 1.02,
    stretchX: 1,
    stretchY: 1,
    bob: 0.02,
    bobPeriod: 3.5,
    glow: 0.72,
    hue: 150,
    saturation: 0.78,
    lightness: 0.6,
    pulseHz: 0.6,
    aura: 0.4,
    progressRing: 0.85,
    progress: 1,
    spinner: 0,
    orbit: 0.4,
    shake: 0,
    eyeOpen: 0.3,
    lookY: 0.05,
  },
  error: {
    scale: 0.94,
    stretchX: 1.02,
    stretchY: 0.96,
    bob: 0,
    bobPeriod: 8,
    glow: 0.5,
    hue: 0,
    saturation: 0.88,
    lightness: 0.55,
    pulseHz: 2,
    aura: 0.3,
    progressRing: 0,
    progress: null,
    spinner: 0,
    orbit: 0.2,
    shake: 0.018,
    eyeOpen: 0.55,
    lookY: -0.15,
  },
};

/**
 * Body pose for an activity. `progress` only applies to `working` (and is
 * ignored elsewhere); it is clamped to 0..1.
 */
export function activityVisual(activity: Activity, progress: number | null = null): ActivityVisual {
  const base = ACTIVITY_VISUALS[activity];
  const resolvedProgress = activity === 'working' ? (progress === null ? null : clamp01(progress)) : base.progress;
  return { ...base, progress: resolvedProgress };
}

/* -------------------------------------------------------------------------- */
/* Emotion channel                                                             */
/* -------------------------------------------------------------------------- */

export interface EmotionVisual {
  /** Hue rotation applied to the body, degrees. */
  hueShift: number;
  /** Saturation multiplier, 0..2. */
  saturationMul: number;
  /** Mouth curve, -1 (frown) .. 1 (smile). */
  smile: number;
  /** Brow attitude, -1 (angry) .. 1 (raised). */
  brow: number;
  /** Additional eye openness, added to the activity baseline. */
  eyeOpen: number;
  /** Additional vertical gaze, -1 (down) .. 1 (up). */
  lookY: number;
  /** Cheek blush, 0..1. */
  blush: number;
}

const EMOTION_VISUALS: Record<Emotion, EmotionVisual> = {
  neutral: { hueShift: 0, saturationMul: 1, smile: 0.05, brow: 0, eyeOpen: 0, lookY: 0, blush: 0 },
  happy: { hueShift: 10, saturationMul: 1.15, smile: 0.85, brow: 0.3, eyeOpen: -0.1, lookY: 0.1, blush: 0.6 },
  curious: { hueShift: -15, saturationMul: 1.05, smile: 0.15, brow: 0.65, eyeOpen: 0.18, lookY: 0.25, blush: 0.12 },
  concerned: { hueShift: -25, saturationMul: 0.85, smile: -0.45, brow: -0.7, eyeOpen: 0.22, lookY: -0.2, blush: 0 },
  focused: { hueShift: 5, saturationMul: 1.08, smile: -0.1, brow: -0.3, eyeOpen: -0.12, lookY: -0.05, blush: 0 },
};

export function emotionVisual(emotion: Emotion): EmotionVisual {
  return { ...EMOTION_VISUALS[emotion] };
}

/* -------------------------------------------------------------------------- */
/* Speech channel                                                              */
/* -------------------------------------------------------------------------- */

export interface SpeechVisual {
  /** Mouth openness, 0..1. */
  mouthOpen: number;
  /** Mouth width, 0 (narrow) .. 1 (wide). */
  mouthWide: number;
  /** Ripple / resonance strength, 0..1. */
  ripple: number;
  /** Viseme carried through for reference (null when silent). */
  viseme: string | null;
}

interface VisemeShape {
  open: number;
  wide: number;
}

const DEFAULT_VISEME: VisemeShape = { open: 0.4, wide: 0.6 };

/** Preston-Blair-ish viseme table, keyed by normalized id. */
const VISEME_SHAPES: Record<string, VisemeShape> = {
  aa: { open: 0.9, wide: 0.7 },
  a: { open: 0.8, wide: 0.7 },
  e: { open: 0.4, wide: 1 },
  i: { open: 0.3, wide: 0.95 },
  o: { open: 0.75, wide: 0.35 },
  u: { open: 0.45, wide: 0.3 },
  m: { open: 0, wide: 0.65 },
  b: { open: 0, wide: 0.65 },
  p: { open: 0, wide: 0.65 },
  f: { open: 0.15, wide: 0.75 },
  v: { open: 0.15, wide: 0.75 },
  l: { open: 0.3, wide: 0.6 },
  t: { open: 0.25, wide: 0.6 },
  th: { open: 0.25, wide: 0.6 },
  w: { open: 0.45, wide: 0.35 },
  q: { open: 0.45, wide: 0.35 },
  rest: { open: 0, wide: 0.5 },
  x: { open: 0, wide: 0.5 },
  silence: { open: 0, wide: 0.5 },
};

/** Map a viseme id (any case / punctuation) to a mouth shape. Pure. */
export function visemeShape(viseme: string): VisemeShape {
  const normalized = viseme.toLowerCase().replace(/[^a-z]/g, '');
  if (!normalized) return DEFAULT_VISEME;
  const two = VISEME_SHAPES[normalized.slice(0, 2)];
  if (two) return two;
  const one = normalized[0] ? VISEME_SHAPES[normalized[0]] : undefined;
  return one ?? DEFAULT_VISEME;
}

export function speechVisual(speech?: Speech | null): SpeechVisual {
  if (!speech) return { mouthOpen: 0, mouthWide: 0.5, ripple: 0, viseme: null };
  const shape = visemeShape(speech.viseme);
  const energy = clamp01(speech.energy);
  return {
    mouthOpen: clamp01(shape.open * (0.35 + 0.65 * energy)),
    mouthWide: clamp01(shape.wide),
    ripple: energy,
    viseme: speech.viseme,
  };
}

/* -------------------------------------------------------------------------- */
/* Connection channel                                                          */
/* -------------------------------------------------------------------------- */

export interface ConnectionVisual {
  /** Overall opacity, 0..1. */
  opacity: number;
  /** Desaturation, 0..1 (1 = fully grey). */
  desaturate: number;
  /** Flicker / glitch strength, 0..1. */
  glitch: number;
}

const CONNECTION_VISUALS: Record<Connection, ConnectionVisual> = {
  online: { opacity: 1, desaturate: 0, glitch: 0 },
  reconnecting: { opacity: 0.85, desaturate: 0.4, glitch: 0.5 },
  offline: { opacity: 0.55, desaturate: 0.9, glitch: 0.12 },
};

export function connectionVisual(connection: Connection = 'online'): ConnectionVisual {
  return { ...CONNECTION_VISUALS[connection] };
}

/* -------------------------------------------------------------------------- */
/* Composition + interpolation                                                 */
/* -------------------------------------------------------------------------- */

export interface AvatarVisual {
  activity: ActivityVisual;
  emotion: EmotionVisual;
  speech: SpeechVisual;
  connection: ConnectionVisual;
}

/**
 * Compose the four independent channels from a `DotState`. This is the single
 * source of truth for "what should the avatar look like right now".
 */
export function deriveVisual(state: DotState): AvatarVisual {
  return {
    activity: activityVisual(state.activity, state.progress ?? null),
    emotion: emotionVisual(state.emotion),
    speech: speechVisual(state.speech),
    connection: connectionVisual(state.connection ?? 'online'),
  };
}

/**
 * Blend flat records of numbers. Non-numeric fields (nulls, strings) snap to
 * the target, while every numeric field eases across. Channels are flat by
 * design, so this covers all of them.
 */
function blendChannel<T extends object>(a: T, b: T, t: number): T {
  const out: Record<string, unknown> = {};
  const from = a as Record<string, unknown>;
  const to = b as Record<string, unknown>;
  for (const key of Object.keys(to)) {
    const av = from[key];
    const bv = to[key];
    out[key] = typeof av === 'number' && typeof bv === 'number' ? lerp(av, bv, t) : bv;
  }
  return out as T;
}

/** Blend two complete visuals channel-by-channel. */
export function blendVisual(a: AvatarVisual, b: AvatarVisual, t: number): AvatarVisual {
  const k = clamp01(t);
  return {
    activity: blendChannel(a.activity, b.activity, k),
    emotion: blendChannel(a.emotion, b.emotion, k),
    speech: blendChannel(a.speech, b.speech, k),
    connection: blendChannel(a.connection, b.connection, k),
  };
}

/**
 * Advance `current` toward `target`.
 *
 * Frame-rate independent exponential smoothing. Because each channel is blended
 * separately, retargeting one axis leaves the others exactly where they were —
 * the invariant that keeps speech from restarting when emotion changes.
 *
 * When `reducedMotion` is set (or `dtSeconds <= 0`), the target is returned
 * directly, i.e. a static pose.
 */
export function stepVisual(
  current: AvatarVisual,
  target: AvatarVisual,
  dtSeconds: number,
  reducedMotion = false,
): AvatarVisual {
  if (reducedMotion || !(dtSeconds > 0)) return target;
  const t = 1 - Math.exp(-dtSeconds / VISUAL_TAU_SECONDS);
  return blendVisual(current, target, t);
}
