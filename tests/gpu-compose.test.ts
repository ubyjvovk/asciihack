/**
 * Pure-function tests for the GPU/legacy viewport split (T-0040).
 *
 * Runs in node under the root tsconfig (no DOM lib): imports only the pure
 * exports of `web/src/gpu/path.ts`, which by design does not pull in
 * `three/webgpu` or the DOM. The impure `GlViewport`/`GpuPath`/`GpuCompositor`
 * wiring cannot be tested without a browser (see `docs/gpu-compose.md`
 * §"what I could not verify").
 *
 * Case names are the ticket's acceptance list — do not rename them.
 */
import { describe, it, expect } from 'vitest';
import {
  backendFor,
  choosePath,
  gpuCanvasSize,
  moodFor,
  parseGpuQueryOptions,
  rawLook,
  styledLook,
} from '../web/src/gpu/path.js';
import type { CellKind, LevelView, MapCell } from '../src/model/types.js';

/** Build a synthetic `LevelView` from a rectangular grid of cell kinds. */
function levelOf(
  rows: readonly (readonly CellKind[])[],
  lits?: readonly (readonly (boolean | undefined)[])[],
): LevelView {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const kindAt = (x: number, y: number): CellKind => {
    if (x < 0 || y < 0 || y >= height || x >= width) return 'unexplored';
    return rows[y]?.[x] ?? 'unexplored';
  };
  return {
    width,
    height,
    kindAt,
    cellAt(x: number, y: number): MapCell | null {
      const kind = kindAt(x, y);
      if (kind === 'unexplored') return null;
      const lit = lits?.[y]?.[x];
      const cell: MapCell = { x, y, kind, terrain: null, top: null };
      if (lit !== undefined) cell.lit = lit;
      return cell;
    },
  };
}

describe('gpu compose — path decision', () => {
  it('choosePath sends a needsDepth style to the legacy path and everything else to the GPU', () => {
    // With the GPU ready and `auto`, a depth style keeps the legacy renderer;
    // a normal style rides the GPU-styled path.
    expect(choosePath({ gpuParam: 'auto', gpuReady: true, styleNeedsDepth: true })).toBe('legacy');
    expect(choosePath({ gpuParam: 'auto', gpuReady: true, styleNeedsDepth: false })).toBe('styled');
  });

  it('choosePath honours ?gpu=off and ?gpu=raw', () => {
    // `off` always lands on legacy regardless of GPU readiness or style.
    expect(choosePath({ gpuParam: 'off', gpuReady: true, styleNeedsDepth: false })).toBe('legacy');
    expect(choosePath({ gpuParam: 'off', gpuReady: false, styleNeedsDepth: false })).toBe('legacy');
    // `raw` shows the GPU frame directly and ignores the depth-style rule (no
    // style pass is running to care).
    expect(choosePath({ gpuParam: 'raw', gpuReady: true, styleNeedsDepth: true })).toBe('raw');
    expect(choosePath({ gpuParam: 'raw', gpuReady: true, styleNeedsDepth: false })).toBe('raw');
  });

  it('choosePath falls back to legacy while the GPU is not ready', () => {
    // A pending async init or a device-lost recovery reads as gpuReady=false.
    expect(choosePath({ gpuParam: 'auto', gpuReady: false, styleNeedsDepth: false })).toBe('legacy');
    expect(choosePath({ gpuParam: 'raw', gpuReady: false, styleNeedsDepth: false })).toBe('legacy');
  });
});

