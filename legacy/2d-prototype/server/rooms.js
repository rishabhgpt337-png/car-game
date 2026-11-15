// Lobby + room lifecycle.
//
// A room owns a 4-digit code, a member list and (once started) a Game instance.
// Codes are strings so leading behaviour is predictable ("1000".."9999").

import {
  ARENA,
  INTERP_DELAY_MS,
  MAX_PLAYERS,
  SNAPSHOT_HZ,
  TICK_HZ,
} from '../shared/constants.js';
import { Game } from './game.js';

const MAX_NAME_LENGTH = 14;
const CODE_MIN = 1000;
const CODE_MAX = 9999;

function cleanName(raw, socket) {
  const name = String(raw ?? '')
    .replace(/[^\w \-.]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name || `Racer ${socket.id.slice(0, 3).toUpperCase()}`;
}

class Room {
  constructor(io, code) {
    this.io = io;
    this.code = code;
    this.hostId = null;
    this.state = 'lobby'; // 'lobby' | 'playing'
    this.members = new Map(); // socketId -> { name }
    this.game = null;
  }

  view() {
    return {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      maxPlayers: MAX_PLAYERS,
      players: Array.from(this.members, ([id, member]) => ({ id, name: member.name })),
    };
  }

  broadcast() {
    this.io.to(this.code).emit('lobby:room', this.view());
  }

  start() {
    if (this.state !== 'lobby') return false;

    this.state = 'playing';
    this.game = new Game(this.io, this.code);

    const roster = [];
    for (const [socketId, member] of this.members) {
      const ship = this.game.addPlayer(socketId, member.name);
      roster.push({
        socketId,
        id: ship.id,
        name: member.name,
        x: ship.x,
        y: ship.y,
        angle: ship.angle,
      });
    }

    // Send each player their own slot so prediction starts from the real spawn.
    for (const entry of roster) {
      this.io.to(entry.socketId).emit('game:start', {
        code: this.code,
        you: entry.id,
        players: roster.map(({ id, name, x, y, angle }) => ({ id, name, x, y, angle })),
        arena: ARENA,
        tickHz: TICK_HZ,
        snapshotHz: SNAPSHOT_HZ,
        interpDelayMs: INTERP_DELAY_MS,
      });
    }

    this.broadcast();
    this.game.start();
    return true;
  }

  stopGame() {
    if (this.game) this.game.stop();
    this.game = null;
  }

  destroy() {
    this.stopGame();
    this.members.clear();
  }
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> Room
    this.roomOf = new Map(); // socketId -> Room
  }

  freeCode() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const code = String(CODE_MIN + Math.floor(Math.random() * (CODE_MAX - CODE_MIN + 1)));
      if (!this.rooms.has(code)) return code;
    }
    // Extremely unlikely: fall back to a linear scan so creation never fails.
    for (let code = CODE_MIN; code <= CODE_MAX; code += 1) {
      const value = String(code);
      if (!this.rooms.has(value)) return value;
    }
    return null;
  }

  create(socket, rawName) {
    if (this.roomOf.has(socket.id)) return { ok: false, error: 'You are already in a room' };

    const code = this.freeCode();
    if (!code) return { ok: false, error: 'Server is full, try again later' };

    const room = new Room(this.io, code);
    room.hostId = socket.id;
    this.rooms.set(code, room);
    this.enter(socket, room, rawName);

    return { ok: true, code };
  }

  join(socket, rawCode, rawName) {
    if (this.roomOf.has(socket.id)) return { ok: false, error: 'You are already in a room' };

    const code = String(rawCode ?? '').trim();
    if (!/^\d{4}$/.test(code)) return { ok: false, error: 'Game codes are 4 digits' };

    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'No game with that code' };
    if (room.state !== 'lobby') return { ok: false, error: 'That game has already started' };
    if (room.members.size >= MAX_PLAYERS) return { ok: false, error: 'That room is full' };

    this.enter(socket, room, rawName);
    return { ok: true, code };
  }

  enter(socket, room, rawName) {
    socket.join(room.code);
    socket.data.code = room.code;
    room.members.set(socket.id, { name: cleanName(rawName, socket) });
    this.roomOf.set(socket.id, room);
    room.broadcast();
  }

  start(socket) {
    const room = this.roomOf.get(socket.id);
    if (!room) return { ok: false, error: 'You are not in a room' };
    if (room.hostId !== socket.id) return { ok: false, error: 'Only the host can start the race' };
    if (!room.start()) return { ok: false, error: 'The race already started' };
    return { ok: true };
  }

  leave(socket) {
    const room = this.roomOf.get(socket.id);
    if (!room) return { ok: true };

    this.roomOf.delete(socket.id);
    room.members.delete(socket.id);
    socket.leave(room.code);
    socket.data.code = null;

    if (room.game) room.game.removePlayer(socket.id);

    if (room.members.size === 0) {
      room.destroy();
      this.rooms.delete(room.code);
      return { ok: true };
    }

    // Hand the host role to the next member in line.
    if (room.hostId === socket.id) {
      room.hostId = room.members.keys().next().value;
    }

    room.broadcast();
    return { ok: true };
  }

  input(socket, message) {
    const room = this.roomOf.get(socket.id);
    if (!room || room.state !== 'playing' || !room.game) return;
    room.game.queueInput(socket.id, message);
  }
}
