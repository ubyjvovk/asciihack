import { describe, expect, it } from 'vitest';
import {
  clampFov,
  DEFAULT_SETTINGS,
  FOV_MAX,
  FOV_MIN,
  parseSettings,
  serializeSettings,
} from '../src/ui/settings.js';

describe('parseSettings', () => {
  it('defaults on missing (blank) input', () => {
    expect(parseSettings('')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('   \n')).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults on garbage (invalid JSON)', () => {
    expect(parseSettings('not json at all')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"fov":')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS); // JSON but not an object
  });

  it('fills defaults for partial input and clamps fov', () => {
    expect(parseSettings('{"fov": 80}')).toEqual({ fov: 80, theme: 'amber', minimap: true });
    expect(parseSettings('{"fov": 500}')).toEqual({ ...DEFAULT_SETTINGS, fov: FOV_MAX });
    expect(parseSettings('{"fov": -20}')).toEqual({ ...DEFAULT_SETTINGS, fov: FOV_MIN });
    expect(parseSettings('{"fov": 65, "theme": "gloom", "minimap": false}')).toEqual({
      fov: 65,
      theme: 'gloom',
      minimap: false,
    });
  });

  it('rejects an unknown theme and a non-boolean minimap', () => {
    const s = parseSettings('{"fov": 70, "theme": "neon", "minimap": "yes"}');
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.minimap).toBe(DEFAULT_SETTINGS.minimap);
    expect(s.fov).toBe(70);
  });
});

describe('clampFov', () => {
  it('clamps to 40–100 and rounds', () => {
    expect(clampFov(60)).toBe(60);
    expect(clampFov(39)).toBe(FOV_MIN);
    expect(clampFov(101)).toBe(FOV_MAX);
    expect(clampFov(62.6)).toBe(63);
  });

  it('falls back to the default on non-finite input', () => {
    expect(clampFov(Number.NaN)).toBe(DEFAULT_SETTINGS.fov);
    expect(clampFov(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SETTINGS.fov);
  });
});

describe('serializeSettings', () => {
  it('round-trips through parseSettings', () => {
    const s = { fov: 65, theme: 'amber' as const, minimap: true };
    expect(parseSettings(serializeSettings(s))).toEqual(s);
  });
});
