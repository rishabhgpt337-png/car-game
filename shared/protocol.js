// Wire protocol shared by the server and the browser client.
// Bump PROTOCOL_VERSION whenever an event payload or the snapshot layout changes;
// the server refuses clients on a different version.

export const PROTOCOL_VERSION = 1;

export const EVENTS = Object.freeze({
  // client -> server
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

  // server -> client
  HELLO_OK: 'server:hello',
  ROOM: 'lobby:room',
  RACE_STARTED: 'race:started',
  SNAPSHOT: 'race:snapshot',
  RACE_ENDED: 'race:ended',
  PONG: 'net:pong',
  ERROR: 'net:error',
});

export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  RACING: 'racing',
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
});

/** Simulation rates. One client input == one server tick. */
export const NET = Object.freeze({
  TICK_HZ: 60,
  SNAPSHOT_HZ: 20,
  INPUT_HZ: 60,
  /** Remote entities render this far behind the newest snapshot (ms). */
  INTERP_DELAY_MS: 100,
  PING_INTERVAL_MS: 2000,
  HELLO_TIMEOUT_MS: 5000,
});

/**
 * Snapshot row layout. Arrays (not objects) keep 4-player frames under a few
 * hundred bytes so they stay inside a single WebSocket frame.
 */
export const SNAPSHOT_FIELDS = Object.freeze({
  ID: 0,
  X: 1,
  Y: 2,
  Z: 3,
  VX: 4,
  VY: 5,
  VZ: 6,
  YAW: 7,
  HEALTH: 8,
  ARMOR: 9,
  ACK: 10,
  FLAGS: 11,
});

export const SNAPSHOT_STRIDE = 12;

export const FLAGS = Object.freeze({
  ALIVE: 1 << 0,
  DRIFTING: 1 << 1,
  BRAKING: 1 << 2,
  FIRE_PRIMARY: 1 << 3,
});

/** Decode one snapshot row into a readable object (client-side convenience). */
export function decodeRacer(row) {
  return {
    id: row[SNAPSHOT_FIELDS.ID],
    x: row[SNAPSHOT_FIELDS.X],
    y: row[SNAPSHOT_FIELDS.Y],
    z: row[SNAPSHOT_FIELDS.Z],
    vx: row[SNAPSHOT_FIELDS.VX],
    vy: row[SNAPSHOT_FIELDS.VY],
    vz: row[SNAPSHOT_FIELDS.VZ],
    yaw: row[SNAPSHOT_FIELDS.YAW],
    health: row[SNAPSHOT_FIELDS.HEALTH],
    armor: row[SNAPSHOT_FIELDS.ARMOR],
    ack: row[SNAPSHOT_FIELDS.ACK],
    flags: row[SNAPSHOT_FIELDS.FLAGS],
    alive: (row[SNAPSHOT_FIELDS.FLAGS] & FLAGS.ALIVE) !== 0,
  };
}
