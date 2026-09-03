import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { App } from '../src/ui/app.js';
import { FACINGS, opposite, poseFor, spritesFromMap, strafe, turn, blitGrid, Viewport3D } from '../src/ui/view3d.js';
import { FpsMode } from '../src/ui/modes/fps.js';
import { OrthoMode } from '../src/ui/modes/ortho.js';
import { blankGrid } from '../src/ui/grid.js';
import { clrToRgb, makeFrameBuffer, type GlyphInfo, type LevelView } from '../src/model/types.js';
import type { BridgeMsg, RetMsg } from '../src/engine/protocol.js';
import { NethackSession } from '../src/engine/session.js';
import type { KeyEvent } from '../src/term/input.js';
import type { TermIO } from '../src/term/screen.js';
import { DEFAULT_RAMP } from '../src/render/ascii.js';
import type { ScreenGrid } from '../src/model/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Doubles

class FakeTerm implements TermIO {
  columns: number;
  rows: number;
  private keyCb: ((e: KeyEvent) => void) | null = null;
  constructor(cols = 80, rows = 24) {
    this.columns = cols;
    this.rows = rows;
  }
  write(): void {}
  onKey(cb: (e: KeyEvent) => void): void {
    this.keyCb = cb;
  }
  onResize(): void {}
}

function ev(key: string, opts: { shift?: boolean; ctrl?: boolean } = {}): KeyEvent {
  return { key, ctrl: opts.ctrl ?? false, shift: opts.shift ?? false, alt: false, seq: key };
}

function glyph(ch: string, cls: GlyphInfo['cls'] = 'mon', color = 15): GlyphInfo {
  return { glyph: 1, ch, color, cls, idx: 0, flags: 0 };
}

function tinyLevel(top: (x: number, y: number) => GlyphInfo | null): LevelView {
  return {
    width: 5,
    height: 5,
    kindAt: (x, y) => (x === 2 && y === 2 ? 'floor' : x === 0 || y === 0 ? 'wall' : 'floor'),
    cellAt: (x, y) => {
      if (x < 0 || y < 0 || x >= 5 || y >= 5) return null;
      const t = top(x, y);
      return { x, y, kind: t ? 'floor' : 'unexplored', terrain: null, top: t };
    },
  };
}

function freshSessionWithHero(replies: RetMsg[]): NethackSession {
  const s = new NethackSession((r) => replies.push(r));
  s.handle({
    t: 'hello',
    proto: 1,
    version: 'test',
    S: {},
    cmap: [],
    nhw: { NHW_MESSAGE: 1, NHW_STATUS: 2, NHW_MAP: 3, NHW_MENU: 4, NHW_TEXT: 5 },
    bl: {},
    pick: {},
    atr: {},
    mg: { MG_HERO: 1 },
    clr: {},
    blmask: {},
  } as unknown as BridgeMsg);
  s.handle({ t: 'call', name: 'create_nhwindow', args: [1], id: 1 } as unknown as BridgeMsg);
  s.handle({ t: 'call', name: 'create_nhwindow', args: [2], id: 2 } as unknown as BridgeMsg);
  s.handle({ t: 'call', name: 'create_nhwindow', args: [3], id: 3 } as unknown as BridgeMsg);
  return s;
}

/** Feed start.jsonl until the first key/pos request, returning the session/app. */
function startApp(mode: string, replies: RetMsg[]): { session: NethackSession; app: App } {
  const session = freshSessionWithHero(replies);
  const path = resolve(HERE, 'fixtures', 'bridge', 'start.jsonl');
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const line of lines) {
    if ('reply' in line) continue;
    session.handleBatch([line as unknown as BridgeMsg]);
    const p = session.pending;
    if (p !== null && (p.kind === 'key' || p.kind === 'pos')) break;
    // Dismiss any blocking display (intro menu) so the stream advances.
    if (p !== null && p.kind === 'display') session.answer({ kind: 'dismiss' });
  }
  const app = new App({ session, term: new FakeTerm(), mode });
  session.handleBatch([]);
  return { session, app };
}

