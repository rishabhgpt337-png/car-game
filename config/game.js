// Server-side runtime configuration: environment, network limits, room limits,
// and the base vehicle tuning that roster/map modifiers multiply.

import { NET } from '../shared/protocol.js';

const number = (value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parsePort = (value) => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000;
};

export const SERVER = {
  port: parsePort(process.env.PORT),
  host: process.env.HOST || '0.0.0.0',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  isProduction: process.env.NODE_ENV === 'production',
};

export const NETWORK = {
  ...NET,
  /** Max inputs buffered per racer; older inputs are dropped first. */
  INPUT_QUEUE_LIMIT: 8,
  /** Catch-up cap so a stalled process cannot spiral into a long tick. */
  MAX_STEPS_PER_LOOP: 6,
};

export const ROOM = {
  CODE_MIN: 1000,
  CODE_MAX: 9999,
  MAX_PLAYERS: 4,
  MAX_ROOMS: 2000,
  NAME_MAX_LENGTH: 16,
  /** Abandoned lobby rooms are swept after this long without activity. */
  LOBBY_TTL_MS: 30 * 60 * 1000,
};

export const RATE = {
  /** Lobby/action events per socket per second (burstable). */
  LOBBY_ACTIONS_PER_SECOND: 8,
  /** Input messages tolerated per socket per second (nominal is 60). */
  INPUTS_PER_SECOND: 90,
};

/**
 * Base vehicle tuning before driver and map multipliers.
 * Units: metres, seconds, radians. Forward is +Z at yaw 0 (Three.js right-handed).
 */
export const VEHICLE = {
  baseTopSpeed: 32,
  baseAcceleration: 24,
  baseTurnRate: 2.1,
  brakeFactor: 2.4,
  reverseSpeedRatio: 0.35,
  coastDrag: 0.55,
  /** Downforce-ish grip coefficient applied to lateral velocity. */
  lateralGrip: 9,
  spawnHeight: 0.6,
  /** Health is shared; armor comes from the driver and absorbs damage first. */
  baseHealth: 100,
};

export const SIM_LOG_INTERVAL_MS = 10_000;
