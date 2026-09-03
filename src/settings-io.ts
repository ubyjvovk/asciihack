/**
 * Node-only I/O for player settings (see `src/ui/settings.ts` for the pure
 * parse/serialize helpers). Split out so `src/ui/*` stays browser-clean:
 * the terminal CLI imports these; the browser build never touches them.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  serializeSettings,
  type Settings,
} from './ui/settings.js';

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
