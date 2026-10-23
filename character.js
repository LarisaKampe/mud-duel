/* ==========================================================================
   character.js — the character RIGS
   Each fighter is 6 image parts (your SVGs in /assets) joined at pivots and
   posed by rotating the parts. All numbers here are in the SVG's own pixels
   ("design px"). Origin (0, 0) is the middle of the feet on the ground, y
   grows DOWN. `scale` converts design px to game px.

   To tweak a character:
   - part.pivot  = point inside that SVG the part rotates around
   - joints      = where that pivot sits (legs/body relative to the feet,
                   arms/head relative to the body's pivot)
   - part.rest   = which way the arm hangs in the drawing (radians, 0 = down)
   ========================================================================== */
"use strict";

const SKINS = {
  kiko: {
    name: "Kiko",
    scale: 0.29,
    unit: 1.9, // pose offsets (bob, crouch, sit) scale with hip height
    lean: 0.55,
    legSwing: 0.4,
    armSwing: 0.7,
    joints: {
      body: { parent: "root", x: 0, y: -83 },
      legBack: { parent: "root", x: -44, y: -83 },
      legFront: { parent: "root", x: 45, y: -83 },
      armBack: { parent: "body", x: -56, y: -88 },
      armFront: { parent: "body", x: 56, y: -92 },
      head: { parent: "body", x: -1, y: -114 },
    },
    parts: {
      body: { file: "character1-body", pivot: [126, 136], centre: [125, 78] },
      head: { file: "character1-head", pivot: [221, 338], centre: [221, 300] },
      armBack: {
        file: "character1-arm-left",
        pivot: [84, 16],
        centre: [50, 80],
        rest: 0.45,
      },
      armFront: {
        file: "character1-arm-right",
        pivot: [16, 14],
        centre: [32, 72],
        rest: -0.26,
        hand: [50, 132],
      },
      legBack: {
        file: "character1-leg-left",
        pivot: [32, 8],
        centre: [32, 45],
      },
      legFront: {
        file: "character1-leg-right",
        pivot: [28, 8],
        centre: [28, 45],
      },
    },
    order: ["legBack", "legFront", "armBack", "armFront", "body", "head"],
    orderThrow: ["legBack", "legFront", "armBack", "body", "head", "armFront"],
    hitbox: { w: 170, h: 400 },
    head: { x: 221, y: 300, r: 100 }, // head-hit circle, in head SVG px
    eyes: [
      [190, 306],
      [258, 306],
    ],
    eyeR: 19,
    release: [110, -275], // where throws leave the raised claw
  },
  boro: {
    name: "Boro",
    scale: 0.31,
    unit: 2.07,
    lean: 0.55,
    legSwing: 0.4,
    armSwing: 0.7,
    joints: {
      body: { parent: "root", x: 0, y: -73 },
      legBack: { parent: "root", x: -44, y: -83 },
      legFront: { parent: "root", x: 45, y: -83 },
      armBack: { parent: "body", x: -51, y: -110 },
      armFront: { parent: "body", x: 69, y: -110 },
      head: { parent: "body", x: 20, y: -140 },
    },
    parts: {
      body: { file: "character2-body", pivot: [75, 132], centre: [75, 82] },
      head: { file: "character2-head", pivot: [168, 256], centre: [168, 190] },
      armBack: {
        file: "character2-arm-left",
        pivot: [76, 14],
        centre: [45, 80],
        rest: 0.44,
      },
      armFront: {
        file: "character2-arm-right",
        pivot: [14, 14],
        centre: [30, 75],
        rest: -0.29,
        hand: [52, 146],
      },
      legBack: {
        file: "character2-leg-left",
        pivot: [44, 6],
        centre: [42, 45],
      },
      legFront: {
        file: "character2-leg-left-1",
        pivot: [32, 8],
        centre: [32, 42],
      },
    },
    order: ["legBack", "legFront", "armBack", "armFront", "body", "head"],
    orderThrow: ["legBack", "legFront", "armBack", "body", "head", "armFront"],
    hitbox: { w: 160, h: 370 },
    head: { x: 168, y: 190, r: 92 },
    eyes: [
      [123, 187],
      [207, 187],
    ],
    eyeR: 16,
    release: [120, -285],
  },
};

