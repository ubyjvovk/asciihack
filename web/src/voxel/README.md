# web/src/voxel

Voxel construction kit and mesher.

Ported from `~/afterburn` commit `8492a00` (2026-09-20), original files
`src/voxel/{kit,palette,mesh}.js` (vendored at `vendor/afterburn/src/voxel/`
in this repo for reference). This is a **behaviour-identical** TypeScript
port: same mulberry32 RNG constants, same `noise3`/`fbm3` formulas, same
`PAL`/`MAT`/`FX` tables, same 24 B/vertex layout and same byte quantisation
in `GeoWriter`. **AsciiHack owns this copy and may edit it freely** — unlike
`web/src/asciicity/`, which stays in sync with its upstream.

See `docs/gpu-voxel.md` for the API table and the small list of deviations
from the JS original.
