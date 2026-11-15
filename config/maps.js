// Map catalogue. Each environment changes grip, the effective speed cap and how
// often item crates appear. Track geometry itself (splines, colliders) arrives
// with the Three.js/Cannon content pass; these values are already authoritative.

export const MAPS = [
  {
    id: 'hairpin_canyons',
    name: 'Hairpin Canyons',
    description: 'Switchbacks and canyon walls. Punishes a wide line.',
    env: 'canyon',
    race: { laps: 3, lapLengthM: 780 },
    physics: { friction: 1.08, speedCap: 0.92, gravity: 1.0 },
    items: { spawnRateMultiplier: 0.9, crateCount: 12, respawnSeconds: 8 },
    bounds: { x: 420, z: 420 },
  },
  {
    id: 'highway_sprint',
    name: 'Highway Sprint',
    description: 'Wide straights and long sightlines. Speed wins, brakes decide.',
    env: 'highway',
    race: { laps: 2, lapLengthM: 1150 },
    physics: { friction: 0.94, speedCap: 1.18, gravity: 1.0 },
    items: { spawnRateMultiplier: 0.7, crateCount: 8, respawnSeconds: 10 },
    bounds: { x: 600, z: 300 },
  },
  {
    id: 'wasteland_arena',
    name: 'Wasteland Arena',
    description: 'Open killbox with constant crate pressure. Combat first.',
    env: 'wasteland',
    race: { laps: 4, lapLengthM: 620 },
    physics: { friction: 1.14, speedCap: 0.98, gravity: 1.0 },
    items: { spawnRateMultiplier: 1.4, crateCount: 18, respawnSeconds: 6 },
    bounds: { x: 380, z: 380 },
  },
];

export const MAP_IDS = MAPS.map((map) => map.id);
export const MAP_BY_ID = new Map(MAPS.map((map) => [map.id, map]));
export const DEFAULT_MAP_ID = MAPS[0].id;

/** Shape sent to clients; enough to render a map card and preview stats. */
export function publicMaps() {
  return MAPS.map((map) => ({
    id: map.id,
    name: map.name,
    description: map.description,
    env: map.env,
    laps: map.race.laps,
    lapLengthM: map.race.lapLengthM,
    physics: { ...map.physics },
    items: { ...map.items },
  }));
}

export function publicMap(map) {
  return publicMaps().find((entry) => entry.id === map.id) ?? null;
}
