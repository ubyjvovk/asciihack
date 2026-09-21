# AFTERBURN — Architecture & contracts

Stack: **three.js r185 `three/webgpu` + TSL**, Vite, plain ES modules (no TypeScript, no framework), HTML/CSS overlay UI,
WebAudio. No runtime network access: everything (fonts included) is local. Read `docs/GDD.md` and `docs/ART_BIBLE.md` first.

```
index.html  viewer.html  ui.html  audio.html      entry pages (game · model viewer · UI harness · audio harness)
src/main.js                                        boot + game loop
src/render/   renderer.js pipeline.js moods.js materials.js   (weather.js particles.js later)
src/voxel/    kit.js palette.js mesh.js            (terrain.js rig helpers later)
src/models/   one file per model (see §2)
src/world/    layout.js world.js setpieces/*
src/game/     player, companion, camera, nav, interact, script runner, quests/*
src/ui/       index.js + components + ui.css  (see §4)
src/audio/    index.js + parts               (see §5)
src/content/  all player-facing text          (see §6)
tools/        shot.mjs (screenshots/playtests) · readability.mjs (text lint)
```

## 0. Ground rules for everyone working here
- **Own your files.** Only create/edit the files your task names. Need a change elsewhere (kit, palette, pipeline)? Don't
  edit it — say so in your final report. Shared files are edited by the lead only.
- **Look at your work.** A dev server is already running at `http://localhost:5173` (do NOT start another, do not run
  `npm install`). Take screenshots with `node tools/shot.mjs "<path>" shots/<you>/<name>.png` and *open the PNG with the
  Read tool*. Iterate until it is genuinely good, not merely present. Check at least `studio`, `storm_night` and
  `after_rain_gold` moods. Keep your screenshots under `shots/<your-task>/`.
- No new npm dependencies without asking. No network fetches at runtime. No `git commit` (the lead commits).
- Code style: modern JS, small pure functions, JSDoc on exports, no dead code, no TODO placeholders in shipped paths.
- Coordinates: **X = east, Y = up, Z = south** (north is −Z). World unit = 1 m.

## 1. Voxel kit (`src/voxel/kit.js`, `palette.js`, `mesh.js`)
A model is plain data: named **parts**, each a list of axis-aligned boxes. `src/models/_demo.js` is the canonical example
— read it before writing a model.

```js
import { VoxelBuilder } from '../voxel/kit.js';
const b = new VoxelBuilder({ unit: 0.125, seed: 7, jitter: 0.05 }); // unit = metres per grid unit
b.box(x, y, z, w, h, d, color, mat?, {j?})   // min corner + size in units; fractions OK; color = palette key | 0xRRGGBB
b.voxel(x, y, z, color, mat?)
b.fill(x0,y0,z0, x1,y1,z1, (x,y,z) => color | [color, mat] | null, step?)   // per-voxel; X-runs are merged
b.shell(x,y,z,w,h,d, t, color, mat, open?)     // hollow box; open ⊂ ['top','bottom','n','s','e','w']
b.line(ax,ay,az, bx,by,bz, s, color, mat)      // stair-stepped strut/cable
b.blob(cx,cy,cz, rx,ry,rz, s, (x,y,z,t) => …)  // noisy stepped ellipsoid (rocks, bushes, mounds)
b.at(dx,dy,dz, fn)  b.rotY(quarters, fn)  b.mirrorX(fn)  b.bothX(fn)  b.bothZ(fn)  b.stamp(fn, x,y,z, quarters)
//   transforms nest innermost-first: b.at(5,0,0, () => b.bothX(() => …)) mirrors about x = 5.
b.part('lid', { pivot: [5, 9, 0], parent: 'root' })  …boxes…  b.root()   // moving parts, pivot in units
b.anchor('hand', x, y, z)                      // named point (game attaches items, prompts, particles)
b.light({ x, y, z, color, intensity, distance, flicker })   // request a real point light (≤ 3 per model, prefer 0–1)
b.range(a,b) b.int(a,b) b.chance(p) b.pick(arr) b.noise(x,y,z,scale) b.fbm(...)    // seeded → deterministic
return b.build('name');   // → { name, unit, parts[], anchors{}, lights[], bounds{min,max}, boxCount }
```
Colours: use **palette keys** (`'hull0'`, `'moss1'`, … see `palette.js`) wherever one fits. Materials: preset names from
`MAT` (`'rock' 'metal' 'paint' 'glass' 'lamp' 'led' 'ember' 'glow' 'leaf' …`). `leaf` sways in wind; `lamp/led/ember/glow/
crystal` are emissive with built-in flicker/pulse/twinkle. Need a colour or preset that doesn't exist? Use a literal
(`0x…` / `{rough, metal, emissive, fx, dry}`) and list it in your report so the lead can promote it to the palette.

