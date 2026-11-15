// Validation and sanitising for anything that arrives from a client.
// The server must never trust lengths, types or numeric ranges.

import { ROOM } from '../../config/game.js';

const stripUnsafe = (value) => String(value ?? '').replace(/[^\w \-.]/g, '');

export function sanitizeDisplayName(raw, socketId) {
  const name = stripUnsafe(raw).trim().slice(0, ROOM.NAME_MAX_LENGTH);
  return name || `Racer ${String(socketId).slice(0, 3).toUpperCase()}`;
}

export function normalizeGameCode(raw) {
  const code = String(raw ?? '').trim();
  return /^\d{4}$/.test(code) ? code : null;
}

const clampNumber = (value, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(max, Math.max(min, parsed));
};

/**
 * Race input from the client:
 *   seq      monotonically increasing per race
 *   throttle -1..1 (negative = reverse/brake)
 *   steer    -1..1
 *   drift    boolean (handbrake / drift modifier)
 *   brake    boolean
 *   useItem  boolean (items land in the next pass; accepted and ignored today)
 */
export function sanitizeInput(message) {
  if (!message || typeof message !== 'object') {
    return { seq: 0, throttle: 0, steer: 0, drift: false, brake: false, useItem: false };
  }

  return {
    seq: Math.max(0, Math.floor(clampNumber(message.seq, 0, Number.MAX_SAFE_INTEGER))),
    throttle: clampNumber(message.throttle, -1, 1),
    steer: clampNumber(message.steer, -1, 1),
    drift: message.drift === true,
    brake: message.brake === true,
    useItem: message.useItem === true,
  };
}
