// Authoritative race loop for one room. Thin wrapper: MatchCore owns physics,
// combat and laps; this class owns the 60 Hz clock and the snapshots.

import { EVENTS, NET, PHASE } from '../../../shared/constants.js';
import { publicMap } from '../../../shared/maps.js';
import { MatchCore } from '../../../shared/match.js';

export class Race {
  constructor({ io, code, mapId, log, onFinished }) {
    this.io = io;
    this.code = code;
    this.log = log;
    this.onFinished = onFinished;
    this.match = new MatchCore({ mapId, mode: 'server' });
    this.bySocket = new Map();
    this.timer = null;
    this.acc = 0;
    this.last = 0;
    this.lastSnapshotTick = -1;
    this.loopTick = 0;
    this.finished = false;
  }

  get map() {
    return this.match.map;
  }

  get racerCount() {
    return this.match.racers.size;
  }

  addRacer({ socketId, name, driverId }) {
    const racer = this.match.addRacer({ socketId, name, driverId, isBot: false });
    this.bySocket.set(socketId, racer.id);
    return racer;
  }

  removeRacer(socketId) {
    const racerId = this.bySocket.get(socketId);
    if (racerId === undefined) return;
    this.bySocket.delete(socketId);
    this.match.removeRacer(racerId);
  }

  queueInput(socketId, message) {
    const racerId = this.bySocket.get(socketId);
    if (racerId === undefined) return;
    this.match.queueInput(racerId, message);
  }

  start() {
    this.match.start();

    for (const racer of this.match.racers.values()) {
      this.io.to(racer.socketId).emit(EVENTS.RACE_STARTED, {
        code: this.code,
        you: racer.id,
        map: publicMap(this.match.map),
        laps: this.match.map.laps,
        racers: this.match.info().racers,
        network: NET,
      });
    }

    this.io.to(this.code).emit(EVENTS.SNAPSHOT, this.match.snapshot());

    this.last = performance.now();
    this.timer = setInterval(() => this.loop(), 1000 / NET.TICK_HZ);
    this.timer.unref?.();
    this.log.info(`race started in ${this.code} (${this.map.id}, ${this.racerCount} racers)`);
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

    while (this.acc >= dt && steps < 6) {
      this.acc -= dt;
      this.match.step();
      this.loopTick += 1;
      steps += 1;
    }

    // Snapshot clock runs during the countdown too, so clients see it tick.
    if (steps > 0 && this.loopTick - this.lastSnapshotTick >= NET.TICK_HZ / NET.SNAPSHOT_HZ) {
      this.lastSnapshotTick = this.loopTick;
      this.io.to(this.code).emit(EVENTS.SNAPSHOT, this.match.snapshot());
    }

    if (this.match.phase === PHASE.FINISHED) this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.stop();

    const payload = {
      reason: 'finished',
      winner: this.match.winnerId,
      results: this.match.results(),
    };

    // Room.endRace emits the final snapshot + race:ended to the channel.
    this.onFinished?.(payload);
  }
}
