import { EVENTS } from '../../../shared/constants.js';
import { normalizeGameCode, sanitizeName } from '../../../shared/validate.js';
import { Room } from './Room.js';

const CODE_MIN = 1000;
const CODE_MAX = 9999;
const MAX_ROOMS = 2000;
const LOBBY_TTL_MS = 30 * 60 * 1000;

export class RoomManager {
  constructor({ io, log }) {
    this.io = io;
    this.log = log;
    this.rooms = new Map();
    this.codeOf = new Map();

    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  get size() {
    return this.rooms.size;
  }

  roomFor(socketId) {
    const code = this.codeOf.get(socketId);
    return code ? this.rooms.get(code) ?? null : null;
  }

  allocateCode() {
    const span = CODE_MAX - CODE_MIN + 1;
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const code = String(CODE_MIN + Math.floor(Math.random() * span));
      if (!this.rooms.has(code)) return code;
    }
    for (let code = CODE_MIN; code <= CODE_MAX; code += 1) {
      const candidate = String(code);
      if (!this.rooms.has(candidate)) return candidate;
    }
    return null;
  }

  create(socket, { name, driverId } = {}) {
    if (this.codeOf.has(socket.id)) {
      return { ok: false, code: 'ALREADY_IN_ROOM', error: 'You are already in a room' };
    }
    if (this.rooms.size >= MAX_ROOMS) {
      return { ok: false, code: 'INTERNAL', error: 'Server is at capacity, try again shortly' };
    }

    const code = this.allocateCode();
    if (!code) {
      return { ok: false, code: 'INTERNAL', error: 'Server is at capacity, try again shortly' };
    }

    const room = new Room({ io: this.io, code, hostId: socket.id, log: this.log });
    this.rooms.set(code, room);

    const result = this.enter(socket, room, { name, driverId });
    if (!result.ok) {
      this.rooms.delete(code);
      return result;
    }

    this.log.info(`room ${code} created by ${socket.id}`);
    return { ok: true, code };
  }

  join(socket, { code, name, driverId } = {}) {
    if (this.codeOf.has(socket.id)) {
      return { ok: false, code: 'ALREADY_IN_ROOM', error: 'You are already in a room' };
    }

    const normalized = normalizeGameCode(code);
    if (!normalized) {
      return { ok: false, code: 'BAD_REQUEST', error: 'Game codes are 4 digits' };
    }

    const room = this.rooms.get(normalized);
    if (!room) {
      return { ok: false, code: 'ROOM_NOT_FOUND', error: 'No room with that code' };
    }
    if (room.state !== 'lobby') {
      return { ok: false, code: 'ROOM_IN_PROGRESS', error: 'That race already started' };
    }

    const result = this.enter(socket, room, { name, driverId });
    if (!result.ok) return result;

    this.log.info(`${socket.id} joined room ${normalized}`);
    return { ok: true, code: normalized };
  }

  enter(socket, room, { name, driverId }) {
    const result = room.addPlayer({
      socketId: socket.id,
      name: sanitizeName(name, socket.id),
      driverId,
    });
    if (!result.ok) return result;

    socket.join(room.code);
    socket.data.roomCode = room.code;
    this.codeOf.set(socket.id, room.code);

    room.broadcast();
    return { ok: true };
  }

  leave(socket) {
    const code = this.codeOf.get(socket.id);
    if (!code) return { ok: true };

    this.codeOf.delete(socket.id);
    socket.leave(code);
    socket.data.roomCode = null;

    const room = this.rooms.get(code);
    if (!room) return { ok: true };

    const { empty } = room.removePlayer(socket.id);
    if (empty) this.destroyRoom(room);
    return { ok: true };
  }

  selectDriver(socket, driverId) {
    const room = this.roomFor(socket.id);
    if (!room) return { ok: false, code: 'NOT_IN_ROOM', error: 'You are not in a room' };
    return room.setDriver(socket.id, driverId);
  }

  selectMap(socket, mapId) {
    const room = this.roomFor(socket.id);
    if (!room) return { ok: false, code: 'NOT_IN_ROOM', error: 'You are not in a room' };
    return room.setMap(socket.id, mapId);
  }

  setReady(socket, ready) {
    const room = this.roomFor(socket.id);
    if (!room) return { ok: false, code: 'NOT_IN_ROOM', error: 'You are not in a room' };
    return room.setReady(socket.id, ready);
  }

  start(socket) {
    const room = this.roomFor(socket.id);
    if (!room) return { ok: false, code: 'NOT_IN_ROOM', error: 'You are not in a room' };
    return room.start(socket.id);
  }

  input(socket, message) {
    const room = this.roomFor(socket.id);
    if (!room || room.state !== 'racing' || !room.race) return;
    room.race.queueInput(socket.id, message);
  }

  destroyRoom(room) {
    room.destroy();
    this.rooms.delete(room.code);
    this.log.info(`room ${room.code} closed`);
  }

  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.state !== 'lobby') continue;
      if (now - room.updatedAt < LOBBY_TTL_MS) continue;

      this.io.to(room.code).emit(EVENTS.ERROR, {
        code: 'ROOM_EXPIRED',
        message: 'Room closed after a long idle period',
      });
      this.destroyRoom(room);
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.codeOf.clear();
  }
}
