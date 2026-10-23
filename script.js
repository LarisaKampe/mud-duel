/* ==========================================================================
   script.js — how Mud Duel WORKS
   Config, input (keyboard, slingshot drag, touch buttons), fixed-timestep
   engine, fighters, mud balls, rival AI, rounds, and boot.
   Loaded last: after character.js (rig) and visual.js (drawing).
   ========================================================================== */
'use strict';

/* ---------- CONFIG: every tunable in one place (pixels, seconds) ---------- */
const VIEW_W = 960, VIEW_H = 540;
const GROUND_Y = 452;
const STEP = 1 / 60;

const ARENA = { mid: 480, fenceHalf: 6, fenceH: 46, leftMin: 60, leftMax: 440, rightMin: 520, rightMax: 900 };
const PUDDLES = { left: { x: 110, w: 100 }, right: { x: 850, w: 100 } };

const PHYS = {
  gravity: 1800, moveSpeed: 240, accel: 1900, friction: 14, airControl: 0.6,
  jumpV: 620, coyote: 0.08, jumpBuffer: 0.12,
  ballGravity: 900, ballR: 7,
  throwMin: 360, throwMax: 880,       // release speed range (px/s)
  chargeTime: 0.85,                   // keyboard: hold time for full power
  aimMin: -0.3, aimMax: 1.4, aimSpeed: 1.5,
};

const RULES = {
  hitBase: 18, hitPower: 14, headBonus: 8,   // mud added per hit; 100 = round lost
  maxAmmo: 3, scoopTime: 0.5, throwTime: 0.28, hitTime: 0.38, cooldown: 0.15,
  roundsToWin: 2,
  dragFull: 170, dragMin: 14,                // slingshot: px of pull for full power / to count
  maxSplatsPerFighter: 18, maxDecals: 70,
};

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STORE = { best: 'mudDuel.best' };
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
};

/* ---------- utils ---------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const pick = arr => arr[(Math.random() * arr.length) | 0];
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;  // ~N(0,1)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- INPUT ---------- */
class ButtonInput {
  constructor() { this.down = false; this.pressed = false; this.released = false; }
  set(down) {
    if (down && !this.down) this.pressed = true;
    if (!down && this.down) this.released = true;
    this.down = down;
  }
  consume() { this.pressed = false; this.released = false; }
}
const input = {
  left: new ButtonInput(), right: new ButtonInput(), jump: new ButtonInput(), scoop: new ButtonInput(),
  aimUp: new ButtonInput(), aimDown: new ButtonInput(), throw: new ButtonInput(),
  each(fn) { for (const k of ['left', 'right', 'jump', 'scoop', 'aimUp', 'aimDown', 'throw']) fn(this[k]); },
  consume() { this.each(b => b.consume()); },
  releaseAll() { this.each(b => b.set(false)); pointer.active = false; pointer.released = false; },
};
const KEYMAP = {
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  KeyW: 'jump', KeyS: 'scoop', ArrowUp: 'aimUp', ArrowDown: 'aimDown', Space: 'throw', KeyJ: 'throw',
};
// Slingshot aiming: press, pull back, release. Coordinates are in game pixels.
const pointer = { active: false, released: false, id: null, sx: 0, sy: 0, cx: 0, cy: 0 };

/* ---------- ENGINE: fixed 60 Hz simulation, interpolated rendering ---------- */
class Engine {
  constructor(step, update, render) { this.step = step; this.update = update; this.render = render; this.acc = 0; this.last = 0; this.running = false; }
  start() { if (this.running) return; this.running = true; this.last = performance.now(); requestAnimationFrame(this.loop); }
  loop = t => {
    let dt = (t - this.last) / 1000; this.last = t;
    dt = clamp(dt, 0, 0.25);
    this.acc += dt;
    let n = 0;
    while (this.acc >= this.step && n < 8) { this.update(this.step); this.acc -= this.step; n++; }
    this.render(this.acc / this.step);
    requestAnimationFrame(this.loop);
  };
}

/* ---------- PARTICLES: preallocated pool, no per-frame allocation ---------- */
class ParticlePool {
  constructor(n) {
    this.n = n; this.i = 0;
    for (const k of ['x', 'y', 'vx', 'vy', 'life', 'max', 'size', 'g']) this[k] = new Float32Array(n);
    this.col = new Array(n).fill('#000');
  }
  clear() { this.life.fill(0); }
  spawn(x, y, vx, vy, life, size, col, g) {
    const i = this.i; this.i = (i + 1) % this.n;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life; this.size[i] = size; this.col[i] = col; this.g[i] = g;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt; this.vy[i] += this.g[i] * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt;
      if (this.y[i] > GROUND_Y + 30) this.life[i] = 0;
    }
  }
}