/* ---------- rig math (all in design px, pivot-relative part space) ---------- */
const POSE_KEYS = [
  "body",
  "bodyX",
  "bodyY",
  "head",
  "armBack",
  "armFront",
  "legBack",
  "legFront",
];
function newPose() {
  return {
    body: 0,
    bodyX: 0,
    bodyY: 0,
    head: 0,
    armBack: 0,
    armFront: 0,
    legBack: 0,
    legFront: 0,
  };
}
function rotPt(x, y, a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

// Point in a part's space (relative to its pivot) → rig space
function rigPoint(rig, pose, part, lx, ly) {
  let x = lx,
    y = ly;
  if (part !== "body") {
    [x, y] = rotPt(x, y, pose[part]);
    const j = rig.joints[part];
    x += j.x;
    y += j.y;
    if (j.parent === "root") return { x: x + pose.bodyX, y: y + pose.bodyY };
  }
  [x, y] = rotPt(x, y, pose.body);
  const b = rig.joints.body;
  return { x: x + b.x + pose.bodyX, y: y + b.y + pose.bodyY };
}

// Rig space → a part's space (relative to its pivot). Inverse of rigPoint.
function partPoint(rig, pose, part, rx, ry) {
  const j = rig.joints[part],
    b = rig.joints.body;
  if (j.parent === "root" && part !== "body")
    return rotPt(rx - pose.bodyX - j.x, ry - pose.bodyY - j.y, -pose[part]);
  let [x, y] = rotPt(rx - pose.bodyX - b.x, ry - pose.bodyY - b.y, -pose.body);
  if (part === "body") return [x, y];
  return rotPt(x - j.x, y - j.y, -pose[part]);
}

const limbAngle = (dx, dy) => Math.atan2(-dx, dy); // angle that points a hanging limb along (dx, dy)

/* ---------- poses ----------
   Angles rotate each part away from how it's drawn (0 = as drawn).
   Positive = clockwise. Offsets are multiplied by rig.unit. */
function poseTarget(f, t, out) {
  const rig = f.rig;
  for (const k of POSE_KEYS) out[k] = 0;
  const k = f.stateDur ? Math.min(1, f.stateT / f.stateDur) : 0;
  const L = rig.legSwing,
    A = rig.armSwing;

  switch (f.state) {
    case "windup": {
      out.body = -0.1 - 0.12 * f.charge;
      out.armFront = -2.0 - 0.5 * f.charge; // throwing arm raised beside the head (visible warning)
      out.armBack = 0.9 + 0.3 * f.charge; // other arm out for balance
      out.head = -0.15 * f.aim;
      out.legBack = 0.32 * L;
      out.legFront = -0.28 * L;
      out.bodyY = 2 + f.charge * 2;
      break;
    }
    case "throw":
      out.body = 0.28 - 0.15 * k;
      out.armFront = -1.1 + 0.9 * k; // snaps forward, then relaxes
      out.armBack = 0.6;
      out.legBack = 0.35 * L;
      out.legFront = -0.3 * L;
      out.head = 0.1;
      break;
    case "hit": {
      const wob = Math.sin(t * 40) * 0.12 * (1 - k);
      out.body = -0.38 * (1 - k * 0.6) + wob;
      out.head = -0.3 * (1 - k) + wob;
      out.armBack = 1.6;
      out.armFront = -1.6; // arms fly out
      out.legFront = -0.35 * L;
      out.legBack = 0.2 * L;
      break;
    }
    case "scoop": {
      const dip = Math.sin(Math.min(1, k * 1.4) * Math.PI);
      out.bodyY = 10;
      out.legBack = 0.69;
      out.legFront = -0.69;
      out.body = 0.75;
      out.head = -0.35;
      out.armFront = -0.2 - 0.3 * dip; // reach into the puddle
      out.armBack = 0.3;
      break;
    }
    case "win": {
      const hop = Math.abs(Math.sin(t * 8));
      out.bodyY = -hop * 8;
      out.armBack = 2.1 + Math.sin(t * 16) * 0.2; // both arms up and out
      out.armFront = -2.1 - Math.sin(t * 16) * 0.2;
      out.legBack = 0.15 * hop;
      out.legFront = -0.15 * hop;
      out.head = Math.sin(t * 8) * 0.08;
      break;
    }
    case "lose":
      out.bodyY = 22;
      out.legFront = -1.3;
      out.legBack = 1.3; // legs splayed, sat in the mud
      out.body = -0.08;
      out.head = 0.25;
      out.armBack = 0.5;
      out.armFront = -0.5;
      break;
    default:
      if (!f.grounded) {
        // airborne
        const falling = Math.max(0, Math.min(1, f.vy / 600));
        out.legBack = 0.45 * L;
        out.legFront = -0.6 * L;
        out.armBack = 1.4 - falling * 0.4 + Math.sin(t * 20) * 0.15 * falling;
        out.armFront = -1.4 + falling * 0.4 - Math.sin(t * 20) * 0.15 * falling;
        out.body = 0.05;
      } else if (Math.abs(f.vx) > 20) {
        // running
        const speed = Math.min(1, Math.abs(f.vx) / 240),
          ph = f.runPhase,
          s = Math.sin(ph);
        const back = f.vx * f.facing < 0 ? -1 : 1;
        out.legBack = s * 0.75 * speed * L;
        out.legFront = -s * 0.75 * speed * L;
        out.armBack = -s * 0.7 * speed * A;
        out.armFront = s * 0.7 * speed * A;
        out.body = 0.12 * speed * back;
        out.bodyY = -Math.abs(Math.cos(ph)) * 4 * speed;
        out.head = Math.sin(ph) * 0.06 * speed; // bobbling mask
      } else {
        // idle breathing
        out.bodyY = Math.sin(t * 2.2) * 0.8;
        out.armBack = 0.06 + Math.sin(t * 2.2) * 0.04;
        out.armFront = -0.06 - Math.sin(t * 2.2) * 0.04;
        out.head = Math.sin(t * 0.9) * 0.04;
      }
  }
  out.body *= rig.lean;
  out.bodyY *= rig.unit;
  out.bodyX *= rig.unit;
  return out;
}

function blendPose(cur, tgt, k) {
  for (const key of POSE_KEYS) cur[key] += (tgt[key] - cur[key]) * k;
}
