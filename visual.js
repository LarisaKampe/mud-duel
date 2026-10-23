/* ==========================================================================
   visual.js — everything you SEE
   Scenery (cached), the fighter renderer (poses the rig from character.js
   and paints mud splats onto each part), mud balls, particles, HUD, menu
   screens and resizing. Loaded after character.js, before script.js.
   ========================================================================== */
'use strict';

const $ = id => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const R = { S: 1, scale: 1, ground: null, groundCtx: null, puddle: null };
const FONT_DISPLAY = '"Luckiest Guy", "Arial Black", sans-serif';

/* ---------- art files (in the /assets folder next to index.html) ---------- */
const ASSET_FILES = {
  background: 'assets/background.jpg',
  puddle: 'assets/mud-puddle.svg',
};
for (const skin of Object.values(SKINS)) for (const part of Object.values(skin.parts)) ASSET_FILES[part.file] = 'assets/' + part.file + '.svg';
const IMG = {};
function loadAssets() {
  const inline = window.ASSET_INLINE || {};               // the single-file build embeds the art here
  return Promise.all(Object.entries(ASSET_FILES).map(([name, path]) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { IMG[name] = img; resolve(); };
    img.onerror = () => reject(new Error(path));
    img.src = inline[name] || path;
  })));
}
const FONT_BODY = '"Helvetica Neue", Helvetica, Arial, sans-serif';
let GROUND_TOP = 0;               // where the cached mud-floor image starts (set in buildArt)

function makeCanvas(w, h, S) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(w * S)); cv.height = Math.max(1, Math.ceil(h * S));
  const c = cv.getContext('2d'); c.scale(cv.width / w, cv.height / h);
  return { cv, c };
}

function rrPath(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
  const q = Math.min(r, w / 2, h / 2);
  c.moveTo(x + q, y); c.arcTo(x + w, y, x + w, y + h, q); c.arcTo(x + w, y + h, x, y + h, q);
  c.arcTo(x, y + h, x, y, q); c.arcTo(x, y, x + w, y, q); c.closePath();
}

