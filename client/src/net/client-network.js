// Online transport. Owns one Socket.io connection, the 60 Hz input loop and
// snapshot ingestion. Rendering and game rules live elsewhere.

import { io } from 'socket.io-client';
import { EVENTS, NET, PROTOCOL_VERSION } from '@shared/constants.js';

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export class ClientNetwork {
  constructor({ url }) {
    this.url = url;
    this.socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 6000,
      timeout: NET.HELLO_TIMEOUT_MS,
    });

    this.handlers = new Map();
    this.config = null;
    this.room = null;
    this.racing = false;
    this.racerId = null;
    this.seq = 0;
    this.pending = [];
    this.latencyMs = null;
    this.serverOffsetMs = 0;
    this.inputProvider = null;
    this.inputTimer = null;
    this.pingTimer = null;
    this.readyPromise = null;
    this.handshakeDone = false;

    this.bind();
  }

  // --------------------------------------------------------------- events

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[net] "${event}" handler failed`, error);
      }
    }
  }

  get id() {
    return this.socket.id;
  }

  get isHost() {
    return Boolean(this.room) && this.room.hostId === this.socket.id;
  }

  // ------------------------------------------------------------- handshake

  connect() {
    if (this.handshakeDone) return Promise.resolve({ ok: true, config: this.config });
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyPromise = null;
        reject(new Error('Server handshake timed out'));
      }, NET.HELLO_TIMEOUT_MS + 3000);

      const handshake = () => {
        this.socket.emit(EVENTS.HELLO, { protocolVersion: PROTOCOL_VERSION }, (res) => {
          clearTimeout(timeout);
          if (!res?.ok) {
            this.socket.disconnect();
            this.readyPromise = null;
            reject(new Error(res?.error || 'Handshake rejected'));
            return;
          }

          this.handshakeDone = true;
          this.config = res.config;
          this.serverOffsetMs = res.serverTime - Date.now();
          this.startPing();
          resolve(res);
        });
      };

      if (this.socket.connected) handshake();
      else this.socket.once('connect', handshake);

      this.socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        this.readyPromise = null;
        reject(new Error(error?.message || 'Could not reach the game server'));
      });
    });

    return this.readyPromise;
  }

  bind() {
    this.socket.on('connect', () => {
      if (this.handshakeDone) this.startPing();
    });

    this.socket.on('disconnect', () => {
      this.racing = false;
      this.stopInput();
      this.emit('disconnected');
    });

    this.socket.on(EVENTS.ROOM, (room) => {
      this.room = room;
      this.emit('room', room);
    });

    this.socket.on(EVENTS.RACE_STARTED, (info) => {
      this.racing = true;
      this.racerId = info.you;
      this.seq = 0;
      this.pending = [];
      this.emit('race-started', info);
      this.startInput();
    });

    this.socket.on(EVENTS.SNAPSHOT, (snapshot) => {
      const mine = snapshot.p?.find((row) => row[0] === this.racerId);
      if (mine) {
        const ack = mine[9];
        if (this.pending.length > 0) {
          this.pending = this.pending.filter((input) => input.seq > ack);
        }
      }
      this.emit('snapshot', snapshot);
    });

    this.socket.on(EVENTS.RACE_ENDED, (payload) => {
      this.racing = false;
      this.stopInput();
      this.emit('race-ended', payload);
    });

    this.socket.on(EVENTS.ERROR, (payload) => this.emit('error', payload));
  }

  startPing() {
    if (this.pingTimer) return;

    const ping = () => {
      if (!this.socket.connected) return;
      const sentAt = Date.now();
      this.socket.emit(EVENTS.PING, { t: sentAt }, (res) => {
        if (!res) return;
        const rtt = Date.now() - sentAt;
        this.latencyMs = this.latencyMs === null ? Math.round(rtt) : Math.round(this.latencyMs * 0.75 + rtt * 0.25);
        this.serverOffsetMs = res.serverTime - (sentAt + rtt / 2);
        this.emit('latency', { latencyMs: this.latencyMs });
      });
    };

    ping();
    this.pingTimer = setInterval(ping, NET.PING_INTERVAL_MS);
  }

  // ----------------------------------------------------------------- input

  setInputProvider(provider) {
    this.inputProvider = provider;
  }

  sendInput(input) {
    if (!this.racing) return;
    const seq = this.seq + 1;
    this.seq = seq;

    const payload = {
      seq,
      throttle: clamp(Number(input?.throttle) || 0, -1, 1),
      steer: clamp(Number(input?.steer) || 0, -1, 1),
      drift: input?.drift === true,
      brake: input?.brake === true,
      fire: input?.fire === true,
    };

    this.pending.push(payload);
    if (this.pending.length > 240) this.pending.shift();
    this.socket.emit(EVENTS.INPUT, payload);
  }

  startInput() {
    if (this.inputTimer) return;
    this.inputTimer = setInterval(() => {
      if (!this.racing) return;
      this.sendInput(this.inputProvider ? this.inputProvider() : null);
    }, 1000 / NET.INPUT_HZ);
  }

  stopInput() {
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = null;
  }

  // ----------------------------------------------------------------- lobby

  request(event, payload = {}) {
    return new Promise((resolve) => {
      if (!this.socket.connected) {
        resolve({ ok: false, code: 'DISCONNECTED', error: 'Not connected to the game server' });
        return;
      }
      this.socket.emit(event, payload, (res) => {
        resolve(res ?? { ok: false, code: 'NO_RESPONSE', error: 'Server did not answer' });
      });
    });
  }

  createRoom({ name, driverId } = {}) {
    return this.request(EVENTS.CREATE_ROOM, { name, driverId });
  }

  joinRoom({ code, name, driverId } = {}) {
    return this.request(EVENTS.JOIN_ROOM, { code, name, driverId });
  }

  async leaveRoom() {
    const res = await this.request(EVENTS.LEAVE_ROOM);
    if (res.ok) {
      this.room = null;
      this.racing = false;
      this.racerId = null;
      this.stopInput();
    }
    return res;
  }

  selectDriver(driverId) {
    return this.request(EVENTS.SELECT_DRIVER, { driverId });
  }

  selectMap(mapId) {
    return this.request(EVENTS.SELECT_MAP, { mapId });
  }

  setReady(ready) {
    return this.request(EVENTS.SET_READY, { ready: Boolean(ready) });
  }

  startRace() {
    return this.request(EVENTS.START_RACE);
  }

  dispose() {
    this.stopInput();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.handlers.clear();
    this.socket.disconnect();
  }
}

export default ClientNetwork;