function nonSpaces(grid: ScreenGrid, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = 0; x < grid.width; x++) if (grid.cells[y * grid.width + x]!.ch !== ' ') n++;
  return n;
}

function viewportZone(grid: ScreenGrid): { hasRamp: boolean; hasHero: boolean } {
  let hasRamp = false;
  let hasHero = false;
  for (let y = 1; y < grid.height - 2; y++) {
    for (let x = 0; x < grid.width; x++) {
      const ch = grid.cells[y * grid.width + x]!.ch;
      if (DEFAULT_RAMP.includes(ch) && ch !== ' ') hasRamp = true;
      if (ch === '@') hasHero = true;
    }
  }
  return { hasRamp, hasHero };
}

// ---------------------------------------------------------------------------
// view3d unit tests

describe('view3d FACINGS order and vi-keys', () => {
  it('lists 8 facings clockwise from north with k u l n j b h y', () => {
    expect(FACINGS.map((f) => f.name)).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    expect(FACINGS.map((f) => f.key)).toEqual(['k', 'u', 'l', 'n', 'j', 'b', 'h', 'y']);
    expect(FACINGS[0]!.yaw).toBeCloseTo(0);
    expect(FACINGS[2]!.yaw).toBeCloseTo(Math.PI / 2);
    expect(FACINGS[4]!.yaw).toBeCloseTo(Math.PI);
  });
});

describe('view3d turn/opposite/strafe wrap-around', () => {
  it('turn wraps N→NW counter-clockwise and NW→N clockwise', () => {
    expect(turn(FACINGS[0]!, -1).name).toBe('NW');
    expect(turn(FACINGS[7]!, 1).name).toBe('N');
  });

  it('opposite maps N→S and E→W', () => {
    expect(opposite(FACINGS[0]!).name).toBe('S');
    expect(opposite(FACINGS[2]!).name).toBe('W');
  });

  it('strafe steps ±90° (N strafes to W/E)', () => {
    expect(strafe(FACINGS[0]!, -1).name).toBe('W');
    expect(strafe(FACINGS[0]!, 1).name).toBe('E');
  });
});

describe('view3d spritesFromMap', () => {
  it('skips terrain and (fps) the hero, includes the pet with its colour', () => {
    const petColor = 10;
    const map = tinyLevel((x, y) => {
      if (x === 2 && y === 2) return glyph('@', 'mon', 15); // hero cell
      if (x === 3 && y === 2) return glyph('d', 'pet', petColor); // pet
      if (x === 1 && y === 1) return glyph('#', 'cmap', 7); // terrain
      return null;
    });
    const fps = spritesFromMap(map, { x: 2, y: 2 }, false);
    expect(fps.some((s) => s.x === 2 && s.y === 2)).toBe(false);
    expect(fps.some((s) => s.x === 1 && s.y === 1)).toBe(false);
    const pet = fps.find((s) => s.x === 3 && s.y === 2)!;
    expect(pet.ch).toBe('d');
    const c = clrToRgb(petColor);
    expect(pet.rgb[0]).toBeCloseTo(c[0]! / 255);
    expect(pet.rgb[1]).toBeCloseTo(c[1]! / 255);
    expect(pet.rgb[2]).toBeCloseTo(c[2]! / 255);
    const ortho = spritesFromMap(map, { x: 2, y: 2 }, true);
    const hero = ortho.find((s) => s.x === 2 && s.y === 2)!;
    expect(hero.ch).toBe('@');
  });
});

