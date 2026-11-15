// Driver roster. Values here are *modifiers* consumed by the simulation and,
// later, by the Cannon vehicle controller and combat systems.
// Keeping them data-only means balance changes never touch server logic.

export const DRIVERS = [
  {
    id: 'drifter',
    name: 'The Drifter',
    tagline: 'Loose rear, tight lines. Rewards throttle discipline.',
    physics: {
      topSpeed: 0.94,
      acceleration: 1.02,
      turnRate: 1.2,
      grip: 0.78,
      driftGrip: 0.42,
      mass: 0.9,
    },
    combat: { armorMax: 90, damage: 1.0, fireRate: 1.0 },
    itemLuck: 1.0,
  },
  {
    id: 'speedster',
    name: 'The Speedster',
    tagline: 'Straight-line monster. Fragile when the pack catches up.',
    physics: {
      topSpeed: 1.12,
      acceleration: 1.2,
      turnRate: 0.92,
      grip: 0.92,
      driftGrip: 0.62,
      mass: 0.85,
    },
    combat: { armorMax: 70, damage: 0.95, fireRate: 1.0 },
    itemLuck: 1.0,
  },
  {
    id: 'tank',
    name: 'The Tank',
    tagline: 'Rolling cover. Shrugs off mines and trades speed for armor.',
    physics: {
      topSpeed: 0.86,
      acceleration: 0.86,
      turnRate: 0.82,
      grip: 1.06,
      driftGrip: 0.7,
      mass: 1.35,
    },
    combat: { armorMax: 160, damage: 0.9, fireRate: 0.85 },
    itemLuck: 0.9,
  },
  {
    id: 'gunner',
    name: 'The Gunner',
    tagline: 'Weapons platform on wheels. Wins the firefight, not the lap.',
    physics: {
      topSpeed: 0.95,
      acceleration: 0.96,
      turnRate: 1.04,
      grip: 0.96,
      driftGrip: 0.6,
      mass: 1.05,
    },
    combat: { armorMax: 100, damage: 1.25, fireRate: 1.2 },
    itemLuck: 1.1,
  },
];

export const DRIVER_IDS = DRIVERS.map((driver) => driver.id);
export const DRIVER_BY_ID = new Map(DRIVERS.map((driver) => [driver.id, driver]));
export const DEFAULT_PLAYER_LIMIT = DRIVERS.length;

/** Shape sent to clients: no balance internals beyond what the UI displays. */
export function publicDrivers() {
  return DRIVERS.map((driver) => ({
    id: driver.id,
    name: driver.name,
    tagline: driver.tagline,
    stats: {
      speed: driver.physics.topSpeed,
      accel: driver.physics.acceleration,
      handling: driver.physics.turnRate,
      grip: driver.physics.grip,
      armor: driver.combat.armorMax,
      damage: driver.combat.damage,
    },
  }));
}
