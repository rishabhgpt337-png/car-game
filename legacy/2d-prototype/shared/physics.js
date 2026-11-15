// Deterministic ship physics shared by the server and the browser.
// Keep this file free of Node/browser APIs: both sides run the exact same code,
// which is what makes client-side prediction and server reconciliation match.

import { ARENA, SHIP } from './constants.js';

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Spawn ring position for a given slot id. */
export function spawnPoint(slot) {
  const total = 8;
  const angle = ((slot % total) / total) * Math.PI * 2 - Math.PI / 2;
  const radius = Math.min(ARENA.width, ARENA.height) * 0.32;
  return {
    x: ARENA.width * 0.5 + Math.cos(angle) * radius,
    y: ARENA.height * 0.5 + Math.sin(angle) * radius,
    angle,
  };
}

export function createShip(id, name, x, y, angle = -Math.PI / 2) {
  return {
    id,
    name,
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    turret: angle,
    hp: SHIP.maxHp,
    alive: true,
    score: 0,
    ack: 0,
    respawnTick: 0,
    nextFireTick: 0,
  };
}

/** Soft wall bounce so ships slide along the arena edge instead of sticking. */
function bounceWalls(ship) {
  const r = SHIP.radius;

  if (ship.x < r) {
    ship.x = r;
    ship.vx = Math.abs(ship.vx) * 0.25;
  } else if (ship.x > ARENA.width - r) {
    ship.x = ARENA.width - r;
    ship.vx = -Math.abs(ship.vx) * 0.25;
  }

  if (ship.y < r) {
    ship.y = r;
    ship.vy = Math.abs(ship.vy) * 0.25;
  } else if (ship.y > ARENA.height - r) {
    ship.y = ARENA.height - r;
    ship.vy = -Math.abs(ship.vy) * 0.25;
  }
}

/**
 * Advance one ship by a fixed timestep.
 *
 * @param {object} ship   mutable ship state
 * @param {{t?:number,r?:number,a?:number,f?:boolean}} input
 *        t: throttle -1..1, r: turn -1..1, a: absolute turret angle (rad), f: firing
 * @param {number} dt     seconds (always 1 / TICK_HZ)
 */
export function stepShip(ship, input, dt) {
  if (!ship.alive) return;

  const throttle = clamp(Number(input.t) || 0, -1, 1);
  const turn = clamp(Number(input.r) || 0, -1, 1);

  if (Number.isFinite(input.a)) ship.turret = wrapAngle(input.a);

  const speed = Math.hypot(ship.vx, ship.vy);
  const speedRatio = Math.min(1, speed / SHIP.maxSpeed);
  // Arcade steering: full agility at speed, a slow pivot when stopped.
  ship.angle = wrapAngle(ship.angle + turn * SHIP.turnSpeed * (0.35 + 0.65 * speedRatio) * dt);

  const accel = throttle * (throttle >= 0 ? SHIP.accel : SHIP.reverseAccel);
  ship.vx += Math.cos(ship.angle) * accel * dt;
  ship.vy += Math.sin(ship.angle) * accel * dt;

  // Split velocity into forward / lateral and scrub the sideways part (grip).
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);
  const forward = ship.vx * cos + ship.vy * sin;
  const lateral = -ship.vx * sin + ship.vy * cos;
  const keptLateral = lateral * Math.exp(-SHIP.lateralGrip * dt);
  ship.vx = cos * forward - sin * keptLateral;
  ship.vy = sin * forward + cos * keptLateral;

  const drag = Math.exp(-SHIP.drag * dt);
  ship.vx *= drag;
  ship.vy *= drag;

  const newSpeed = Math.hypot(ship.vx, ship.vy);
  if (newSpeed > SHIP.maxSpeed) {
    const scale = SHIP.maxSpeed / newSpeed;
    ship.vx *= scale;
    ship.vy *= scale;
  }

  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;
  bounceWalls(ship);
}