/* ---------- ENTITIES ---------- */
class Fighter {
  constructor(side, rig) {
    this.side = side; this.rig = rig; this.sprites = {}; this.spriteKey = '';
    this.facing = side === 'left' ? 1 : -1;
    this.minX = side === 'left' ? ARENA.leftMin : ARENA.rightMin;
    this.maxX = side === 'left' ? ARENA.leftMax : ARENA.rightMax;
    this.puddle = PUDDLES[side];
    this.pose = newPose(); this.target = newPose();
    this.splats = [];
    this.intent = { move: 0, jump: false, scoop: false, aiming: false, aimStart: false, aim: 0.7, power: null, release: false, cancel: false };
    this.reset(side === 'left' ? 200 : 760);
  }
  reset(x) {
    this.x = this.prevX = x; this.y = this.prevY = GROUND_Y;
    this.vx = 0; this.vy = 0; this.grounded = true; this.coyote = 0; this.jumpBuf = 0;
    this.mud = 0; this.mudShown = 0; this.ammo = RULES.maxAmmo;
    this.state = 'free'; this.stateT = 0; this.stateDur = 0; this.cooldown = 0;
    this.charge = 0; this.aim = 0.7; this.runPhase = 0; this.blinkT = 1 + Math.random() * 3; this.face = 'normal';
    this.splats.length = 0; this.spriteKey = '';
    const p = newPose(); for (const k of POSE_KEYS) { this.pose[k] = p[k]; }
  }
  setState(s, dur = 0) { this.state = s; this.stateT = 0; this.stateDur = dur; }
  onPuddle() { return Math.abs(this.x - this.puddle.x) < this.puddle.w / 2; }
  // Where a throw leaves the hand. Deterministic, so the aim preview matches the real throw.
  spawnPoint(aim) {
    const s = this.rig.scale, r = this.rig.release;
    return { x: this.x + this.facing * (r[0] * s + Math.cos(aim) * 16), y: this.y + r[1] * s - Math.sin(aim) * 16 };
  }
  throwSpeed(power) { return PHYS.throwMin + power * (PHYS.throwMax - PHYS.throwMin); }
}

class Ball {
  constructor() { this.alive = false; this.x = this.y = this.prevX = this.prevY = this.vx = this.vy = 0; this.owner = null; this.power = 0; this.spin = 0; this.seen = false; }
}

/* ---------- RIVAL AI ----------
   Moves around its half, hides behind its hay bale, refills at its puddle,
   winds up visibly before each throw (so you can react), aims with some
   error, and sometimes dodges. Each match raises the level. */
