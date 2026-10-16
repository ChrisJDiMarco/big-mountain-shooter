/**
 * The match: Blue vs Red team deathmatch on the mountain. Owns the agents (the player + bots),
 * the flow (title → loadout → countdown → playing → results), spawning, the lift back to the
 * summit, damage/regen/kills, and wires input → rider physics → weapons → hits → events.
 *
 * Network-ready shape: every rider is driven by an input struct each fixed step (the player's
 * from the keyboard/mouse, bots' from their brains); the simulation only reads those.
 */
import { makeRng, clamp, wrapAngle } from "../core/noise.js";
import { makeRider, placeRider, stepRider, KIND } from "./rider.js";
import { makeLoadout, weaponStep, activeWeapon, WEAPONS, PRIMARIES, flinch } from "./weapons.js";
import { resolveShot, eyeOf } from "./combat.js";
import { makeBrain, assignTrail, botThink } from "./bots.js";
import { MAP } from "../world/mountain.js";

export const TEAM = {
  blue: { name: "BLUE TEAM", color: "#2f8cff" },
  red: { name: "RED TEAM", color: "#ff3b3b" },
};

const BLUE_BOTS = ["RidgeRunner", "TacoSlayer", "LiftLineLarry", "PowderHound", "GnarWhal"];
const RED_BOTS = ["SnowViper", "BorealGhost", "AlpineRage", "OrangeCrush", "YardSale", "Gaper99"];

export const SCORE_LIMIT = 50;
export const MATCH_TIME = 600;
export const RESPAWN_TIME = 4;
export const LIFT_TIME = 3.2;
const REGEN_DELAY = 4;

/** Player settings survive reloads (per-browser convenience; the game works without storage). */
function loadSettings() {
  const s = { sens: 1.0, fov: 74 }; // fov = vertical degrees (74 ≈ 106° horizontal at 16:9)
  try {
    const raw = globalThis.localStorage?.getItem("bms-settings");
    if (raw) {
      const v = JSON.parse(raw);
      if (Number.isFinite(v.sens)) s.sens = Math.min(4, Math.max(0.2, v.sens));
      if (Number.isFinite(v.fov)) s.fov = Math.min(90, Math.max(62, v.fov));
    }
  } catch {
    /* storage blocked: defaults */
  }
  return s;
}
function saveSettings(s) {
  try {
    globalThis.localStorage?.setItem("bms-settings", JSON.stringify({ sens: s.sens, fov: s.fov }));
  } catch {
    /* storage blocked: fine */
  }
}

