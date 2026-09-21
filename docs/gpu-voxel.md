# Voxel kit (`web/src/voxel/`)

Ported from `~/afterburn` commit `8492a00`, 2026-09-20 (vendored at
`vendor/afterburn/src/voxel/` in this repo). The port is behaviour-identical
to the JS original: same RNG constants, same noise/fbm formulas, same
palette and material tables, same 24 B/vertex layout, same byte quantisation
in `GeoWriter`. Afterburn model code can be dropped in unchanged.

## What was ported

| From (JS) | To (TS) | Notes |
| --- | --- | --- |
| `vendor/afterburn/src/voxel/kit.js` | `web/src/voxel/kit.ts` | `VoxelBuilder` + seeded RNG/noise, no three.js |
| `vendor/afterburn/src/voxel/palette.js` | `web/src/voxel/palette.ts` | `PAL`, `MAT`, `FX`, `hexOf`, `matOf` |
| `vendor/afterburn/src/voxel/mesh.js` | `web/src/voxel/mesh.ts` | `GeoWriter`, `hiddenFaces`, `partGeometry`, `buildModelObject`, `bakeModel` (`three/webgpu`) |

`pixelfont.js` is out of scope (see ticket T-0036).

## Units (`docs/gpu.md` §4)

- **Cell = 1 unit = 1 three.js "metre".** Wall height = 1 unit, eye height = 0.5.
- **Voxel unit = 0.125** (8 voxels per cell edge). This is the default of
  `new VoxelBuilder()` (`unit: 0.125`), unchanged from afterburn.
- Coordinates: X = east, Y = up, Z = south (three's convention, matches map `x` east / `y` south).

## API — one line per symbol

### `kit.ts`

| Symbol | What it does |
| --- | --- |
| `makeRng(seed = 1)` | mulberry32 RNG (returns a `() => number` in [0,1)). |
| `noise3(x, y, z, seed = 0)` | Deterministic 3D value noise in [0,1]. |
| `fbm3(x, y, z, octaves = 3, seed = 0)` | Fractal noise in [0,1]. |
| `VoxelBuilder({ unit?, seed?, jitter? })` | Construction session; append boxes, then `.build(name)`. |
| `b.box(x,y,z,w,h,d,color,mat?,{j?})` | Axis-aligned box. Negative sizes flip; zero-sized skipped. |
| `b.voxel(x,y,z,color,mat?,{j?})` | 1×1×1 shortcut for `box`. |
| `b.fill(x0,y0,z0,x1,y1,z1,fn,step=1)` | Voxel-by-voxel fill; X runs merged when colour+material match. |
| `b.shell(x,y,z,w,h,d,t,color,mat?,open?)` | Hollow box; `open ⊂ ['top','bottom','n','s','e','w']`. |
| `b.line(ax,ay,az,bx,by,bz,s,color,mat?)` | Stair-stepped s×s×s cable/strut. |
| `b.blob(cx,cy,cz,rx,ry,rz,s,colorFn,{rough?,hollow?})` | Noisy ellipsoid mound of s-cubes. |
| `b.at(dx,dy,dz,fn)` / `b.rotY(q,fn)` / `b.mirrorX/Z(fn)` / `b.bothX/Z(fn)` | Transform stack; nested innermost-first. |
| `b.part(name,{pivot?,parent?})` / `b.root()` | Start/switch to a named part; pivot in units. |
| `b.anchor(name,x,y,z)` | Named point (metres in the output model). |
| `b.light({x,y,z,color?,intensity?,distance?,flicker?,name?,castShadow?})` | Request a real light (≤ 3/model). |
| `b.stamp(fn,x,y,z,quarters)` | Sub-builder at an offset + Y rotation. |
| `b.range/int/chance/pick/noise/fbm(...)` | Seeded helpers — deterministic. |
| `b.build(name)` → `VoxelModel` | Freeze into plain data with bounds. |

Types exported: `VoxelBox`, `VoxelPart`, `VoxelModel`, `VoxelLight`,
`VoxelAnchors`, `BuilderOptions`, `BoxOptions`, `FillResult`.

### `palette.ts`

| Symbol | What it does |
| --- | --- |
| `PAL` | Named sRGB colours (`{ hull0: 0xd8d2c4, moss1: 0x5f7852, … }`). |
| `MAT` | Material presets (`rock`, `metal`, `lamp`, `glass`, …) → partial `MatPreset`. |
| `FX` | fx codes (`none`, `flicker`, `pulse`, `sway`, `twinkle`) → 0..4. |
| `hexOf(c)` | Palette key / `0xRRGGBB` / `'#rrggbb'` → `0xRRGGBB` number. |
| `matOf(m)` | Preset name / literal / falsy → `MatPreset` (falsy → `rock`). |

Types exported: `ColorRef`, `MatPreset`, `MatRef`.

### `mesh.ts`

| Symbol | What it does |
| --- | --- |
| `EMISSIVE_RANGE = 32` | Divisor used to quantise `box.emissive` into `aMat.z`. |
| `GeoWriter(capBoxes = 1024)` | Growable typed-array writer; `.box()`, `.quad()`, `.toGeometry()`. |
| `hiddenFaces(boxes)` → `Uint8Array` | FACE_* bitmask per box; culls faces fully covered by a neighbour. |
| `partGeometry(part, unit, {cull?})` | One part → `BufferGeometry` (pivot at local origin). |
| `buildModelObject(model, material, {castShadow?,receiveShadow?,cull?})` | `Object3D` hierarchy (one `Mesh` per part; `userData.parts[name]`). |
| `bakeModel(writer, model, matrix, {cull?})` | Bake all parts of a model into one `GeoWriter` under a world matrix. |

Vertex layout (24 B/vertex): `position` f32×3 · `normal` i8n×4 · `aColor`
u8n×4 (sRGB rgb + per-box random) · `aMat` u8n×4
(roughness, metalness, `emissive / EMISSIVE_RANGE`, `fx | stone*32 | ground*64 | dry*128`).

## Deviations from the JS original

None that affect runtime behaviour. The mechanical translation edits are:

- **Type annotations only.** Every JSDoc `@param`/`@type` in the original
  became a real TS type. Named-only exports (no `export default`), relative
  imports end in `.js`. No behavioural change.
- **`MatPreset` widened once at the seam.** The JS `MAT.rock` and friends
  have varying keys (`{ rough, metal, stone }` vs `{ rough, metal, emissive, fx, dry }`);
  the port declares `MatPreset` with every field optional so both preset
  entries and inline literals fit. `matOf` still returns whichever record is
  passed in, so callers observe the same values.
- **`_alloc`'s "grow via `Old.constructor`" trick** was split into four
  typed helpers (`Float32Array`, `Int8Array`, `Uint8Array`, `Uint32Array`)
  because TS cannot express "new instance of the same typed-array kind"
  without `any`. The runtime effect is identical (new buffer, copy prefix).
- **Object3D `userData` access uses `userData['rest'|'parts'|'model']`**
  because index signatures on `Record<string, unknown>` fail dot access
  under strict mode. Same shape at runtime.
- **Diffed line by line against `vendor/afterburn/src/voxel/{kit,palette,mesh}.js`**;
  no formulas, constants, table entries or byte offsets changed.
