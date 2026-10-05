/**
 * Desktop settings, persisted to localStorage.
 *
 * Deliberately small: server URL plus the avatar/orbit sizes. New settings go
 * here so the settings view can grow without touching the rest of the app.
 */

export interface DotySettings {
  serverUrl: string;
  /** Square orbit area for the harness satellites, in CSS pixels (the radius). */
  orbitSize: number;
  /** Diameter of each satellite dot, in CSS pixels. */
  orbitalSize: number;
  /** Diameter of the character, in CSS pixels. */
  dotySize: number;
}

export const ORBIT_RANGE = { min: 110, max: 320 } as const;
export const ORBITAL_RANGE = { min: 8, max: 44 } as const;
export const DOTY_RANGE = { min: 48, max: 160 } as const;

const KEY = 'doty.settings';

export const DEFAULT_SETTINGS: DotySettings = {
  serverUrl: 'http://localhost:8787',
  orbitSize: 150,
  orbitalSize: 17,
  dotySize: 76,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function normalizeSettings(input: Partial<DotySettings>): DotySettings {
  return {
    serverUrl:
      typeof input.serverUrl === 'string' && input.serverUrl.trim()
        ? input.serverUrl.trim()
        : DEFAULT_SETTINGS.serverUrl,
    orbitSize: clampNumber(input.orbitSize, ORBIT_RANGE.min, ORBIT_RANGE.max, DEFAULT_SETTINGS.orbitSize),
    orbitalSize: clampNumber(input.orbitalSize, ORBITAL_RANGE.min, ORBITAL_RANGE.max, DEFAULT_SETTINGS.orbitalSize),
    dotySize: clampNumber(input.dotySize, DOTY_RANGE.min, DOTY_RANGE.max, DEFAULT_SETTINGS.dotySize),
  };
}

export function loadSettings(): DotySettings {
  const base: DotySettings = {
    ...DEFAULT_SETTINGS,
    serverUrl: envServerUrl() ?? DEFAULT_SETTINGS.serverUrl,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    return normalizeSettings({ ...base, ...(JSON.parse(raw) as Partial<DotySettings>) });
  } catch {
    return base;
  }
}

/** Build-time default (e.g. the remote brain) so a fresh install points there. */
function envServerUrl(): string | null {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const value = env?.VITE_DOTY_SERVER;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function saveSettings(settings: DotySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeSettings(settings)));
  } catch {
    // Persistence is best-effort.
  }
}
