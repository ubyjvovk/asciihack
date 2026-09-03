import { describe, expect, it } from 'vitest';
import { paintCompass } from '../src/ui/compass.js';
import { blankGrid } from '../src/ui/grid.js';
import type { ScreenGrid } from '../src/model/types.js';
import type { Rect } from '../src/ui/modes/classic.js';

describe('compass ribbon', () => {
  it('facing north shows N at the centre column and NE/NW at ±20 columns with E/W absent', () => {
    const grid = blankGrid(120, 24);
    const rect: Rect = { x: 10, y: 5, width: 100, height: 18 };
    paintCompass(grid, rect, 0);
    const centre = rect.x + Math.floor(rect.width / 2); // 60
    expect(grid.cells[rect.y * grid.width + centre]!.ch).toBe('N');
    // The NE label starts at centre + 20, NW at centre − 20.
    expect(grid.cells[rect.y * grid.width + centre + 20]!.ch).toBe('N');
    expect(grid.cells[rect.y * grid.width + centre + 21]!.ch).toBe('E');
    expect(grid.cells[rect.y * grid.width + centre - 20]!.ch).toBe('N');
    expect(grid.cells[rect.y * grid.width + centre - 19]!.ch).toBe('W');
    // E (90°) and W (−90°) map to ±40 columns: outside the 41-wide ribbon.
    expect(grid.cells[rect.y * grid.width + centre + 40]!.ch).not.toBe('E');
    expect(grid.cells[rect.y * grid.width + centre - 40]!.ch).not.toBe('W');
  });

  it('facing south-west (yaw 225°) shows SW centred, S to the left and W to the right', () => {
    const grid = blankGrid(120, 24);
    const rect: Rect = { x: 10, y: 5, width: 100, height: 18 };
    paintCompass(grid, rect, (5 * Math.PI) / 4); // 225°
    const centre = rect.x + Math.floor(rect.width / 2); // 60
    // SW starts at the centre.
    expect(grid.cells[rect.y * grid.width + centre]!.ch).toBe('S');
    expect(grid.cells[rect.y * grid.width + centre + 1]!.ch).toBe('W');
    // S (Δ −45°) lands 20 columns left of centre, W (Δ +45°) 20 right.
    expect(grid.cells[rect.y * grid.width + centre - 20]!.ch).toBe('S');
    expect(grid.cells[rect.y * grid.width + centre + 20]!.ch).toBe('W');
  });
});
