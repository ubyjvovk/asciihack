/**
 * AsciiHack CLI entry point (docs/architecture.md §8). Parses flags, prepares
 * the per-user playground, spawns the bridge, and runs the terminal app until
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

const HERE = dirname(fileURLToPath(import.meta.url));
/** Default location of the built bridge binary. */
const DEFAULT_BRIDGE = join(HERE, '..', 'build', 'nethack', 'bridge', 'nh-bridge');
/** Default source playground (cloned from the build) before the first copy. */
const DEFAULT_PLAYGROUND = join(HERE, '..', 'build', 'nethack', 'bridge', 'playground');
/** Per-user playground so saves persist and the build dir stays clean. */
const USER_PLAYGROUND = join(homedir(), '.asciihack', 'playground');

/** Parsed CLI flags. */
interface CliFlags {
  mode: string;
  name: string;
  bridge: string;
  playground: string;
  options: string[];
}

/** Print usage and exit non-zero. */
function usage(): never {
  console.error(
    [
      'usage: asciihack [--mode=classic|fps|ortho] [--name=NAME]',
      '                 [--bridge=PATH] [--playground=DIR] [--options=K,V,...]',
      '',
      '  --mode       requested view (default fps; falls back to classic until T-0007)',
      '  --name       character name (default "asciihack")',
      '  --bridge     path to the nh-bridge binary',
      '  --playground directory to copy into ~/.asciihack/playground on first run',
      '  --options    extra NETHACKOPTIONS (comma-separated)',
    ].join('\n'),
  );
  process.exit(2);
}

/** Parse `process.argv.slice(2)` into `CliFlags`. */
export function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    mode: 'fps',
    name: 'asciihack',
    bridge: DEFAULT_BRIDGE,
    playground: DEFAULT_PLAYGROUND,
    options: [],
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') usage();
    if (arg.startsWith('--mode=')) flags.mode = arg.slice('--mode='.length);
    else if (arg.startsWith('--name=')) flags.name = arg.slice('--name='.length);
    else if (arg.startsWith('--bridge=')) flags.bridge = arg.slice('--bridge='.length);
    else if (arg.startsWith('--playground=')) flags.playground = arg.slice('--playground='.length);
    else if (arg.startsWith('--options=')) {
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
  preparePlayground(resolve(flags.playground), USER_PLAYGROUND);

  const term = new TtyTerm();
  const bridge = spawnBridge({
    binary: bridgePath,
    playgroundDir: USER_PLAYGROUND,
    name: flags.name,
    options: flags.options.length > 0 ? flags.options : undefined,
  });
  const session = new NethackSession((r) => bridge.reply(r), { playerName: flags.name });
  const app = new App({ session, term, mode: flags.mode });
  app.enter();
  try {
    await runSession(bridge, session);
  } finally {
    app.leave();
    term.restore();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main();
}