export function createGame({ world, ground, park }) {
  const game = {
    phase: "title", // title | loadout | countdown | playing | results
    time: 0,
    phaseT: 0,
    rng: makeRng(1),
    agents: [],
    player: null,
    scores: { blue: 0, red: 0 },
    clock: MATCH_TIME,
    feed: [], // {killer, victim, weapon, killerTeam, victimTeam, t, headshot, how}
    popups: [], // trick / score popups {text, points, t}
    events: [], // per-step events for views/audio/hud
    choice: { kind: "ski", weapon: "ar" },
    ground,
    forest: world.forest,
    park,
    world,
    winner: null,
    keysPrev: new Set(),
    trickArm: { flip: false, spin: false },
    medals: [], // the player's recent medals {name, points, icon, t}
    firstBlood: false,
    settings: loadSettings(),
    toast: null, // {text, t}
  };
  game.physicsWorld = {
    ground: ground.ground,
    groundNormal: ground.groundNormal,
    snowFriction: ground.snowFriction,
    trees: world.forest,
    obstacles: [],
    kickerLip: park ? park.kickerLip : null,
    jibAt: park ? park.jibAt : null,
    terrain: ground.terrain,
  };

  function makeAgent(id, name, team, isPlayer, kind, weapon) {
    return {
      id,
      name,
      team,
      isPlayer,
      rider: makeRider(kind),
      lookYaw: Math.PI,
      lookPitch: -0.12,
      health: 100,
      alive: true,
      respawnT: 0,
      liftT: 0,
      invuln: 0,
      lastDamageT: -99,
      lastAttacker: null,
      loadout: makeLoadout(weapon),
      stats: { kills: 0, deaths: 0, score: 0, tricks: 0, streak: 0 },
      brain: null,
      hitFlash: 0,
      damageDir: null,
      killedBy: null,
    };
  }

  /** Summit start gates: blue drops from the west side, red from the east. */
  function startSpot(team, n) {
    const trails = world.mountain.trails;
    const t = team === "blue" ? trails.find((x) => x.id === "storm-bowl") : trails.find((x) => x.id === "ridge-runner");
    const p = t.path[Math.min(t.path.length - 1, 6 + n * 3)];
    const off = (n % 3) - 1;
    return { x: p.x - p.tz * off * 5, z: p.z + p.tx * off * 5, heading: Math.atan2(-p.tx, -p.tz) };
  }

  /** Respawn: spawn points along every run; pick one uphill of the action and away from enemies. */
  function respawnSpot(ag) {
    const trails = world.mountain.trails.filter((t) => t.path.length > 200);
    const alive = game.agents.filter((a) => a.alive && a !== ag);
    // Median progress of the fight (z), so respawns land just above it.
    const zs = alive.map((a) => a.rider.p.z).sort((a, b) => a - b);
    const mid = zs.length ? zs[Math.floor(zs.length / 2)] : MAP.summit.z;
    const wantZ = Math.max(MAP.summit.z + 30, mid - 180);
    let best = null;
    let bestScore = -Infinity;
    for (const t of trails) {
      for (let i = 4; i < t.path.length - 60; i += 25) {
        const p = t.path[i];
        let nearestEnemy = Infinity;
        let nearestFriend = Infinity;
        for (const a of alive) {
          const d = Math.hypot(a.rider.p.x - p.x, a.rider.p.z - p.z);
          if (a.team === ag.team) nearestFriend = Math.min(nearestFriend, d);
          else nearestEnemy = Math.min(nearestEnemy, d);
        }
        const score =
          -Math.abs(p.z - wantZ) * 0.5 +
          Math.min(nearestEnemy, 200) * 1.2 -
          (nearestEnemy < 60 ? 400 : 0) +
          (nearestFriend < 120 ? 40 : 0) +
          game.rng() * 30;
        if (score > bestScore) {
          bestScore = score;
          best = { x: p.x, z: p.z, heading: Math.atan2(-p.tx, -p.tz), trail: t };
        }
      }
    }
    return best;
  }

  function spawn(ag, spot) {
    placeRider(ag.rider, ground, spot.x, spot.z, spot.heading);
    ag.rider.v.x = -Math.sin(spot.heading) * 6;
    ag.rider.v.z = -Math.cos(spot.heading) * 6;
    ag.lookYaw = spot.heading;
    ag.lookPitch = -0.12;
    ag.health = 100;
    ag.alive = true;
    ag.invuln = 2;
    ag.lastDamageT = -99;
    ag.loadout = makeLoadout(ag.loadout.slots[0].def.id);
    if (ag.brain) assignTrail(ag, world.mountain.trails, game.rng);
  }

  game.reset = (seed) => {
    game.rng = makeRng(seed * 2654435761 + 12345);
    game.phase = "title";
    game.phaseT = 0;
    game.time = 0;
    game.scores = { blue: 0, red: 0 };
    game.clock = MATCH_TIME;
    game.feed = [];
    game.popups = [];
    game.medals = [];
    game.firstBlood = false;
    game.events = [];
    game.winner = null;
    game.agents = [];
    const rng = game.rng;
    game.player = makeAgent(0, "You", "blue", true, game.choice.kind, game.choice.weapon);
    game.agents.push(game.player);
    BLUE_BOTS.forEach((name, i) => {
      const kind = rng() < 0.4 ? "board" : "ski";
      const ag = makeAgent(1 + i, name, "blue", false, kind, PRIMARIES[Math.floor(rng() * PRIMARIES.length)]);
      ag.brain = makeBrain(rng, 0.35 + rng() * 0.5);
      game.agents.push(ag);
    });
    RED_BOTS.forEach((name, i) => {
      const kind = rng() < 0.4 ? "board" : "ski";
      const ag = makeAgent(10 + i, name, "red", false, kind, PRIMARIES[Math.floor(rng() * PRIMARIES.length)]);
      ag.brain = makeBrain(rng, 0.35 + rng() * 0.5);
      game.agents.push(ag);
    });
    placeAll();
  };

  function placeAll() {
    let nb = 0;
    let nr = 0;
    for (const ag of game.agents) {
      const spot = startSpot(ag.team, ag.team === "blue" ? nb++ : nr++);
      spawn(ag, spot);
      ag.rider.v.x = 0;
      ag.rider.v.z = 0;
      ag.stats = { kills: 0, deaths: 0, score: 0, tricks: 0, streak: 0 };
    }
  }

  /** Apply the loadout menu's choice to the player. */
  function applyChoice() {
    const p = game.player;
    p.rider.kind = game.choice.kind;
    p.loadout = makeLoadout(game.choice.weapon);
  }

  game.begin = () => {
    // Straight into play from wherever reset left us (judges and "skip intro").
    applyChoice();
    placeAll();
    game.scores = { blue: 0, red: 0 };
    game.clock = MATCH_TIME;
    game.feed = [];
    game.popups = [];
    game.medals = [];
    game.firstBlood = false;
    game.winner = null;
    game.phase = "playing";
    game.phaseT = 0;
  };

  game.flowPhase = () => {
    switch (game.phase) {
      case "title":
        return "menu";
      case "loadout":
        return "menu";
      case "countdown":
        return "countdown";
      case "results":
        return "results";
      default:
        return "playing";
    }
  };

  // ── input helpers ──
  const pressed = (ctx, ...codes) => codes.some((c) => ctx.keys.has(c) && !game.keysPrev.has(c));
  const held = (ctx, ...codes) => codes.some((c) => ctx.keys.has(c));

  function playerInput(ctx, dt) {
    const p = game.player;
    const r = p.rider;
    if (pressed(ctx, "Minus", "NumpadSubtract")) game.settings.sens = Math.max(0.2, Math.round((game.settings.sens - 0.1) * 10) / 10);
    if (pressed(ctx, "Equal", "NumpadAdd")) game.settings.sens = Math.min(4, Math.round((game.settings.sens + 0.1) * 10) / 10);
    if (pressed(ctx, "Minus", "NumpadSubtract", "Equal", "NumpadAdd")) {
      game.toast = { text: `MOUSE SENSITIVITY  ${game.settings.sens.toFixed(1)}`, t: game.time };
      saveSettings(game.settings);
    }
    // Field of view: [ and ] (vertical 62–90°; the toast also gives the 16:9 horizontal).
    if (pressed(ctx, "BracketLeft")) game.settings.fov = Math.max(62, game.settings.fov - 4);
    if (pressed(ctx, "BracketRight")) game.settings.fov = Math.min(90, game.settings.fov + 4);
    if (pressed(ctx, "BracketLeft", "BracketRight")) {
      const h = Math.round((2 * Math.atan(Math.tan((game.settings.fov * Math.PI) / 360) * (16 / 9)) * 180) / Math.PI);
      game.toast = { text: `FIELD OF VIEW  ${game.settings.fov}°  (${h}° HORIZONTAL)`, t: game.time };
      saveSettings(game.settings);
    }
    const sens = 0.0021 * game.settings.sens * (1 - p.loadout.ads * (1 - 1 / activeWeapon(p.loadout).def.zoom) * 0.85);
    p.lookYaw = wrapAngle(p.lookYaw - ctx.look.x * sens);
    p.lookPitch = clamp(p.lookPitch - ctx.look.y * sens, -1.45, 1.45);
    const left = held(ctx, "KeyA", "ArrowLeft");
    const right = held(ctx, "KeyD", "ArrowRight");
    const fwd = held(ctx, "KeyW", "ArrowUp");
    const back = held(ctx, "KeyS", "ArrowDown");
    let swap = null;
    if (pressed(ctx, "Digit1")) swap = 0;
    if (pressed(ctx, "Digit2")) swap = 1;
    if (ctx.wheel.y !== 0 || pressed(ctx, "KeyQ")) swap = 1 - p.loadout.active;
    // Tricks need a fresh press after take-off, so holding W/A/D into a jump doesn't auto-flip.
    const arm = game.trickArm;
    if (r.grounded) {
      arm.flip = false;
      arm.spin = false;
    } else {
      if (!fwd && !back) arm.flip = true;
      if (!left && !right) arm.spin = true;
    }
    const fire = held(ctx, "Mouse1");
    const ads = held(ctx, "Mouse2", "KeyE");
    return {
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      // Firing or aiming brings the gun up out of the tuck.
      tuck: fwd && !fire && !ads ? 1 : 0,
      brake: back ? 1 : 0,
      jump: held(ctx, "Space") ? 1 : 0,
      spin: r.grounded || !arm.spin ? 0 : (right ? 1 : 0) - (left ? 1 : 0),
      flip: r.grounded || !arm.flip ? 0 : (fwd ? 1 : 0) - (back ? 1 : 0),
      fire,
      ads,
      steady: held(ctx, "ShiftLeft", "ShiftRight"),
      reload: pressed(ctx, "KeyR"),
      swap,
      redeploy: pressed(ctx, "Backspace"),
    };
  }

  // ── simulation ──
  function damage(victim, amount, attacker, how, part, fromX, fromZ, dist = 0) {
    if (!victim.alive || victim.invuln > 0) return;
    const before = victim.health;
    victim.health -= amount;
    victim.lastDamageT = game.time;
    victim.lastAttacker = attacker;
    victim.hitFlash = 0.12;
    flinch(victim.loadout, amount, game.rng);
    if (fromX !== undefined) victim.damageDir = { x: fromX, z: fromZ, t: game.time };
    if (attacker && attacker !== victim) {
      game.events.push({ type: "hit", attacker, victim, amount, part, kill: victim.health <= 0, x: victim.rider.p.x, y: victim.rider.p.y + 1.1, z: victim.rider.p.z });
    }
    if (victim.health <= 0) kill(victim, attacker, how, part === "head", { dist, oneShot: before >= 99 && amount >= before });
  }

  function kill(victim, killer, how, headshot, info = {}) {
    const victimAir = !victim.rider.grounded;
    const victimStreak = victim.stats.streak;
    victim.alive = false;
    victim.health = 0;
    victim.respawnT = RESPAWN_TIME;
    victim.stats.deaths++;
    victim.stats.streak = 0;
    victim.killedBy = killer;
    // A crash or a tree with a recent attacker credits the attacker.
    let credit = killer;
    if ((!credit || credit === victim) && victim.lastAttacker && game.time - victim.lastDamageT < 6) credit = victim.lastAttacker;
    if (credit && credit !== victim && credit.team !== victim.team) {
      credit.stats.kills++;
      credit.stats.streak++;
      credit.stats.best = Math.max(credit.stats.best ?? 0, credit.stats.streak);
      credit.stats.score += 100 + (headshot ? 50 : 0);
      game.scores[credit.team]++;
      awardMedals(credit, victim, how, headshot, info, victimAir, victimStreak);
    } else {
      // Self-inflicted (tree, crash): the other team gets the point, like a suicide in TDM.
      game.scores[victim.team === "blue" ? "red" : "blue"]++;
    }
    const weaponName = how === "tree" ? "TREE" : how === "crash" ? "WIPEOUT" : how;
    game.feed.unshift({
      killer: credit && credit !== victim ? credit.name : null,
      killerTeam: credit?.team,
      victim: victim.name,
      victimTeam: victim.team,
      weapon: weaponName,
      headshot,
      t: game.time,
      mine: credit === game.player || victim === game.player,
    });
    if (game.feed.length > 6) game.feed.length = 6;
    game.events.push({ type: "kill", killer: credit, victim, headshot, how });
    if (credit === game.player && victim !== game.player) {
      game.popups.push({ text: "ELIMINATED", sub: victim.name, points: 100, t: game.time, kill: true });
    }
    victim.lastKilledBy = credit && credit !== victim ? credit : null;
    victim.killInfo = {
      by: credit && credit !== victim ? credit.name : null,
      team: credit?.team,
      weapon: weaponName,
      dist: Math.round(info.dist ?? 0),
      headshot,
      health: credit && credit !== victim ? Math.max(1, Math.round(credit.health)) : 0,
    };
  }

  /** Call-of-Duty style medals for the killer (shown for the player; every agent banks the points). */
  function awardMedals(k, victim, how, headshot, info, victimAir, victimStreak) {
    const medals = [];
    const add = (name, points, icon) => {
      medals.push({ name, points, icon });
      k.stats.score += points;
    };
    if (!game.firstBlood) {
      game.firstBlood = true;
      add("FIRST BLOOD", 100, "blood");
    }
    if (headshot) add("HEADSHOT", 50, "head");
    if (info.oneShot && how !== "tree" && how !== "crash") add("ONE SHOT", 50, "scope");
    if (!k.rider.grounded) add("AIRBORNE KILL", 75, "air");
    if (victimAir) add("SKY SNIPE", 75, "sky");
    if (info.dist > 120) add("LONGSHOT", 50, "scope");
    else if (info.dist > 0 && info.dist < 5) add("POINT BLANK", 25, "fist");
    if (how === "tree") add("TREE TROUBLE", 75, "tree");
    else if (how === "crash") add("WIPEOUT", 50, "crash");
    if (k.lastKilledBy === victim) {
      add("REVENGE", 50, "revenge");
      k.lastKilledBy = null;
    }
    if (victimStreak >= 3) add("BUZZKILL", 50, "buzz");
    // Multi-kills: kills within 4 seconds of each other.
    k.multi = game.time - (k.lastKillT ?? -99) < 4 ? (k.multi ?? 1) + 1 : 1;
    k.lastKillT = game.time;
    if (k.multi === 2) add("DOUBLE KILL", 50, "multi");
    else if (k.multi === 3) add("TRIPLE KILL", 100, "multi");
    else if (k.multi >= 4) add("MULTI KILL", 150, "multi");
    const streakNames = { 3: "ON A ROLL", 5: "AVALANCHE", 7: "UNSTOPPABLE", 10: "KING OF THE MOUNTAIN" };
    if (streakNames[k.stats.streak]) add(streakNames[k.stats.streak], k.stats.streak * 25, "streak");
    k.stats.medals = (k.stats.medals ?? 0) + medals.length;
    if (k === game.player) {
      for (const m of medals) game.medals.push({ ...m, t: game.time });
      if (medals.length) game.events.push({ type: "medal", medals });
    }
  }

  function simulate(dt, ctx) {
    game.time += dt;
    if (game.phase === "playing") game.clock = Math.max(0, game.clock - dt);
    for (const ag of game.agents) {
      ag.invuln = Math.max(0, ag.invuln - dt);
      ag.hitFlash = Math.max(0, ag.hitFlash - dt);
      if (!ag.alive) {
        if (ag.liftT > 0) {
          ag.liftT -= dt;
          if (ag.liftT <= 0) {
            spawn(ag, ag.liftSpot ?? startSpot(ag.team, (ag.id * 7) % 6));
            game.events.push({ type: "spawn", agent: ag, lift: true });
          }
        } else {
          ag.respawnT -= dt;
          if (ag.respawnT <= 0 && game.phase === "playing") {
            spawn(ag, respawnSpot(ag));
            game.events.push({ type: "spawn", agent: ag });
          }
        }
        continue;
      }
      let input;
      if (ag.isPlayer) input = ctx ? playerInput(ctx, dt) : { steer: 0, tuck: 0, brake: 0, jump: 0 };
      else input = botThink(ag, game, dt);
      if (game.phase === "countdown") {
        // Frozen in the start gate: look around only (playerInput already applied the look).
        continue;
      }
      // Physics.
      stepRider(ag.rider, input, dt, game.physicsWorld);
      for (const ev of ag.rider.events) {
        if (ev.type === "trick") {
          ag.stats.tricks += ev.points;
          ag.stats.score += ev.points;
          if (ag.isPlayer) game.popups.push({ text: ev.name, points: ev.points, t: game.time, trick: true });
          game.events.push({ type: "trick", agent: ag, ...ev });
        } else if (ev.type === "crash" || ev.type === "tree") {
          game.events.push({ type: ev.type, agent: ag, impact: ev.impact });
          if (ev.damage > 0) damage(ag, ev.damage, ag.lastAttacker && game.time - ag.lastDamageT < 6 ? ag.lastAttacker : null, ev.type, "body");
        } else {
          game.events.push({ type: ev.type, agent: ag, ...ev });
        }
      }
      if (!ag.alive) continue;
      // Weapons.
      const aim = { yaw: ag.lookYaw, pitch: ag.lookPitch };
      const shot = weaponStep(ag.loadout, input, { speed: ag.rider.speed, grounded: ag.rider.grounded }, aim, dt, game.rng);
      if (ag.isPlayer && ag.loadout.dry) game.events.push({ type: "dry", agent: ag });
      if (shot && game.phase === "playing") {
        const origin = eyeOf(ag, {});
        const res = resolveShot(ag, shot, origin, game.agents, ground, game.forest);
        game.events.push({ type: "shot", agent: ag, def: shot.def, origin, res });
        for (const h of res.hits) {
          if (h.agent.team === ag.team) continue; // no friendly fire
          damage(h.agent, h.damage, ag, shot.def.name, h.part, ag.rider.p.x, ag.rider.p.z, h.dist);
        }
        // Near misses crack past the player's head.
        const me = game.player;
        if (ag !== me && me.alive && ag.team !== me.team) {
          const e = eyeOf(me, {});
          for (const pel of shot.pellets) {
            const t = (e.x - origin.x) * pel.dx + (e.y - origin.y) * pel.dy + (e.z - origin.z) * pel.dz;
            if (t < 2) continue;
            const cx = origin.x + pel.dx * t;
            const cy = origin.y + pel.dy * t;
            const cz = origin.z + pel.dz * t;
            const miss = Math.hypot(cx - e.x, cy - e.y, cz - e.z);
            if (miss < 2.6 && !res.hits.some((h) => h.agent === me)) {
              game.events.push({ type: "whiz", x: cx, y: cy, z: cz, miss });
              break;
            }
          }
        }
      }
      // Regen.
      if (ag.health < 100 && game.time - ag.lastDamageT > REGEN_DELAY) ag.health = Math.min(100, ag.health + 32 * dt);
      // Out of bounds / reached the base / stuck: ride the lift back up.
      const p = ag.rider.p;
      const atBase = p.z > MAP.baseZ - 60 && ag.rider.speed < 7;
      const tooFar = p.z > MAP.bounds.maxZ || p.x < MAP.bounds.minX || p.x > MAP.bounds.maxX || p.z < MAP.bounds.minZ;
      const stuck = (ag.brain && ag.brain.stuckT > 6) || (ag.isPlayer && input.redeploy);
      if (atBase || tooFar || stuck) {
        if (ag.brain) ag.brain.stuckT = 0;
        ag.alive = false;
        ag.liftT = LIFT_TIME;
        // Chosen now so the lift camera can fly straight to it.
        ag.liftSpot = startSpot(ag.team, (ag.id * 7) % 6);
        game.events.push({ type: "lift", agent: ag });
      }
    }
    // Riders bump off each other (and a hard hit at speed sends both flying).
    if (game.phase === "playing") {
      const live = game.agents.filter((a) => a.alive);
      for (let i = 0; i < live.length; i++)
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i].rider;
          const b = live[j].rider;
          const dx = b.p.x - a.p.x;
          const dz = b.p.z - a.p.z;
          if (Math.abs(dx) > 1 || Math.abs(dz) > 1 || Math.abs(b.p.y - a.p.y) > 1.6) continue;
          const d = Math.hypot(dx, dz) || 0.01;
          if (d >= 0.85) continue;
          const nx = dx / d;
          const nz = dz / d;
          const push = (0.85 - d) / 2;
          a.p.x -= nx * push;
          a.p.z -= nz * push;
          b.p.x += nx * push;
          b.p.z += nz * push;
          const rel = (b.v.x - a.v.x) * nx + (b.v.z - a.v.z) * nz;
          if (rel < 0) {
            const imp = -rel * 0.55;
            a.v.x -= nx * imp;
            a.v.z -= nz * imp;
            b.v.x += nx * imp;
            b.v.z += nz * imp;
            if (-rel > 9) {
              a.crash = Math.max(a.crash, 1.1);
              b.crash = Math.max(b.crash, 1.1);
              game.events.push({ type: "collide", a: live[i], b: live[j], impact: -rel });
            }
          }
        }
    }
    // Match end.
    if (game.phase === "playing" && (game.scores.blue >= SCORE_LIMIT || game.scores.red >= SCORE_LIMIT || game.clock <= 0)) {
      game.phase = "results";
      game.phaseT = 0;
      game.winner = game.scores.blue === game.scores.red ? null : game.scores.blue > game.scores.red ? "blue" : "red";
    }
    game.popups = game.popups.filter((p) => game.time - p.t < 2.2);
    game.medals = game.medals.filter((m) => game.time - m.t < 3.2);
  }

  game.update = (dt, ctx) => {
    game.events.length = 0;
    game.phaseT += dt;
    const go = ctx && (pressed(ctx, "Enter", "NumpadEnter", "Space") || pressed(ctx, "Mouse1"));
    switch (game.phase) {
      case "title":
        if (go) {
          game.phase = "loadout";
          game.phaseT = 0;
        }
        game.time += dt;
        break;
      case "loadout": {
        if (ctx) {
          if (pressed(ctx, "Digit1", "KeyA", "ArrowLeft")) game.choice.kind = "ski";
          if (pressed(ctx, "Digit2", "KeyD", "ArrowRight")) game.choice.kind = "board";
          const list = PRIMARIES;
          let i = list.indexOf(game.choice.weapon);
          if (pressed(ctx, "KeyW", "ArrowUp")) i = (i + list.length - 1) % list.length;
          if (pressed(ctx, "KeyS", "ArrowDown")) i = (i + 1) % list.length;
          game.choice.weapon = list[i];
        }
        if (ctx && pressed(ctx, "Enter", "NumpadEnter", "Space") && game.phaseT > 0.2) {
          applyChoice();
          placeAll();
          game.scores = { blue: 0, red: 0 };
          game.clock = MATCH_TIME;
          game.feed = [];
          game.phase = "countdown";
          game.phaseT = 0;
        }
        game.time += dt;
        break;
      }
      case "countdown":
        simulate(dt, ctx);
        if (game.phaseT >= 3) {
          game.phase = "playing";
          game.phaseT = 0;
          game.events.push({ type: "go" });
        }
        break;
      case "playing":
        simulate(dt, ctx);
        break;
      case "results":
        game.time += dt;
        if (go && game.phaseT > 1.5) {
          game.reset(Math.floor(game.rng() * 1e9));
          game.phase = "loadout";
          game.phaseT = 0;
        }
        break;
    }
    if (ctx) game.keysPrev = new Set(ctx.keys);
  };

  /** Test hooks for the studio photos (deterministic setups). */
  game.damage = damage;
  game.startSpot = startSpot;
  game.weaponOf = (ag) => activeWeapon(ag.loadout);
  game.WEAPONS = WEAPONS;
  game.KIND = KIND;
  return game;
}
