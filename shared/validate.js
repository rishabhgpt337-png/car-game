// Input validation shared by the authoritative server and local mode.

export const MAX_NAME_LENGTH = 16;

const clampNumber = (value, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(max, Math.max(min, parsed));
};

export function sanitizeName(raw, fallbackSeed = '') {
  const name = String(raw ?? '')
    .replace(/[^\w \-.]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  if (name) return name;
  return `Racer ${String(fallbackSeed).slice(0, 3).toUpperCase()}`;
}

export function normalizeGameCode(raw) {
  const code = String(raw ?? '').trim();
  return /^\d{4}$/.test(code) ? code : null;
}

/** Clamp every race input field; unknown fields never reach the simulation. */
export function sanitizeInput(message) {
  if (!message || typeof message !== 'object') {
    return { seq: 0, throttle: 0, steer: 0, drift: false, brake: false, fire: false };
  }

  return {
    seq: Math.max(0, Math.floor(clampNumber(message.seq, 0, Number.MAX_SAFE_INTEGER))),
    throttle: clampNumber(message.throttle, -1, 1),
    steer: clampNumber(message.steer, -1, 1),
    drift: message.drift === true,
    brake: message.brake === true,
    fire: message.fire === true,
  };
}
