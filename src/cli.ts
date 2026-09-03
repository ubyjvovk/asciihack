/**
 * AsciiHack CLI entry point (docs/architecture.md §8). Parses flags, prepares
 * the per-player playground, spawns the bridge, and runs the terminal app until
 * NetHack exits. `npm start -- --mode=classic --name=tester` is the primary
 * invocation.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnBridge } from './engine/bridge.js';
import { NethackSession, runSession } from './engine/session.js';
import { TtyTerm } from './term/tty.js';
import { App } from './ui/app.js';
import { loadSettings, saveSettings, settingsPath } from './settings-io.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Default location of the built bridge binary. */
const DEFAULT_BRIDGE = join(HERE, '..', 'build', 'nethack', 'bridge', 'nh-bridge');
/** Default source playground (cloned from the build) before the first copy. */
const DEFAULT_PLAYGROUND = join(HERE, '..', 'build', 'nethack', 'bridge', 'playground');
/** Default per-user playground so saves persist and the build dir stays clean. */
const USER_PLAYGROUND = join(process.env.ASCIIHACK_HOME ?? join(homedir(), '.asciihack'), 'playground');

/** Parsed CLI flags. */
export interface CliFlags {
  mode: string;
  name: string;
  bridge: string;
  playground: string;
  options: string[];
  /** Render theme, or null to fall back to the saved setting (default `amber`). */
  theme: string | null;
  /** Whether to show the minimap, or null to fall back to the saved setting. */
  minimap: boolean | null;
  /** Vertical FOV in degrees, or null to fall back to the saved setting. */
  fov: number | null;
}

/** Write the usage text to the given stream. */
function printUsage(out: NodeJS.WritableStream): void {
  out.write(
    [
      'usage: asciihack [--mode=classic|fps|ortho] [--name=NAME]',
      '                 [--bridge=PATH] [--playground=DIR] [--options=K,V,...]',
      '                 [--theme=cyber|gloom|solarized|amber] [--no-minimap] [--fov=DEG]',
      '',
      '  --mode       requested view (default fps)',
      '  --theme      render theme for fps/ortho (default amber)',
      '  --no-minimap hide the minimap overlay in fps/ortho',
      '  --fov        first-person vertical FOV in degrees (default 60, 40-100)',
      '  --name       character name (default "asciihack")',
      '  --bridge     path to the nh-bridge binary',
      '  --playground per-player playground dir (default $ASCIIHACK_HOME/playground',
      '               or ~/.asciihack/playground); copied from the build on first use',
      '  --options    extra NETHACKOPTIONS (comma-separated)',
    ].join('\n') + '\n',
  );
}

/** Show usage on an error and exit non-zero. */
function usage(): never {
  printUsage(process.stderr);
  process.exit(2);
}

/** Show usage on an explicit --help request and exit 0. */
function showHelp(): never {
  printUsage(process.stdout);
  process.exit(0);
}

/** Parse `process.argv.slice(2)` into `CliFlags`. */
export function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    mode: 'fps',
    name: 'asciihack',
    bridge: DEFAULT_BRIDGE,
    playground: '',
    options: [],
    theme: null,
    minimap: null,
    fov: null,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') showHelp();
    if (arg === '--no-minimap') flags.minimap = false;
    else if (arg.startsWith('--theme=')) flags.theme = arg.slice('--theme='.length);
    else if (arg.startsWith('--mode=')) flags.mode = arg.slice('--mode='.length);
    else if (arg.startsWith('--name=')) flags.name = arg.slice('--name='.length);
    else if (arg.startsWith('--bridge=')) flags.bridge = arg.slice('--bridge='.length);
    else if (arg.startsWith('--playground=')) flags.playground = arg.slice('--playground='.length);
    else if (arg.startsWith('--fov=')) {
      const f = Number(arg.slice('--fov='.length));
      if (!Number.isFinite(f)) {
        console.error(`asciihack: --fov expects a number, got "${arg.slice('--fov='.length)}"`);
        usage();
      }
      flags.fov = f;
    } else if (arg.startsWith('--options=')) {
      flags.options = arg
        .slice('--options='.length)
        .split(',')
        .filter((s) => s.length > 0);
    } else {
      console.error(`asciihack: unknown argument "${arg}"`);
      usage();
    }
  }
  if (flags.mode !== 'classic' && flags.mode !== 'fps' && flags.mode !== 'ortho') {
    console.error(`asciihack: unknown mode "${flags.mode}"`);
    usage();
  }
  if (flags.theme !== null && flags.theme !== 'cyber' && flags.theme !== 'gloom' && flags.theme !== 'solarized' && flags.theme !== 'amber') {
    console.error(`asciihack: unknown theme "${flags.theme}"`);
    usage();
  }
  return flags;
}

/** Ensure the user playground exists (copied from the build on first run). */
export function preparePlayground(source: string, target: string): void {
  if (existsSync(target)) return;
  if (!existsSync(source)) {
    throw new Error(
      `playground source not found at ${source} — run "bash scripts/nethack-build.sh lib && bash scripts/nethack-build.sh bridge" first`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

/** Run the game to completion, restoring the terminal on the way out. */
async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const bridgePath = resolve(flags.bridge);
  if (!existsSync(bridgePath)) {
    console.error(
      `asciihack: bridge binary not found at ${bridgePath}\n` +
        'Build it with:  bash scripts/nethack-build.sh lib && bash scripts/nethack-build.sh bridge',
    );
    process.exit(1);
  }
  // --playground names the per-player target dir; default to the per-user dir.
  const targetPlayground = flags.playground ? resolve(flags.playground) : USER_PLAYGROUND;
  preparePlayground(resolve(DEFAULT_PLAYGROUND), targetPlayground);

  const term = new TtyTerm();
  const bridge = spawnBridge({
    binary: bridgePath,
    playgroundDir: targetPlayground,
    name: flags.name,
    options: flags.options.length > 0 ? flags.options : undefined,
  });
  const session = new NethackSession((r) => bridge.reply(r), { playerName: flags.name });
  const sFile = settingsPath();
  const app = new App({
    session,
    term,
    mode: flags.mode,
    theme: (flags.theme ?? undefined) as 'cyber' | 'gloom' | 'solarized' | 'amber' | undefined,
    minimap: flags.minimap ?? undefined,
    fov: flags.fov ?? undefined,
    settings: loadSettings(sFile),
    onSettingsChange: (s) => saveSettings(sFile, s),
  });
  app.enter();
  try {
    await runSession(bridge, session);
  } finally {
    app.leave();
    term.restore();
  }
  // The bridge auto-dismissed "Saving..." during the session, so nothing
  // survives to be printed on the alternate screen; echo the last two
  // messages (typically "Saving...  Be seeing you...") on the restored
  // terminal so the player gets the same farewell tty shows (T-0015).
  const tail = session.messages.slice(-2).join('  ');
  if (tail) process.stdout.write(`${tail}\n`);
  process.exit(await bridge.exited);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main();
}
