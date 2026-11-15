// Shared tunables. Imported by both the server and the browser client so the
// simulation stays identical on both sides (required for client-side prediction).

/** Authoritative simulation rate. One input = one tick. */
export const TICK_HZ = 60;
/** Input messages per second sent by the client. Must match TICK_HZ for exact replay. */
export const INPUT_HZ = 60;
/** Network snapshots per second. Interpolation hides the gaps between them. */
export const SNAPSHOT_HZ = 20;
/** Ticks between two snapshots. */
export const SNAPSHOT_EVERY = TICK_HZ / SNAPSHOT_HZ;

export const MAX_PLAYERS = 8;

/** How far behind the newest snapshot we render remote entities (milliseconds). */
export const INTERP_DELAY_MS = 100;

export const ARENA = {
  width: 2400,
  height: 1600,
};

export const SHIP = {
  radius: 20,
  maxHp: 100,
  accel: 950, // px / s^2 forward
  reverseAccel: 550,
  maxSpeed: 560,
  drag: 1.9, // exponential velocity damping
  lateralGrip: 9, // how fast sideways drift is scrubbed off
  turnSpeed: 3.4, // rad / s at full speed
  respawnMs: 2000,
};

export const BULLET = {
  radius: 5,
  speed: 950,
  damage: 14,
  cooldownMs: 200,
  lifeMs: 1500,
};
