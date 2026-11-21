// Authoritative match simulation: karts, laps, crates, weapons, damage and
// respawns. Runs unchanged on the Node server (online) and in the browser
// (single-player vs bots), so both modes behave identically.

import {
  CRATE,
  FLAGS,
  IDLE_INPUT,
  NET,
  PHASE,
  RACE,
  VEHICLE,
  WEAPON,
  WEAPONS,
} from './constants.js';
import { DRIVERS, DRIVER_BY_ID } from './roster.js';
import { MAPS, MAP_BY_ID, publicMap } from './maps.js';
import {
  buildTrack,
  cratePositions,
  isGateCrossed,
  pointAt,
  projectToTrack,
  spawnGrid,
} from './track.js';
import { createRacerState, stepVehicle } from './vehicle.js';
import { sanitizeInput } from './validate.js';

const DT = 1 / NET.TICK_HZ;
const MS_TO_TICKS = NET.TICK_HZ / 1000;
const MAX_QUEUED_INPUTS = 8;
const WEAPON_POOL = [
  WEAPON.MACHINEGUN,
  WEAPON.MACHINEGUN,
  WEAPON.MACHINEGUN,
  WEAPON.MINE,
  WEAPON.MINE,
  WEAPON.BOOST,
];

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MatchCore {
  constructor({ mapId, mode = 'server', seed = null }) {
    this.map = MAP_BY_ID.get(mapId) ?? MAPS[0];
    this.track = buildTrack(this.map);
    this.mode = mode;
    this.seed = Number.isFinite(seed) ? seed : Math.floor(Math.random() * 2 ** 31);
    this.rng = mulberry32(this.seed);

    this.racers = new Map();
    this.bySocket = new Map();
    this.bullets = [];
    this.mines = [];
    this.crates = cratePositions(this.track, this.map.items.crateCount).map((pos, index) => ({
      id: index + 1,
      x: pos.x,
      z: pos.z,
      s: pos.s,
      weapon: this.randomWeapon(),
      active: true,
      respawnTick: 0,
    }));

    this.nextRacerId = 1;
    this.nextEntityId = 1;
    this.tick = 0;
    this.phase = PHASE.COUNTDOWN;
    this.countdownTicks = 0;
    this.raceTime = 0;
    this.winnerId = null;
    this.finishOrder = [];
    this.events = [];
  }

  get started() {
    return this.phase === PHASE.RACING || this.phase === PHASE.FINISHED;
  }

  driverFor(racer) {
    return DRIVER_BY_ID.get(racer.driverId) ?? DRIVERS[0];
  }

  randomWeapon() {
    return WEAPON_POOL[Math.floor(this.rng() * WEAPON_POOL.length)];
  }

  // --------------------------------------------------------------- roster

  addRacer({ socketId = null, name, driverId, isBot = false }) {
    const driver = DRIVER_BY_ID.get(driverId) ?? DRIVERS[0];
    const id = this.nextRacerId;
    this.nextRacerId += 1;

    const spawn = spawnGrid(this.track, this.racers.size);
    const racer = {
      id,
      socketId,
      name: String(name ?? `Racer ${id}`),
      driverId: driver.id,
      isBot,
      ...createRacerState({ spawn }),
      armor: driver.combat.armorMax,
      ack: 0,
      queue: [],
      s: spawn.s,
      lastS: spawn.s,
      lateral: 0,
      onRoad: true,
      lap: 0,
      checkpoint: 0,
      progress: spawn.s,
      finished: false,
      place: 0,
      weapon: WEAPON.NONE,
      ammo: 0,
      weaponCooldown: 0,
      prevFire: false,
      boostTicks: 0,
      stallTicks: 0,
      invulnTicks: 0,
      respawns: 0,
    };

    this.racers.set(id, racer);
    if (socketId) this.bySocket.set(socketId, id);
    return racer;
  }

  removeRacer(racerId) {
    const racer = this.racers.get(racerId);
    if (!racer) return;
    this.racers.delete(racerId);
    if (racer.socketId) this.bySocket.delete(racer.socketId);
  }

  queueInput(racerId, message) {
    const racer = this.racers.get(racerId);
    if (!racer || racer.isBot) return;
    if (racer.queue.length >= MAX_QUEUED_INPUTS) racer.queue.shift();
    racer.queue.push(sanitizeInput(message));
  }

  // ----------------------------------------------------------------- loop

  start() {
    this.phase = PHASE.COUNTDOWN;
    this.countdownTicks = Math.round((this.map.countdownMs ?? RACE.countdownMs) * MS_TO_TICKS);
    this.tick = 0;
    this.raceTime = 0;
    this.winnerId = null;
    this.finishOrder = [];
    this.events = [];

    for (const racer of this.racers.values()) {
      racer.invulnTicks = 90;
      racer.prevFire = false;
      racer.queue = [];
    }
  }

  step() {
    if (this.phase === PHASE.COUNTDOWN) {
      this.countdownTicks = Math.max(0, this.countdownTicks - 1);
      if (this.countdownTicks === 0) {
        this.phase = PHASE.RACING;
        for (const racer of this.racers.values()) racer.invulnTicks = 60;
      }
      return;
    }

    if (this.phase !== PHASE.RACING) return;

    this.tick += 1;
    this.raceTime += DT;

    for (const racer of this.racers.values()) this.stepRacer(racer);

    this.stepBullets();
    this.stepMines();
    this.stepCrates();
  }

  stepRacer(racer) {
    const input = racer.isBot
      ? this.botInput(racer)
      : racer.queue.length > 0
        ? racer.queue.shift()
        : IDLE_INPUT;

    if (input.seq > racer.ack) racer.ack = input.seq;
    if (racer.finished) return;

    if (racer.stallTicks > 0) {
      racer.stallTicks -= 1;
      if (racer.stallTicks === 0) this.respawn(racer);
      return;
    }

    if ((racer.flags & FLAGS.ALIVE) === 0) return;

    if (racer.weaponCooldown > 0) racer.weaponCooldown -= 1;
    if (racer.invulnTicks > 0) racer.invulnTicks -= 1;

    const boosting = racer.boostTicks > 0;
    if (boosting) racer.boostTicks -= 1;

    stepVehicle(racer, input, DT, {
      driver: this.driverFor(racer),
      map: this.map,
      onRoad: racer.onRoad,
      boosting,
    });

    const projection = projectToTrack(this.track, racer.x, racer.z);
    racer.s = projection.s;
    racer.lateral = projection.lateral;
    racer.onRoad = projection.onRoad;

    this.clampToTrack(racer, projection);
    this.updateLap(racer, projection.s);
    racer.progress = racer.lap + projection.s;
    this.updateWeapon(racer, input);
  }

  clampToTrack(racer, projection) {
    const limit = this.map.width / 2 - VEHICLE.wallMargin;
    if (Math.abs(projection.lateral) <= limit) return;

    const side = Math.sign(projection.lateral) || 1;
    const p = pointAt(this.track, projection.s);
    racer.x = p.x + p.nx * limit * side;
    racer.z = p.z + p.nz * limit * side;

    const normalSpeed = racer.vx * p.nx + racer.vz * p.nz;
    racer.vx -= p.nx * normalSpeed * 1.35;
    racer.vz -= p.nz * normalSpeed * 1.35;
    racer.vx *= 0.96;
    racer.vz *= 0.96;
  }

  updateLap(racer, s) {
    const gate = RACE.lapGates[racer.checkpoint];
    if (gate !== undefined && isGateCrossed(racer.lastS, s, gate)) {
      racer.checkpoint += 1;

      if (racer.checkpoint >= RACE.lapGates.length) {
        racer.checkpoint = 0;
        racer.lap += 1;
        this.pushEvent({ k: 'lap', a: racer.id, lap: racer.lap });

        if (racer.lap >= this.map.laps) {
          this.finishRacer(racer);
        }
      }
    }

    racer.lastS = s;
  }

  finishRacer(racer) {
    if (racer.finished) return;

    racer.finished = true;
    racer.place = this.finishOrder.length + 1;
    racer.vx = 0;
    racer.vz = 0;
    this.finishOrder.push(racer.id);
    this.pushEvent({ k: 'finish', a: racer.id, place: racer.place });

    if (this.phase === PHASE.RACING) {
      this.phase = PHASE.FINISHED;
      this.winnerId = racer.id;
    }
  }

  // -------------------------------------------------------------- weapons

  updateWeapon(racer, input) {
    const pressed = input.fire && !racer.prevFire;
    racer.prevFire = input.fire;

    if (racer.weapon === WEAPON.NONE || racer.ammo <= 0) return;
    if (racer.weaponCooldown > 0) return;

    const spec = WEAPONS[racer.weapon];
    const driver = this.driverFor(racer);

    if (racer.weapon === WEAPON.MACHINEGUN) {
      if (!input.fire) return;
      this.spawnBullet(racer, spec, spec.damage * driver.combat.damage);
      racer.weaponCooldown = Math.max(2, Math.round((spec.cooldownMs / driver.combat.fireRate) * MS_TO_TICKS));
    } else if (racer.weapon === WEAPON.MINE) {
      if (!pressed) return;
      this.dropMine(racer, spec, spec.damage * driver.combat.damage);
      racer.weaponCooldown = Math.max(4, Math.round(spec.cooldownMs * MS_TO_TICKS));
    } else if (racer.weapon === WEAPON.BOOST) {
      if (!pressed) return;
      racer.boostTicks = Math.round(spec.durationMs * MS_TO_TICKS);
      racer.weaponCooldown = Math.max(4, Math.round(spec.cooldownMs * MS_TO_TICKS));
      this.pushEvent({ k: 'boost', a: racer.id });
    }

    racer.ammo -= 1;
    if (racer.ammo <= 0) {
      racer.ammo = 0;
      racer.weapon = WEAPON.NONE;
    }
  }

  spawnBullet(racer, spec, damage) {
    const sin = Math.sin(racer.yaw);
    const cos = Math.cos(racer.yaw);

    this.bullets.push({
      id: this.nextEntityId++,
      owner: racer.id,
      x: racer.x + sin * 2.4,
      y: racer.y + 0.55,
      z: racer.z + cos * 2.4,
      vx: sin * spec.speed + racer.vx * 0.15,
      vz: cos * spec.speed + racer.vz * 0.15,
      life: Math.round(spec.lifeMs * MS_TO_TICKS),
      damage,
    });
  }

  dropMine(racer, spec, damage) {
    const sin = Math.sin(racer.yaw);
    const cos = Math.cos(racer.yaw);

    this.mines.push({
      id: this.nextEntityId++,
      owner: racer.id,
      damage,
      x: racer.x - sin * 3.2,
      z: racer.z - cos * 3.2,
      armTicks: Math.round(spec.armMs * MS_TO_TICKS),
      life: Math.round(spec.lifeMs * MS_TO_TICKS),
      armed: false,
    });
  }

  stepBullets() {
    const survivors = [];

    for (const bullet of this.bullets) {
      bullet.x += bullet.vx * DT;
      bullet.z += bullet.vz * DT;
      bullet.life -= 1;

      let hit = null;
      if (bullet.life > 0) {
        for (const racer of this.racers.values()) {
          if (racer.id === bullet.owner) continue;
          if ((racer.flags & FLAGS.ALIVE) === 0 || racer.finished) continue;
          const dx = racer.x - bullet.x;
          const dz = racer.z - bullet.z;
          if (dx * dx + dz * dz <= 1.8 * 1.8) {
            hit = racer;
            break;
          }
        }
      }

      if (hit) {
        this.applyDamage(hit, bullet.damage, bullet.owner);
        this.pushEvent({ k: 'hit', x: round(bullet.x), z: round(bullet.z) });
        continue;
      }

      if (bullet.life > 0) survivors.push(bullet);
    }

    this.bullets = survivors;
  }

  stepMines() {
    const survivors = [];

    for (const mine of this.mines) {
      mine.life -= 1;
      if (!mine.armed) {
        mine.armTicks -= 1;
        if (mine.armTicks <= 0) mine.armed = true;
      }

      let triggered = false;
      if (mine.armed) {
        for (const racer of this.racers.values()) {
          if ((racer.flags & FLAGS.ALIVE) === 0 || racer.finished) continue;
          const dx = racer.x - mine.x;
          const dz = racer.z - mine.z;
          if (dx * dx + dz * dz <= 3.2 * 3.2) {
            triggered = true;
            break;
          }
        }
      }

      if (triggered) {
        this.explodeMine(mine);
        continue;
      }

      if (mine.life > 0) survivors.push(mine);
    }

    this.mines = survivors;
  }

  explodeMine(mine) {
    const spec = WEAPONS[WEAPON.MINE];

    for (const racer of this.racers.values()) {
      if ((racer.flags & FLAGS.ALIVE) === 0 || racer.finished) continue;
      const dx = racer.x - mine.x;
      const dz = racer.z - mine.z;
      if (dx * dx + dz * dz <= spec.radius * spec.radius) {
        this.applyDamage(racer, mine.damage, mine.owner);
      }
    }

    this.pushEvent({ k: 'explode', x: round(mine.x), z: round(mine.z) });
  }

  stepCrates() {
    const respawnMs = this.map.items.respawnMs ?? CRATE.respawnMs;

    for (const crate of this.crates) {
      if (!crate.active) {
        if (this.tick >= crate.respawnTick) {
          crate.active = true;
          crate.weapon = this.randomWeapon();
        }
        continue;
      }

      for (const racer of this.racers.values()) {
        if ((racer.flags & FLAGS.ALIVE) === 0 || racer.finished) continue;
        const dx = racer.x - crate.x;
        const dz = racer.z - crate.z;
        if (dx * dx + dz * dz > CRATE.pickupRadius * CRATE.pickupRadius) continue;

        const spec = WEAPONS[crate.weapon];
        racer.weapon = crate.weapon;
        racer.ammo = spec.ammo;
        racer.weaponCooldown = 0;

        crate.active = false;
        crate.respawnTick = this.tick + Math.round(respawnMs * MS_TO_TICKS);
        this.pushEvent({ k: 'pickup', a: racer.id, w: crate.weapon, x: round(crate.x), z: round(crate.z) });
        break;
      }
    }
  }

  // ---------------------------------------------------------------- damage

  applyDamage(victim, amount, ownerId) {
    if ((victim.flags & FLAGS.ALIVE) === 0 || victim.finished) return;
    if (victim.invulnTicks > 0) return;

    let remaining = amount;
    if (victim.armor > 0) {
      const absorbed = Math.min(victim.armor, remaining);
      victim.armor -= absorbed;
      remaining -= absorbed;
    }

    victim.health -= remaining;

    if (victim.health <= 0) {
      victim.health = 0;
      this.stall(victim, ownerId);
    }
  }

  stall(racer) {
    racer.armor = 0;
    racer.flags = FLAGS.STALLED;
    racer.vx = 0;
    racer.vz = 0;
    racer.weapon = WEAPON.NONE;
    racer.ammo = 0;
    racer.boostTicks = 0;
    racer.stallTicks = Math.round(VEHICLE.respawnMs * MS_TO_TICKS);
    this.pushEvent({ k: 'wrecked', a: racer.id });
  }

  respawn(racer) {
    const p = pointAt(this.track, racer.s);

    racer.x = p.x;
    racer.z = p.z;
    racer.yaw = Math.atan2(p.tx, p.tz);
    racer.vx = 0;
    racer.vz = 0;
    racer.health = VEHICLE.baseHealth;
    racer.armor = Math.round(this.driverFor(racer).combat.armorMax * 0.5);
    racer.flags = FLAGS.ALIVE;
    racer.invulnTicks = 120;
    racer.stallTicks = 0;
    racer.lastS = racer.s;
    racer.weapon = WEAPON.NONE;
    racer.ammo = 0;
    racer.respawns += 1;

    this.pushEvent({ k: 'respawn', a: racer.id, x: round(racer.x), z: round(racer.z) });
  }

  // ------------------------------------------------------------------ bots

  botInput(racer) {
    if (racer.finished) return IDLE_INPUT;

    const speed = Math.hypot(racer.vx, racer.vz);
    const lookahead = (10 + speed * 0.32) / this.track.totalLength;
    const target = pointAt(this.track, racer.s + lookahead);
    const desired = Math.atan2(target.x - racer.x, target.z - racer.z);
    const diff = wrapAngle(desired - racer.yaw);

    const steer = clamp(diff * 2.2, -1, 1);
    const throttle = Math.abs(diff) > 1.15 ? 0.55 : 1;

    let fire = false;
    if (racer.weapon !== WEAPON.NONE && racer.ammo > 0) {
      const roll = this.rng();
      fire = racer.weapon === WEAPON.MACHINEGUN ? roll < 0.14 : roll < 0.03;
    }

    return {
      seq: 0,
      throttle,
      steer,
      drift: Math.abs(diff) > 0.65 && speed > 18,
      brake: false,
      fire,
    };
  }

  pushEvent(event) {
    if (this.events.length < 32) this.events.push(event);
  }

  // ------------------------------------------------------------- snapshots

  snapshot() {
    const racers = [];

    for (const racer of this.racers.values()) {
      racers.push([
        racer.id,
        round(racer.x),
        round(racer.y),
        round(racer.z),
        round(racer.yaw, 3),
        round(racer.vx),
        round(racer.vz),
        Math.round(racer.health),
        Math.round(racer.armor),
        racer.ack,
        racer.flags,
        racer.lap,
        round(racer.progress, 4),
        racer.weapon,
        racer.ammo,
        racer.place,
      ]);
    }

    const snapshot = {
      t: this.tick,
      phase: this.phase,
      countdownMs: Math.round((this.countdownTicks / NET.TICK_HZ) * 1000),
      raceTime: round(this.raceTime, 2),
      laps: this.map.laps,
      winner: this.winnerId,
      p: racers,
      b: this.bullets.map((bullet) => [bullet.id, round(bullet.x), round(bullet.y), round(bullet.z)]),
      m: this.mines.map((mine) => [mine.id, round(mine.x), round(mine.z), mine.armed ? 1 : 0]),
      c: this.crates.map((crate) => [
        crate.id,
        round(crate.x),
        round(crate.z),
        crate.weapon,
        crate.active ? 1 : 0,
      ]),
      e: this.events,
    };

    this.events = [];
    return snapshot;
  }

  info() {
    return {
      map: publicMap(this.map),
      laps: this.map.laps,
      racers: Array.from(this.racers.values(), (racer) => ({
        id: racer.id,
        name: racer.name,
        driverId: racer.driverId,
        isBot: racer.isBot,
      })),
    };
  }

  results() {
    const ordered = Array.from(this.racers.values()).sort((a, b) => {
      if (a.place && b.place) return a.place - b.place;
      if (a.place) return -1;
      if (b.place) return 1;
      return b.progress - a.progress;
    });

    return ordered.map((racer, index) => ({
      id: racer.id,
      name: racer.name,
      driverId: racer.driverId,
      isBot: racer.isBot,
      place: racer.place || index + 1,
      lap: Math.min(racer.lap + 1, this.map.laps),
      progress: round(racer.progress, 3),
      health: Math.round(racer.health),
      finished: racer.finished,
    }));
  }
}
