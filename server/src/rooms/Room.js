import { EVENTS } from '../../../shared/constants.js';
import { DRIVERS, DRIVER_BY_ID } from '../../../shared/roster.js';
import { DEFAULT_MAP_ID, MAP_BY_ID } from '../../../shared/maps.js';
import { Race } from '../race/Race.js';

export const MAX_PLAYERS = 4;

export class Room {
  constructor({ io, code, hostId, log }) {
    this.io = io;
    this.code = code;
    this.hostId = hostId;
    this.log = log;
    this.state = 'lobby'; // 'lobby' | 'racing'
    this.mapId = DEFAULT_MAP_ID;
    this.players = new Map();
    this.race = null;
    this.updatedAt = Date.now();
  }

  touch() {
    this.updatedAt = Date.now();
  }

  freeDriverId() {
    const taken = new Set(Array.from(this.players.values(), (player) => player.driverId));
    const free = DRIVERS.find((driver) => !taken.has(driver.id));
    return (free ?? DRIVERS[0]).id;
  }

  resolveDriver(driverId, exceptSocketId) {
    if (!driverId) return { ok: true, driverId: this.freeDriverId() };
    if (!DRIVER_BY_ID.has(driverId)) {
      return { ok: false, code: 'BAD_DRIVER', error: 'Unknown driver' };
    }
    const taken = Array.from(this.players.values()).some(
      (player) => player.driverId === driverId && player.socketId !== exceptSocketId,
    );
    if (taken) return { ok: false, code: 'DRIVER_TAKEN', error: 'That driver is already taken' };
    return { ok: true, driverId };
  }

  addPlayer({ socketId, name, driverId }) {
    if (this.state !== 'lobby') {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'That race already started' };
    }
    if (this.players.size >= MAX_PLAYERS) {
      return { ok: false, code: 'ROOM_FULL', error: 'That room is full' };
    }

    const driver = this.resolveDriver(driverId, socketId);
    if (!driver.ok) return driver;

    this.players.set(socketId, {
      socketId,
      name,
      driverId: driver.driverId,
      ready: false,
    });
    this.touch();
    return { ok: true };
  }

  removePlayer(socketId) {
    const existed = this.players.delete(socketId);

    if (this.race) {
      this.race.removeRacer(socketId);
      if (this.race.racerCount === 0) {
        this.endRace({ reason: 'empty', results: [] });
      }
    }

    if (this.hostId === socketId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value;
    }

    this.touch();
    if (existed && this.players.size > 0) this.broadcast();

    return { empty: this.players.size === 0 };
  }

  setDriver(socketId, driverId) {
    const player = this.players.get(socketId);
    if (!player) return { ok: false, code: 'NOT_IN_ROOM', error: 'You are not in this room' };
    if (this.state !== 'lobby') {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'Cannot change driver mid-race' };
    }

    const resolved = this.resolveDriver(driverId, socketId);
    if (!resolved.ok) return resolved;

    player.driverId = resolved.driverId;
    player.ready = false;
    this.touch();
    this.broadcast();
    return { ok: true, driverId: resolved.driverId };
  }

  setMap(socketId, mapId) {
    if (socketId !== this.hostId) {
      return { ok: false, code: 'NOT_HOST', error: 'Only the host picks the map' };
    }
    if (this.state !== 'lobby') {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'Cannot change map mid-race' };
    }
    if (!MAP_BY_ID.has(mapId)) {
      return { ok: false, code: 'BAD_MAP', error: 'Unknown map' };
    }

    this.mapId = mapId;
    this.touch();
    this.broadcast();
    return { ok: true, mapId };
  }

  setReady(socketId, ready) {
    const player = this.players.get(socketId);
    if (!player) return { ok: false, code: 'NOT_IN_ROOM', error: 'You are not in this room' };
    if (this.state !== 'lobby') {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'The race already started' };
    }

    player.ready = Boolean(ready);
    this.touch();
    this.broadcast();
    return { ok: true, ready: player.ready };
  }

  start(socketId) {
    if (socketId !== this.hostId) {
      return { ok: false, code: 'NOT_HOST', error: 'Only the host can start the race' };
    }
    if (this.state !== 'lobby') {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'The race already started' };
    }

    const waiting = Array.from(this.players.values()).find(
      (player) => player.socketId !== this.hostId && !player.ready,
    );
    if (waiting) {
      return { ok: false, code: 'NOT_READY', error: `${waiting.name} is not ready` };
    }

    this.state = 'racing';
    this.race = new Race({
      io: this.io,
      code: this.code,
      mapId: this.mapId,
      log: this.log,
      onFinished: (payload) => this.endRace(payload),
    });

    for (const player of this.players.values()) {
      this.race.addRacer({
        socketId: player.socketId,
        name: player.name,
        driverId: player.driverId,
      });
      player.ready = false;
    }

    this.broadcast();
    this.race.start();
    this.touch();
    return { ok: true, mapId: this.mapId };
  }

  endRace(payload = { reason: 'finished', results: [] }) {
    if (!this.race) return;

    const finalSnapshot = this.race.match.snapshot();
    this.race.stop();
    this.race = null;
    this.state = 'lobby';

    for (const player of this.players.values()) player.ready = false;

    this.io.to(this.code).emit(EVENTS.SNAPSHOT, finalSnapshot);
    this.io.to(this.code).emit(EVENTS.RACE_ENDED, payload);
    this.touch();
    this.broadcast();
  }

  view() {
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      mapId: this.mapId,
      maxPlayers: MAX_PLAYERS,
      players: Array.from(this.players.values(), (player) => ({
        id: player.socketId,
        name: player.name,
        driverId: player.driverId,
        ready: player.ready,
      })),
    };
  }

  broadcast() {
    this.io.to(this.code).emit(EVENTS.ROOM, this.view());
  }

  destroy() {
    this.race?.stop();
    this.race = null;
    this.players.clear();
  }
}