class RivalAI {
  constructor() { this.setLevel(1); }
  setLevel(L) {
    this.L = L;
    this.throwEvery = Math.max(0.85, 2.3 - 0.22 * (L - 1));
    this.error = Math.max(14, 64 - 9 * (L - 1));
    this.dodgeChance = Math.min(0.8, 0.22 + 0.1 * (L - 1));
    this.windup = Math.max(0.28, 0.62 - 0.05 * (L - 1));
    this.predict = Math.min(1, 0.25 + 0.15 * (L - 1));
    this.reset();
  }
  reset() {
    this.throwT = 1.3 + Math.random(); this.moveT = 0; this.targetX = 760;
    this.windT = 0; this.stepT = 0; this.stepDir = 0; this.err = 0; this.style = 0.8;
  }
  think(dt, me, foe, game) {
    const it = me.intent;
    it.move = 0; it.jump = false; it.scoop = false; it.aiming = false; it.aimStart = false; it.release = false; it.cancel = false; it.power = null;
    this.moveT -= dt; this.throwT -= dt; this.stepT -= dt;

    // Dodge incoming mud (one decision per ball)
    for (const b of game.balls) {
      if (!b.alive || b.owner !== foe || b.seen) continue;
      const t = (me.x - b.x) / b.vx;
      if (t <= 0 || t > 0.7) continue;
      const yAt = b.y + b.vy * t + 0.5 * PHYS.ballGravity * t * t;
      if (yAt < me.y - 110 || yAt > me.y + 5) continue;
      b.seen = true;
      if (Math.random() < this.dodgeChance) {
        if (yAt > me.y - 60 && me.grounded) it.jump = true;
        else { this.stepDir = me.x < (me.minX + me.maxX) / 2 ? 1 : -1; this.stepT = 0.35; }
      }
    }

    // Where to stand
    if (me.ammo === 0) {
      this.targetX = me.puddle.x;
      if (me.onPuddle() && me.state === 'free') it.scoop = true;
    } else if (this.moveT <= 0) {
      this.moveT = 0.9 + Math.random() * 1.6;
      const cover = game.covers.find(c => c.side === me.side && c.hp > 0);
      this.targetX = cover && Math.random() < 0.35
        ? clamp(cover.x + 46 * -me.facing, me.minX, me.maxX)          // behind its rock
        : me.minX + 20 + Math.random() * (me.maxX - me.minX - 40);
    }
    let move = 0;
    if (this.stepT > 0) move = this.stepDir;
    else if (Math.abs(this.targetX - me.x) > 8) move = Math.sign(this.targetX - me.x);
    if (me.state === 'windup') move = 0;
    it.move = move;

    // Throwing: visible wind-up, then release
    if (me.state === 'free' && me.ammo > 0 && this.throwT <= 0 && me.grounded) {
      it.aiming = true; it.aimStart = true;
      this.windT = this.windup;
      this.throwT = this.throwEvery * (0.7 + Math.random() * 0.6);
      this.err = gauss() * this.error;
      this.style = Math.random() < 0.5 ? 0.42 + Math.random() * 0.15 : 0.85 + Math.random() * 0.25;
    }
    if (me.state === 'windup') {
      it.aiming = true;
      this.windT -= dt;
      const plan = this.solve(me, foe);
      it.aim = plan.aim;
      it.power = plan.power * clamp(1 - this.windT / this.windup, 0.15, 1);
      if (this.windT <= 0) { it.power = plan.power; it.release = true; }
    }
  }
  // Pick an angle and power that lands on the (predicted) player.
  solve(me, foe) {
    const g = PHYS.ballGravity;
    const angles = [this.style, 0.78, 1.0, 0.55, 0.35];
    for (const a of angles) {
      const sp = me.spawnPoint(a);
      const tx = foe.x + foe.vx * 0.8 * this.predict + this.err;
      const dx = Math.max(40, (tx - sp.x) * me.facing);
      const h = sp.y - (foe.y - 50);
      const c = Math.cos(a), den = 2 * c * c * (dx * Math.tan(a) - h);
      if (den <= 0) continue;
      const v = Math.sqrt(g * dx * dx / den);
      if (v >= PHYS.throwMin && v <= PHYS.throwMax) return { aim: a, power: (v - PHYS.throwMin) / (PHYS.throwMax - PHYS.throwMin) };
    }
    return { aim: 0.78, power: 1 };
  }
}

/* ---------- GAME ---------- */
class Game {
  constructor(events) {
    this.events = events;
    this.player = new Fighter('left', SKINS.kiko);
    this.rival = new Fighter('right', SKINS.boro);
    this.ai = new RivalAI();
    this.balls = Array.from({ length: 16 }, () => new Ball());
    this.particles = new ParticlePool(420);
    this.texts = Array.from({ length: 6 }, () => ({ life: 0, text: '', x: 0, y: 0, col: '#fff', size: 22 }));
    this.screenSplats = Array.from({ length: 8 }, () => ({ life: 0, x: 0, y: 0, r: 0, seed: 1 }));
    this.decals = []; this.covers = [];
    this.best = parseInt(store.get(STORE.best), 10) || 0;
    this.time = 0; this.kbAim = 0.7;
    this.level = 1;
    this.state = 'title';
    this.newMatch(1);
    this.state = 'title';
  }

  /* ----- match & round flow ----- */
  newMatch(level) {
    this.level = level; this.ai.setLevel(level);
    this.wins = { left: 0, right: 0 }; this.round = 0;
    this.decals.length = 0; this.events.onGroundReset(this.decals);
    this.newRound();
  }
  newRound() {
    this.round++;
    this.player.reset(200); this.rival.reset(760); this.ai.reset();
    for (const b of this.balls) b.alive = false;
    this.particles.clear();
    for (const t of this.texts) t.life = 0;
    for (const s of this.screenSplats) s.life = 0;
    this.covers = [
      { side: 'left', x: 250 + Math.random() * 110, w: 66, h0: 48, hp: 5, maxHp: 5, splats: [] },
      { side: 'right', x: 600 + Math.random() * 110, w: 66, h0: 48, hp: 5, maxHp: 5, splats: [] },
    ];
    this.state = 'intro'; this.stateT = 0;
    this.banner = { text: 'Round ' + this.round, sub: '', t: 0, dur: 1.4 };
    this.hitStop = 0; this.slowT = 0; this.timeScale = 1;
    this.shakeT = 0; this.shakeMag = 0; this.hint = { text: '', t: 0 };
    this.roundWinner = null;
  }
  endRound(winner) {
    const loser = winner === this.player ? this.rival : this.player;
    this.wins[winner.side]++;
    this.roundWinner = winner;
    this.state = 'roundEnd'; this.stateT = 0;
    loser.setState('lose'); winner.setState('win');
    loser.vx = 0; winner.vx = 0;
    this.slowT = 0.8; this.timeScale = 0.3;
    const matchOver = this.wins[winner.side] >= RULES.roundsToWin;
    this.banner = {
      text: matchOver ? (winner === this.player ? 'You win!' : winner.rig.name + ' wins!') : winner.rig.name + ' takes the round',
      sub: '', t: 0, dur: 2.6,
    };
  }
  start() { this.newMatch(1); input.releaseAll(); }

