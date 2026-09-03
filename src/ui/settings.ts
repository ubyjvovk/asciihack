/**
 * Player settings persisted to `~/.asciihack/settings.json` (docs/ui.md —
 * Settings): the first-person vertical FOV, the render theme and the minimap
 * flag, remembered across runs. The file is loaded once at start (missing or
 * invalid input falls back to defaults, never crashes) and written atomically
 * whenever FOV, theme or minimap changes. `parseSettings`/`serializeSettings`
 * are pure; `loadSettings`/`saveSettings` are the thin I/O wrappers.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Theme } from '../render/themes.js';

/** Lower bound of the vertical FOV in degrees (F6/F7 and `--fov` clamp to it). */
export const FOV_MIN = 40;
/** Upper bound of the vertical FOV in degrees. */
export const FOV_MAX = 100;
/** Default theme (amber — the user preference after comparing with AsciiCity). */
export const DEFAULT_THEME: Theme = 'amber';

/** The persisted player settings. */
export interface Settings {
  /** First-person vertical field of view in degrees (40–100). */
  fov: number;
  /** Render theme for fps/ortho. */
  theme: Theme;
  /** Whether the minimap is shown in fps/ortho. */
  minimap: boolean;
}

/** The built-in defaults used when the settings file is missing or invalid. */
export const DEFAULT_SETTINGS: Settings = { fov: 60, theme: DEFAULT_THEME, minimap: true };

/** Clamp a FOV value to `[FOV_MIN, FOV_MAX]` (non-finite values fall back to the default). */
export function clampFov(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.fov;
  return Math.min(FOV_MAX, Math.max(FOV_MIN, Math.round(value)));
}

function isTheme(value: string): value is Theme {
  return value === 'cyber' || value === 'gloom' || value === 'solarized' || value === 'amber';
}

/**
 * Parse the raw settings-file text into `Settings`. Missing, blank or
 * invalid-JSON input yields the defaults; a partial object fills only its
 * missing fields with defaults, clamps `fov` and validates `theme`/`minimap`.
 */
export function parseSettings(text: string): Settings {
  if (text.trim() === '') return { ...DEFAULT_SETTINGS };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof data !== 'object' || data === null) return { ...DEFAULT_SETTINGS };
  const d = data as Record<string, unknown>;
  return {
    fov: typeof d.fov === 'number' ? clampFov(d.fov) : DEFAULT_SETTINGS.fov,
    theme: typeof d.theme === 'string' && isTheme(d.theme) ? d.theme : DEFAULT_SETTINGS.theme,
    minimap: typeof d.minimap === 'boolean' ? d.minimap : DEFAULT_SETTINGS.minimap,
  };
}

/** Serialize `Settings` to the file format (pretty JSON + trailing newline). */
export function serializeSettings(s: Settings): string {
  return JSON.stringify({ fov: s.fov, theme: s.theme, minimap: s.minimap }, null, 2) + '\n';
}

/** The default settings-file path (`$ASCIIHACK_HOME/settings.json`, else `~/.asciihack/`). */
export function settingsPath(): string {
  return join(process.env.ASCIIHACK_HOME ?? join(homedir(), '.asciihack'), 'settings.json');
}

/** Read and parse the settings file at `path` (missing/unreadable → defaults). */
export function loadSettings(path: string): Settings {
  try {
    return parseSettings(readFileSync(path, 'utf8'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Write `s` to `path` atomically (`.tmp` + rename); never throws on failure. */
export function saveSettings(path: string, s: Settings): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serializeSettings(s));
    renameSync(tmp, path);
  } catch {
    // A failed write must never crash the game or break the key handler.
  }
}
