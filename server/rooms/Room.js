// A single lobby/race room. Owns membership, roster and map selection, ready
// gating and the Race instance while racing.

import { EVENTS, PHASE } from '../../shared/protocol.js';
import { ROOM } from '../../config/game.js';
import { DRIVER_BY_ID, DRIVERS } from '../../config/roster.js';
import { DEFAULT_MAP_ID, MAP_BY_ID } from '../../config/maps.js';
import { Race } from '../simulation/Race.js';

export class Room {
  constructor({ io, code, hostId, log }) {
    this.io = io;
    this.code = code;
    this.hostId = hostId;
    this.log = log;

    this.phase = PHASE.LOBBY;
    this.mapId = DEFAULT_MAP_ID;
    /** @type {Map<string, {socketId:string,name:string,driverId:string,ready:boolean,racerId:number|null}>} */
    this.players = new Map();
    this.race = null;

    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  touch() {
    this.updatedAt = Date.now();
  }

  // ------------------------------------------------------------- members

  /** First driver nobody in the room has picked. */
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
    if (this.phase !== PHASE.LOBBY) {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'That race already started' };
    }
    if (this.players.size >= ROOM.MAX_PLAYERS) {
      return { ok: false, code: 'ROOM_FULL', error: 'That room is full' };
    }

    const driver = this.resolveDriver(driverId, socketId);
    if (!driver.ok) return driver;

    this.players.set(socketId, {
      socketId,
      name,
      driverId: driver.driverId,
      ready: false,
      racerId: null,
    });
    this.touch();
    return { ok: true };
  }

  /** No broadcast here: the caller joins the socket.io channel first. */
  removePlayer(socketId) {
    const existed = this.players.delete(socketId);

    if (this.race) {
      this.race.removeRacer(socketId);
      if (this.race.racerCount === 0) this.endRace('empty');
    }

    if (this.hostId === socketId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value;
    }

    this.touch();
    if (existed && this.players.size > 0) this.broadcast();
    return { empty: this.players.size === 0 };
  }

  // ------------------------------------------------------------ lobby UI

  setDriver(socketId, driverId) {
    const player = this.players.get(socketId);
    if (!player) return { ok: false, code: 'NOT_IN_ROOM', error: 'You are not in this room' };
    if (this.phase !== PHASE.LOBBY) {
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
    if (this.phase !== PHASE.LOBBY) {
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
    if (this.phase !== PHASE.LOBBY) {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'The race already started' };
    }

    player.ready = Boolean(ready);
    this.touch();
    this.broadcast();
    return { ok: true, ready: player.ready };
  }

  // ---------------------------------------------------------------- race

  start(socketId) {
    if (socketId !== this.hostId) {
      return { ok: false, code: 'NOT_HOST', error: 'Only the host can start the race' };
    }
    if (this.phase !== PHASE.LOBBY) {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'The race already started' };
    }

    const waiting = Array.from(this.players.values()).find(
      (player) => player.socketId !== this.hostId && !player.ready,
    );
    if (waiting) {
      return { ok: false, code: 'NOT_READY', error: `${waiting.name} is not ready` };
    }

    this.phase = PHASE.RACING;
    this.race = new Race({ io: this.io, code: this.code, mapId: this.mapId, log: this.log });

    for (const player of this.players.values()) {
      const racer = this.race.addRacer({
        socketId: player.socketId,
        name: player.name,
        driverId: player.driverId,
      });
      player.racerId = racer ? racer.id : null;
      player.ready = false;
    }

    this.broadcast();
    this.race.start();
    this.touch();
    return { ok: true, mapId: this.mapId };
  }

  endRace(reason = 'finished') {
    if (!this.race) return;

    const results = this.race.results();
    this.race.stop();
    this.race = null;
    this.phase = PHASE.LOBBY;

    for (const player of this.players.values()) {
      player.racerId = null;
      player.ready = false;
    }

    this.io.to(this.code).emit(EVENTS.RACE_ENDED, { reason, results });
    this.touch();
    this.broadcast();
  }

  // ---------------------------------------------------------- broadcasting

  view() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      mapId: this.mapId,
      maxPlayers: ROOM.MAX_PLAYERS,
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