  /* ----- per-tick update ----- */
  update(dt) {
    this.time += dt;
    if (this.state === 'paused') { input.consume(); pointer.released = false; return; }

    if (this.hitStop > 0) {                                // brief freeze on impact
      this.hitStop -= dt;
      for (const f of [this.player, this.rival]) { f.prevX = f.x; f.prevY = f.y; }
      for (const b of this.balls) { b.prevX = b.x; b.prevY = b.y; }
      return;                                             // input kept for next tick
    }
    let sdt = dt;
    if (this.slowT > 0) { this.slowT -= dt; sdt = dt * this.timeScale; }
    this.stateT += dt;

    const fighting = this.state === 'fight';
    this.buildPlayerIntent(dt, fighting);
    if (fighting) this.ai.think(sdt, this.rival, this.player, this);
    else this.clearIntent(this.rival.intent);

    this.updateFighter(this.player, sdt, this.rival);
    this.updateFighter(this.rival, sdt, this.player);
    this.updateBalls(sdt);
    this.particles.update(sdt);
    for (const t of this.texts) if (t.life > 0) { t.life -= sdt; t.y -= 34 * sdt; }
    for (const s of this.screenSplats) if (s.life > 0) s.life -= dt;
    if (this.shakeT > 0) this.shakeT -= dt;
    if (this.hint.t > 0) this.hint.t -= dt;
    this.banner.t += dt;

    // Mud drips off very muddy fighters
    for (const f of [this.player, this.rival]) {
      if (f.mud > 45 && Math.random() < f.mud / 900) {
        this.particles.spawn(f.x + (Math.random() - 0.5) * 24, f.y - 20 - Math.random() * 60, 0, 20, 0.6, 3, '#5a3a1f', 900);
      }
    }

    // State machine
    if (this.state === 'intro' && this.stateT >= this.banner.dur) { this.state = 'fight'; this.stateT = 0; }
    if (this.state === 'roundEnd' && this.stateT >= 2.8) {
      if (this.wins[this.roundWinner.side] >= RULES.roundsToWin) this.finishMatch();
      else this.newRound();
    }
    input.consume(); pointer.released = false;
  }

  clearIntent(it) { it.move = 0; it.jump = false; it.scoop = false; it.aiming = false; it.aimStart = false; it.release = false; it.cancel = false; it.power = null; }

  buildPlayerIntent(dt, fighting) {
    const p = this.player, it = p.intent;
    this.clearIntent(it);
    if (!fighting) return;
    it.move = (input.right.down || touchInput.right ? 1 : 0) - (input.left.down || touchInput.left ? 1 : 0);
    it.jump = input.jump.pressed || touchInput.jumpPressed;
    it.scoop = input.scoop.pressed || touchInput.scoopPressed;
    touchInput.jumpPressed = false; touchInput.scoopPressed = false;

    if (input.aimUp.down) this.kbAim = Math.min(PHYS.aimMax, this.kbAim + PHYS.aimSpeed * dt);
    if (input.aimDown.down) this.kbAim = Math.max(PHYS.aimMin, this.kbAim - PHYS.aimSpeed * dt);

    if (pointer.active || pointer.released) {
      // Slingshot: throw direction is opposite to the pull
      const dx = pointer.sx - pointer.cx, dy = pointer.sy - pointer.cy;
      const len = Math.hypot(dx, dy);
      let a = Math.atan2(-dy, dx * p.facing);
      if (Math.abs(a) > Math.PI / 2) a = a > 0 ? PHYS.aimMax : PHYS.aimMin;
      it.aim = clamp(a, PHYS.aimMin, PHYS.aimMax);
      it.power = len < RULES.dragMin ? 0 : clamp(len / RULES.dragFull, 0.12, 1);
      it.aiming = true;
      it.aimStart = pointer.justStarted;
      if (pointer.released) { if (len >= RULES.dragMin) it.release = true; else it.cancel = true; }
      pointer.justStarted = false;
    } else {
      it.aiming = input.throw.down || input.throw.released;
      it.aimStart = input.throw.pressed;
      it.aim = this.kbAim;
      it.power = null;                                     // keyboard: hold to charge
      it.release = input.throw.released;
    }
  }

