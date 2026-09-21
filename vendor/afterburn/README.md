# `vendor/afterburn/` — read-only reference copy

Source material for the GPU render-path wave (`docs/gpu.md`). Copied from the
sibling project `~/afterburn` at commit **`8492a00`** (2026-09-20) with the
user's explicit permission ("copy code and resources from there freely").

It lives in the repo because **worker containers mount only this repository** —
`~/afterburn` is not visible to them, and a port written from a description
instead of the source is not a port (T-0037, attempt 1).

```
src/voxel/{kit,mesh,palette,pixelfont}.js   the voxel construction kit + mesher
src/render/{renderer,pipeline,materials,moods,weather}.js   the render stack
src/models/_demo.js                          the canonical model example
src/models/pilot.js                          the hero: a voxel humanoid, the base for ours
src/models/pip.js                            the lantern robot: a small companion
src/models/critters.js                       small creatures
src/models/body.js                           (from their src/game/) shared character rig/animation params
docs/ARCHITECTURE.md                         §1 voxel kit, §3 render contracts
docs/ART_BIBLE.md                            §2 voxel rules, §3 palette, §5 moods
tools/shot.mjs                               their headless screenshot tool
```

**Do not edit anything under this directory.** It is the reference the ports
are checked against; our copies live in `web/src/voxel/` and `web/src/gpu/`
and are ours to change. If something here needs fixing, fix it in
`~/afterburn` and re-copy.