describe('gpu compose — backend + option defaults', () => {
  it('backendFor picks webgl2 when forced by the query and webgpu otherwise', () => {
    expect(backendFor('webgl2')).toBe('webgl2');
    expect(backendFor('webgpu')).toBe('webgpu');
    // Missing / unrecognised → let three probe (webgpu default).
    expect(backendFor(null)).toBe('webgpu');
  });

  it('the viewport options default to the query string so /scene.html needs no change', () => {
    // A fully populated search: every knob is decoded.
    const q = parseGpuQueryOptions('?gpu=raw&q=high&backend=webgl2&mood=lava');
    expect(q).toEqual({ gpu: 'raw', quality: 'high', backend: 'webgl2', mood: 'lava' });
    // Missing search: every knob falls to `auto` / `null` so a bare
    // `new GlViewport({})` and `/scene.html` read identical defaults.
    const d = parseGpuQueryOptions('');
    expect(d).toEqual({ gpu: 'auto', quality: 'auto', backend: 'auto', mood: null });
    // Invalid values fall to defaults, not to `undefined`.
    const bad = parseGpuQueryOptions('?gpu=maybe&q=insane&backend=vulkan&mood=cozy');
    expect(bad).toEqual({ gpu: 'auto', quality: 'auto', backend: 'auto', mood: null });
  });
});

describe('gpu compose — sizing and grade', () => {
  it('gpuCanvasSize matches the style scene target in styled mode and the viewport in raw mode', () => {
    const style = { subX: 4, subY: 8 };
    // Styled: cols·subX × rows·subY exactly (viewport size is ignored — the
    // style pass owns the visible target and stretches for us).
    expect(gpuCanvasSize('styled', style, 40, 20, { cssW: 900, cssH: 500, dpr: 2 }))
      .toEqual({ w: 160, h: 160 });
    // Raw: CSS viewport × dpr (dpr capped at 1.5 per docs/gpu.md §6).
    expect(gpuCanvasSize('raw', style, 40, 20, { cssW: 800, cssH: 600, dpr: 2 }))
      .toEqual({ w: 1200, h: 900 });
    expect(gpuCanvasSize('raw', style, 40, 20, { cssW: 800, cssH: 600, dpr: 1 }))
      .toEqual({ w: 800, h: 600 });
  });

  it('styled mode zeroes vignette and grain and scales the output by the style exposure', () => {
    // AsciiCity applies its own exposure = 1.7; styled mode compensates so the
    // frame reaches the style prelude where its own scaling expects it.
    const styled = styledLook(1.7);
    expect(styled.vignette).toBe(0);
    expect(styled.grain).toBe(0);
    expect(styled.outputScale).toBeCloseTo(1 / 1.7);
    // Raw mode leaves vignette/grain alone (mood values win) and does not
    // touch outputScale — this contract is what `docs/gpu.md` §6.1 pins down.
    expect(rawLook()).toEqual({});
  });
});

describe('gpu compose — mood decision', () => {
  it('moodFor picks lava, ice, flooded, torchlit and deep_dark in that precedence', () => {
    // 1) Hero standing on lava beats everything below in the table.
    expect(moodFor(levelOf([['lava']]), 0, 0)).toBe('lava');
    // 2) Orthogonally adjacent lava still counts as lava; a diagonal-only
    //    neighbour must not (deep_dark result below pins the diagonal case).
    expect(moodFor(levelOf([['floor', 'lava']]), 0, 0)).toBe('lava');
    expect(moodFor(levelOf([['floor', 'floor'], ['floor', 'lava']]), 0, 0))
      .toBe('deep_dark');
    // 3) Ice beats water/flooded/torchlit but loses to lava (checked above).
    expect(moodFor(levelOf([['ice']]), 0, 0)).toBe('ice');
    // 4) Water at the hero's cell → flooded. Ice adjacent must not upgrade.
    expect(moodFor(levelOf([['water']]), 0, 0)).toBe('flooded');
    // 5) Adjacent water still flooded.
    expect(moodFor(levelOf([['floor', 'water']]), 0, 0)).toBe('flooded');
    // 6) Plain lit floor → torchlit; the corridor cell type is irrelevant.
    expect(moodFor(levelOf([['floor']], [[true]]), 0, 0)).toBe('torchlit');
    // 7) Anything else (dark corridor, unknown adjacent) → deep_dark.
    expect(moodFor(levelOf([['corridor']], [[false]]), 0, 0)).toBe('deep_dark');
  });
});