  updateFighter(f, dt, foe) {
    const it = f.intent;
    f.prevX = f.x; f.prevY = f.y;
    f.stateT += dt; f.cooldown -= dt;

    if ((f.state === 'hit' || f.state === 'throw') && f.stateT >= f.stateDur) f.setState('free');
    if (f.state === 'scoop' && f.stateT >= f.stateDur) {
      f.ammo = RULES.maxAmmo; f.setState('free');
      for (let i = 0; i < 10; i++) this.particles.spawn(f.x + f.facing * 14, GROUND_Y - 4, (Math.random() - 0.5) * 120, -80 - Math.random() * 160, 0.5, 4, '#6b4423', 900);
      if (f === this.player) this.say('Mud ready: ' + RULES.maxAmmo + ' throws');
    }
    const locked = f.state === 'hit' || f.state === 'throw' || f.state === 'scoop' || f.state === 'win' || f.state === 'lose';

    // Horizontal movement
    const move = locked ? 0 : it.move;
    const maxV = PHYS.moveSpeed * (f.state === 'windup' ? 0.45 : 1);
    if (move !== 0) {
      f.vx += move * PHYS.accel * (f.grounded ? 1 : PHYS.airControl) * dt;
      f.vx = clamp(f.vx, -maxV, maxV);
    } else if (f.grounded) {
      f.vx *= Math.exp(-PHYS.friction * dt);
      if (Math.abs(f.vx) < 4) f.vx = 0;
    }

    // Jump with coyote time + input buffer
    if (it.jump) f.jumpBuf = PHYS.jumpBuffer;
    f.jumpBuf -= dt;
    f.coyote = f.grounded ? PHYS.coyote : f.coyote - dt;
    if ((!locked) && f.jumpBuf > 0 && f.coyote > 0) {
      f.vy = -PHYS.jumpV; f.grounded = false; f.coyote = 0; f.jumpBuf = 0;
      this.dust(f.x, GROUND_Y, 5);
    }

    // Aim, charge, throw
    if (f.state === 'free' && it.aiming && f.cooldown <= 0) {
      if (f.ammo > 0) { f.setState('windup'); f.charge = 0; }
      else if (it.aimStart && f === this.player) this.say(f.onPuddle() ? 'Out of mud! Press S (or Scoop) to refill' : 'Out of mud! Refill at your puddle');
    }
    if (f.state === 'windup') {
      f.aim = it.aim;
      if (it.power !== null) f.charge = it.power;
      else f.charge = Math.min(1, f.charge + dt / PHYS.chargeTime);
      if (it.cancel || !it.aiming) f.setState('free');
      else if (it.release) this.throwBall(f);
    }

    // Scoop mud from the puddle
    if (f.state === 'free' && it.scoop && f.grounded) {
      if (f.ammo >= RULES.maxAmmo) { if (f === this.player) this.say('Your hands are already full of mud'); }
      else if (f.onPuddle()) { f.setState('scoop', RULES.scoopTime); f.vx = 0; }
      else if (f === this.player) this.say('Stand in your puddle to scoop mud');
    }

    // Integrate
    if (!f.grounded) f.vy += PHYS.gravity * dt;
    f.x += f.vx * dt; f.y += f.vy * dt;
    if (f.x < f.minX) { f.x = f.minX; f.vx = 0; }
    if (f.x > f.maxX) { f.x = f.maxX; f.vx = 0; }
    if (f.y >= GROUND_Y) {
      if (!f.grounded && f.vy > 300) this.dust(f.x, GROUND_Y, 6);
      f.y = GROUND_Y; f.vy = 0; f.grounded = true;
    } else f.grounded = false;

    // Animation
    if (f.grounded) f.runPhase += dt * f.vx * f.facing * 0.055;
    f.blinkT -= dt; if (f.blinkT < -0.12) f.blinkT = 2 + Math.random() * 3;
    f.face = f.state === 'hit' ? 'ouch' : f.state === 'windup' ? 'focus' : f.state === 'win' ? 'happy'
      : f.state === 'lose' ? 'sad' : f.blinkT < 0 ? 'blink' : 'normal';
    poseTarget(f, this.time, f.target);
    blendPose(f.pose, f.target, 1 - Math.exp(-18 * dt));
    f.mudShown += (f.mud - f.mudShown) * Math.min(1, 8 * dt);
  }

  throwBall(f) {
    const b = this.balls.find(x => !x.alive) || this.balls[0];
    const sp = f.spawnPoint(f.aim), v = f.throwSpeed(f.charge);
    b.alive = true; b.owner = f; b.power = f.charge; b.seen = false; b.spin = 0;
    b.x = b.prevX = sp.x; b.y = b.prevY = sp.y;
    b.vx = f.facing * Math.cos(f.aim) * v; b.vy = -Math.sin(f.aim) * v;
    f.ammo--; f.setState('throw', RULES.throwTime); f.cooldown = RULES.cooldown;
    for (let i = 0; i < 4; i++) this.particles.spawn(sp.x, sp.y, b.vx * 0.2 + (Math.random() - 0.5) * 60, b.vy * 0.2 + (Math.random() - 0.5) * 60, 0.3, 3, '#7a5230', 700);
  }

