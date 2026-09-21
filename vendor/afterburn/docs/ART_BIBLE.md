# AFTERBURN — Art Bible

Reference for the production bar: `afterlight.mp4` (repo root, not committed). Study it: low warm sun raking across
wet stone, cool teal shadows, lamp light pooling and reflecting in puddles, haze, shallow depth of field, grain,
and a calm thin-line HUD. We match that *level*, with our own world: a lonely alien valley after a crash.

## 0. Mood targets (concept art)
`docs/concept/key_art_night.png` (the opening: storm, fires, lantern) → `key_art_gold.png` (after the rain: low sun, mirror puddles,
warm cabin lights) → `key_art_starry.png` (the wonder beat: ringed giant, two moons, the valley glowing). Generated concept
paintings, not screenshots: they set the emotional and lighting targets and the **columnar basalt** character of Vesper.

## 1. The look in one paragraph
A miniature world built from **axis-aligned boxes of mixed sizes** ("voxel-ish", not a uniform grid), photographed
like a tabletop diorama with a long lens. Materials are physically plausible (rough rock, satin painted metal,
glass, water). Light does the storytelling: one strong key (fire, lantern, low sun), cool ambient fill, real soft
shadows, bounce light, reflections on wet ground. Mostly desaturated teal-slate world; **orange** (the pilot) and
**warm lantern light** (Pip, lamps) are the only saturated warm notes early on. Colour returns as the story warms.

## 2. Voxel rules
- World unit = 1 m. **Boxes only.** No spheres, cylinders or smooth curves; curves are stair-stepped.
- Grid sizes: terrain columns 0.5 m, height steps 0.25 m · structures 0.25 m · props 0.125 m · characters ≈ 0.08 m.
- Mixed scale is the charm: big calm slabs next to clusters of tiny detail (bolts, vents, moss crumbs, pebbles).
- Inside one model everything is axis-aligned. Whole props may be yawed freely when placed; big structures only
  in 90° steps (a crashed ship or fallen mast may be tilted — that *is* the story).
- Every surface gets subtle per-box colour jitter (±3–6 % lightness, tiny hue drift). Never flat fills.
- Break silhouettes: chipped corners, missing tiles, stacked offsets, overgrowth. Avoid perfect symmetry except on
  manufactured objects, and even those are dented/scorched after the crash.
- Emissive bits are tiny and meaningful: a lamp, an eye, a status LED, a glow-berry. Never large glowing slabs.
- Budgets: hero model (ship) ≤ 6 000 boxes · character ≤ 900 · prop ≤ 400 · small scatter ≤ 40.

## 3. Palette (sRGB hex; defined in `src/voxel/palette.js`)
| Family | Colours |
|---|---|
| Basalt / wet rock | `#1d2426` `#2a3437` `#35424a` `#46545a` |
| Slate / dry rock | `#56636a` `#6b777b` `#828c8c` |
| Ash sand | `#5c5b55` `#6f6c63` `#89857a` |
| Scorch | `#0e1112` `#1a1917` `#2b2521` ember `#ff6a2a` |
| Moss / lichen | `#4c5a36` `#6d7a4a` `#8f9a6b` lichen `#a9b59a` |
| Glow flora | stem `#2c4a4a` cap `#3f7f78` glow `#7ef0d0` berry-blue `#5aa0ff` berry-red `#ff5a4a` bloom `#e06aa8` |
| Sparrow hull | cream `#d8d2c4` `#bdb6a6` panel-grey `#8a8f8e` stripe-teal `#2f7d78` dark `#23292b` |
| Pilot | suit-orange `#d9622b` `#b84e20` helmet `#e9e4d8` visor `#1b2a33` strap `#3a3f42` |
| Pip | body-cream `#d9cfb8` worn `#b3a88f` brass `#a9823c` rubber `#2a2c2d` lantern-glow `#ffb45e` eye `#9ff5e0` |
| Outpost | wall `#8d8a7f` `#6f6d66` roof-rust `#8a4b2d` `#a25a34` frame `#3b4346` canvas `#b9ad8e` |
| Crystal | warm `#ff9d4a` `#ffc27a` cold `#6fc3ff` `#a8e0ff` |
| Practical light | lamp `#ffb060` fire `#ff8a3c` screen `#8fe8d8` |

