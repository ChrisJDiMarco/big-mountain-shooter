# Audio

Procedural WebAudio engine for Big Mountain Shooter. No files, no npm packages, deterministic
(constant-seeded LCG, never `Math.random`). The only optional asset is a recorded rifle shot
loaded via `loadSample("rifle", url)`.

| File | What |
| --- | --- |
| `audio.js` | `createAudio()` — the public API (every method guarded: a no-op before `start()`, never throws) |
| `engine.js` | context, mix graph, voice manager (budget/stealing/cleanup), speed-of-sound queue, listener, ducking, sample + bank caches |
| `loops.js` | continuous/scheduled sound: motion beds, chairlift, ambience, music, heartbeat |
| `sounds.js` | the sound bank: every one-shot designed as an offline render (gun layers, foley, impacts, UI, IR…) |
| `dsp.js` | offline DSP toolkit (SVF/biquad filters, modal partials, N-wave, Friedlander blast, grains, envelopes) |
| `bankWorker.js` | module worker that renders the bank off the main thread after `start()` |
| `.studio/audio-dev/` (repo root) | `stress.mjs` (node: budget/leak test on a fake AudioContext), `levels.mjs` (node: offline level report), `browser.html` (serve the repo, open it: renders scenarios through the browser's real Web Audio offline and measures them) |

## Integration

```js
const audio = createAudio();
audio.loadSample("rifle", "assets/audio/rifle.wav"); // optional, any time (decodes before start())
// on any key/click:
audio.start();
// every frame, after the camera is updated (also drives the internal scheduler):
audio.setListener(camera);
// every frame while the player is alive and riding; otherwise silenceMotion():
audio.motion({ speed, grounded, edge, skid, kind, air, powder, grinding }, dt);
```

Event mapping suggestions (game → audio):

| Game | Call |
| --- | --- |
| `shot` by you / by a bot | `shot(def.id, null)` / `shot(def.id, muzzleOrRiderPos, { id: agentIndex })` (`id` lets the budget cap each rider at 3 overlapping reports) |
| `res.impacts[]` | `impact(im.kind, im)` — `"flesh"`/`"tree"`/`"snow"` are understood, plus `"metal"`; pellet clusters are merged |
| `whiz` | `whiz({ x, y, z })` |
| `hit` (attacker = you) | `hitmarker(kill ? "kill" : part === "head" ? "head" : "body")` (9 pellets in one frame = one tick) |
| `hit` (victim = you) | `hurt(amount)` · low health: `heartbeat(health < 30)` |
| `kill` by you / of you | `killConfirm()` / `death()` · respawn: `respawn()` |
| `medal`, streaks | `medal()`, `streak()` |
| `land` / `crash` / `tree` | `land(impact)` / `crash()` / `treeHit()` |
| viewmodel `onCue(name, id)` | `"equip"` → `equip(id)`; `magOut magIn bolt slide pump shell chamber` → `reload(id, name)` |
| ADS start / end, empty trigger | `adsIn()` / `adsOut()`, `dryFire()` |
| countdown 3-2-1, `go` | `countdown(n)` (n ≤ 1 is the high final beep), `go()` |
| riding the lift | `liftHum(true)` … `liftHum(false)` |
| title/loadout · match · results | `music("menu")` + `ambience(true)` · `music("match")` · `music("results")` |
| M key / options | `toggleMute()`, `setVolume(0..1)` (perceptual: gain = v²) |

`shot()` includes the per-shot action (AR/SMG bolt-carrier clack, pistol slide, sniper action
ring, shotgun receiver clunk). The manual cycles — sniper bolt and shotgun pump — come from the
viewmodel's `bolt`/`pump` cues via `reload()`. The old calls `shot(kind, dist, pan)`, `tick(kill)`
and `beep()` still work (deprecated) so the game keeps sounding until it is rewired.
`stats()` returns voices, queue, drops/steals, live loop sources and music state for probes.

## API

`start()` · `ctx` · `analyser()` · `toggleMute() → muted` · `muted` · `setVolume(v)` ·
`loadSample(name, url) → Promise<boolean>` · `setListener(camera)` · `motion(state, dt)` ·
`silenceMotion()` · `shot(weaponId, pos|null, opts)` · `whiz(pos)` · `impact(kind, pos)` ·
`hitmarker(kind)` · `killConfirm()` · `medal()` · `streak()` · `land(impactSpeed)` · `crash()` ·
`treeHit()` · `reload(weaponId, phase)` · `dryFire()` · `equip(weaponId)` · `adsIn()` · `adsOut()` ·
`hurt(amount)` · `heartbeat(on)` · `death()` · `respawn()` · `ui(kind)` · `countdown(n)` · `go()` ·
`liftHum(on)` · `ambience(on)` · `music("menu"|"match"|"results"|"off")` · `stats()`

Weapons: `ar smg shotgun sniper pistol` (`rifle` = `ar`). `shot` opts: `{ id, gain }`.
Positions are any `{x, y, z}` (copied, so reused vectors are fine). The camera is read without
importing three: `camera.position` (or `matrixWorld` translation if parented) and the
`matrixWorld` basis (forward = −Z column, up = Y column).

## Mix

```
voices ─► bus weapons │ impacts │ motion │ ambience ─► duck ─► world ─► worldLP (death/hurt muffle) ─┐
sends  ─► HP 140 / LP 5.2k ─► Convolver (3.6 s valley IR) ─► return ──► world                      │
voices ─► bus ui │ player │ music ─► duck ────────────────────────────────────────────────────────────┤
master (volume·mute) ─► DynamicsCompressor (−10 dB, 3:1, knee 6) ─► soft clip (WaveShaper 2×, ±0.98 ceiling) ─► Analyser ─► out
```

- **Gunshots** are layered renders: crack (supersonic N-wave + Friedlander muzzle blast + gas
  sizzle + muzzle-device ring), body (swept band-pass "bark" + low blast + 2–4 kHz "snap",
  saturated), thump (pitch-dropping low punch), close stereo tail, action foley; sniper adds a
  rolling ridge echo, shotgun (with the sample) a low boom. 3/3/2/2/2 variants + ±3 % pitch.
  With the `rifle` sample loaded it becomes the core layer (rate ar 1.0 · smg 1.12 · pistol 1.22 ·
  shotgun 0.82 · sniper 0.74, per-weapon filter, onset-trimmed, peak-normalised) under the
  synth crack/thump. **Gain staging:** the own-shot layer sum is measured at load and scaled so
  its peak is AR −6 dBFS (SMG −7.5, pistol −8, shotgun −4.5, sniper −4) at the master input.
- **Levels** (peak dBFS at the master input): hitmarker body −12 / head −10.5 / kill −9 (they
  out-weigh gunfire by 7–20 dB in their critical band and duck weapons −5 dB), UI −22…−18,
  countdown −15/−13, go −10, foley −27…−12, impacts −18…−13 at 8 m, whiz −9. Beds (RMS): wind
  −36 (8 m/s) … −22 (30 m/s), carve ≈ −28, hockey stop ≈ −24, menu pad ≈ −31, ambience ≈ −35.
  Your shots duck motion −5, ambience −6, music −8 dB. Run `node .studio/audio-dev/levels.mjs`.
- **Space:** world sounds use an HRTF `PannerNode` (inverse, ref 8 m, rolloff 1, max 2 km) after a
  per-voice air low-pass (16 kHz near → 1.5 kHz at 400 m), start `distance / 343` s late, and send
  to the valley reverb with `wetGain(d)` — the echo sits ≈ 22 dB under the dry at 8 m, level at
  ~150 m, and dominates (+6…+11 dB) at 400–800 m. Distant shots also lose their crack (> 90 m)
  and thump (> 40 m) layers.

## Budget and cleanup

At most 40 one-shot voices (a voice = one event: 1–6 BufferSources → gain → [LP → panner]);
beyond that the lowest (loudness × age-decay) voice is faded out in 20 ms, or the newcomer is
dropped if it would be the quietest. Hitmarkers/UI are protected. Group caps: your gun 6 + 2 tails,
3 per rider (`opts.id`), 3 whizzes, 10 impacts. Delayed (distant) events wait in a ≤ 48-entry
JS queue and only become nodes 120 ms before they sound. Every source's `onended` disconnects
its voice's nodes; a reaper disposes anything 1 s past its end. Loop sources stop after a few
silent seconds. `node .studio/audio-dev/stress.mjs` drives 2+ minutes of 12-rider play plus a
point-blank flood and asserts the budgets every frame and a full return to the persistent graph.

## Notes

- One-shots are rendered once and cached (~17 MB of AudioBuffers; band-limited material uses
  8–32 kHz buffers). Rendering happens in `bankWorker.js` after `start()`; without module workers
  it falls back to ~3 ms slices per frame, and anything needed sooner renders on demand.
- Every buffer starts and ends at exactly 0 and every live gain moves with `setTargetAtTime` or
  ramps from its current value, so nothing clicks; loops are seamless crossfaded renders.
- Lowpass/highpass `Q` on live `BiquadFilterNode`s is in dB (WebAudio semantics).
- Options: `createAudio({ hrtfMaxDistance: 150 })` pans voices beyond 150 m with cheap
  equal-power instead of HRTF if a heavy firefight ever costs too much CPU (default: all HRTF).
  `{ worker: false, autoTick: false }` are for tests.
