// Single source of truth for the wire protocol and simulation tuning.
// Imported by the server, the Vite client and the offline bot mode.

export const PROTOCOL_VERSION = 2;

export const NET = Object.freeze({
  TICK_HZ: 60,
  SNAPSHOT_HZ: 20,
  INPUT_HZ: 60,
  INTERP_DELAY_MS: 110,
  LOCAL_INTERP_DELAY_MS: 40,
  PING_INTERVAL_MS: 2000,
  HELLO_TIMEOUT_MS: 5000,
});

export const PHASE = Object.freeze({
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
});

export const EVENTS = Object.freeze({
  HELLO: 'client:hello',
  CREATE_ROOM: 'lobby:create',
  JOIN_ROOM: 'lobby:join',
  LEAVE_ROOM: 'lobby:leave',
  SELECT_DRIVER: 'lobby:driver',
  SELECT_MAP: 'lobby:map',
  SET_READY: 'lobby:ready',
  START_RACE: 'race:start',
  INPUT: 'race:input',
  PING: 'net:ping',

  HELLO_OK: 'server:hello',
  ROOM: 'lobby:room',
  RACE_STARTED: 'race:started',
  SNAPSHOT: 'race:snapshot',
  RACE_ENDED: 'race:ended',
  PONG: 'net:pong',
  ERROR: 'net:error',
});

export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  BAD_DRIVER: 'BAD_DRIVER',
  BAD_MAP: 'BAD_MAP',
  DRIVER_TAKEN: 'DRIVER_TAKEN',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_IN_PROGRESS: 'ROOM_IN_PROGRESS',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
  NOT_READY: 'NOT_READY',
  NOT_VERIFIED: 'NOT_VERIFIED',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  DISCONNECTED: 'DISCONNECTED',
  NO_SERVER: 'NO_SERVER',
});

export const FLAGS = Object.freeze({
  ALIVE: 1 << 0,
  DRIFTING: 1 << 1,
  BRAKING: 1 << 2,
  BOOSTING: 1 << 3,
  STALLED: 1 << 4,
});

/** Base kart tuning, before driver + map modifiers. Units: m, s, rad. */
export const VEHICLE = Object.freeze({
  baseTopSpeed: 34,
  baseAcceleration: 26,
  baseTurnRate: 2.2,
  brakeFactor: 2.6,
  reverseSpeedRatio: 0.35,
  coastDrag: 0.5,
  lateralGrip: 9,
  spawnHeight: 0.45,
  baseHealth: 100,
  respawnMs: 3000,
  wallMargin: 1.2,
  offRoadGrip: 0.62,
});

export const WEAPON = Object.freeze({
  NONE: 0,
  MACHINEGUN: 1,
  MINE: 2,
  BOOST: 3,
});

export const WEAPONS = Object.freeze({
  [WEAPON.MACHINEGUN]: {
    id: 'machinegun',
    name: 'Machine Gun',
    short: 'MG',
    ammo: 36,
    cooldownMs: 130,
    damage: 9,
    speed: 135,
    lifeMs: 1100,
    color: 0x8ef6ff,
  },
  [WEAPON.MINE]: {
    id: 'mine',
    name: 'Mine',
    short: 'MINE',
    ammo: 3,
    cooldownMs: 650,
    damage: 38,
    radius: 5.5,
    lifeMs: 20000,
    armMs: 600,
    color: 0xffd166,
  },
  [WEAPON.BOOST]: {
    id: 'boost',
    name: 'Speed Boost',
    short: 'BOOST',
    ammo: 1,
    cooldownMs: 900,
    damage: 0,
    durationMs: 1600,
    multiplier: 1.55,
    color: 0xff6bd6,
  },
});

export const CRATE = Object.freeze({
  radius: 1.8,
  pickupRadius: 3.4,
  respawnMs: 7000,
});

/** Race/track defaults; per-map values override laps and crate counts. */
export const RACE = Object.freeze({
  countdownMs: 3200,
  lapGates: [0.25, 0.5, 0.75, 1],
});

/**
 * Snapshot row layout. Arrays keep a 4-racer frame inside one small
 * WebSocket packet; names/drivers travel once in `race:started`.
 */
export const SNAPSHOT_FIELDS = Object.freeze({
  ID: 0,
  X: 1,
  Y: 2,
  Z: 3,
  YAW: 4,
  VX: 5,
  VZ: 6,
  HEALTH: 7,
  ARMOR: 8,
  ACK: 9,
  FLAGS: 10,
  LAP: 11,
  PROGRESS: 12,
  WEAPON: 13,
  AMMO: 14,
  PLACE: 15,
});

export const SNAPSHOT_STRIDE = 16;

export function decodeRacer(row) {
  return {
    id: row[0],
    x: row[1],
    y: row[2],
    z: row[3],
    yaw: row[4],
    vx: row[5],
    vz: row[6],
    health: row[7],
    armor: row[8],
    ack: row[9],
    flags: row[10],
    lap: row[11],
    progress: row[12],
    weapon: row[13],
    ammo: row[14],
    place: row[15],
    alive: (row[10] & FLAGS.ALIVE) !== 0,
  };
}

export const IDLE_INPUT = Object.freeze({
  seq: 0,
  throttle: 0,
  steer: 0,
  drift: false,
  brake: false,
  fire: false,
});
