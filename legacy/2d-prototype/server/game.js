// Authoritative match simulation and network loop for one room.
//
// Design notes:
//  * Fixed 60 Hz simulation, one queued client input consumed per tick.
//  * Snapshots are sent at 20 Hz with each ship's last consumed input sequence,
//    which lets the client replay its unacknowledged inputs (reconciliation).
//  * The server never trusts client state: only throttle/turn/aim/fire are
//    accepted, and firing rate, damage and respawns are decided here.

import { ARENA, BULLET, SHIP, SNAPSHOT_EVERY, TICK_HZ } from '../shared/constants.js';
import { createShip, spawnPoint, stepShip, wrapAngle } from '../shared/physics.js';

const MAX_QUEUED_INPUTS = 8;
const MAX_STEPS_PER_LOOP = 6;
const FIRE_COOLDOWN_TICKS = Math.ceil((BULLET.cooldownMs / 1000) * TICK_HZ);
const RESPAWN_TICKS = Math.ceil((SHIP.respawnMs / 1000) * TICK_HZ);
const IDLE_INPUT = Object.freeze({ t: 0, r: 0, f: false, seq: 0, a: undefined });

const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function sanitizeInput(message) {
  if (!message || typeof message !== 'object') return { ...IDLE_INPUT };

  const number = (value, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
  };

  return {
    t: number(message.t, -1, 1),
    r: number(message.r, -1, 1),
    a: Number.isFinite(Number(message.a)) ? wrapAngle(Number(message.a)) : undefined,
    f: message.f === true,
    seq: Math.max(0, Math.floor(number(message.seq, 0, Number.MAX_SAFE_INTEGER))),
  };
}

export class Game {
  constructor(io, code) {
    this.io = io;
    this.code = code;

    /** @type {Map<number, object>} slot id -> ship state */
    this.ships = new Map();
    /** @type {Map<string, number>} socket id -> slot id */
    this.bySocket = new Map();
    /** @type {Map<number, string>} slot id -> socket id */
    this.sockets = new Map();
    /** @type {Map<number, object[]>} slot id -> queued inputs */
    this.queues = new Map();

    this.bullets = [];
    this.events = [];
    this.tick = 0;
    this.acc = 0;
    this.last = 0;
    this.lastSnapshotTick = -1;
    this.nextShipId = 1;
    this.nextBulletId = 1;
    this.timer = null;
  }

  // ---------------------------------------------------------------- roster

  addPlayer(socketId, name) {
    const id = this.nextShipId++;
    const spawn = spawnPoint(id);
    const ship = createShip(id, name, spawn.x, spawn.y, spawn.angle);

    this.ships.set(id, ship);
    this.bySocket.set(socketId, id);
    this.sockets.set(id, socketId);
    this.queues.set(id, []);
    this.pushEvent({ k: 'join', a: id });

    return ship;
  }

  removePlayer(socketId) {
    const id = this.bySocket.get(socketId);
    if (id === undefined) return;

    this.bySocket.delete(socketId);
    this.sockets.delete(id);
    this.ships.delete(id);
    this.queues.delete(id);
    this.bullets = this.bullets.filter((bullet) => bullet.owner !== id);
    this.pushEvent({ k: 'leave', a: id });
  }

  get playerCount() {
    return this.ships.size;
  }

  // ------------------------------------------------------------ net input

  queueInput(socketId, message) {
    const id = this.bySocket.get(socketId);
    if (id === undefined) return;

    const queue = this.queues.get(id);
    if (!queue) return;

    // Drop the oldest input if a client floods us: the newest state wins.
    if (queue.length >= MAX_QUEUED_INPUTS) queue.shift();
    queue.push(sanitizeInput(message));
  }

  // ---------------------------------------------------------------- loop

