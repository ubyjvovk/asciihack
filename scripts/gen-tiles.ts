#!/usr/bin/env -S npx tsx
/**
 * Generate `src/render/tiles.json` from NetHack's tile art text files
 * (`nethack/win/share/{monsters,objects,other}.txt`; see docs/tiles.md).
 * Run: `npx tsx scripts/gen-tiles.ts`. Deterministic: keys are sorted, so
 * running it twice yields a byte-identical file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Base-64 alphabet for the compact 256-char pixel encoding (see docs/tiles.md). */
const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One parsed tile file: palette (RGB per char) plus raw (comment, rows) tiles. */
export interface ParsedTileFile {
  palette: Array<[number, number, number]>;
  paletteChars: string[];
  tiles: Array<{ comment: string; rows: string[] }>;
}

/** Parse one `win/share/*.txt` file into its palette and raw tiles. */
export function parseTileFile(text: string, source: string): ParsedTileFile {
  const palette = new Map<string, [number, number, number]>();
  const order: string[] = [];
  const tiles: ParsedTileFile['tiles'] = [];
  const lines = text.split('\n');
  let i = 0;
  let pending: string | null = null;
  const fail = (msg: string): never => {
    throw new Error(`gen-tiles: ${source}: ${msg}`);
  };
  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.trim();
    i++;
    if (line === '') continue;
    const pal = line.match(/^(\S)\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (pal) {
      const ch = pal[1]!;
      if (!palette.has(ch)) order.push(ch);
      palette.set(ch, [Number(pal[2]), Number(pal[3]), Number(pal[4])]);
      continue;
    }
    const tileHead = raw.match(/^# tile \d+\s*\((.*)\)\s*$/);
    if (tileHead) {
      pending = tileHead[1]!.trim();
      continue;
    }
    if (line.startsWith('#')) continue; // ordinary comment
    if (line === '{') {
      if (pending === null) fail('tile body without a preceding "# tile N (name)" line');
      const name: string = pending as string;
      const rows: string[] = [];
      while (i < lines.length) {
        const body = lines[i]!.trim();
        i++;
        if (body === '' || body.startsWith('#')) continue;
        if (body === '}') break;
        rows.push(body.replace(/\s+/g, ''));
      }
      if (rows.length !== 16) fail(`tile "${name}" has ${rows.length} rows, expected 16`);
      for (const r of rows) {
        if (r.length !== 16) fail(`tile "${name}" has a row of length ${r.length}, expected 16`);
        for (const c of r) {
          if (!palette.has(c)) fail(`tile "${name}" uses unknown palette char "${c}"`);
        }
      }
      tiles.push({ comment: name, rows });
      pending = null;
      continue;
    }
    fail(`unexpected line: ${raw.slice(0, 80)}`);
  }
  if (pending !== null) fail(`tile "${pending}" has no body`);
  return {
    palette: order.map((c) => palette.get(c)!),
    paletteChars: order,
    tiles,
  };
}

/** Split a monster tile comment into base name + gender (`jackal,male` et al). */
export function splitMonsterName(comment: string): { base: string; gender: 'm' | 'f' | null } {
  const low = comment.toLowerCase();
  if (low.endsWith(',male')) return { base: low.slice(0, -5), gender: 'm' };
  if (low.endsWith(',female')) return { base: low.slice(0, -7), gender: 'f' };
  if (low.endsWith(', nogender')) return { base: low.slice(0, -10), gender: null };
  if (low.endsWith(',nogender')) return { base: low.slice(0, -9), gender: null };
  return { base: low, gender: null };
}

/** Split an object tile comment into name + optional description (`descr / name`). */
export function splitObjectName(comment: string): { name: string; descr: string | null } {
  const slash = comment.indexOf('/');
  if (slash < 0) return { name: comment.toLowerCase().trim(), descr: null };
  return {
    descr: comment.slice(0, slash).toLowerCase().trim(),
    name: comment.slice(slash + 1).toLowerCase().trim(),
  };
}

/** Encode 256 palette indices (0–63) as 256 base-64 characters. */
export function encodePixels(indices: number[]): string {
  return indices.map((v) => B64[v]!).join('');
}

function buildJson(): string {
  const mon = parseTileFile(
    readFileSync(join(repo, 'nethack', 'win', 'share', 'monsters.txt'), 'utf8'),
    'monsters.txt',
  );
  const obj = parseTileFile(
    readFileSync(join(repo, 'nethack', 'win', 'share', 'objects.txt'), 'utf8'),
    'objects.txt',
  );
  const oth = parseTileFile(
    readFileSync(join(repo, 'nethack', 'win', 'share', 'other.txt'), 'utf8'),
    'other.txt',
  );
  // The palette is shared across all three files; fail loudly if not.
  const ref = JSON.stringify(mon.palette);
  for (const [name, f] of [['objects.txt', obj], ['other.txt', oth]] as const) {
    if (JSON.stringify(f.palette) !== ref) {
      throw new Error(`gen-tiles: palette mismatch between monsters.txt and ${name}`);
    }
  }
  const transparentIdx = mon.paletteChars.indexOf('.');
  if (transparentIdx !== 0) {
    throw new Error(`gen-tiles: expected '.' to be palette index 0, found ${transparentIdx}`);
  }
  const idxOf = new Map<string, number>(mon.paletteChars.map((c, k) => [c, k]));
  const encode = (rows: string[]): string =>
    encodePixels(rows.join('').split('').map((c) => idxOf.get(c)!));

  const monsters: Record<string, Record<string, string>> = {};
  for (const t of mon.tiles) {
    const { base, gender } = splitMonsterName(t.comment);
    const key = gender === 'm' ? 'm' : gender === 'f' ? 'f' : 'n';
    (monsters[base] ??= {})[key] = encode(t.rows);
  }
  const objects: Record<string, string> = {};
  const objectsByDescr: Record<string, string> = {};
  for (const t of obj.tiles) {
    const { name, descr } = splitObjectName(t.comment);
    const pix = encode(t.rows);
    objects[name] ??= pix;
    if (descr !== null) objectsByDescr[descr] ??= pix;
  }
  const other: Record<string, string> = {};
  for (const t of oth.tiles) {
    const name = t.comment.toLowerCase();
    other[name] ??= encode(t.rows);
  }
  const sortObj = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const sortedMonsters = sortObj(
    Object.fromEntries(Object.entries(monsters).map(([k, v]) => [k, sortObj(v)])),
  );
  const out = {
    palette: mon.palette,
    monsters: sortedMonsters,
    objects: sortObj(objects),
    objectsByDescr: sortObj(objectsByDescr),
    other: sortObj(other),
  };
  return JSON.stringify(out, null, 1) + '\n';
}

function main(): void {
  const json = buildJson();
  const dest = join(repo, 'src', 'render', 'tiles.json');
  writeFileSync(dest, json);
  const parsed = JSON.parse(json) as {
    monsters: Record<string, unknown>;
    objects: Record<string, unknown>;
    other: Record<string, unknown>;
  };
  console.log(
    `gen-tiles: ${Object.keys(parsed.monsters).length} monsters, ` +
      `${Object.keys(parsed.objects).length} objects, ` +
      `${Object.keys(parsed.other).length} other -> ${dest}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
