import { describe, expect, it } from 'vitest';
import { paintCompass } from '../src/ui/compass.js';
import { blankGrid } from '../src/ui/grid.js';
import type { ScreenGrid } from '../src/model/types.js';
import type { Rect } from '../src/ui/modes/classic.js';

function cell(grid: ScreenGrid, rect: Rect, col: number): string {
  return grid.cells[rect.y * grid.width + col]!.ch;
}

describe('compass ribbon', () => {
  it('facing north with a 90° FOV shows N at the centre and NE/NW at ±(ribbon half-width)', () => {
    const grid = blankGrid(120, 24);
    const rect: Rect = { x: 10, y: 5, width: 100, height: 18 };
    paintCompass(grid, rect, 0, Math.PI / 2); // 90°
    const centre = rect.x + Math.floor(rect.width / 2); // 60
    const half = Math.round((rect.width * 0.34) / 2); // 17
    expect(cell(grid, rect, centre)).toBe('N');
    // NE starts at centre + half, NW at centre − half.
    expect(cell(grid, rect, centre + half)).toBe('N');
    expect(cell(grid, rect, centre + half + 1)).toBe('E');
    expect(cell(grid, rect, centre - half)).toBe('N');
    expect(cell(grid, rect, centre - half + 1)).toBe('W');
    // E (90°) and W (−90°) map to ±34 columns: outside the half-width window.
    expect(cell(grid, rect, centre + 34)).not.toBe('E');
    expect(cell(grid, rect, centre - 34)).not.toBe('W');
  });

  it('facing south-west shows SW centred, S to the left and W to the right', () => {
    const grid = blankGrid(120, 24);
    const rect: Rect = { x: 10, y: 5, width: 100, height: 18 };
    paintCompass(grid, rect, (5 * Math.PI) / 4, Math.PI / 2); // 225° yaw, 90° FOV
    const centre = rect.x + Math.floor(rect.width / 2); // 60
    const half = Math.round((rect.width * 0.34) / 2); // 17
    expect(cell(grid, rect, centre)).toBe('S');
    expect(cell(grid, rect, centre + 1)).toBe('W');
    // S (Δ −45°) lands 17 columns left of centre, W (Δ +45°) 17 right.
    expect(cell(grid, rect, centre - half)).toBe('S');
    expect(cell(grid, rect, centre + half)).toBe('W');
  });

  it('with a 90° FOV NE/NW sit exactly at ±(ribbon half-width)', () => {
    const grid = blankGrid(120, 24);
    const rect: Rect = { x: 10, y: 5, width: 100, height: 18 };
    paintCompass(grid, rect, 0, Math.PI / 2); // 90°
    const centre = rect.x + Math.floor(rect.width / 2);
    const half = Math.round((rect.width * 0.34) / 2);
    expect(cell(grid, rect, centre + half)).toBe('N');
    expect(cell(grid, rect, centre + half + 1)).toBe('E');
    expect(cell(grid, rect, centre - half)).toBe('N');
    expect(cell(grid, rect, centre - half + 1)).toBe('W');
  });

  it('with a 50° FOV NE/NW fall outside the ribbon window', () => {
    const grid = blankGrid(120, 24);
    const rect: Rect = { x: 10, y: 5, width: 100, height: 18 };
    paintCompass(grid, rect, 0, (50 * Math.PI) / 180); // 50°
    const centre = rect.x + Math.floor(rect.width / 2);
    const half = Math.round((rect.width * 0.34) / 2); // 17
    // N is still centred.
    expect(cell(grid, rect, centre)).toBe('N');
    // NE/NW map to ±31 columns, beyond the ±17 window.
    expect(cell(grid, rect, centre + half)).not.toBe('N');
    expect(cell(grid, rect, centre - half)).not.toBe('N');
  });
});