  start() {
    this.last = performance.now();
    this.timer = setInterval(() => this.loop(), 1000 / TICK_HZ);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  loop() {
    const now = performance.now();
    let elapsed = (now - this.last) / 1000;
    this.last = now;
    if (elapsed > 0.25) elapsed = 0.25;

    this.acc += elapsed;
    const dt = 1 / TICK_HZ;
    let steps = 0;

    while (this.acc >= dt && steps < MAX_STEPS_PER_LOOP) {
      this.acc -= dt;
      this.step(dt);
      this.tick += 1;
      steps += 1;
    }

    if (steps > 0 && this.tick - this.lastSnapshotTick >= SNAPSHOT_EVERY) {
      this.lastSnapshotTick = this.tick;
      this.sendSnapshot();
    }
  }

  step(dt) {
    for (const ship of this.ships.values()) {
      const queue = this.queues.get(ship.id);
      const input = queue && queue.length > 0 ? queue.shift() : IDLE_INPUT;

      if (input.seq) ship.ack = input.seq;

      if (ship.alive) {
        stepShip(ship, input, dt);
        if (input.f) this.fire(ship);
      } else if (this.tick >= ship.respawnTick) {
        this.respawn(ship);
      }
    }

    this.updateBullets(dt);
  }

  // -------------------------------------------------------------- combat

  fire(ship) {
    if (this.tick < ship.nextFireTick) return;
    ship.nextFireTick = this.tick + FIRE_COOLDOWN_TICKS;

    const angle = ship.turret;
    const muzzle = SHIP.radius + BULLET.radius + 2;

    this.bullets.push({
      id: this.nextBulletId++,
      owner: ship.id,
      x: ship.x + Math.cos(angle) * muzzle,
      y: ship.y + Math.sin(angle) * muzzle,
      vx: Math.cos(angle) * BULLET.speed + ship.vx * 0.25,
      vy: Math.sin(angle) * BULLET.speed + ship.vy * 0.25,
      life: Math.ceil((BULLET.lifeMs / 1000) * TICK_HZ),
    });
  }

  updateBullets(dt) {
    const survivors = [];
    const hitRadius = SHIP.radius + BULLET.radius;

    for (const bullet of this.bullets) {
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      bullet.life -= 1;

      if (
        bullet.life <= 0 ||
        bullet.x < 0 ||
        bullet.y < 0 ||
        bullet.x > ARENA.width ||
        bullet.y > ARENA.height
      ) {
        continue;
      }

      let victim = null;
      for (const ship of this.ships.values()) {
        if (!ship.alive || ship.id === bullet.owner) continue;
        const dx = ship.x - bullet.x;
        const dy = ship.y - bullet.y;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          victim = ship;
          break;
        }
      }

      if (!victim) {
        survivors.push(bullet);
        continue;
      }

      victim.hp -= BULLET.damage;
      this.pushEvent({ k: 'hit', a: victim.id, b: bullet.owner });

      if (victim.hp <= 0) {
        victim.hp = 0;
        this.kill(victim, this.ships.get(bullet.owner));
      }
    }

    this.bullets = survivors;
  }

  kill(victim, killer) {
    victim.alive = false;
    victim.vx = 0;
    victim.vy = 0;
    victim.respawnTick = this.tick + RESPAWN_TICKS;

    if (killer && killer.id !== victim.id) {
      killer.score += 1;
      this.pushEvent({ k: 'kill', a: victim.id, b: killer.id });
    } else {
      this.pushEvent({ k: 'down', a: victim.id });
    }
  }

  respawn(ship) {
    const spawn = spawnPoint(ship.id);
    ship.x = spawn.x;
    ship.y = spawn.y;
    ship.angle = spawn.angle;
    ship.turret = spawn.angle;
    ship.vx = 0;
    ship.vy = 0;
    ship.hp = SHIP.maxHp;
    ship.alive = true;
    this.pushEvent({ k: 'spawn', a: ship.id });
  }

  // ------------------------------------------------------------ snapshots

  pushEvent(event) {
    if (this.events.length < 64) this.events.push(event);
  }

  sendSnapshot() {
    const ships = [];
    for (const ship of this.ships.values()) {
      ships.push([
        ship.id,
        round(ship.x, 1),
        round(ship.y, 1),
        round(ship.vx, 2),
        round(ship.vy, 2),
        round(ship.angle, 3),
        round(ship.turret, 3),
        Math.round(ship.hp),
        ship.ack,
        ship.score,
        ship.alive ? 1 : 0,
      ]);
    }

    const bullets = this.bullets.map((bullet) => [
      bullet.id,
      round(bullet.x, 1),
      round(bullet.y, 1),
      bullet.owner,
    ]);

    const snapshot = { t: this.tick, p: ships, b: bullets, e: this.events };
    this.events = [];

    this.io.to(this.code).emit('net:snapshot', snapshot);
  }
}
