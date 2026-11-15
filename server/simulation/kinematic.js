// Movement stand-in for the Cannon-es vehicle controller.
//
// This is intentionally a simple kinematic integrator: it exists so the room
// tick loop can move authoritative bodies today and the netcode (ack/rewind,
// prediction, interpolation) can be tuned before rigid-body physics lands.
// Replace stepVehicle() with the Cannon raycast-vehicle controller later; the
// Race loop and snapshot format do not need to change.

import { FLAGS } from '../../shared/protocol.js';
import { VEHICLE } from '../../config/game.js';

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

export function createRaceState({ driver, spawn }) {
  return {
    x: spawn.x,
    y: VEHICLE.spawnHeight,
    z: spawn.z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: spawn.yaw,
    health: VEHICLE.baseHealth,
    armor: driver.combat.armorMax,
    flags: FLAGS.ALIVE,
  };
}

export function stepVehicle(state, input, dt, { driver, map }) {
  if ((state.flags & FLAGS.ALIVE) === 0) return;

  const speedCap = VEHICLE.baseTopSpeed * driver.physics.topSpeed * map.physics.speedCap;
  const acceleration = VEHICLE.baseAcceleration * driver.physics.acceleration;
  const coastDrag = VEHICLE.coastDrag * map.physics.friction;

  const throttle = clamp(input.throttle, -1, 1);
  const steer = clamp(input.steer, -1, 1);

  const sinYaw = Math.sin(state.yaw);
  const cosYaw = Math.cos(state.yaw);

  // Forward is +Z at yaw 0; lateral is the perpendicular axis.
  let forward = state.vx * sinYaw + state.vz * cosYaw;
  let lateral = state.vx * cosYaw - state.vz * sinYaw;

  // Steering needs some speed, and a drifting driver gets more yaw authority.
  const speedRatio = Math.min(1, Math.abs(forward) / Math.max(1, speedCap));
  const authority = 0.4 + 0.6 * speedRatio;
  const driftBonus = input.drift ? 1.15 : 1;
  state.yaw = wrapAngle(
    state.yaw + steer * VEHICLE.baseTurnRate * driver.physics.turnRate * authority * driftBonus * dt,
  );

  // Engine, drag, brake.
  forward += throttle * acceleration * dt;
  const drag = throttle === 0 ? coastDrag : coastDrag * 0.35;
  forward -= forward * drag * dt;
  if (input.brake) forward *= Math.exp(-VEHICLE.brakeFactor * dt);
  forward = clamp(forward, -speedCap * VEHICLE.reverseSpeedRatio, speedCap);

  // Grip: scrubs sideways velocity, less so while drifting.
  const gripCoefficient = input.drift ? driver.physics.driftGrip : driver.physics.grip;
  lateral *= Math.exp(-gripCoefficient * VEHICLE.lateralGrip * dt);

  // Rebuild world velocity from the (possibly rotated) local axes.
  const newSin = Math.sin(state.yaw);
  const newCos = Math.cos(state.yaw);
  state.vx = newSin * forward + newCos * lateral;
  state.vz = newCos * forward - newSin * lateral;

  state.x += state.vx * dt;
  state.z += state.vz * dt;

  // Placeholder arena bounds until real track colliders exist.
  const boundX = map.bounds.x;
  const boundZ = map.bounds.z;
  if (state.x < -boundX || state.x > boundX) {
    state.x = clamp(state.x, -boundX, boundX);
    state.vx *= -0.2;
  }
  if (state.z < -boundZ || state.z > boundZ) {
    state.z = clamp(state.z, -boundZ, boundZ);
    state.vz *= -0.2;
  }

  let flags = FLAGS.ALIVE;
  if (input.drift && Math.abs(forward) > speedCap * 0.3) flags |= FLAGS.DRIFTING;
  if (input.brake) flags |= FLAGS.BRAKING;
  state.flags = flags;
}