Rendering side: `buildModelObject(model, material)` → `Object3D` with `userData.parts[name]` (pivoted `Object3D`s you
can rotate/move for animation). `bakeModel(writer, model, matrix)` bakes static scenery into world chunks.

## 2. Model modules (`src/models/<name>.js`)
```js
export const meta = { name, about, variants?: {...} };
export function build(opts = {}) → VoxelModel            // deterministic; opts select states/variants
export function animate(root, t, { anim, dt, ... })       // optional, procedural; must be cheap (no allocation)
// a file may export several builders:  export function buildCrate(opts) …  → viewer: ?model=props&fn=buildCrate
```
- Origin = centre of the footprint at ground level (y = 0 is the ground). Characters face **+Z** (toward the camera).
- Respect budgets (ART_BIBLE §2). Big flat areas = few big boxes; spend boxes on silhouette and small storytelling detail.
- States are options, not separate files: `build({ state: 'asleep' })`, `build({ power: true, hull: 'patched' })`.
- View it: `/viewer.html?model=<name>&fn=<export>&opts=<json>&mood=<mood>&az=35&el=28&anim=walk&t=0.4`
  (`window.__stats` reports boxes/parts/bounds; the screenshot tool prints it).

## 3. Render (`src/render/*`) — lead-owned
`createRenderer()` → WebGPU renderer · `createPipeline({renderer, scene, camera, sun, quality, look})` → MRT → SSGI → SSR →
god rays → TRAA → DOF → bloom → AgX → grade/vignette/grain · `Atmosphere` blends **moods** (sun, sky, fog, wetness,
puddles, glow, look) · `createVoxelMaterial()` is the one material for all voxels; global weather uniforms in `W`.

## 4. UI (`src/ui/*`) — HTML/CSS overlay, no framework
`createUI(rootEl, { audio })` → `ui`. All methods are safe to call any time. Anything returning a Promise resolves when
the player is done with it. While any modal is open `ui.isBlocking()` is true and the game ignores movement input; the UI
handles its own keys (`E`/`Space`/`Enter`/click advance · `Esc` closes where allowed).
```js
ui.hud.show(bool)
ui.hud.setPlace({ region: 'CRASH SITE / 01', title: 'The Long Scar', sub: 'STORM · NIGHT' })
ui.hud.setObjective(text | null)                       // one short readable line; animates on change
ui.hud.setCompanion({ name, tag, line, mood } | null)  // bottom-left card (Pip); mood ∈ 'happy'|'sad'|'curious'|'sleepy'
ui.hud.setPrompt({ key: 'E', verb: 'Read', title: 'the sign', sub? } | null)   // bottom-centre interact prompt
ui.hud.setHints([{ keys: ['W','A','S','D'], label: 'Move' }, …])
ui.hud.toast({ kind: 'note'|'item'|'quest'|'info', title, text?, ms? })
ui.hud.flashSaved()
ui.map.update({ player: {x, z, yaw}, pois: [{ id, x, z, label, known, done }], bounds: {minX, maxX, minZ, maxZ} })
ui.dialogue.say({ who, text, tier?, mood? }) → Promise        // who ∈ 'PIP' | 'SHIP' | 'ADA' | '' (narration)
ui.dialogue.choose({ who, text, options: [{ id, label }] }) → Promise<id>
ui.note.open({ kind: 'paper'|'terminal'|'sign'|'tag'|'card', title?, body: [paragraphs], signed? }) → Promise
ui.checklist.open({ title, items: [{ id, label, state: 'ok'|'bad'|'work', detail? }] }) → Promise
ui.inventory.set(items)                                 // [{ id, name, icon?, count? }] → satchel strip in the HUD
ui.keypad.open({ digits, title, check: (code) => boolean }) → Promise<boolean>
ui.steps.open({ title, intro?, controls: [{ id, label, kind: 'valve'|'lever'|'button'|'switch', color? }], check: (sequence) => 'ok'|'wrong'|'more' }) → Promise<boolean>
ui.dial.open({ title, min, max, target?, labels? , check }) → Promise<number|null>
ui.journal.open({ notes: [...], cards: [...], sketches: [...] }) → Promise
ui.title.show({ hasSave }) → Promise<'new'|'continue'>      ui.pause.open(settings) → Promise<settings>
ui.nameEntry.open() → Promise<string>
ui.fade(toOpacity 0..1, ms) → Promise     ui.letterbox(bool)     ui.caption(text | null)   // big centred story line
ui.isBlocking() → boolean
```
Reading text is BIG (ART_BIBLE §7). Text reveals word-by-word; first press completes the line, second advances.