describe('view3d poseFor and Viewport3D', () => {
  it('poseFor centres the hero cell', () => {
    const p = poseFor({ x: 3, y: 5 }, Math.PI / 2);
    expect(p.x).toBeCloseTo(3.5);
    expect(p.y).toBeCloseTo(5.5);
    expect(p.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('blitGrid copies a quantized grid into the viewport rect', () => {
    const dst = blankGrid(10, 6);
    const src = blankGrid(4, 2);
    src.cells[0]!.ch = 'X';
    blitGrid(src, dst, { x: 2, y: 1, width: 4, height: 2 });
    expect(dst.cells[1 * 10 + 2]!.ch).toBe('X');
    expect(dst.cells[0]!.ch).toBe(' ');
  });

  it('Viewport3D reuses its grid at a stable size and reallocates on resize', () => {
    const v = new Viewport3D();
    const fb = makeFrameBuffer(4, 2);
    const g1 = v.render({ x: 0, y: 0, width: 4, height: 2 }, (f) => f.rgb.set(fb.rgb), 'cyber');
    const g2 = v.render({ x: 0, y: 0, width: 4, height: 2 }, (f) => f.rgb.set(fb.rgb), 'cyber');
    expect(g2).toBe(g1);
    const g3 = v.render({ x: 0, y: 0, width: 6, height: 2 }, (f) => f.rgb.set(fb.rgb), 'cyber');
    expect(g3).not.toBe(g1);
    expect(g3.width).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// fps/ortho App key routing

describe('fps mode key routing', () => {
  it('Right then Up sends u (north-east); Right twice then Up sends l (east)', () => {
    const replies: RetMsg[] = [];
    const session = freshSessionWithHero(replies);
    const term = new FakeTerm();
    const app = new App({ session, term, mode: 'fps' });
    const fps = app.activeMode as FpsMode;
    expect(fps.name).toBe('fps');
    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 7 } as unknown as BridgeMsg);
    const before = replies.length;
    app.handleKey(ev('Right'));
    expect(session.pending?.kind).toBe('key'); // turn consumed, request still pending
    expect(replies.length).toBe(before);
    expect(fps.currentFacing.name).toBe('NE');
    app.handleKey(ev('Up'));
    expect(session.pending).toBeNull();
    expect(replies.at(-1)).toEqual({ id: 7, ret: 'u'.charCodeAt(0) });

    // A second turn steps to east, so Up then sends 'l'.
    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 70 } as unknown as BridgeMsg);
    app.handleKey(ev('Right'));
    expect(fps.currentFacing.name).toBe('E');
    app.handleKey(ev('Up'));
    expect(replies.at(-1)).toEqual({ id: 70, ret: 'l'.charCodeAt(0) });
  });

  it('Down after facing north sends j', () => {
    const replies: RetMsg[] = [];
    const session = freshSessionWithHero(replies);
    const term = new FakeTerm();
    const app = new App({ session, term, mode: 'fps' });
    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 8 } as unknown as BridgeMsg);
    app.handleKey(ev('Down'));
    expect(replies.at(-1)).toEqual({ id: 8, ret: 'j'.charCodeAt(0) });
  });

  it('Shift+Right strafes 90° right and sends l when facing north', () => {
    const replies: RetMsg[] = [];
    const session = freshSessionWithHero(replies);
    const term = new FakeTerm();
    const app = new App({ session, term, mode: 'fps' });
    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 9 } as unknown as BridgeMsg);
    app.handleKey(ev('Right', { shift: true }));
    // Facing north, strafing right = east = 'l'; the facing is unchanged.
    expect(replies.at(-1)).toEqual({ id: 9, ret: 'l'.charCodeAt(0) });
    expect((app.activeMode as FpsMode).currentFacing.name).toBe('N');
  });

  it('typing y sends y and sets facing NW so the next Up sends y', () => {
    const replies: RetMsg[] = [];
    const session = freshSessionWithHero(replies);
    const term = new FakeTerm();
    const app = new App({ session, term, mode: 'fps' });
    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 10 } as unknown as BridgeMsg);
    app.handleKey(ev('y'));
    expect(replies.at(-1)).toEqual({ id: 10, ret: 'y'.charCodeAt(0) });
    expect((app.activeMode as FpsMode).currentFacing.name).toBe('NW');
    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 11 } as unknown as BridgeMsg);
    app.handleKey(ev('Up'));
    expect(replies.at(-1)).toEqual({ id: 11, ret: 'y'.charCodeAt(0) });
  });

  it('a turn requests frames until the yaw settles (≤ 6 ticks at 30 fps) and then stops', () => {
    const replies: RetMsg[] = [];
    const session = freshSessionWithHero(replies);
    let clock = 1000;
    const mode = new FpsMode(session, () => clock);
    const start = 1000;
    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 12 } as unknown as BridgeMsg);
    mode.handleKey(ev('Right'), () => {});
    let ticks = 0;
    let t = start;
    let running = mode.tick(start);
    while (running && ticks < 20) {
      t += 33;
      clock = t;
      ticks++;
      running = mode.tick(t);
    }
    expect(ticks).toBeLessThanOrEqual(6);
    expect(mode.tick(t + 1000)).toBe(false);
    expect(mode.currentYaw).toBeCloseTo(Math.PI / 4);
  });
});

