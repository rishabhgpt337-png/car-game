// Deterministic kart step shared by the server and the offline bot mode.
// Flat-world arcade model: no suspension, no jumps, tuned for feel.

import { FLAGS, VEHICLE } from './constants.js';

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

export function createRacerState({ spawn }) {
  return {
    x: spawn.x,
    y: VEHICLE.spawnHeight,
    z: spawn.z,
    yaw: spawn.yaw,
    vx: 0,
    vz: 0,
    health: VEHICLE.baseHealth,
    armor: 0,
    flags: FLAGS.ALIVE,
  };
}

export function stepVehicle(state, input, dt, { driver, map, onRoad = true, boosting = false }) {
  if ((state.flags & FLAGS.ALIVE) === 0) return;

  const roadFactor = onRoad ? 1 : VEHICLE.offRoadGrip;
  const boostFactor = boosting ? 1.55 : 1;
  const speedCap = VEHICLE.baseTopSpeed * driver.physics.topSpeed * map.physics.speedCap * roadFactor * boostFactor;
  const acceleration = VEHICLE.baseAcceleration * driver.physics.acceleration * (boosting ? 1.75 : 1);

  const throttle = clamp(input.throttle, -1, 1);
  const steer = clamp(input.steer, -1, 1);

  const sinYaw = Math.sin(state.yaw);
  const cosYaw = Math.cos(state.yaw);

  let forward = state.vx * sinYaw + state.vz * cosYaw;
  let lateral = state.vx * cosYaw - state.vz * sinYaw;

  const speedRatio = Math.min(1, Math.abs(forward) / Math.max(1, speedCap));
  const authority = 0.42 + 0.58 * speedRatio;
  const driftBonus = input.drift ? 1.12 : 1;

  state.yaw = wrapAngle(
    state.yaw + steer * VEHICLE.baseTurnRate * driver.physics.turnRate * authority * driftBonus * dt,
  );

  forward += throttle * acceleration * dt;

  const drag = throttle === 0 ? VEHICLE.coastDrag * map.physics.friction : VEHICLE.coastDrag * 0.3;
  forward -= forward * drag * dt;

  if (input.brake) forward *= Math.exp(-VEHICLE.brakeFactor * dt);
  forward = clamp(forward, -speedCap * VEHICLE.reverseSpeedRatio, speedCap);

  const grip = input.drift ? driver.physics.driftGrip : driver.physics.grip;
  lateral *= Math.exp(-grip * VEHICLE.lateralGrip * dt);

  const newSin = Math.sin(state.yaw);
  const newCos = Math.cos(state.yaw);
  state.vx = newSin * forward + newCos * lateral;
  state.vz = newCos * forward - newSin * lateral;

  state.x += state.vx * dt;
  state.z += state.vz * dt;

  let flags = FLAGS.ALIVE;
  if (input.drift && Math.abs(forward) > speedCap * 0.3) flags |= FLAGS.DRIFTING;
  if (input.brake) flags |= FLAGS.BRAKING;
  if (boosting) flags |= FLAGS.BOOSTING;
  state.flags = flags;
}

export function speedOf(state) {
  return Math.hypot(state.vx, state.vz);
}