  updateBalls(dt) {
    const r = PHYS.ballR;
    for (const b of this.balls) {
      if (!b.alive) continue;
      b.prevX = b.x; b.prevY = b.y;
      b.vy += PHYS.ballGravity * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.spin += dt * b.vx * 0.05;
      if (Math.random() < 0.35) this.particles.spawn(b.x, b.y, b.vx * 0.05, b.vy * 0.05, 0.25, 2.5, '#6b4423', 400);

      // fighters
      for (const f of [this.player, this.rival]) {
        if (f === b.owner || !b.alive) continue;
        const rg = f.rig, hw = rg.hitbox.w * rg.scale / 2, top = f.y - rg.hitbox.h * rg.scale * (f.state === 'lose' ? 0.6 : 1);
        const nx = clamp(b.x, f.x - hw, f.x + hw), ny = clamp(b.y, top, f.y);
        if ((b.x - nx) ** 2 + (b.y - ny) ** 2 <= r * r) { this.hitFighter(f, b); b.alive = false; }
      }
      if (!b.alive) continue;

      // hay bales
      for (const cv of this.covers) {
        if (cv.hp <= 0) continue;
        const h = coverHeight(cv);
        if (Math.abs(b.x - cv.x) < cv.w / 2 + r && b.y > GROUND_Y - h - r) {
          cv.hp--;
          if (cv.splats.length < 8) cv.splats.push({ x: clamp(b.x - cv.x, -cv.w / 2 + 6, cv.w / 2 - 6), y: -Math.max(8, GROUND_Y - b.y), r: 6 + b.power * 3, seed: (Math.random() * 1e9) | 0 });
          this.burst(b.x, b.y, 10, b.vx);
          for (let i = 0; i < 6; i++) this.particles.spawn(b.x, b.y, (Math.random() - 0.5) * 200, -Math.random() * 200, 0.6, 3, '#a39d91', 700);
          if (cv.hp === 0) this.popText('Rock smashed!', cv.x, GROUND_Y - 70, '#fff1c2', 20);
          b.alive = false; break;
        }
      }
      if (!b.alive) continue;

      // middle fence
      if (Math.abs(b.x - ARENA.mid) < ARENA.fenceHalf + r && b.y > GROUND_Y - ARENA.fenceH - r) {
        this.burst(b.x, b.y, 10, b.vx); b.alive = false; continue;
      }
      // ground
      if (b.y >= GROUND_Y - 2) {
        this.addDecal(b.x, b.power);
        this.burst(b.x, GROUND_Y - 2, 8, b.vx);
        b.alive = false; continue;
      }
      if (b.x < -40 || b.x > VIEW_W + 40) b.alive = false;
    }
    // mid-air clashes
    for (let i = 0; i < this.balls.length; i++) {
      const a = this.balls[i]; if (!a.alive) continue;
      for (let j = i + 1; j < this.balls.length; j++) {
        const b = this.balls[j];
        if (!b.alive || a.owner === b.owner) continue;
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < (r * 2.2) ** 2) {
          a.alive = b.alive = false;
          this.burst((a.x + b.x) / 2, (a.y + b.y) / 2, 16, 0);
          this.popText('Clash!', (a.x + b.x) / 2, (a.y + b.y) / 2 - 20, '#fff1c2', 22);
          this.shake(3, 0.15);
        }
      }
    }
  }

  hitFighter(f, b) {
    if (this.state !== 'fight') { this.burst(b.x, b.y, 10, b.vx); return; }
    const rig = f.rig, S = rig.scale, hc = rig.head, hpv = rig.parts.head.pivot;
    const hp = rigPoint(rig, f.pose, 'head', hc.x - hpv[0], hc.y - hpv[1]);
    const hx = f.x + f.facing * S * hp.x, hy = f.y + S * hp.y;
    const head = (b.x - hx) ** 2 + (b.y - hy) ** 2 < (hc.r * S + PHYS.ballR + 2) ** 2;

    const dmg = RULES.hitBase + b.power * RULES.hitPower + (head ? RULES.headBonus : 0);
    f.mud = Math.min(100, f.mud + dmg);
    f.vx += Math.sign(b.vx) * 170;
    if (f.state !== 'win' && f.state !== 'lose') f.setState('hit', RULES.hitTime);
    this.addFighterSplat(f, b, head);
    this.burst(b.x, b.y, 18, b.vx);
    this.hitStop = 0.05 + b.power * 0.05;
    this.shake(4 + b.power * 5, 0.25);
    this.popText(head ? 'Mask full!' : pick(['Splat!', 'Splosh!', 'Gloop!']), f.x, f.y - 150, head ? '#ffd36b' : '#fff1c2', head ? 26 : 22);
    if (f === this.player) this.screenSplat(b.power + (head ? 0.5 : 0));
    if (f.mud >= 100) this.endRound(f === this.player ? this.rival : this.player);
  }

  // Store the splat in the hit part's own space so it moves with that part.
  // Store the splat in the hit part's own SVG pixels so it moves with that part.
  addFighterSplat(f, b, head) {
    const rig = f.rig, S = rig.scale;
    const rx = (b.x - f.x) / (S * f.facing), ry = (b.y - f.y) / S;
    const hipY = rig.joints.body.y + f.pose.bodyY;
    const part = head ? 'head' : ry > hipY + 10 ? (rx < 0 ? 'legBack' : 'legFront') : 'body';
    const P = rig.parts[part];
    let [x, y] = partPoint(rig, f.pose, part, rx, ry);
    x = lerp(x + P.pivot[0], P.centre[0], 0.3); y = lerp(y + P.pivot[1], P.centre[1], 0.3);
    const r = (6 + b.power * 5 + Math.random() * 2) / S;          // 6-13 game px, stored in SVG px
    f.splats.push({ part, x, y, r, seed: (Math.random() * 1e9) | 0 });
    if (f.splats.length > RULES.maxSplatsPerFighter) f.splats.shift();
    f.spriteKey = '';                                           // re-bake that fighter's mud
  }

  addDecal(x, power) {
    const d = { x, y: GROUND_Y + 3 + Math.random() * 16, r: 9 + power * 8 + Math.random() * 4, seed: (Math.random() * 1e9) | 0 };
    this.decals.push(d);
    if (this.decals.length > RULES.maxDecals) { this.decals.shift(); this.events.onGroundReset(this.decals); }
    else this.events.onDecal(d);
  }

  finishMatch() {
    const won = this.roundWinner === this.player;
    if (won && this.level > this.best) { this.best = this.level; store.set(STORE.best, String(this.best)); }
    this.state = 'over'; this.stateT = 0;
    this.events.onMatchOver(won, this);
  }

  /* ----- effects ----- */
  burst(x, y, n, vx) {
    for (let i = 0; i < n; i++) {
      this.particles.spawn(x, y, -vx * 0.15 + (Math.random() - 0.5) * 260, -60 - Math.random() * 220,
        0.4 + Math.random() * 0.4, 3 + Math.random() * 4, Math.random() < 0.7 ? '#6b4423' : '#8b5a30', 900);
    }
  }
  dust(x, y, n) {
    for (let i = 0; i < n; i++) this.particles.spawn(x + (Math.random() - 0.5) * 20, y - 2, (Math.random() - 0.5) * 140, -30 - Math.random() * 80, 0.35, 3, '#8a6a4a', 500);
  }
  shake(mag, t) { if (REDUCED_MOTION) return; this.shakeMag = Math.max(this.shakeT > 0 ? this.shakeMag : 0, mag); this.shakeT = t; this.shakeDur = t; }
  popText(text, x, y, col, size) {
    let slot = this.texts[0];
    for (const t of this.texts) if (t.life < slot.life) slot = t;
    Object.assign(slot, { text, x, y, col, size, life: 1.1 });
  }
  screenSplat(strength) {
    const n = 1 + Math.round(strength * 2);
    for (let i = 0; i < n; i++) {
      const s = this.screenSplats.find(q => q.life <= 0) || this.screenSplats[0];
      const edge = Math.random();
      s.x = edge < 0.5 ? (Math.random() < 0.5 ? 30 + Math.random() * 120 : VIEW_W - 30 - Math.random() * 120) : 100 + Math.random() * (VIEW_W - 200);
      s.y = edge < 0.5 ? 60 + Math.random() * (VIEW_H - 120) : (Math.random() < 0.5 ? 30 + Math.random() * 60 : VIEW_H - 30 - Math.random() * 60);
      s.r = 30 + Math.random() * 30 * (0.6 + strength);
      s.seed = (Math.random() * 1e9) | 0; s.life = 1.6;
    }
  }
  say(text) { this.hint.text = text; this.hint.t = 2.4; }
}
function coverHeight(cv) { return cv.h0 * (0.4 + 0.6 * cv.hp / cv.maxHp); }

