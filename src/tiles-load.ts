/**
 * Node-only loader for `src/render/tiles.json` (see `src/render/tiles.ts`
 * for the pure decoders). Split out so `src/render/*` stays browser-clean.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tileSetFromFile, type TileFile, type TileSet } from './render/tiles.js';

let loaded: TileSet | null = null;

/** Load and parse `tiles.json` once (lazily); later calls return the cache. */
export function loadTiles(): TileSet {
  if (loaded) return loaded;
  const dir = dirname(fileURLToPath(import.meta.url));
  const file = JSON.parse(readFileSync(join(dir, 'render', 'tiles.json'), 'utf8')) as TileFile;
  loaded = tileSetFromFile(file);
  return loaded;
}
