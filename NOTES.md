# Big Mountain Shooter

_The studio's living memory of this game. Whoever builds here keeps it current — the pitch, the
key decisions and why, and the current state (features, known issues). A newcomer should
understand the game from this file alone. It is injected into every conversation about this
game, so decisions written here survive any chat window._

## Pitch

In the user's words: "a multiplayer first person shooter video game we can sell on Steam … first
rate graphics, body movement and first person movement … a skiing and snowboarding game (players
can choose which one they'll be) … a variety of awesome guns just like COD … a beautiful big
mountain to ski on with amazing courses and trees and jumps … like you're skiing an even larger
and doper Steamboat … and you have to shoot at each other while skiing and doing jumps."

Visual bar: `references/image-7552600d.jpg` (the user's mock-up): golden-hour low sun front-right,
jagged snowy peaks across a wide valley, snow-loaded spruces, a branded park kicker + red rails,
orange safety netting, a chairlift; first person with skis below, a ski pole in the left glove and
an M4 with a holo sight in the right; enemies in bright jackets/helmets/goggles/backpacks mid-air
shooting. HUD: BLUE TEAM score | clock | score RED TEAM top-centre, north-up circular minimap
top-left, kill feed top-right, team roster with health bottom-left, km/h + weapon/ammo
bottom-right, trick popups ("BACKFLIP +500").

## Decisions

- **Engine: three.js r185 (vendored), WebGL2, plain ES modules, no build.** Ships to Steam later by
  wrapping in Electron/Tauri (+ steamworks.js); multiplayer later via Genex multiplayer on the web
  draft or a dedicated server (see Roadmap). The sim is already input-struct driven per fixed step
  so it can be made server-authoritative.
- **Mode: Team Deathmatch, Blue vs Red, 6v6 (you + 5 bots vs 6 bots)**, first to 50 or most after
  10:00. Everyone drops in at the summit; respawns land just uphill of the median fight position
  away from enemies; reaching the base (or leaving bounds) "rides the lift" back to the summit.
- **Controls:** W tuck/push, S brake (hockey stop), A/D carve, SPACE hold-to-preload then release
  to pop. In the air A/D spin and W/S flip — but only after a FRESH press post-takeoff (so holding W
  into a jump doesn't auto-flip). Mouse aims independently of the skis (you can shoot sideways or
  behind while bombing down). LMB fire, RMB/E aim down sights, SHIFT hold breath on the scope,
  R reload, 1/2/Q/wheel swap, TAB scoreboard, M mute, −/= mouse sensitivity, [ ] field of view
  (vertical, saved in localStorage with the sensitivity), BACKSPACE redeploy
  (ride the lift back up). Tucking lowers the gun (low ready); firing/aiming raises it first.
- **Simulation at a fixed 120 Hz** (`fixedStepMs = 1000/120`); visuals (camera, viewmodel, fx,
  HUD) run once per rendered frame with dt = simulated time advanced, fed by a queue of sim events
  (shot/hit/kill/land/grind…), so feel is smooth at any frame rate and the sim stays deterministic.
- **Feel is springs** (`src/core/spring.js`): viewmodel recoil/sway/body-lag/mag-slap/raise,
  camera punch + FOV kick per shot, trauma² noise shake, landing compression. Per-weapon recoil
  patterns (first shots climb, then drift), hit flinch, sniper sway with a breath meter.
- **Feedback language (COD-like):** outlined dynamic crosshair (red over enemies), hitmarkers
  (gold for heads, kill-X), medals with icons (First Blood, Headshot, Longshot, Airborne,
  Skyfall, Revenge, Buzzkill, Double/Triple, streaks, Perfect Pop, tree/wipe-out kills…), rim
  light + red flash on hit riders, helmet "ping" (sparks + chips + metallic tick) on headshots,
  jacket feathers on body hits, nameplates (teammates, aimed/tagged enemies), ragdoll-ish corpses
  that slide and settle, death card (killer, weapon, distance, headshot, their HP), kill cam that
  rises off your body and zooms onto your killer (world desaturates, their tag enlarges), a drone
  flight up the mountain when you ride the lift that lands exactly on your eyes (no cut), a cool
  shimmer on spawn-protected riders, suppression (near misses close the vignette in).
- **World is one deterministic landscape function** (`src/world/mountain.js`): the 2 × 3 km
  playable mountain (4 m heightfield) + a 26 km far ring (valley + 3 km-high ranges). Runs are
  splines cut as smoothed corridors with a guaranteed ≥5 % downhill grade. Map seed fixed (the
  mountain is a designed map); the run seed drives bots/spawns.
- **Look:** golden-hour sky shader (sun SW, 11.5° elevation), PMREM env from the sky, ACES in a
  final pass at exposure 0.62, bloom only above 2.2 HDR, height + sun-scattering fog written into
  three's fog chunks (warm toward the sun), baked sun-visibility map for ridge shadows and long
  distant tree shadows, 4096 realtime shadow map following the player. Snow shader: world-space
  two-scale normals, corduroy on groomers (fades by fwidth), rock on >45° faces, sun glitter.
- **Trees:** instanced snow-loaded spruces (stacked alpha-tested branch skirts, snow on the top
  faces) in 3 LODs refilled per 128 m cell; collision grid for riders and bullets.
- **Physics** (`src/game/rider.js`): point rider + ski heading; edges rotate velocity toward the
  skis up to a carve limit (excess = skid = braking); a progressive edge angle (keys build and
  release the edge, quick edge changes at speed unweight); drag caps ~75 km/h upright / ~100
  tucked; powder slows you. Kickers/boxes/rails are analytic height bumps on the terrain, so mesh
  == physics. Popping within ~2.5 m of a kicker's lip = PERFECT POP (×1.45). Landings: clean,
  SKETCHY (scrub speed) or wipe-out. Riders collide with each other (hard hits send both flying).
- **Grinds:** boxes and rails have packed-snow feed ramps; a jib under you while travelling along
  it (±50°) locks you on (0.6 m magnet from the air), gravity + friction act along its straight
  top line (shared by mesh and physics), you leave off the end or with a jump. Lined up = 50-50,
  across = BOARDSLIDE/SLIDE, "270 ON" if you spun onto it; points by distance. Sparks on rails.
- **Weapons** (`src/game/weapons.js`): hitscan, COD-like TTKs; AR, SMG, shotgun (9 pellets, per-
  shell reload), sniper (4.2× scope overlay), pistol secondary. Head ×1.4–2.2.
- **Assets:** local Blender (free). The exporter keeps only static meshes (no empties, no
  parenting, no armatures), so guns carry tiny "Marker" meshes (Sight/Muzzle/GripL/Eject) and
  riders are rigid parts placed per frame by procedural IK (`src/game/riderView.js`). Paths of the
  exported GLBs live in `src/assetManifest.js` (each export is its own job folder). Riders' multi-
  material parts are merged into one vertex-coloured mesh per part (per-vertex roughness/metal in
  an `aPbr` attribute) — draw calls ~900 → ~110–410. Genex credits: one recorded rifle shot was
  generated (`assets/genex/5b611718…`, came out at −42 dBFS; `assets/audio/rifle-shot.wav` is it
  normalised +38 dB and trimmed); credits are now ~1, so every other sound is synthesised.
- **Audio** (`src/audio/`, see its README): a procedural WebAudio engine, deterministic (seeded
  LCG). Every one-shot is an offline render cached after `start()` (rendered in a module worker):
  layered gunshots (supersonic crack + muzzle blast + body + thump + action foley; the recorded
  rifle sample becomes the core layer once loaded, gain-staged to AR −6 dBFS), impacts, foley,
  hitmarkers, UI. A voice manager (40 voices, quiet-first stealing, per-rider caps) plays them;
  distance = speed-of-sound delay + air low-pass + HRTF panner + a valley convolution reverb that
  dominates at range. Ducking: your shots duck beds/music, hitmarkers duck weapons. Beds: wind,
  carve, skid, powder, air, rail grind, chairlift, ambience; music per phase (menu/match/results);
  the lift flight drives the wind bed from the camera's speed. Master compressor + soft clip.
  Dev tools: `node .studio/audio-dev/stress.mjs` (budget/leak test), `levels.mjs` (level report),
  `browser.html` (offline render check in a real browser).
- **Post chain:** MSAA HalfFloat target with a depth texture → world → screen-space god rays
  (quarter res, radial march from the sun over sky depth) → viewmodel pass (own depth clear) →
  bloom → final (ACES, split toning, vignette, speed radial blur, damage edges, scope mask, lens
  flare + sun-lit lens dirt, snow clumps on the goggles after wipe-outs/powder landings, edge
  chromatic aberration, a halo-free unsharp mask in Reinhard space, low-health desaturation).
- **UI:** everything via `__studio.hud` with a diffing layer (`src/ui/gamehud.js`) so the overlay
  only repaints when a readout changes.

## Current state

Playable end to end: title → loadout (skis/board + AR/SMG/shotgun/sniper; pistol secondary) →
3-2-1 at the summit gates → TDM match → results → next match. Bots ski their runs, hit kickers
(skilled ones spin), spot enemies with real line of sight, react, track with decaying aim error
and burst-fire; stuck bots ride the lift. Tricks score (180/360/540/720…, flips 500, combos +250,
grinds by distance) with popups and a live trick/grind readout; bad landings and trees/lift
towers wipe you out (and can kill).

World: 2 × 3 km mountain (5 runs incl. a terrain park with 3 table-top kickers, a rail and two
boxes with feed ramps, and 4 more kickers on other runs), 44k instanced snow-loaded spruces +
~40k billboard spruces in the valley, a working chairlift, orange netting, bamboo markers, trail
signs, team start arches, a timber base lodge, a 26 km landscape of 3 km-high ranges (alpenglow on
the high peaks) across a wide valley. Golden-hour sky + baked ridge/tree shadows + realtime
shadows + god rays, diamond-dust glints, ski spray and powder roost, powder bursts, bullet impacts
(snow chunks + haze, tree snow-dumps, jacket feathers, metal sparks), tracers, muzzle flashes and
smoke, ejected shells, ski tracks that fade over a minute. Particles are lumpy, top-lit puffs that
fade right in front of the lens.

Gun feel: Blender guns with working parts (mags, pump, bolt, slide), full reload choreography
(the pole hand comes off to swap the mag), recoil patterns + springs, muzzle flash/smoke/shells,
low-ready when tucking, ADS that lines up the optic, scope sway + hold breath.

Models (local Blender, scripts in `assets/src/`, exact paths in `src/assetManifest.js`):
- Guns (6.8k–23k tris each): `gun-ar` M4 + EOTech-style holo, `gun-smg` (red dot, foregrip),
  `gun-shotgun` (pump moves, side-saddle shells), `gun-sniper` (arctic chassis, 34 mm scope, bolt
  lifts/racks after each shot), `gun-pistol` (slide kicks). Markers: Sight (ADS aligns it to the
  screen centre), Muzzle, GripL (left hand / bots' support hand), Eject; moving parts Mag, Pump,
  Bolt, Slide, ChargingHandle. Origin = right-hand grip; barrel +Y in Blender (−Z in three).
- Rider body: 16 rigid parts pivoted at joints (Pelvis, Torso, Head, Backpack, UpperArm/Forearm/
  Hand L/R, Thigh/Shin/Boot L/R); materials Jacket/Pants/Helmet/GoggleLens are tinted per rider.
- Gear (`rider-gear` export): skis, snowboard, ski pole, first-person gloves (procedural fallbacks
  in `viewmodel.js` if it fails to load).

HUD (like the reference): team score + progress bars + clock, north-up trail-map minimap with a
view cone (teammates always, enemies when spotted or firing; dots are one path per team so they
nest inside the map), kill feed with gun icons (+ gold skull for headshots), team roster with
health, km/h, weapon/ammo with round pips, outlined dynamic crosshair, hitmarkers, damage arcs,
medals, trick popups, live air/grind readout, reload prompt, breath meter, holo and scope
reticles, TAB scoreboard, death card; gameplay readouts step aside while dead / on the lift.
Title: logo lockup (mountain mark, BIG MOUNTAIN, gold-ruled SHOOTER) on a soft plate. Results:
tables + MATCH MVP / TOP SHREDDER / YOUR MATCH cards (best streak, medals).

Perf (960×600 preview): ~60 fps, ~1.5 M triangles, ~110–410 draw calls, boot ≈ 1–2 s.

Studio hooks: cameras `title summit run park overview valley trees fp chase bot boarder lift menu
loadout results jumpside jumpfp jumpfpclean jumptrick jumpads jumpreload jumpfight jumpdeath
jumplift jumpgrind jumpgrindside jumpgrindboard jumpsplat jumpgun-{smg,shotgun,sniper,pistol}`
(named views stick until reset/begin/input; jump* run a demo first or start from a fresh living
player), demos `jump trick carve fight firefight lift death grind`, probes `phase player match
render assets audio lastDemo` (`audio` = mixer stats: voices, drops, steals, errors, music).

## Known issues / next

- Far-terrain forest outside the domain is billboards + painted texture (fine from afar).
- Bots hold guns two-handed even on skis (the player holds a pole in the left hand).
- Only some skilled bots (even ids) line up for the rails/boxes; others ignore them.
- Audio was verified by measurement (levels, budgets, distance delays, headless-Chromium renders)
  but not yet tuned by ear: start with `GUNS[w].smix` / `sample.maxDur` in `src/audio/sounds.js`
  for the recorded rifle layer. Everything but the rifle shot is synthesised (Genex credits ≈ 1).
- No grenades/killstreaks yet; no real networking yet (bots only).

## Roadmap to Steam

1. Feel + looks (this build). 2. Real multiplayer: Genex multiplayer for web playtests; for Steam a
dedicated authoritative server (Node + WebSocket/WebRTC) or Steam Networking via steamworks.js.
3. Progression (unlocks, attachments, cosmetics), more maps/modes (Drop-In race-deathmatch,
King of the Mountain). 4. Electron/Tauri wrapper, Steamworks (achievements, lobbies), store page.