## 5. Audio (`src/audio/*`) — WebAudio, fully synthesised (no sample files)
```js
const audio = createAudio();  audio.unlock()            // call on first user gesture
audio.setMood(moodName, seconds)   audio.setProgress(0..1)   // ambience + music follow story
audio.sfx(name, { volume?, pitch?, pan? })              // see list in src/audio/index.js
audio.speak(who, text)                                  // Pip/SHIP talk-blips paced to the text reveal
audio.setEmitters([{ id, kind: 'fire'|'hum'|'drip'|'stream'|'wind'|'sparks', x, z, radius, volume }])
audio.setListener(x, z)      audio.setVolumes({ master, music, sfx, ambience })     audio.thunder(distance01)
```

## 6. Content (`src/content/*`)
All player-facing text lives here, keyed by id, tagged with a tier (GDD §5). `node tools/readability.mjs` must pass.
Quest code refers to ids only. No text literals in game code.

## 7. Debug / automation hooks
`/index.html?dev=1&tp=<poi>&mood=<mood>&q=<quality>&nohud=1&skip=<checkpoint>` · `window.__game` exposes
`tp(x,z)`, `setMood(name,secs)`, `flag(name,val)`, `give(item)`, `press(key)`, `state()`; `window.__ready` when playable.
`tools/shot.mjs --script file.mjs` drives scripted playtests (`export default async ({page, shot, sleep}) => {…}`).

## 8. World query interface (`src/world/*` — lead-owned; game code depends only on this)
```js
world.bounds                      // { minX, maxX, minZ, maxZ } playable area (≈ −72…72)
world.heightAt(x, z) → number     // ground/platform top in metres at a point
world.walkable(x, z) → boolean    // false for water, steep steps (> 0.5 m), props, walls, out of bounds
world.surfaceAt(x, z) → 'rock' | 'sand' | 'moss' | 'metal' | 'wood' | 'water' | 'mud'   // footsteps, splashes
world.nav                         // { cell: 0.5, cols, rows, originX, originZ, blocked: Uint8Array(cols*rows) } for A*
world.pois                        // { [id]: { x, z, y, yaw, radius, place? } } named spots quests refer to
world.placeAt(x, z) → { id, region, title } | null      // which named place the player is in (HUD header)
world.setBlocked(x0, z0, x1, z1, blocked)                // quests open/close paths (doors, gates)
```
Game systems must work against any object with this shape (there is a flat stub in `src/game/dev/stubWorld.js`).

## 9. Character animation params (shared by pilot, Pip, critters)
`animate(root, t, p)` with `p = { anim, dt, speed /* m/s */, phase /* radians, advanced by distance walked so feet never
slide */, k /* 0..1 progress of one-shot anims */, expr /* face/eye expression */, carry /* bool */, headYaw, headPitch }`.
Looping anims: `idle`, `walk`, `jog`, plus character-specific ones. One-shots are driven by `k`. Must not allocate per frame.