/* ==========================================================================
   UI GLUE — screens, listeners (attached once), touch, boot
   ========================================================================== */
const touchInput = { left: false, right: false, jumpPressed: false, scoopPressed: false };

const game = new Game({
  onDecal: d => drawDecalOnGround(d),
  onGroundReset: decals => redrawGround(decals),
  onMatchOver: (won, g) => {
    $('over-title').textContent = won ? 'You win!' : g.rival.rig.name + ' wins';
    $('over-text').textContent = won
      ? g.rival.rig.name + ' is mud from mask to toes. The next rival throws faster and aims better.'
      : 'You ended up in the mud this time. Try hiding behind your rock and throwing while ' + g.rival.rig.name + ' refills.';
    $('btn-next').textContent = won ? 'Next rival' : 'Rematch';
    $('btn-next').dataset.level = won ? g.level + 1 : g.level;
    showScreen('over');
  },
});

function startMatch(level) { game.newMatch(level); input.releaseAll(); showScreen(null); }
function toTitle() { game.newMatch(1); game.state = 'title'; updateBest(); showScreen('title'); }
function updateBest() { $('best-title').textContent = game.best > 0 ? 'Rivals beaten: ' + game.best : ''; }
let pausedFrom = null;
function togglePause() {
  if (game.state === 'paused') { game.state = pausedFrom; showScreen(null); }
  else if (game.state === 'fight' || game.state === 'intro' || game.state === 'roundEnd') {
    pausedFrom = game.state; game.state = 'paused'; input.releaseAll(); showScreen('pause');
  }
}

