// Authoritative race simulation for one room.
//
// Loop contract:
//   * fixed timestep (NET.TICK_HZ), accumulator driven by a monotonic clock
//   * exactly one queued client input is consumed per tick -> deterministic ack
//   * snapshots at NET.SNAPSHOT_HZ carrying per-racer ack sequence numbers so
//     clients can replay only their unacknowledged inputs
//
// Nothing here is rendered; positions/rotation are the only truth the client
// receives, and the client only ever sends intent.

import { randomInt } from 'node:crypto';
import { EVENTS, FLAGS, NET, SNAPSHOT_FIELDS } from '../../shared/protocol.js';
import { NETWORK } from '../../config/game.js';
import { DRIVER_BY_ID } from '../../config/roster.js';
import { MAP_BY_ID, publicMap } from '../../config/maps.js';
import { createRaceState, stepVehicle } from './kinematic.js';
import { sanitizeInput } from '../util/validate.js';

const IDLE_INPUT = Object.freeze({
  seq: 0,
  throttle: 0,
  steer: 0,
  drift: false,
  brake: false,
  useItem: false,
});

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export class Race {
  constructor({ io, code, mapId, log }) {
    this.io = io;
    this.code = code;
    this.map = MAP_BY_ID.get(mapId);
    this.log = log;

    this.racers = new Map(); // racerId -> racer
    this.bySocket = new Map(); // socketId -> racerId

    this.tick = 0;
    this.acc = 0;
    this.last = 0;
    this.lastSnapshotTick = -1;
    this.nextRacerId = 1;
    this.events = [];
    this.timer = null;
    this.startedAt = 0;
    this.seed = randomInt(0, 2 ** 31 - 1);
  }

  get racerCount() {
    return this.racers.size;
  }

  // ------------------------------------------------------------- roster

  addRacer({ socketId, name, driverId }) {
    const driver = DRIVER_BY_ID.get(driverId);
    if (!driver) return null;

    const id = this.nextRacerId++;
    const spawn = this.spawnFor(id - 1);
    const racer = {
      id,
      socketId,
      name,
      driverId,
      ...createRaceState({ driver, spawn }),
      ack: 0,
      pending: [],
    };

    this.racers.set(id, racer);
    this.bySocket.set(socketId, id);
    this.pushEvent({ k: 'join', id });
    return racer;
  }

  removeRacer(socketId) {
    const id = this.bySocket.get(socketId);
    if (id === undefined) return;
    this.bySocket.delete(socketId);
    this.racers.delete(id);
    this.pushEvent({ k: 'leave', id });
  }

  /**
   * Grid slot: two columns behind the start line. Real map spawn points replace
   * this once track layouts exist.
   */
  spawnFor(index) {
    const column = index % 2;
    const row = Math.floor(index / 2);
    return {
      x: (column === 0 ? -2.2 : 2.2) + row * 0.4,
      z: -row * 6.5,
      yaw: 0,
    };
  }

  // --------------------------------------------------------------- input

  queueInput(socketId, message) {
    const racerId = this.bySocket.get(socketId);
    if (racerId === undefined) return;

    const racer = this.racers.get(racerId);
    if (!racer) return;

    if (racer.pending.length >= NETWORK.INPUT_QUEUE_LIMIT) racer.pending.shift();
    racer.pending.push(sanitizeInput(message));
  }

  // ---------------------------------------------------------------- loop

  start() {
    this.last = performance.now();
    this.startedAt = Date.now();

    for (const racer of this.racers.values()) {
      this.io.to(racer.socketId).emit(EVENTS.RACE_STARTED, {
        code: this.code,
        you: racer.id,
        map: publicMap(this.map),
        racers: Array.from(this.racers.values(), (entry) => ({
          id: entry.id,
          name: entry.name,
          driverId: entry.driverId,
        })),
        network: NET,
        startedAt: this.startedAt,
        seed: this.seed,
      });
    }

    this.timer = setInterval(() => this.loop(), 1000 / NET.TICK_HZ);
    this.timer.unref?.();
    this.log.info(`race started in ${this.code} (${this.map.id}, ${this.racers.size} racers)`);
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
    const dt = 1 / NET.TICK_HZ;
    let steps = 0;

    while (this.acc >= dt && steps < NETWORK.MAX_STEPS_PER_LOOP) {
      this.acc -= dt;
      this.step(dt);
      this.tick += 1;
      steps += 1;
    }

    if (steps > 0 && this.tick - this.lastSnapshotTick >= NET.TICK_HZ / NET.SNAPSHOT_HZ) {
      this.lastSnapshotTick = this.tick;
      this.broadcastSnapshot();
    }
  }

  step(dt) {
    for (const racer of this.racers.values()) {
      const input = racer.pending.length > 0 ? racer.pending.shift() : IDLE_INPUT;
      if (input.seq > racer.ack) racer.ack = input.seq;

      stepVehicle(racer, input, dt, {
        driver: DRIVER_BY_ID.get(racer.driverId),
        map: this.map,
      });
    }
  }

  // ----------------------------------------------------------- snapshots

  pushEvent(event) {
    if (this.events.length < 32) this.events.push(event);
  }

  encodeRacer(racer) {
    const row = new Array(12);
    row[SNAPSHOT_FIELDS.ID] = racer.id;
    row[SNAPSHOT_FIELDS.X] = round(racer.x);
    row[SNAPSHOT_FIELDS.Y] = round(racer.y);
    row[SNAPSHOT_FIELDS.Z] = round(racer.z);
    row[SNAPSHOT_FIELDS.VX] = round(racer.vx);
    row[SNAPSHOT_FIELDS.VY] = round(racer.vy);
    row[SNAPSHOT_FIELDS.VZ] = round(racer.vz);
    row[SNAPSHOT_FIELDS.YAW] = round(racer.yaw, 3);
    row[SNAPSHOT_FIELDS.HEALTH] = Math.round(racer.health);
    row[SNAPSHOT_FIELDS.ARMOR] = Math.round(racer.armor);
    row[SNAPSHOT_FIELDS.ACK] = racer.ack;
    row[SNAPSHOT_FIELDS.FLAGS] = racer.flags;
    return row;
  }

  broadcastSnapshot() {
    const snapshot = {
      t: this.tick,
      srv: Date.now(),
      p: Array.from(this.racers.values(), (racer) => this.encodeRacer(racer)),
      e: this.events,
    };
    this.events = [];
    this.io.to(this.code).emit(EVENTS.SNAPSHOT, snapshot);
  }

  // ------------------------------------------------------------- results

  results() {
    return Array.from(this.racers.values(), (racer) => ({
      id: racer.id,
      name: racer.name,
      driverId: racer.driverId,
      health: Math.round(racer.health),
      armor: Math.round(racer.armor),
      alive: (racer.flags & FLAGS.ALIVE) !== 0,
    }));
  }
}