## 4. Materials (per-box `mat` preset → roughness / metalness / emissive)
`rock 0.92/0` · `wetrock 0.55/0` · `sand 0.95/0` · `moss 1.0/0` · `paint 0.55/0.1` · `metal 0.4/0.85` · `brass 0.35/0.9`
· `rubber 0.9/0` · `glass 0.08/0 (+transmission look via dark tint)` · `plastic 0.5/0` · `fabric 0.95/0` · `crystal 0.15/0`
· `lamp` emissive 6–12 · `led` emissive 3–6 · `ember` emissive 4 (flicker) · `glow` emissive 2–5.
World wetness (rain) lowers roughness and darkens albedo on up-facing surfaces and forms puddles in low spots.

## 5. Moods (lighting states; defined in `src/render/moods.js`, blended over 10–25 s on story beats)
| Mood | Story | Key light | Fill / sky | Air | Feel |
|---|---|---|---|---|---|
| `storm_night` | start | cold moon through cloud, very low; lightning flashes | deep blue-teal, near black | heavy rain, thick haze, wet 1.0 | alone, small, cold; fires and the hand lamp are everything |
| `grey_dawn` | power on | soft overcast top-light | flat blue-grey | light rain → drizzle, mist | tired hope |
| `after_rain_gold` | hull fixed | **low warm sun, long shadows, god rays** | cool teal shadows, broken cloud | rain stopped, wet 0.8, puddles mirror the sky | the reference look; relief |
| `clear_evening` | engine fixed | lower, pinker sun | peach horizon, teal zenith, first stars | dry-ish, light haze, drifting spores | calm, proud |
| `starry_night` | radio sent | bright twin moons, cool rim light | star field, ringed planet, faint aurora | clear; **glow flora fully open** | wonder |
| `first_light` | launch | sunrise behind the ship | rose-gold | ground mist | joy, goodbye |

## 6. Camera & lens
Perspective, FOV ≈ 28–32°, pitch ≈ 38–46°, distance 22–34 m, follows the player with a soft spring. Depth of field
focused on the player, gentle (diorama, not mush). Subtle vignette, fine grain, AgX-style filmic curve, slight
teal-shadow / warm-highlight split-tone. Bloom only on true emitters. No chromatic aberration, no lens dirt.

## 7. HUD / UI
*"Instrument panel of a quiet ship."* Thin, calm, never cute-cartoony.
- Glass panels `rgba(10,18,21,.78)` + backdrop blur 14 px, hairline border `rgba(159,216,207,.18)`, 2 px radius,
  optional 1 px amber accent line on the leading edge.
- Colours: text-cream `#e9e4d8` · dim `#9aa7a5` · amber accent `#f2b267` · teal accent `#8fe8d8` · danger-soft `#e8836b`.
- Type: **Lexend** (reading text and headings; early-reader-friendly letterforms) and **JetBrains Mono** (tiny caps
  labels, tracking 0.18em). Reading text is BIG: dialogue 26 px, notes 24–28 px, line-height 1.5, ≤ 38 characters a
  line for T1–T2. Chrome labels can be small (11–12 px) — they are not required reading.
- Layout echoes the reference: logo + place name top-left; trail map top-right; note/toast top-centre; companion
  card bottom-left; interact prompt bottom-centre; hint bar + buttons along the bottom.
- Motion: 180–260 ms ease-out fades/slides; nothing bounces. Text appears word-by-word at a calm pace; click to complete.
- Notes look like what they are: Ada's notes = warm paper card with a handwriting-like but highly legible face
  (still Lexend for T1–T2; legibility beats flavour); SHIP = teal mono terminal card; signs = engraved plate.

## 8. Audio direction
Generative, quiet. Storm: rain, wind, far thunder, hull creaks, fire crackle. Music: sparse felt-piano-like notes and
warm pads, minor/dorian early → lydian/major late; a new layer joins with every repair. Pip: soft pitched blips per
word. UI: soft wood/glass ticks. Nothing harsh, nothing loud, no sudden stingers.
