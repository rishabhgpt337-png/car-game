// The four drivers. Pure data: the simulation and the client UI both read it.

export const DRIVERS = [
  {
    id: 'drifter',
    name: 'The Drifter',
    role: 'Slide King',
    tagline: 'Loose rear, tight lines. Drift through the pack.',
    color: 0x34e7ff,
    css: '#34e7ff',
    physics: { topSpeed: 0.94, acceleration: 1.02, turnRate: 1.2, grip: 0.8, driftGrip: 0.42 },
    combat: { armorMax: 90, damage: 1, fireRate: 1 },
    stats: { speed: 3, accel: 4, handling: 5, armor: 2 },
  },
  {
    id: 'speedster',
    name: 'The Speedster',
    role: 'Straight-Line Monster',
    tagline: 'Nothing catches you on the straights. Corners are the price.',
    color: 0xff3d81,
    css: '#ff3d81',
    physics: { topSpeed: 1.14, acceleration: 1.2, turnRate: 0.9, grip: 0.92, driftGrip: 0.62 },
    combat: { armorMax: 70, damage: 0.95, fireRate: 1 },
    stats: { speed: 5, accel: 5, handling: 2, armor: 1 },
  },
  {
    id: 'tank',
    name: 'The Tank',
    role: 'Rolling Cover',
    tagline: 'Armor for days. Let them break themselves on you.',
    color: 0xffd166,
    css: '#ffd166',
    physics: { topSpeed: 0.86, acceleration: 0.86, turnRate: 0.84, grip: 1.06, driftGrip: 0.7 },
    combat: { armorMax: 160, damage: 0.9, fireRate: 0.85 },
    stats: { speed: 2, accel: 2, handling: 2, armor: 5 },
  },
  {
    id: 'gunner',
    name: 'The Gunner',
    role: 'Weapons Platform',
    tagline: 'Wins the firefight, not the lap. Make every crate count.',
    color: 0x7dff6b,
    css: '#7dff6b',
    physics: { topSpeed: 0.95, acceleration: 0.97, turnRate: 1.04, grip: 0.96, driftGrip: 0.6 },
    combat: { armorMax: 100, damage: 1.25, fireRate: 1.15 },
    stats: { speed: 3, accel: 3, handling: 3, armor: 3 },
  },
];

export const DRIVER_IDS = DRIVERS.map((driver) => driver.id);
export const DRIVER_BY_ID = new Map(DRIVERS.map((driver) => [driver.id, driver]));

export function publicDrivers() {
  return DRIVERS.map((driver) => ({
    id: driver.id,
    name: driver.name,
    role: driver.role,
    tagline: driver.tagline,
    color: driver.color,
    css: driver.css,
    stats: { ...driver.stats },
    physics: { ...driver.physics },
    combat: { ...driver.combat },
  }));
}
