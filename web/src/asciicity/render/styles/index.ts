/**
 * Render-style registry (docs/architecture.md §4.11): one `RenderStyle` per
 * `STYLE_ORDER` id, assembled from the per-style modules. Throws at import
 * if any id is missing or duplicated.
 */
import { STYLE_ORDER, type RenderStyle } from '../style';
import { STYLES as ascii } from './ascii';
import { STYLES as braille } from './braille';
import { STYLES as blocks } from './blocks';
import { STYLES as teletext } from './teletext';
import { STYLES as dither } from './dither';
import { STYLES as pico8 } from './pico8';
import { STYLES as edges } from './edges';
import { STYLES as hatch } from './hatch';
import { STYLES as matrix } from './matrix';

const modules: readonly (readonly RenderStyle[])[] = [
  ascii,
  braille,
  blocks,
  teletext,
  dither,
  pico8,
  edges,
  hatch,
  matrix,
];

const byId = new Map<string, RenderStyle>();
for (const group of modules) {
  for (const style of group) {
    if (byId.has(style.id)) {
      throw new Error(`duplicate render style id: ${style.id}`);
    }
    byId.set(style.id, style);
  }
}

/**
 * Every style in `R`-cycle order. Missing or extra ids (relative to
 * `STYLE_ORDER`) throw at import so a stub ticket cannot silently drop one.
 */
export const STYLES: readonly RenderStyle[] = STYLE_ORDER.map((id) => {
  const style = byId.get(id);
  if (!style) throw new Error(`missing render style id: ${id}`);
  return style;
});

if (byId.size !== STYLE_ORDER.length) {
  const extra = [...byId.keys()].filter(
    (id) => !(STYLE_ORDER as readonly string[]).includes(id),
  );
  throw new Error(`render style ids not in STYLE_ORDER: ${extra.join(', ')}`);
}
