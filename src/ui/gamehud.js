/**
 * The game's HUD and menus, drawn through `__studio.hud` (one canvas quad, no DOM). A diffing
 * layer only re-sends items whose content changed, and fast-changing readouts are quantised, so
 * the overlay repaints a handful of times a second instead of every frame.
 */
import { GUN_ICONS, MOUNTAIN_ICON, RIDER_ICON, HITMARKER, MEDAL_ICONS, KILL_X } from "./icons.js";
import { TEAM, SCORE_LIMIT } from "../game/game.js";
import { WEAPONS, PRIMARIES, activeWeapon } from "../game/weapons.js";
import { KIND } from "../game/rider.js";
import { clamp, wrapAngle } from "../core/noise.js";

const FONT = '"DIN Condensed", "DIN Alternate", "Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", sans-serif';
const BLUE = "#3d95ff";
const RED = "#ff4a4a";
const GOLD = "#ffd35a";

export function createGameHud(getHud, getCanvas, minimap) {
  const sent = new Map();
  let screen = "";
  const measureCtx = document.createElement("canvas").getContext("2d");

  const hud = () => getHud();
  function aspect() {
    const c = getCanvas();
    return c && c.width > 0 && c.height > 0 ? c.width / c.height : 16 / 9;
  }
  /** Text width as a fraction of the frame width (size in design px). */
  function textW(str, size, weight = 600) {
    measureCtx.font = `${weight} ${size}px ${FONT}`;
    return measureCtx.measureText(str).width / (720 * aspect());
  }
  function put(kind, id, ...args) {
    const key = JSON.stringify(args);
    if (sent.get(id) === key) return;
    sent.set(id, key);
    const h = hud();
    if (h && typeof h[kind] === "function") h[kind](id, ...args);
  }
  function text(id, str, opts) {
    put("text", id, String(str), { font: FONT, weight: 700, ...opts });
  }
  function drop(id) {
    if (!sent.has(id)) return;
    sent.delete(id);
    hud()?.remove(id);
  }
  function keepOnly(prefixes) {
    for (const id of [...sent.keys()]) {
      if (!prefixes.some((p) => id.startsWith(p))) drop(id);
    }
  }
  let crossKey = "";
  function crosshair(opts) {
    const key = JSON.stringify(opts);
    if (key === crossKey) return;
    crossKey = key;
    hud()?.crosshair(opts);
  }

  // ── screens ──
  function titleScreen(game) {
    keepOnly(["title-"]);
    crosshair({ visible: false });
    const ar = aspect();
    // Logo lockup on a soft dark plate (the sky behind it is bright).
    put("panel", "title-plate", { anchor: "top", x: 0, y: 0.075, w: 0.92, h: 0.35, radius: 0.03, fill: "rgba(4,12,28,0.26)" });
    put("path", "title-icon", MOUNTAIN_ICON, { anchor: "top", x: 0, y: 0.09, w: 0.075, h: 0.075, fill: "#ffffff", stroke: "rgba(0,0,0,0.35)", width: 0.002 });
    text("title-name", "BIG MOUNTAIN", { anchor: "top", y: 0.16, size: 66, color: "#ffffff", weight: "italic 900" });
    // SHOOTER, letter-spaced in gold between two rules.
    text("title-name2", "S  H  O  O  T  E  R", { anchor: "top", y: 0.282, size: 24, color: GOLD, weight: 900 });
    const ruleH = 0.16; // rule length (frame heights)
    const off = Math.round((textW("S  H  O  O  T  E  R", 24, 900) / 2 + 0.04 + ruleH / ar / 2) * 1000) / 1000; // frame widths
    put("panel", "title-rule-l", { anchor: "top", x: -off, y: 0.297, w: ruleH, h: 0.005, radius: 0.0025, fill: GOLD });
    put("panel", "title-rule-r", { anchor: "top", x: off, y: 0.297, w: ruleH, h: 0.005, radius: 0.0025, fill: GOLD });
    text("title-sub", "SKI IT.   SHRED IT.   SEND IT.   SHOOT IT.", { anchor: "top", y: 0.345, size: 14, color: "#dbe9ff", weight: 800 });
    text("title-top", "BLUE vs RED  •  6 v 6 TEAM DEATHMATCH", { anchor: "top", y: 0.385, size: 12, color: "#9fc0e8", weight: 700 });
    // A slow pulse instead of a hard blink.
    const pulse = Math.round((0.6 + 0.4 * Math.sin(game.time * 3.2)) * 10) / 10;
    text("title-go", "PRESS  ENTER  TO  DROP  IN", { anchor: "bottom", y: 0.24, size: 22, color: `rgba(255,255,255,${pulse})`, weight: 900 });
    put("panel", "title-help-bg", { anchor: "bottom", x: 0, y: 0.04, w: 1.25, h: 0.12, radius: 0.01, fill: "rgba(5,15,30,0.55)" });
    text(
      "title-help",
      "W tuck / push   S brake   A D carve   SPACE hold-to-pop   MOUSE aim   LMB fire   RMB aim-down-sights   SHIFT hold breath\nIn the air: A D spin  •  W S flip  (fresh press)      R reload   1 2 / Q swap   TAB scores   BACKSPACE lift   - = mouse   [ ] FOV   M mute",
      { anchor: "bottom", y: 0.065, size: 13, color: "#dbe7f5", weight: 600 },
    );
  }

  function loadoutScreen(game) {
    keepOnly(["lo-"]);
    crosshair({ visible: false });
    const ar = aspect();
    put("panel", "lo-bg", { anchor: "center", x: 0, y: 0, w: 1.3, h: 0.78, radius: 0.016, fill: "rgba(6,14,28,0.72)", stroke: "rgba(120,170,255,0.35)", width: 0.002 });
    text("lo-title", "CHOOSE YOUR LOADOUT", { anchor: "top", y: 0.14, size: 30, color: "#ffffff", weight: "italic 900" });
    // Ride choice.
    text("lo-ride-h", "RIDE   (A / D)", { anchor: "top", x: -0.18, y: 0.23, size: 14, color: "#9fb8d8", weight: 700 });
    ["ski", "board"].forEach((k, i) => {
      const sel = game.choice.kind === k;
      const x = -0.27 + i * 0.18;
      put("panel", `lo-ride-${k}`, { anchor: "top", x, y: 0.27, w: 0.16 * ar, h: 0.16, radius: 0.01, fill: sel ? "rgba(47,140,255,0.45)" : "rgba(255,255,255,0.07)", stroke: sel ? "#7fb6ff" : "rgba(255,255,255,0.2)", width: 0.003 });
      text(`lo-ride-${k}-t`, k === "ski" ? "SKIS" : "SNOWBOARD", { anchor: "top", x, y: 0.29, size: 22, color: "#ffffff", weight: 900 });
      text(
        `lo-ride-${k}-d`,
        k === "ski" ? "Faster top speed\nSkate on the flats\nQuicker edge-to-edge" : "Bigger pop & spins\nForgiving landings\nTwo-hand aiming",
        { anchor: "top", x, y: 0.335, size: 12, color: "#c9d8ea", weight: 600 },
      );
    });
    // Weapon choice.
    text("lo-gun-h", "PRIMARY   (W / S)", { anchor: "top", x: 0.18, y: 0.23, size: 14, color: "#9fb8d8", weight: 700 });
    PRIMARIES.forEach((id, i) => {
      const d = WEAPONS[id];
      const sel = game.choice.weapon === id;
      const y = 0.27 + i * 0.085;
      put("panel", `lo-gun-${id}`, { anchor: "top", x: 0.18, y, w: 0.33 * ar, h: 0.072, radius: 0.008, fill: sel ? "rgba(47,140,255,0.45)" : "rgba(255,255,255,0.06)", stroke: sel ? "#7fb6ff" : "rgba(255,255,255,0.15)", width: 0.0025 });
      put("path", `lo-gun-${id}-i`, GUN_ICONS[id], { anchor: "top-left", x: 0.525, y: y + 0.014, w: 0.11, h: 0.04, viewBox: "0 0 120 40", fill: sel ? "#ffffff" : "#b9c7d8" });
      text(`lo-gun-${id}-n`, d.name, { anchor: "top-left", x: 0.525 + 0.12 / ar, y: y + 0.012, size: 16, color: "#ffffff", weight: 800 });
      const dps = Math.round((d.damage[0] * d.pellets * d.rpm) / 60);
      text(`lo-gun-${id}-s`, `${d.kind.toUpperCase()}  •  ${d.rpm} RPM  •  ${dps} DPS  •  ${d.mag} RDS`, { anchor: "top-left", x: 0.525 + 0.12 / ar, y: y + 0.043, size: 11, color: "#a9bdd6", weight: 600 });
    });
    text("lo-sec", "SECONDARY:  SIDEARM 9 pistol  (press 2 or Q in game)", { anchor: "top", y: 0.63, size: 12, color: "#9fb8d8", weight: 600 });
    text("lo-team", "You ride for BLUE TEAM  •  first to 50 eliminations or most after 10:00", { anchor: "top", y: 0.68, size: 14, color: "#cfe3ff", weight: 700 });
    // A slow pulse (matches the title) instead of a hard blink.
    const pulse = Math.round((0.6 + 0.4 * Math.sin(game.time * 3.2)) * 10) / 10;
    text("lo-go", "ENTER  —  DROP IN", { anchor: "top", y: 0.74, size: 22, color: `rgba(255,211,90,${pulse})`, weight: 900 });
  }

  function resultsScreen(game) {
    keepOnly(["res-"]);
    crosshair({ visible: false });
    const w = game.winner;
    const title = w ? `${TEAM[w].name} WINS` : "DRAW";
    put("panel", "res-bg", { anchor: "center", x: 0, y: 0, w: 1.25, h: 0.8, radius: 0.016, fill: "rgba(6,14,28,0.78)" });
    text("res-title", title, { anchor: "top", y: 0.13, size: 40, color: w === "red" ? RED : w === "blue" ? BLUE : "#fff", weight: "italic 900" });
    text("res-score", `${game.scores.blue}  —  ${game.scores.red}`, { anchor: "top", y: 0.21, size: 26, color: "#ffffff", weight: 900 });
    scoreboardRows(game, "res-", 0.29);
    // Highlights: MVP, top shredder (trick points), and your own match.
    const ar = aspect();
    const all = game.agents;
    const mvp = [...all].sort((a, b) => b.stats.score - a.stats.score)[0];
    const shred = [...all].sort((a, b) => (b.stats.tricks ?? 0) - (a.stats.tricks ?? 0))[0];
    const me = game.player;
    const cards = [
      { id: "mvp", label: "MATCH MVP", a: mvp, line: mvp ? `${mvp.stats.kills} K   ${mvp.stats.deaths} D   •   ${mvp.stats.score.toLocaleString()} PTS` : "" },
      { id: "shred", label: "TOP SHREDDER", a: shred, line: shred ? `${(shred.stats.tricks ?? 0).toLocaleString()} TRICK PTS` : "" },
      { id: "me", label: "YOUR MATCH", a: me, line: `${me.stats.kills} K   ${me.stats.deaths} D   •   BEST STREAK ${me.stats.best ?? 0}   •   ${me.stats.medals ?? 0} MEDALS` },
    ];
    cards.forEach((c, i) => {
      const x = Math.round(((i - 1) * 0.41) / ar * 1000) / 1000;
      put("panel", `res-c-${c.id}`, { anchor: "top", x, y: 0.585, w: 0.38, h: 0.15, radius: 0.008, fill: c.id === "me" ? "rgba(255,211,90,0.14)" : "rgba(255,255,255,0.06)", stroke: c.id === "mvp" ? "rgba(255,211,90,0.55)" : "rgba(255,255,255,0.12)", width: 0.0015 });
      text(`res-c-${c.id}-l`, c.label, { anchor: "top", x, y: 0.598, size: 12, color: GOLD, weight: 900 });
      text(`res-c-${c.id}-n`, c.a ? c.a.name : "—", { anchor: "top", x, y: 0.628, size: 22, color: c.a ? (c.a.team === "blue" ? BLUE : RED) : "#ffffff", weight: "italic 900" });
      text(`res-c-${c.id}-s`, c.line, { anchor: "top", x, y: 0.685, size: 11, color: "#cfe0f5", weight: 700 });
    });
    if (game.phaseT > 1.5) text("res-go", "ENTER  —  NEXT MATCH", { anchor: "top", y: 0.82, size: 20, color: GOLD, weight: 900 });
  }

  function scoreboardRows(game, prefix, top) {
    const ar = aspect();
    ["blue", "red"].forEach((team, ti) => {
      const col = ti === 0 ? -0.2 : 0.2;
      const list = game.agents.filter((a) => a.team === team).sort((a, b) => b.stats.kills - a.stats.kills || b.stats.score - a.stats.score);
      text(`${prefix}h-${team}`, `${TEAM[team].name.padEnd(14, " ")}    K     D    SCORE`, { anchor: "top", x: col, y: top, size: 14, color: team === "blue" ? BLUE : RED, weight: 800, font: "ui-monospace, Menlo, monospace" });
      list.forEach((a, i) => {
        const y = top + 0.04 + i * 0.036;
        const me = a.isPlayer;
        put("panel", `${prefix}r-${a.id}`, { anchor: "top", x: col, y: y - 0.004, w: 0.36 * ar, h: 0.032, radius: 0.004, fill: me ? "rgba(255,211,90,0.22)" : "rgba(255,255,255,0.05)" });
        const name = a.name.padEnd(14, " ");
        text(`${prefix}n-${a.id}`, `${name}   ${String(a.stats.kills).padStart(2)}    ${String(a.stats.deaths).padStart(2)}    ${String(a.stats.score).padStart(5)}`, {
          anchor: "top",
          x: col,
          y,
          size: 14,
          color: me ? GOLD : "#e8eef8",
          weight: 700,
          font: "ui-monospace, Menlo, monospace",
        });
      });
    });
  }

  // ── in-game ──
  const MM = 0.25; // minimap size (frame heights)
  let fpsT = 0;
  function playScreen(game, view) {
    const p = game.player;
    const ar = aspect();
    // Dead or on the lift: the gameplay readouts (speed, weapon) step aside for the cinematic.
    const keep = ["sb-", "mm-", "kf-", "ro-", "hm", "pop-", "dmg-", "msg-", "cd-", "tab-", "ret-", "hd-", "xh", "med-", "air-", "rl", "br-"];
    if (p.alive) keep.push("sp-", "wp-");
    keepOnly(keep);
    // Score bar.
    put("path", "sb-bg", "M24 0 L926 0 L900 60 L50 60 Z", { anchor: "top", x: 0, y: 0.012, w: 0.98, h: 0.064, viewBox: "0 0 950 60", fill: "rgba(8,18,36,0.6)" });
    put("path", "sb-blue", "M14 0 L100 0 L86 60 L0 60 Z", { anchor: "top", x: -0.062, y: 0.014, w: 0.1, h: 0.06, viewBox: "0 0 100 60", fill: "#1f6fe0" });
    put("path", "sb-red", "M14 0 L100 0 L86 60 L0 60 Z", { anchor: "top", x: 0.062, y: 0.014, w: 0.1, h: 0.06, viewBox: "0 0 100 60", fill: "#d92b2b" });
    text("sb-bt", "BLUE TEAM", { anchor: "top", x: -0.165, y: 0.03, size: 17, color: "#6fb3ff", weight: 800 });
    text("sb-rt", "RED TEAM", { anchor: "top", x: 0.165, y: 0.03, size: 17, color: "#ff6b6b", weight: 800 });
    text("sb-bs", game.scores.blue, { anchor: "top", x: -0.062, y: 0.022, size: 26, color: "#ffffff", weight: 900 });
    text("sb-rs", game.scores.red, { anchor: "top", x: 0.062, y: 0.022, size: 26, color: "#ffffff", weight: 900 });
    put("bar", "sb-bp", Math.round(clamp(game.scores.blue / SCORE_LIMIT, 0, 1) * 50) / 50, { anchor: "top", x: -0.1, y: 0.079, w: 0.12, h: 0.0045, color: "#3d95ff", back: "rgba(255,255,255,0.12)" });
    put("bar", "sb-rp", Math.round(clamp(game.scores.red / SCORE_LIMIT, 0, 1) * 50) / 50, { anchor: "top", x: 0.1, y: 0.079, w: 0.12, h: 0.0045, color: "#ff4a4a", back: "rgba(255,255,255,0.12)" });
    const secs = Math.ceil(game.clock);
    text("sb-clock", `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`, { anchor: "top", x: 0, y: 0.022, size: 26, color: secs <= 30 ? "#ffb0b0" : "#ffffff", weight: 800 });

    // Minimap (north-up).
    const mmX = 0.012;
    const mmY = 0.02;
    put("image", "mm-map", minimap.url, { anchor: "top-left", x: mmX, y: mmY, w: MM, h: MM });
    const cxF = mmX + (MM / 2) / ar; // centre in width fractions
    const cyF = mmY + MM / 2; // in height fractions
    // Rim: a round panel that contains the map (a group, not an overlap).
    put("panel", "mm-ring", { anchor: "top-left", x: mmX - 0.004 / ar, y: mmY - 0.004, w: MM + 0.008, h: MM + 0.008, radius: (MM + 0.008) / 2, fill: null, stroke: "rgba(150,190,255,0.7)", width: 0.004 });
    const letters = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
    for (const [L, [lx, ly]] of Object.entries(letters)) {
      text(`mm-${L}`, L, { anchor: "top-left", x: cxF + (lx * (MM / 2 + 0.018)) / ar - 0.004, y: cyF + ly * (MM / 2 + 0.018) - 0.012, size: 12, color: "#ffffff", weight: 800 });
    }
    // Dots: teammates always, enemies when they've fired recently or the player can see them.
    // Riders bunched in the same spot share one dot; a dot right under your own arrow is left out
    // (the arrow covers it anyway).
    const placed = [];
    const [pu0, pv0] = minimap.project(p.rider.p.x, p.rider.p.z);
    for (const a of game.agents) {
      const id = `mm-d${a.id}`;
      if (a.isPlayer || !a.alive || (a.team !== p.team && !(view.spotted.get(a) > game.time - 2.5))) {
        drop(id);
        continue;
      }
      const [u, v] = minimap.project(a.rider.p.x, a.rider.p.z);
      const s = 0.011;
      const bunched = placed.some(([qu, qv, qt]) => qt === a.team && Math.abs(qu - u) * MM < s * 1.6 && Math.abs(qv - v) * MM < s * 1.6);
      const underMe = p.alive && Math.abs(pu0 - u) * MM < 0.021 && Math.abs(pv0 - v) * MM < 0.021;
      if (bunched || underMe) {
        drop(id);
        continue;
      }
      placed.push([u, v, a.team]);
      put("path", id, "M50 0 A50 50 0 1 1 49.9 0 Z", { anchor: "top-left", x: mmX + (u * MM - s / 2) / ar, y: mmY + v * MM - s / 2, w: s, h: s, fill: a.team === p.team ? "#58a8ff" : "#ff4040", stroke: "#000", width: 0.001 });
    }
    if (p.alive) {
      const [u, v] = minimap.project(p.rider.p.x, p.rider.p.z);
      const yawQ = Math.round(p.lookYaw / 0.08) * 0.08;
      // Arrow pointing along the look direction (yaw 0 = north/up on the map).
      const pts = [[0, -50], [32, 40], [0, 20], [-32, 40]].map(([x, y]) => {
        const c = Math.cos(-yawQ);
        const s2 = Math.sin(-yawQ);
        return [50 + x * c - y * s2, 50 + x * s2 + y * c];
      });
      const d = `M${pts.map((q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(" L")} Z`;
      const s = 0.03;
      const cone = (() => {
        const a = -yawQ;
        const p1 = [50 + Math.sin(a - 0.55) * 46, 50 - Math.cos(a - 0.55) * 46];
        const p2 = [50 + Math.sin(a + 0.55) * 46, 50 - Math.cos(a + 0.55) * 46];
        return `M50 50 L${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L${p2[0].toFixed(1)} ${p2[1].toFixed(1)} Z`;
      })();
      const cs = 0.07;
      const inside = (Math.min(MM, u * MM + cs / 2) - Math.max(0, u * MM - cs / 2)) * (Math.min(MM, v * MM + cs / 2) - Math.max(0, v * MM - cs / 2)) / (cs * cs);
      if (inside > 0.8) put("path", "mm-cone", cone, { anchor: "top-left", x: mmX + (Math.round(u * 200) / 200 * MM - cs / 2) / ar, y: mmY + Math.round(v * 200) / 200 * MM - cs / 2, w: cs, h: cs, fill: "rgba(255,255,255,0.16)" });
      else drop("mm-cone");
      put("path", "mm-me", d, { anchor: "top-left", x: mmX + (Math.round(u * 200) / 200 * MM - s / 2) / ar, y: mmY + Math.round(v * 200) / 200 * MM - s / 2, w: s, h: s, fill: "#ffffff", stroke: "#0b1a33", width: 0.002 });
    } else {
      drop("mm-me");
      drop("mm-cone");
    }

    // Kill feed (top-right).
    const feed = game.feed.filter((f) => game.time - f.t < 7).slice(0, 4);
    for (let i = 0; i < 4; i++) {
      const f = feed[i];
      const ids = [`kf-bg${i}`, `kf-v${i}`, `kf-i${i}`, `kf-k${i}`, `kf-h${i}`];
      if (!f) {
        ids.forEach(drop);
        continue;
      }
      const y = 0.03 + i * 0.048;
      const vw = textW(f.victim, 15, 800);
      const gun = f.weapon;
      const iconId = Object.keys(GUN_ICONS).find((k) => WEAPONS[k].name === gun);
      const kw = f.killer ? textW(f.killer, 15, 800) : 0;
      const iconW = 0.06 / ar; // icon box width in width fractions
      const hsW = f.headshot ? 0.034 / ar : 0; // headshot skull between the gun and the victim
      const total = vw + iconW + hsW + kw + 0.03;
      put("panel", ids[0], { anchor: "top-right", x: 0.008, y: y - 0.006, w: (total + 0.01) * ar, h: 0.04, radius: 0.004, fill: f.mine ? "rgba(255,211,90,0.18)" : "rgba(5,12,25,0.45)" });
      text(ids[1], f.victim, { anchor: "top-right", x: 0.016, y, size: 15, color: f.victimTeam === "blue" ? BLUE : RED, weight: 800 });
      if (f.headshot) put("path", ids[4], MEDAL_ICONS.head, { anchor: "top-right", x: 0.016 + vw + 0.011, y: y + 0.003, w: 0.02, h: 0.02, fill: GOLD });
      else drop(ids[4]);
      if (iconId) {
        put("path", ids[2], GUN_ICONS[iconId], { anchor: "top-right", x: 0.016 + vw + 0.008 + hsW, y: y + 0.002, w: 0.06, h: 0.022, viewBox: "0 0 120 40", fill: f.headshot ? GOLD : "#ffffff" });
      } else {
        text(ids[2], f.weapon === "TREE" ? "🌲" : "✖", { anchor: "top-right", x: 0.016 + vw + 0.008 + hsW, y, size: 15, color: "#ffffff", weight: 800 });
      }
      if (f.killer) text(ids[3], f.killer, { anchor: "top-right", x: 0.016 + vw + iconW + 0.016 + hsW, y, size: 15, color: f.killerTeam === "blue" ? BLUE : RED, weight: 800 });
      else drop(ids[3]);
    }

    // Team roster (bottom-left).
    const team = game.agents.filter((a) => a.team === p.team).sort((a, b) => (a.isPlayer ? 1 : 0) - (b.isPlayer ? 1 : 0));
    team.forEach((a, i) => {
      const y = 0.03 + (team.length - 1 - i) * 0.047;
      const hp = a.alive ? clamp(a.health / 100, 0, 1) : 0;
      put("panel", `ro-bg${a.id}`, { anchor: "bottom-left", x: 0.012, y, w: 0.3, h: 0.04, radius: 0.004, fill: a.isPlayer ? "rgba(255,211,90,0.16)" : "rgba(8,18,36,0.5)", stroke: a.isPlayer ? "rgba(255,211,90,0.6)" : "rgba(80,140,255,0.35)", width: 0.0015 });
      put("path", `ro-ic${a.id}`, RIDER_ICON, { anchor: "bottom-left", x: 0.018, y: y + 0.006, w: 0.028, h: 0.028, fill: a.alive ? "#cfe0f5" : "#5a6b80" });
      text(`ro-n${a.id}`, a.name, { anchor: "bottom-left", x: 0.012 + 0.04 / ar, y: y + 0.016, size: 13, color: a.alive ? "#ffffff" : "#7d8ba0", weight: 700 });
      put("bar", `ro-hp${a.id}`, Math.round(hp * 20) / 20, { anchor: "bottom-left", x: 0.012 + 0.04 / ar, y: y + 0.006, w: 0.22 / ar, h: 0.006, color: a.isPlayer ? GOLD : "#3d95ff", back: "rgba(255,255,255,0.12)" });
    });

    // Speed (bottom-right, above the weapon panel).
    const w = activeWeapon(p.loadout);
    if (p.alive) {
      const kmh = Math.round((p.rider.speed * 3.6) / 2) * 2;
      text("sp-v", `${kmh}`, { anchor: "bottom-right", x: 0.075, y: 0.2, size: 34, color: "#ffffff", weight: "italic 900" });
      text("sp-u", "km/h", { anchor: "bottom-right", x: 0.04, y: 0.205, size: 14, color: "#cfe3ff", weight: 700 });
      put("bar", "sp-bar", Math.round(clamp(kmh / 110, 0, 1) * 25) / 25, { anchor: "bottom-right", x: 0.016, y: 0.19, w: 0.14, h: 0.005, color: "#3dbbff", back: "rgba(255,255,255,0.15)" });

      // Weapon + ammo.
      put("panel", "wp-bg", { anchor: "bottom-right", x: 0.012, y: 0.03, w: 0.42, h: 0.13, radius: 0.006, fill: "rgba(8,18,36,0.55)", stroke: "rgba(255,255,255,0.12)", width: 0.0015 });
      put("path", "wp-icon", GUN_ICONS[w.def.id], { anchor: "bottom-right", x: 0.14, y: 0.075, w: 0.17, h: 0.057, viewBox: "0 0 120 40", fill: "#ffffff" });
      const low = w.mag <= Math.ceil(w.def.mag * 0.25);
      text("wp-mag", w.reloading ? "··" : w.mag, { anchor: "bottom-right", x: 0.06, y: 0.07, size: 36, color: low ? "#ff6b5a" : "#ffffff", weight: 900 });
      text("wp-res", `| ${w.reserve}`, { anchor: "bottom-right", x: 0.02, y: 0.078, size: 16, color: "#c9d6e6", weight: 700 });
      text("wp-name", w.reloading ? "RELOADING…" : w.def.name, { anchor: "bottom-right", x: 0.02, y: 0.045, size: 12, color: w.reloading ? GOLD : "#9fb8d8", weight: 800 });
      // Rounds left as pips along the top of the panel: full ones on the right (the next round
      // is the leftmost full pip), spent ones dim on the left. Each set gets its own box.
      const n = w.def.mag;
      const cell = Math.round(Math.min(0.016, 0.34 / n) * 10000) / 10000;
      const ticks = (count) => {
        let d = "";
        for (let i = 0; i < count; i++) d += `M${i * 10 + 3} 0 h4 v10 h-4 Z`;
        return d;
      };
      const full = Math.max(0, Math.min(n, w.mag));
      const spent = n - full;
      if (full > 0) put("path", "wp-pips", ticks(full), { anchor: "bottom-right", x: 0.02, y: 0.138, w: cell * full, h: cell, viewBox: `0 0 ${full * 10} 10`, fill: low ? "#ff6b5a" : "#e8f1ff" });
      else drop("wp-pips");
      if (spent > 0) put("path", "wp-pipx", ticks(spent), { anchor: "bottom-right", x: Math.round((0.02 + (cell * full) / ar) * 10000) / 10000, y: 0.138, w: cell * spent, h: cell, viewBox: `0 0 ${spent * 10} 10`, fill: "rgba(255,255,255,0.18)" });
      else drop("wp-pipx");
      const ride = p.rider.kind === "ski" ? "SKIS" : "BOARD";
      text("wp-ride", `${ride}  •  ${p.stats.kills} K  ${p.stats.deaths} D  •  ${p.stats.score} PTS`, { anchor: "bottom-right", x: 0.13, y: 0.045, size: 12, color: "#9fb8d8", weight: 800 });
    }

    // Crosshair (hidden when aiming down sights).
    const ads = p.loadout.ads;
    const fovHalf = (view.fov * Math.PI) / 360;
    const def = w.def;
    const spreadRad = def.spreadHip + (def.spreadAds - def.spreadHip) * ads + p.loadout.bloom + (p.rider.grounded ? clamp((p.rider.speed - 8) / 30, 0, 1) * 0.012 : 0.02);
    const gap = Math.round(Math.min(60, (Math.tan(spreadRad) / Math.tan(fovHalf)) * 360));
    const onEnemy = view.aimAgent && view.aimAgent.team !== p.team;
    crosshair({ visible: false });
    const raised = p.loadout.raise ?? 1;
    if (p.alive && ads < 0.6 && game.phase === "playing") {
      // Outlined so it reads on bright snow; the gap breathes with spread; dims at low ready.
      const g = Math.round(clamp(gap, 3, 38) / 2) * 2;
      const len = 7;
      const d = `M50 ${50 - g - len} L50 ${50 - g} M50 ${50 + g} L50 ${50 + g + len} M${50 - g - len} 50 L${50 - g} 50 M${50 + g} 50 L${50 + g + len} 50`;
      const col = onEnemy ? "#ff3b3b" : raised < 0.8 ? "rgba(255,255,255,0.45)" : "#ffffff";
      put("path", "xh-o", d, { anchor: "center", x: 0, y: 0, w: 0.3, h: 0.3, viewBox: "-57.1 -57.1 214.3 214.3", fill: null, stroke: "rgba(0,0,0,0.55)", width: 0.0048 });
      put("path", "xh", d, { anchor: "center", x: 0, y: 0, w: 0.14, h: 0.14, fill: null, stroke: col, width: 0.0022 });
      put("path", "xh-d", "M50 48.5 A1.5 1.5 0 1 1 49.9 48.5 Z", { anchor: "center", x: 0, y: 0, w: 0.006, h: 0.006, viewBox: "47.85 47.85 4.3 4.3", fill: col, stroke: "rgba(0,0,0,0.5)", width: 0.001 });
    } else {
      drop("xh-o");
      drop("xh");
      drop("xh-d");
    }
    // ADS reticles: the optic sits on the screen centre when fully aimed.
    const reticle = p.alive && ads > 0.85 && game.phase === "playing" ? def.id : null;
    if (reticle === "sniper") {
      drop("ret-ring");
      drop("ret-dot");
      put("path", "ret-scope", "M0 50 L44 50 M56 50 L100 50 M50 0 L50 44 M50 56 L50 100 M47 60 L53 60 M46 70 L54 70 M45 80 L55 80", { anchor: "center", x: 0, y: 0, w: 0.84, h: 0.84, fill: null, stroke: "rgba(5,8,10,0.9)", width: 0.0025 });
      put("path", "ret-sdot", "M50 47 A3 3 0 1 1 49.9 47 Z", { anchor: "center", x: 0, y: 0, w: 0.012, h: 0.012, viewBox: "44 44 12 12", fill: "#ff2a1a" });
    } else if (reticle && reticle !== "shotgun" && reticle !== "pistol") {
      drop("ret-scope");
      drop("ret-sdot");
      put("arc", "ret-ring", { anchor: "center", x: 0, y: 0, r: 0.032, width: 0.0028, start: 0, end: Math.PI * 2, fraction: 1, color: "rgba(255,40,30,0.9)" });
      put("path", "ret-dot", "M50 0 A50 50 0 1 1 49.9 0 Z", { anchor: "center", x: 0, y: 0, w: 0.006, h: 0.006, fill: "rgba(255,50,35,0.95)" });
    } else {
      for (const id of ["ret-ring", "ret-dot", "ret-scope", "ret-sdot"]) drop(id);
    }

    // Hitmarker: pops in big and settles; white body, gold headshot, red X on a kill.
    const hmAge = game.time - view.hitT;
    const hmLife = view.hitKill ? 0.42 : 0.22;
    if (hmAge < hmLife) {
      const pop = 1 + 0.45 * Math.max(0, 1 - hmAge / 0.07);
      const size = (view.hitKill ? 0.07 : 0.052) * pop;
      const col = view.hitKill ? "#ff3030" : view.hitPart === "head" ? "#ffd35a" : "#ffffff";
      const alpha = hmAge > hmLife * 0.6 ? Math.round((1 - (hmAge - hmLife * 0.6) / (hmLife * 0.4)) * 10) / 10 : 1;
      const so = Math.round(size * 2.2 * 500) / 500;
      put("path", "hm-o", view.hitKill ? KILL_X : HITMARKER, { anchor: "center", x: 0, y: 0, w: so, h: so, viewBox: "-60 -60 220 220", fill: null, stroke: `rgba(0,0,0,${0.5 * alpha})`, width: view.hitKill ? 0.009 : 0.0065 });
      put("path", "hm", view.hitKill ? KILL_X : HITMARKER, { anchor: "center", x: 0, y: 0, w: Math.round(size * 500) / 500, h: Math.round(size * 500) / 500, fill: null, stroke: col, width: view.hitKill ? 0.0055 : 0.0035 });
    } else {
      drop("hm");
      drop("hm-o");
    }

    // Medals: the newest big under the crosshair, older ones stacked above it, fading.
    const meds = game.medals.slice(-3);
    for (let i = 0; i < 3; i++) {
      const m = meds[meds.length - 1 - i];
      const ids = [`med-i${i}`, `med-t${i}`, `med-p${i}`];
      if (!m) {
        ids.forEach(drop);
        continue;
      }
      const age = game.time - m.t;
      const big = i === 0;
      const y = 0.2 - i * 0.045;
      const size = big ? 24 : 15;
      const pop = big ? 1 + 0.25 * Math.max(0, 1 - age / 0.12) : 1;
      const tw = textW(m.name, size, 900);
      const icon = MEDAL_ICONS[m.icon] ?? MEDAL_ICONS.sky;
      const iw = (big ? 0.04 : 0.026) * pop;
      put("path", ids[0], icon, { anchor: "center", x: -tw / 2 - (iw * 0.9) / ar, y: y, w: Math.round(iw * 500) / 500, h: Math.round(iw * 500) / 500, fill: "#ffd35a", stroke: "#3a2a00", width: 0.0015 });
      text(ids[1], m.name, { anchor: "center", x: 0, y, size: Math.round(size * pop), color: big ? "#ffffff" : "#d8e2ee", weight: "italic 900" });
      text(ids[2], `+${m.points}`, { anchor: "center", x: tw / 2 + 0.03, y, size: big ? 18 : 13, color: "#ffd35a", weight: 900 });
    }

    // Live trick readout while airborne.
    const rr = p.rider;
    if (p.alive && !rr.grounded && rr.air > 0.25 && game.phase === "playing") {
      const spinDeg = Math.round(Math.abs(rr.spin) / (Math.PI / 4)) * 45;
      const flips = Math.abs(rr.flip) / (Math.PI * 2);
      const parts = [];
      if (spinDeg >= 90) parts.push(`${spinDeg}°`);
      if (flips > 0.2) parts.push(`${rr.flip > 0 ? "FRONT" : "BACK"}FLIP ${Math.round(flips * 10) / 10}`);
      text("air-t", parts.join("   ") || "AIRBORNE", { anchor: "center", x: 0, y: 0.3, size: 20, color: "#bfe6ff", weight: "italic 900" });
      text("air-s", `${rr.air.toFixed(1)} s`, { anchor: "center", x: 0, y: 0.335, size: 13, color: "#9fc3e6", weight: 800 });
    } else if (p.alive && rr.grind && game.phase === "playing") {
      // Live grind readout: the trick and the metres so far (points land when you come off).
      text("air-t", rr.grind.name, { anchor: "center", x: 0, y: 0.3, size: 20, color: "#ffd35a", weight: "italic 900" });
      text("air-s", `${rr.grind.dist.toFixed(1)} m`, { anchor: "center", x: 0, y: 0.335, size: 13, color: "#ffe9a8", weight: 800 });
    } else {
      drop("air-t");
      drop("air-s");
    }

    // Reload / ammo prompts.
    const lowMag = w.mag <= Math.ceil(w.def.mag * 0.25);
    if (p.alive && game.phase === "playing" && !w.reloading && lowMag) {
      const out = w.mag === 0 && w.reserve === 0;
      text("rl", out ? "NO AMMO  —  SWAP (Q)" : "R   RELOAD", { anchor: "center", x: 0, y: 0.1, size: 15, color: out ? "#ff6b5a" : "#ffe08a", weight: 900 });
    } else drop("rl");

    // Hold-breath meter on the scope.
    if (view.scoped && p.alive) {
      text("br-t", "SHIFT  HOLD BREATH", { anchor: "bottom", x: 0, y: 0.13, size: 13, color: "#e8eef8", weight: 900 });
      put("bar", "br-b", Math.round(clamp((p.loadout.steady ?? 4) / 4, 0, 1) * 20) / 20, { anchor: "bottom", x: 0, y: 0.115, w: 0.1, h: 0.004, color: "#e8eef8", back: "rgba(0,0,0,0.5)" });
    } else {
      drop("br-t");
      drop("br-b");
    }

    // Popups (tricks / eliminations): stack under-right of centre.
    const pops = game.popups.slice(-3);
    for (let i = 0; i < 3; i++) {
      const pp = pops[i];
      if (!pp) {
        drop(`pop-t${i}`);
        drop(`pop-i${i}`);
        drop(`pop-s${i}`);
        continue;
      }
      const y = 0.08 + i * 0.05;
      put("path", `pop-i${i}`, MOUNTAIN_ICON, { anchor: "center", x: 0.105 * ar - 0.06, y: y - 0.003, w: 0.038, h: 0.038, fill: pp.trick ? "#7fd1ff" : "#ff6b5a" });
      text(`pop-t${i}`, `${pp.text}  +${pp.points}`, { anchor: "center", x: 0.105 + 0.075, y, size: 22, color: pp.trick ? "#e9f6ff" : "#ffffff", weight: "italic 900" });
      if (pp.sub) text(`pop-s${i}`, pp.sub, { anchor: "center", x: 0.105 + 0.075, y: y + 0.03, size: 13, color: "#ffb0a8", weight: 700 });
      else drop(`pop-s${i}`);
    }

    // Ski-direction chevron: where your skis point when you look away from your line.
    if (p.alive && game.phase === "playing") {
      const rel = wrapAngle(p.rider.heading - p.lookYaw);
      if (Math.abs(rel) > 0.45) {
        const relQ = Math.round(rel / 0.1) * 0.1;
        // Screen angle: 0 = up; positive rel = skis to the left of the view.
        const a = -relQ;
        const rr = 0.245; // clear of the crosshair group (±0.15)
        const cx = Math.sin(a) * rr;
        const cy = -Math.cos(a) * rr;
        const pts = [[0, -40], [26, 30], [0, 14], [-26, 30]].map(([x, y]) => [50 + x * Math.cos(a) - y * Math.sin(a), 50 + x * Math.sin(a) + y * Math.cos(a)]);
        const d = `M${pts.map((q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(" L")} Z`;
        put("path", "hd-ski", d, { anchor: "center", x: cx / ar, y: cy, w: 0.035, h: 0.035, fill: "rgba(140,220,255,0.75)", stroke: "rgba(0,20,40,0.6)", width: 0.0015 });
      } else drop("hd-ski");
    } else drop("hd-ski");

    // Damage direction arcs.
    if (p.damageDir && game.time - p.damageDir.t < 1.2 && p.alive) {
      const dx = p.damageDir.x - p.rider.p.x;
      const dz = p.damageDir.z - p.rider.p.z;
      const toward = Math.atan2(-dx, -dz);
      const rel = wrapAngle(toward - p.lookYaw);
      // Screen angle: 0 = up; canvas arc angles start at +x and go clockwise.
      const a = -Math.PI / 2 - rel;
      const alpha = Math.round((1 - (game.time - p.damageDir.t) / 1.2) * 10) / 10;
      put("arc", "dmg-arc", { anchor: "center", x: 0, y: 0, r: 0.14, width: 0.014, start: a - 0.35, end: a + 0.35, fraction: 1, color: `rgba(255,40,30,${alpha})`, cap: "round" });
    } else drop("dmg-arc");

    // Messages.
    let msg = "";
    let sub = "";
    if (game.phase === "countdown") {
      const n = 3 - Math.floor(game.phaseT);
      text("cd-n", n > 0 ? String(n) : "", { anchor: "center", x: 0, y: -0.12, size: 80, color: "#ffffff", weight: "italic 900" });
      msg = "GET READY TO DROP IN";
    } else drop("cd-n");
    if (game.phase === "playing" && game.phaseT < 1.2 && p.alive) {
      text("cd-go", "DROP IN!", { anchor: "center", x: 0, y: -0.16, size: 44, color: GOLD, weight: "italic 900" });
    } else drop("cd-go");
    if (!p.alive && game.phase === "playing") {
      if (p.liftT > 0) {
        msg = "BACK TO THE SUMMIT";
        sub = "riding the express lift…";
      } else {
        const ki = p.killInfo;
        msg = ki?.by ? `ELIMINATED BY ${ki.by.toUpperCase()}` : ki?.weapon === "TREE" ? "YOU HIT A TREE" : "WIPED OUT";
        const detail = ki?.by ? `${ki.weapon}${ki.headshot ? "  •  HEADSHOT" : ""}${ki.dist ? `  •  ${ki.dist} m` : ""}  •  ${ki.health} HP LEFT` : "";
        sub = `${detail ? `${detail}\n` : ""}respawning in ${Math.max(1, Math.ceil(p.respawnT))}`;
      }
    }
    if (msg) {
      text("msg-a", msg, { anchor: "center", x: 0, y: 0.1, size: 30, color: "#ffffff", weight: "italic 900" });
      text("msg-b", sub, { anchor: "center", x: 0, y: 0.15, size: 16, color: "#cfe3ff", weight: 700 });
    } else {
      drop("msg-a");
      drop("msg-b");
    }
    // Settings toast.
    if (game.toast && game.time - game.toast.t < 1.6) text("msg-toast", game.toast.text, { anchor: "top", y: 0.16, size: 16, color: "#cfe3ff", weight: 800 });
    else drop("msg-toast");
    // Out of bounds warning.
    if (view.warning) text("msg-w", view.warning, { anchor: "top", y: 0.12, size: 18, color: "#ffcf5a", weight: 900 });
    else drop("msg-w");

    // Scoreboard on TAB.
    if (view.tab) {
      put("panel", "tab-bg", { anchor: "center", x: 0, y: 0.05, w: 1.25, h: 0.62, radius: 0.012, fill: "rgba(6,14,28,0.78)" });
      scoreboardRows(game, "tab-", 0.26);
    } else {
      for (const id of [...sent.keys()]) if (id.startsWith("tab-")) drop(id);
    }
  }

  return {
    update(game, view) {
      const s = game.phase;
      if (s !== screen) {
        // Switching screens: clear everything we drew.
        for (const id of [...sent.keys()]) drop(id);
        crossKey = "";
        screen = s;
      }
      if (s === "title") titleScreen(game);
      else if (s === "loadout") loadoutScreen(game);
      else if (s === "results") resultsScreen(game);
      else playScreen(game, view);
      fpsT++;
    },
    count: () => sent.size,
  };
}