$('btn-play').addEventListener('click', () => showScreen('howto'));
$('btn-back').addEventListener('click', () => showScreen('title'));
$('btn-start').addEventListener('click', () => startMatch(1));
$('btn-next').addEventListener('click', e => startMatch(parseInt(e.currentTarget.dataset.level, 10) || 1));
$('btn-resume').addEventListener('click', togglePause);
$('btn-quit-pause').addEventListener('click', toTitle);
$('btn-quit-over').addEventListener('click', toTitle);

const playing = () => game.state === 'fight' || game.state === 'intro' || game.state === 'roundEnd';
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' || e.code === 'KeyP') { if (playing() || game.state === 'paused') { e.preventDefault(); togglePause(); } return; }
  const k = KEYMAP[e.code];
  if (!k || !playing()) return;
  e.preventDefault();
  if (!e.repeat) input[k].set(true);
});
window.addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) input[k].set(false); });
window.addEventListener('blur', () => input.releaseAll());
document.addEventListener('visibilitychange', () => { if (document.hidden && playing()) togglePause(); });

// Slingshot aiming on the canvas (mouse, pen and touch)
function toGame(e) { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * VIEW_W / r.width, (e.clientY - r.top) * VIEW_H / r.height]; }
canvas.addEventListener('pointerdown', e => {
  if (!playing() || pointer.active || e.button > 0) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  [pointer.sx, pointer.sy] = toGame(e); pointer.cx = pointer.sx; pointer.cy = pointer.sy;
  pointer.id = e.pointerId; pointer.active = true; pointer.justStarted = true;
});
canvas.addEventListener('pointermove', e => { if (pointer.active && e.pointerId === pointer.id) [pointer.cx, pointer.cy] = toGame(e); });
const endPointer = e => {
  if (!pointer.active || e.pointerId !== pointer.id) return;
  [pointer.cx, pointer.cy] = toGame(e);
  pointer.active = false; pointer.released = true;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// On-screen buttons for touch
for (const btn of document.querySelectorAll('.touch button')) {
  const k = btn.dataset.k;
  const set = down => e => {
    e.preventDefault(); e.stopPropagation();
    if (k === 'pause') { if (down) togglePause(); return; }
    if (k === 'jump') { if (down) touchInput.jumpPressed = true; }
    else if (k === 'scoop') { if (down) touchInput.scoopPressed = true; }
    else touchInput[k] = down;
    btn.classList.toggle('on', down);
  };
  btn.addEventListener('pointerdown', e => { btn.setPointerCapture(e.pointerId); set(true)(e); });
  btn.addEventListener('pointerup', set(false));
  btn.addEventListener('pointercancel', set(false));
  btn.addEventListener('lostpointercapture', set(false));
  btn.addEventListener('contextmenu', e => e.preventDefault());
}

/* ---------- boot ---------- */
const playBtn = $('btn-play');
playBtn.disabled = true; playBtn.textContent = 'Loading art…';
resize();
updateBest();
loadAssets().then(() => {
  resize();
  playBtn.disabled = false; playBtn.textContent = 'Play';
  new Engine(STEP, dt => game.update(dt), render).start();
}).catch(err => {
  playBtn.textContent = 'Art files missing';
  $('best-title').textContent = 'Could not load ' + err.message + '. Keep the assets folder next to index.html.';
});
if (document.fonts && document.fonts.load) document.fonts.load('20px "Luckiest Guy"').catch(() => {});