/* ---------- mud splat shape (shared by fighters, bales, ground, screen) ---------- */
function splatPath(c, x, y, r, seed, squashY = 1) {
  const rnd = mulberry32(seed);
  c.beginPath();
  c.ellipse(x, y, r, r * squashY, 0, 0, Math.PI * 2);
  const n = 5 + ((rnd() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, d = r * (0.7 + rnd() * 0.6), rr = r * (0.22 + rnd() * 0.3);
    const bx = x + Math.cos(a) * d, by = y + Math.sin(a) * d * squashY;
    c.moveTo(bx + rr, by); c.ellipse(bx, by, rr, rr * squashY, 0, 0, Math.PI * 2);
  }
}
function drawSplat(c, x, y, r, seed, squashY = 1) {
  c.fillStyle = '#6a4424'; splatPath(c, x, y, r, seed, squashY); c.fill();
  c.fillStyle = 'rgba(160,110,60,.55)';
  c.beginPath(); c.ellipse(x - r * 0.3, y - r * 0.3 * squashY, r * 0.32, r * 0.22 * squashY, -0.5, 0, Math.PI * 2); c.fill();
}

/* ---------- cached layers ---------- */
function initScenery() {}

function buildArt() {
  GROUND_TOP = GROUND_Y - 8;   // GROUND_Y lives in script.js, so read it at call time
  const S = R.S;
  { // transparent layer the ground mud splats are painted onto (sits over the background)
    const { cv, c } = makeCanvas(VIEW_W, VIEW_H - GROUND_TOP, S);
    R.ground = cv; R.groundCtx = c;
  }
  { // puddle art, rasterised once (drawing an SVG every frame is slow)
    const img = IMG.puddle, w = 124, h = w * img.naturalHeight / img.naturalWidth;
    const { cv, c } = makeCanvas(w, h, S); c.drawImage(img, 0, 0, w, h);
    R.puddle = cv; R.puddleW = w; R.puddleH = h;
  }
  redrawGround(game ? game.decals : []);
}

function redrawGround(decals) {
  if (!R.groundCtx) return;
  R.groundCtx.clearRect(0, 0, VIEW_W, VIEW_H - GROUND_TOP);
  for (const d of decals) drawDecalOnGround(d);
}
function drawDecalOnGround(d) {
  if (!R.groundCtx) return;
  drawSplat(R.groundCtx, d.x, d.y - GROUND_TOP, d.r, d.seed, 0.32);
}

/* ---------- fighters ---------- */
// Each body part is rasterised once at screen resolution, with its mud splats
// painted "source-atop" so mud only lands on the artwork itself.
function bakePart(f, part) {
  const splats = f.splats.filter(q => q.part === part);
  const key = R.S + ':' + splats.length;
  const cached = f.sprites[part];
  if (cached && cached.key === key) return cached.cv;
  const P = f.rig.parts[part], img = IMG[P.file], s = f.rig.scale;
  const w = img.naturalWidth, h = img.naturalHeight;
  const { cv, c } = makeCanvas(w * s, h * s, R.S);
  c.scale(s, s);
  c.drawImage(img, 0, 0, w, h);
  if (splats.length) {
    c.globalCompositeOperation = 'source-atop';
    for (const q of splats) drawSplat(c, q.x, q.y, q.r, q.seed);
  }
  f.sprites[part] = { cv, key, w, h };
  return cv;
}

// Glowing pupils in the mask's eye holes: they look where the creature is going,
// blink, squint when hit, and turn happy or sad at the end of a round.
function drawEyes(c, f) {
  const rig = f.rig, pv = rig.parts.head.pivot, R0 = rig.eyeR;
  if (f.face === 'blink') return;
  const lookX = f.state === 'windup' ? R0 * 0.3 * Math.cos(f.aim) : clamp(f.vx * f.facing / 240, -1, 1) * R0 * 0.25;
  const lookY = f.state === 'windup' ? -R0 * 0.3 * Math.sin(f.aim) : clamp(f.vy / 600, -1, 1) * R0 * 0.25;
  c.lineCap = 'round';
  for (const [ex0, ey0] of rig.eyes) {
    const ex = ex0 - pv[0], ey = ey0 - pv[1];
    if (f.face === 'ouch') {
      const k = R0 * 0.32; c.strokeStyle = '#ffe9a8'; c.lineWidth = R0 * 0.16;
      c.beginPath(); c.moveTo(ex - k, ey - k); c.lineTo(ex + k, ey + k); c.moveTo(ex + k, ey - k); c.lineTo(ex - k, ey + k); c.stroke();
      continue;
    }
    if (f.face === 'happy') {
      c.strokeStyle = '#ffe9a8'; c.lineWidth = R0 * 0.18;
      c.beginPath(); c.arc(ex, ey + R0 * 0.15, R0 * 0.38, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
      continue;
    }
    const px = ex + lookX, py = ey + lookY + (f.face === 'sad' ? R0 * 0.3 : 0);
    const pr = R0 * (f.face === 'focus' ? 0.22 : 0.3);
    c.fillStyle = 'rgba(255, 225, 140, .28)'; c.beginPath(); c.arc(px, py, pr * 1.9, 0, Math.PI * 2); c.fill();
    c.fillStyle = f.face === 'focus' ? '#fff6d0' : '#ffe9a8'; c.beginPath(); c.arc(px, py, pr, 0, Math.PI * 2); c.fill();
  }
}

function drawFighter(c, f, alpha) {
  const x = lerp(f.prevX, f.x, alpha), y = lerp(f.prevY, f.y, alpha);
  const rig = f.rig, pose = f.pose;
  const air = clamp((GROUND_Y - y) / 160, 0, 0.6);
  c.fillStyle = 'rgba(35,20,8,.3)';
  c.beginPath(); c.ellipse(x, GROUND_Y + 2, 26 * (1 - air), 5 * (1 - air), 0, 0, Math.PI * 2); c.fill();

  c.save();
  c.translate(x, y);
  c.scale(rig.scale * f.facing, rig.scale);          // now in SVG px; mirrored when facing left
  // While winding up and throwing, the throwing arm comes in front of the mask so the throw is readable
  const order = f.state === 'windup' || f.state === 'throw' ? rig.orderThrow : rig.order;
  for (const part of order) {
    const cv = bakePart(f, part), sp = f.sprites[part], P = rig.parts[part], j = rig.joints[part];
    c.save();
    c.translate(pose.bodyX, pose.bodyY);
    if (j.parent === 'body') { const b = rig.joints.body; c.translate(b.x, b.y); c.rotate(pose.body); }
    c.translate(j.x, j.y); c.rotate(pose[part]);
    c.drawImage(cv, -P.pivot[0], -P.pivot[1], sp.w, sp.h);
    if (part === 'head') drawEyes(c, f);
    if (part === 'armFront' && f.state === 'windup') {        // mud ball held up, ready to throw
      const r = (PHYS.ballR + 2) / rig.scale, hx = P.hand[0] - P.pivot[0], hy = P.hand[1] - P.pivot[1];
      c.fillStyle = '#6b4423'; c.beginPath(); c.arc(hx, hy, r, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#2e1d12'; c.lineWidth = 2 / rig.scale; c.stroke();
      c.fillStyle = 'rgba(190,140,90,.75)'; c.beginPath(); c.arc(hx - r * 0.3, hy - r * 0.35, r * 0.32, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }
  c.restore();
}

/* ---------- arena props ---------- */
function drawPuddle(c, pd, g, t, glow) {
  const y = GROUND_Y + 10;
  c.drawImage(R.puddle, pd.x - R.puddleW / 2, y - R.puddleH / 2, R.puddleW, R.puddleH);
  const ph = (t * 0.7) % 1;                              // slow ripple
  c.strokeStyle = 'rgba(255,240,215,' + (0.35 * (1 - ph)) + ')'; c.lineWidth = 1.5;
  c.beginPath(); c.ellipse(pd.x + 10, y, 4 + ph * 22, 1.2 + ph * 4, 0, 0, Math.PI * 2); c.stroke();
  if (glow) {                                            // "refill here" cue
    const b = Math.sin(t * 6) * 4;
    c.fillStyle = '#fff1c2'; c.strokeStyle = '#2e1d12'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(pd.x, y - 18 + b); c.lineTo(pd.x - 9, y - 32 + b); c.lineTo(pd.x + 9, y - 32 + b); c.closePath(); c.fill(); c.stroke();
    c.font = '15px ' + FONT_DISPLAY; c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.lineWidth = 4; c.strokeText('Refill here', pd.x, y - 36 + b); c.fillText('Refill here', pd.x, y - 36 + b);
  }
}

// Middle divider: a carved stake bound with rope, in the background's palette
function drawFence(c) {
  const x = ARENA.mid, top = GROUND_Y - ARENA.fenceH;
  c.fillStyle = 'rgba(35,20,8,.3)'; c.beginPath(); c.ellipse(x + 3, GROUND_Y + 3, 16, 4, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#8a5a2b'; c.strokeStyle = '#2e1d12'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(x - 8, GROUND_Y + 3); c.lineTo(x - 8, top + 8); c.lineTo(x, top - 6); c.lineTo(x + 8, top + 8); c.lineTo(x + 8, GROUND_Y + 3); c.closePath(); c.fill(); c.stroke();
  c.fillStyle = '#6b4423'; c.fillRect(x - 7, top + 8, 5, ARENA.fenceH - 6);
  c.fillStyle = '#d9c28a';
  for (const ry of [top + 12, top + 30]) { rrPath(c, x - 10, ry, 20, 6, 3); c.fill(); c.stroke(); }
  c.fillStyle = '#2e1d12';                                // carved eyes
  c.fillRect(x - 5, top + 21, 3, 3); c.fillRect(x + 2, top + 21, 3, 3);
}

function rockPath(c, cv) {
  const h = coverHeight(cv), w = cv.w, x = cv.x, y = GROUND_Y + 4;
  c.beginPath();
  c.moveTo(x - w / 2, y);
  c.bezierCurveTo(x - w / 2 - 6, y - h * 0.55, x - w * 0.3, y - h * 1.02, x - w * 0.02, y - h);
  c.bezierCurveTo(x + w * 0.32, y - h * 0.98, x + w / 2 + 6, y - h * 0.5, x + w / 2, y);
  c.closePath();
}
function drawCover(c, cv) {
  if (cv.hp <= 0) return;
  const h = coverHeight(cv), x = cv.x, y = GROUND_Y + 4, w = cv.w;
  c.fillStyle = 'rgba(35,20,8,.3)'; c.beginPath(); c.ellipse(x + 4, GROUND_Y + 4, w / 2 + 6, 6, 0, 0, Math.PI * 2); c.fill();
  const g = c.createLinearGradient(0, y - h, 0, y);
  g.addColorStop(0, '#b3ad9f'); g.addColorStop(1, '#7e796d');
  c.fillStyle = g; rockPath(c, cv); c.fill();
  c.save(); rockPath(c, cv); c.clip();
  c.fillStyle = 'rgba(255,255,255,.14)'; c.beginPath(); c.ellipse(x - w * 0.2, y - h * 0.62, w * 0.18, h * 0.16, -0.4, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#7f9c3d';                                // moss cap
  c.beginPath(); c.moveTo(x - w, y - h * 0.62);
  for (let i = 0; i <= 6; i++) c.quadraticCurveTo(x - w / 2 + i * w / 6 - w / 12, y - h * 0.48, x - w / 2 + i * w / 6, y - h * (0.66 + (i % 2) * 0.06));
  c.lineTo(x + w, y - h * 1.2); c.lineTo(x - w, y - h * 1.2); c.closePath(); c.fill();
  c.fillStyle = '#a3bf55'; c.beginPath(); c.ellipse(x - w * 0.08, y - h * 0.9, w * 0.22, h * 0.07, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(46,29,18,.65)'; c.lineWidth = 1.6;  // cracks appear as it takes hits
  const r = mulberry32(cv.side === 'left' ? 21 : 22);
  for (let i = 0; i < cv.maxHp - cv.hp; i++) {
    let cx = x - w * 0.35 + r() * w * 0.7, cy = y - h * (0.2 + r() * 0.5);
    c.beginPath(); c.moveTo(cx, cy);
    for (let k = 0; k < 3; k++) { cx += (r() - 0.5) * 14; cy += 5 + r() * 6; c.lineTo(cx, cy); }
    c.stroke();
  }
  for (const s of cv.splats) drawSplat(c, x + s.x, Math.max(y - h + 8, GROUND_Y + s.y), s.r, s.seed);
  c.restore();
  c.strokeStyle = '#2e1d12'; c.lineWidth = 2; rockPath(c, cv); c.stroke();
}

function drawBall(c, b, alpha) {
  const x = lerp(b.prevX, b.x, alpha), y = lerp(b.prevY, b.y, alpha);
  const sp = Math.hypot(b.vx, b.vy), st = Math.min(0.35, sp / 2600);
  c.save(); c.translate(x, y); c.rotate(Math.atan2(b.vy, b.vx)); c.scale(1 + st, 1 - st * 0.6);
  c.fillStyle = '#6b4423'; c.beginPath(); c.arc(0, 0, PHYS.ballR, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#2e1d12'; c.lineWidth = 1.6; c.stroke();
  c.fillStyle = 'rgba(190,140,90,.7)'; c.beginPath(); c.arc(-2, -2.5, 2.4, 0, Math.PI * 2); c.fill();
  c.restore();
}

function drawAimPreview(c, g) {
  const p = g.player;
  if (p.state !== 'windup') return;
  const sp = p.spawnPoint(p.aim), v = p.throwSpeed(p.charge);
  let vx = p.facing * Math.cos(p.aim) * v, vy = -Math.sin(p.aim) * v, x = sp.x, y = sp.y;
  const dt = 0.05;
  for (let i = 0; i < 14; i++) {
    vy += PHYS.ballGravity * dt; x += vx * dt; y += vy * dt;
    if (y > GROUND_Y) break;
    c.globalAlpha = 0.85 * (1 - i / 14);
    c.fillStyle = '#fff6dd'; c.beginPath(); c.arc(x, y, 3.2 - i * 0.12, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  if (pointer.active) {                                 // the slingshot band
    c.strokeStyle = 'rgba(255,246,221,.6)'; c.lineWidth = 2; c.setLineDash([5, 5]);
    c.beginPath(); c.moveTo(pointer.sx, pointer.sy); c.lineTo(pointer.cx, pointer.cy); c.stroke(); c.setLineDash([]);
    c.beginPath(); c.arc(pointer.sx, pointer.sy, 9, 0, Math.PI * 2); c.stroke();
  }
}

/* ---------- HUD ---------- */
function drawMeter(c, f, x, right, wins, g) {
  const w = 300, y = 16;
  c.fillStyle = 'rgba(46,29,18,.62)'; rrPath(c, x, y, w, 58, 14); c.fill();
  c.textBaseline = 'top'; c.font = '22px ' + FONT_DISPLAY; c.fillStyle = '#fff6dd';
  c.textAlign = right ? 'right' : 'left';
  const label = f === g.player ? f.rig.name + ' (you)' : f.rig.name + '  Lv ' + g.level;
  c.fillText(label, right ? x + w - 14 : x + 14, y + 7);
  // rounds won
  for (let i = 0; i < RULES.roundsToWin; i++) {
    const px = right ? x + 18 + i * 20 : x + w - 18 - i * 20;
    c.fillStyle = i < wins ? '#ffd36b' : 'rgba(255,246,221,.2)';
    c.beginPath(); c.arc(px, y + 18, 7, 0, Math.PI * 2); c.fill();
  }
  // mud meter
  const bx = x + 14, bw = w - 28, by = y + 36;
  c.fillStyle = 'rgba(255,246,221,.18)'; rrPath(c, bx, by, bw, 12, 6); c.fill();
  const fillW = bw * clamp(f.mudShown / 100, 0, 1);
  if (fillW > 1) { c.fillStyle = f.mud > 70 ? '#8e4b1c' : '#7a5230'; rrPath(c, right ? bx + bw - fillW : bx, by, fillW, 12, 6); c.fill(); }
  // ammo
  for (let i = 0; i < RULES.maxAmmo; i++) {
    const ax = right ? x + w - 18 - i * 22 : x + 18 + i * 22, ay = y + 74;
    c.fillStyle = i < f.ammo ? '#6b4423' : 'rgba(46,29,18,.25)';
    c.strokeStyle = i < f.ammo ? '#2e1d12' : 'rgba(46,29,18,.3)'; c.lineWidth = 2;
    c.beginPath(); c.arc(ax, ay, 7, 0, Math.PI * 2); c.fill(); c.stroke();
  }
}

function drawHUD(c, g) {
  if (g.state === 'title') return;
  drawMeter(c, g.player, 16, false, g.wins.left, g);
  drawMeter(c, g.rival, VIEW_W - 316, true, g.wins.right, g);

  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const t of g.texts) {                           // floating hit words
    if (t.life <= 0) continue;
    c.globalAlpha = Math.min(1, t.life * 2);
    c.font = t.size + 'px ' + FONT_DISPLAY;
    c.lineWidth = 5; c.strokeStyle = '#2e1d12'; c.strokeText(t.text, t.x, t.y);
    c.fillStyle = t.col; c.fillText(t.text, t.x, t.y);
  }
  c.globalAlpha = 1;

  const bn = g.banner;                                  // round banners
  if (bn && bn.t < bn.dur && (g.state === 'intro' || g.state === 'roundEnd')) {
    const intro = g.state === 'intro';
    const text = intro && bn.t > bn.dur - 0.45 ? 'Throw!' : bn.text;
    const pop = Math.min(1, bn.t * 5), a = Math.min(1, (bn.dur - bn.t) * 3);
    c.globalAlpha = a;
    c.save(); c.translate(VIEW_W / 2, 200); c.scale(0.7 + 0.3 * pop, 0.7 + 0.3 * pop);
    c.font = '64px ' + FONT_DISPLAY; c.lineWidth = 10; c.strokeStyle = '#2e1d12'; c.strokeText(text, 0, 0);
    c.fillStyle = '#ffc93c'; c.fillText(text, 0, 0);
    c.restore(); c.globalAlpha = 1;
  }

  if (g.hint.t > 0 && g.hint.text) {                    // contextual hint
    c.globalAlpha = Math.min(1, g.hint.t * 3);
    c.font = '800 16px ' + FONT_BODY;
    const w = c.measureText(g.hint.text).width + 32;
    c.fillStyle = 'rgba(46,29,18,.8)'; rrPath(c, VIEW_W / 2 - w / 2, VIEW_H - 50, w, 34, 17); c.fill();
    c.fillStyle = '#fff6dd'; c.fillText(g.hint.text, VIEW_W / 2, VIEW_H - 33);
    c.globalAlpha = 1;
  }
}

/* ---------- frame ---------- */
function render(alpha) {
  const c = ctx, g = game, t = g.time;
  c.setTransform(R.S, 0, 0, R.S, 0, 0);
  if (!R.ground) return;                                 // art still loading
  c.drawImage(IMG.background, 0, 0, VIEW_W, VIEW_H);

  c.save();
  if (g.shakeT > 0 && g.state !== 'paused') {
    const m = g.shakeMag * (g.shakeT / (g.shakeDur || 1));
    c.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
  }
  c.drawImage(R.ground, 0, GROUND_TOP, VIEW_W, VIEW_H - GROUND_TOP);
  const needMud = g.state === 'fight' && g.player.ammo === 0 && !g.player.onPuddle();
  drawPuddle(c, PUDDLES.left, g, t, needMud);
  drawPuddle(c, PUDDLES.right, g, t + 1.7, false);
  drawFence(c);
  drawFighter(c, g.rival, alpha);
  drawFighter(c, g.player, alpha);
  for (const cv of g.covers) drawCover(c, cv);          // bales sit in front, so you can hide
  for (const b of g.balls) if (b.alive) drawBall(c, b, alpha);
  const P = g.particles;
  for (let i = 0; i < P.n; i++) {
    if (P.life[i] <= 0) continue;
    const a = P.life[i] / P.max[i], s = P.size[i] * (0.5 + 0.5 * a);
    c.globalAlpha = Math.min(1, a * 1.5); c.fillStyle = P.col[i];
    c.beginPath(); c.arc(P.x[i], P.y[i], s / 2, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  drawAimPreview(c, g);
  c.restore();

  for (const s of g.screenSplats) {                      // mud on "the camera"
    if (s.life <= 0) continue;
    c.globalAlpha = Math.min(0.9, s.life);
    drawSplat(c, s.x, s.y + (1.6 - s.life) * 18, s.r, s.seed);
  }
  c.globalAlpha = 1;
  drawHUD(c, g);
}

/* ---------- screens ---------- */
const stage = $('stage');
const screens = { title: $('screen-title'), howto: $('screen-howto'), pause: $('screen-pause'), over: $('screen-over') };
function showScreen(name) {
  for (const k in screens) screens[k].hidden = k !== name;
  stage.dataset.state = name || 'playing';
  const focusTarget = { title: $('btn-play'), howto: $('btn-start'), pause: $('btn-resume'), over: $('btn-next') }[name];
  if (focusTarget) focusTarget.focus({ preventScroll: true });
  else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

/* ---------- sizing: fit 16:9, render at device pixel density ---------- */
const appEl = $('app');
function resize() {
  const box = appEl.getBoundingClientRect();
  const s = Math.max(0.2, Math.min(box.width / VIEW_W, box.height / VIEW_H));
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  R.scale = s; R.S = s * dpr;
  stage.style.width = VIEW_W * s + 'px'; stage.style.height = VIEW_H * s + 'px';
  stage.style.setProperty('--u', s.toFixed(3));
  canvas.width = Math.round(VIEW_W * R.S); canvas.height = Math.round(VIEW_H * R.S);
  if (IMG.background) buildArt();
}
window.addEventListener('resize', resize);
