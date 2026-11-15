// Client network layer.
//
// Owns exactly one Socket.io connection and hides the wire protocol from the
// rest of the client. The renderer/physics layer (Three.js + Cannon) consumes:
//   * `getInterpolatedRacers(now)` — remote racers, ~100ms in the past
//   * `predictionContext`         — authoritative local state + unacked inputs
//   * `on('snapshot' | 'race-started' | ...)`
//
// It deliberately contains no rendering and no physics.

import {
  EVENTS,
  NET,
  PHASE,
  PROTOCOL_VERSION,
  SNAPSHOT_FIELDS as F,
  decodeRacer,
} from '/shared/protocol.js';

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

function lerpAngle(a, b, t) {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

function normalizeInput(input) {
  return {
    throttle: clamp(Number(input?.throttle) || 0, -1, 1),
    steer: clamp(Number(input?.steer) || 0, -1, 1),
    drift: input?.drift === true,
    brake: input?.brake === true,
    useItem: input?.useItem === true,
  };
}

export class ClientNetwork {
  constructor({ url = window.location.origin, socketFactory = globalThis.io } = {}) {
    if (typeof socketFactory !== 'function') {
      throw new Error('socket.io client bundle is not loaded');
    }

    this.url = url;
    this.socket = socketFactory(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 5000,
      timeout: NET.HELLO_TIMEOUT_MS,
    });

    this.handlers = new Map();
    this.connected = false;
    this.handshakeDone = false;
    this.readyPromise = null;

    this.config = null;
    this.room = null;
    this.roomCode = null;
    this.raceInfo = null;

    this.racing = false;
    this.myRacerId = null;
    this.seq = 0;
    this.pendingInputs = [];
    this.localState = null;

    this.snapshots = [];
    this.latencyMs = null;
    this.serverOffsetMs = 0;

    this.pingTimer = null;
    this.inputTimer = null;
    this.inputProvider = null;

    this.#bindSocket();
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
        console.error(`[net] handler for "${event}" failed`, error);
      }
    }
  }

  // ------------------------------------------------------------- lifecycle

  connect() {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Handshake timed out')), NET.HELLO_TIMEOUT_MS + 2000);

      const onError = (error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error?.message || error)));
      };

      this.socket.once('connect_error', onError);

      const handshake = () => {
        this.socket.emit(EVENTS.HELLO, { protocolVersion: PROTOCOL_VERSION }, (res) => {
          clearTimeout(timeout);
          if (!res?.ok) {
            this.socket.disconnect();
            this.readyPromise = null;
            reject(new Error(res?.error || 'Handshake rejected'));
            return;
          }

          this.connected = true;
          this.handshakeDone = true;
          this.config = res.config;
          this.serverOffsetMs = res.serverTime - Date.now();

          this.#startPing();
          this.emit('ready', { config: this.config, serverTime: res.serverTime });
          resolve(res);
        });
      };

      if (this.socket.connected) {
        handshake();
      } else {
        this.socket.once('connect', handshake);
      }
    });

    return this.readyPromise;
  }

  disconnect() {
    this.socket.disconnect();
  }

  #resetSession() {
    this.room = null;
    this.roomCode = null;
    this.raceInfo = null;
    this.racing = false;
    this.myRacerId = null;
    this.seq = 0;
    this.pendingInputs = [];
    this.localState = null;
    this.snapshots = [];
    this.#stopInputLoop();
  }

  #bindSocket() {
    this.socket.on('connect', () => {
      // The initial connect is handled by connect(); this is a reconnect.
      if (!this.handshakeDone) return;

      this.connected = true;
      const lostCode = this.roomCode;
      if (lostCode) {
        this.#resetSession();
        this.emit('session-lost', { code: lostCode });
      }
      this.#startPing();
      this.emit('reconnected');
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this.racing = false;
      this.#stopInputLoop();
      this.emit('disconnected', { reason });
    });

    this.socket.on(EVENTS.ERROR, (payload) => this.emit('error', payload));

    this.socket.on(EVENTS.ROOM, (room) => {
      this.room = room;
      this.roomCode = room?.code ?? null;
      this.emit('room', room);
    });

    this.socket.on(EVENTS.RACE_STARTED, (info) => {
      this.raceInfo = info;
      this.racing = true;
      this.myRacerId = info.you;
      this.seq = 0;
      this.pendingInputs = [];
      this.snapshots = [];
      this.localState = null;

      this.emit('race-started', info);
      this.#startInputLoop();
    });

    this.socket.on(EVENTS.SNAPSHOT, (snapshot) => this.#ingestSnapshot(snapshot));

    this.socket.on(EVENTS.RACE_ENDED, (payload) => {
      this.racing = false;
      this.myRacerId = null;
      this.#stopInputLoop();
      this.emit('race-ended', payload);
    });
  }

  // -------------------------------------------------------------- snapshot

  #ingestSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.p)) return;

    this.snapshots.push({ recvAt: performance.now(), snapshot });
    if (this.snapshots.length > 60) this.snapshots.shift();

    const mine = snapshot.p.find((row) => row[F.ID] === this.myRacerId);
    if (mine) {
      this.localState = decodeRacer(mine);
      const ack = mine[F.ACK];
      if (this.pendingInputs.length > 0) {
        this.pendingInputs = this.pendingInputs.filter((input) => input.seq > ack);
      }
    }

    this.emit('snapshot', snapshot);
  }

  /**
   * Remote racers sampled INTERP_DELAY_MS behind the newest snapshot, with
   * positions and yaw lerped. The local racer is excluded: it should be
   * rendered from prediction, not interpolation.
   */
  getInterpolatedRacers(time = performance.now() - NET.INTERP_DELAY_MS) {
    if (this.snapshots.length === 0) return [];

    const oldest = this.snapshots[0];
    if (time <= oldest.recvAt) {
      return oldest.snapshot.p.map(decodeRacer).filter((racer) => racer.id !== this.myRacerId);
    }

    for (let i = this.snapshots.length - 1; i > 0; i -= 1) {
      const next = this.snapshots[i];
      const prev = this.snapshots[i - 1];
      if (next.recvAt >= time) {
        const span = Math.max(1, next.recvAt - prev.recvAt);
        const alpha = clamp((time - prev.recvAt) / span, 0, 1);
        return this.#mergeRacers(prev.snapshot.p, next.snapshot.p, alpha);
      }
    }

    const latest = this.snapshots[this.snapshots.length - 1].snapshot.p;
    return latest.map(decodeRacer).filter((racer) => racer.id !== this.myRacerId);
  }

  #mergeRacers(older, newer, alpha) {
    const byId = new Map(older.map((row) => [row[F.ID], row]));
    const merged = [];

    for (const row of newer) {
      if (row[F.ID] === this.myRacerId) continue;

      const prev = byId.get(row[F.ID]);
      const racer = decodeRacer(row);
      if (!prev) {
        merged.push(racer);
        continue;
      }

      racer.x = prev[F.X] + (row[F.X] - prev[F.X]) * alpha;
      racer.y = prev[F.Y] + (row[F.Y] - prev[F.Y]) * alpha;
      racer.z = prev[F.Z] + (row[F.Z] - prev[F.Z]) * alpha;
      racer.yaw = lerpAngle(prev[F.YAW], row[F.YAW], alpha);
      merged.push(racer);
    }

    return merged;
  }

  /**
   * Everything a client-side predictor needs for reconciliation:
   * the last authoritative local state and the inputs the server has not eaten.
   */
  get predictionContext() {
    return { state: this.localState, pending: this.pendingInputs.slice() };
  }

  // ----------------------------------------------------------------- input

  setInputProvider(provider) {
    this.inputProvider = provider;
  }

  sendInput(input) {
    if (!this.racing) return;

    const seq = this.seq + 1;
    this.seq = seq;

    const payload = { seq, ...normalizeInput(input) };
    this.pendingInputs.push(payload);
    if (this.pendingInputs.length > 240) this.pendingInputs.shift();

    this.socket.emit(EVENTS.INPUT, payload);
  }

  #startInputLoop() {
    if (this.inputTimer) return;

    const interval = 1000 / NET.INPUT_HZ;
    let next = performance.now() + interval;

    const tick = () => {
      if (!this.racing) {
        this.inputTimer = null;
        return;
      }

      // Recover from long frames without bursting.
      const now = performance.now();
      if (now - next > interval) next = now;

      const input = this.inputProvider ? this.inputProvider() : null;
      this.sendInput(input);

      next += interval;
      this.inputTimer = setTimeout(tick, Math.max(0, next - performance.now()));
    };

    this.inputTimer = setTimeout(tick, interval);
  }

  #stopInputLoop() {
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.inputTimer = null;
  }

  // ------------------------------------------------------------------ ping

  #startPing() {
    if (this.pingTimer) return;

    const ping = () => {
      if (!this.socket.connected) return;
      const sentAt = Date.now();

      this.socket.emit(EVENTS.PING, { t: sentAt }, (res) => {
        if (!res) return;
        const rtt = Date.now() - sentAt;

        this.latencyMs =
          this.latencyMs === null ? Math.round(rtt) : Math.round(this.latencyMs * 0.75 + rtt * 0.25);
        this.serverOffsetMs = res.serverTime - (sentAt + rtt / 2);

        this.emit('latency', { rtt, latencyMs: this.latencyMs });
      });
    };

    ping();
    this.pingTimer = setInterval(ping, NET.PING_INTERVAL_MS);
  }

  /** Current server clock estimate in epoch ms. */
  serverNow() {
    return Date.now() + this.serverOffsetMs;
  }

  // ----------------------------------------------------------------- lobby

  request(event, payload = {}) {
    return new Promise((resolve) => {
      if (!this.socket.connected) {
        resolve({ ok: false, code: 'DISCONNECTED', error: 'Not connected to the server' });
        return;
      }

      this.socket.emit(event, payload, (res) => {
        resolve(res ?? { ok: false, code: 'NO_RESPONSE', error: 'Server did not answer' });
      });
    });
  }

  async createRoom({ name, driverId } = {}) {
    const res = await this.request(EVENTS.CREATE_ROOM, { name, driverId });
    if (res.ok) {
      this.roomCode = res.code;
      this.emit('joined', res);
    }
    return res;
  }

  async joinRoom({ code, name, driverId } = {}) {
    const res = await this.request(EVENTS.JOIN_ROOM, { code, name, driverId });
    if (res.ok) {
      this.roomCode = res.code;
      this.emit('joined', res);
    }
    return res;
  }

  async leaveRoom() {
    const res = await this.request(EVENTS.LEAVE_ROOM);
    if (res.ok) {
      this.#resetSession();
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

  get phase() {
    return this.room?.phase ?? PHASE.LOBBY;
  }

  get isHost() {
    return Boolean(this.room) && this.room.hostId === this.socket.id;
  }

  dispose() {
    this.#stopInputLoop();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.handlers.clear();
    this.socket.disconnect();
  }
}

export default ClientNetwork;