describe('ortho mode key routing', () => {
  it('ortho Up sends k', () => {
    const replies: RetMsg[] = [];
    const session = freshSessionWithHero(replies);
    const term = new FakeTerm();
    const app = new App({ session, term, mode: 'ortho' });
    session.handle({ t: 'call', name: 'nhgetch', args: [], id: 13 } as unknown as BridgeMsg);
    app.handleKey(ev('Up'));
    expect(replies.at(-1)).toEqual({ id: 13, ret: 'k'.charCodeAt(0) });
  });
});

describe('minimap and theme toggles', () => {
  it('F4 removes the minimap from the grid', () => {
    if (!existsSync(resolve(HERE, 'fixtures', 'bridge', 'start.jsonl'))) return;
    const replies: RetMsg[] = [];
    const { app } = startApp('fps', replies);
    const before = app.lastGrid!;
    const beforeRect = { zone: viewportZone(before) };
    expect(beforeRect.zone.hasHero).toBe(true);
    app.handleKey(ev('F4'));
    const after = app.lastGrid!;
    expect(viewportZone(after).hasHero).toBe(false);
  });

  it('F5 changes the cell colours of the viewport', () => {
    if (!existsSync(resolve(HERE, 'fixtures', 'bridge', 'start.jsonl'))) return;
    const replies: RetMsg[] = [];
    const { app } = startApp('fps', replies);
    const snap = (g: ScreenGrid): string => {
      let s = '';
      for (let y = 1; y < g.height - 2; y++)
        for (let x = 0; x < g.width; x++) {
          const c = g.cells[y * g.width + x]!;
          s += `${c.ch},${c.fg[0]},${c.fg[1]},${c.fg[2]};`;
        }
      return s;
    };
    const before = snap(app.lastGrid!);
    app.handleKey(ev('F5'));
    const after = snap(app.lastGrid!);
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Structural render checks

describe('3D structural render checks', () => {
  it.skipIf(!existsSync(resolve(HERE, 'fixtures', 'bridge', 'start.jsonl')))(
    'fps viewport rows contain ramp glyphs and the minimap contains the hero @',
    () => {
      const replies: RetMsg[] = [];
      const { app } = startApp('fps', replies);
      const grid = app.lastGrid!;
      expect(nonSpaces(grid, 1, grid.height - 3)).toBeGreaterThan(50);
      expect(viewportZone(grid).hasRamp).toBe(true);
      expect(viewportZone(grid).hasHero).toBe(true);
    },
  );

  it.skipIf(!existsSync(resolve(HERE, 'fixtures', 'bridge', 'start.jsonl')))(
    'ortho viewport contains the hero sprite @ overlay',
    () => {
      const replies: RetMsg[] = [];
      const { session, app } = startApp('ortho', replies);
      const mode = app.activeMode as OrthoMode;
      expect(mode.name).toBe('ortho');
      const grid = app.lastGrid!;
      expect(viewportZone(grid).hasHero).toBe(true);
      expect(session.hero).not.toBeNull();
    },
  );
});

describe('fps/ortho mode controls', () => {
  it('FpsMode and OrthoMode implement the Mode interface with JSDoc-visible names', () => {
    const replies: RetMsg[] = [];
    const session = freshSessionWithHero(replies);
    expect(new FpsMode(session).name).toBe('fps');
    expect(new OrthoMode(session).name).toBe('ortho');
  });
});
