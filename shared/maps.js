// Track catalogue. Control points are metres on the XZ plane and are shared by
// the server simulation (spawns, laps, pickups) and the Three.js track mesh.

export const MAPS = [
  {
    id: 'hairpin_canyons',
    name: 'Hairpin Canyons',
    env: 'canyon',
    description: 'Tight switchbacks between canyon walls. Brake or bounce.',
    width: 13,
    laps: 2,
    countdownMs: 3200,
    physics: { friction: 1.08, speedCap: 0.92 },
    items: { crateCount: 11, respawnMs: 7000 },
    points: [
      [-170, -120], [-90, -165], [10, -150], [95, -165], [165, -110],
      [170, -40], [110, -35], [80, 10], [105, 60], [160, 105],
      [120, 165], [30, 180], [-60, 150], [-110, 95], [-170, 110],
      [-215, 50], [-205, -40],
    ],
    theme: {
      sky: 0x2a1710,
      fog: 0x3d2418,
      ground: 0x8a5535,
      road: 0x37322d,
      roadEdge: 0xffb46b,
      barrier: 0x5b3826,
      accent: 0x34e7ff,
      rock: 0x9a6a45,
      decor: 'rocks',
    },
  },
  {
    id: 'highway_sprint',
    name: 'Highway Sprint',
    env: 'highway',
    description: 'Wide straights, neon guardrails and huge top speeds.',
    width: 20,
    laps: 2,
    countdownMs: 3200,
    physics: { friction: 0.94, speedCap: 1.18 },
    items: { crateCount: 9, respawnMs: 8000 },
    points: [
      [-260, -70], [-140, -120], [0, -130], [150, -120], [255, -70],
      [275, 0], [255, 70], [150, 120], [0, 130], [-150, 120],
      [-260, 70], [-280, 0],
    ],
    theme: {
      sky: 0x08101f,
      fog: 0x0d1a2e,
      ground: 0x121b26,
      road: 0x232a35,
      roadEdge: 0x4d7cff,
      barrier: 0x1c2b45,
      accent: 0xff3d81,
      rock: 0x2b3a55,
      decor: 'pylons',
    },
  },
  {
    id: 'wasteland_arena',
    name: 'Wasteland Arena',
    env: 'wasteland',
    description: 'Open killbox with constant crate pressure. Combat first.',
    width: 16,
    laps: 3,
    countdownMs: 3200,
    physics: { friction: 1.14, speedCap: 0.98 },
    items: { crateCount: 14, respawnMs: 6000 },
    points: [
      [-150, -130], [-40, -160], [80, -150], [150, -90], [165, 0],
      [140, 90], [70, 150], [-40, 160], [-140, 130], [-185, 40], [-185, -60],
    ],
    theme: {
      sky: 0x1b1510,
      fog: 0x2b231a,
      ground: 0x4b4132,
      road: 0x302a24,
      roadEdge: 0xffd166,
      barrier: 0x3a3126,
      accent: 0x7dff6b,
      rock: 0x6b5a42,
      decor: 'barrels',
    },
  },
];

export const MAP_IDS = MAPS.map((map) => map.id);
export const MAP_BY_ID = new Map(MAPS.map((map) => [map.id, map]));
export const DEFAULT_MAP_ID = MAPS[0].id;

export function publicMaps() {
  return MAPS.map((map) => ({
    id: map.id,
    name: map.name,
    description: map.description,
    env: map.env,
    width: map.width,
    laps: map.laps,
    physics: { ...map.physics },
    items: { ...map.items },
    theme: { ...map.theme },
  }));
}

export function publicMap(map) {
  return publicMaps().find((entry) => entry.id === map.id) ?? publicMaps()[0];
}
