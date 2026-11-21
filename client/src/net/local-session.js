// Offline / bot mode. Runs the exact shared MatchCore in the browser, using
// the same snapshots the online renderer consumes. This is the fallback that
// keeps the Vercel deployment playable without a backend.

import { MatchCore } from '@shared/match.js';
import { DRIVERS } from '@shared/roster.js';
import { NET, PHASE } from '@shared/constants.js';

export class LocalSession {
  constructor({ mapId, driverId, name, botCount = 3 }) {
    this.match = new MatchCore({ mapId, mode: 'local' });

    const me = this.match.addRacer({ name, driverId, isBot: false });
    this.racerId = me.id;
    this.roster = [{ id: me.id, name, driverId, isBot: false }];

    const used = new Set([driverId]);
    for (const driver of DRIVERS) {
      if (this.roster.length > botCount) break;
      if (used.has(driver.id)) continue;
      used.add(driver.id);

      const bot = this.match.addRacer({
        name: `BOT ${driver.name.replace('The ', '')}`,
        driverId: driver.id,
        isBot: true,
      });
      this.roster.push({ id: bot.id, name: bot.name, driverId: bot.driverId, isBot: true });
    }

    this.handlers = new Map();
    this.inputProvider = null;
    this.running = false;
    this.frame = null;
    this.last = 0;
    this.acc = 0;
    this.seq = 0;

    this.match.start();
  }

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
        console.error(`[local] "${event}" handler failed`, error);
      }
    }
  }

  setInputProvider(provider) {
    this.inputProvider = provider;
  }

  start() {
    if (this.running) return;
    this.running = true;

    this.emit('race-started', {
      you: this.racerId,
      map: { ...this.match.map, ...this.match.info().map },
      laps: this.match.map.laps,
      racers: this.roster,
      network: NET,
      mode: 'local',
    });

    this.last = performance.now();
    this.frame = requestAnimationFrame(this.loop);
  }

  loop = (now) => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.loop);

    let delta = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += delta;

    const step = 1 / NET.TICK_HZ;
    let steps = 0;

    while (this.acc >= step && steps < 6) {
      this.acc -= step;
      steps += 1;

      if (this.match.phase === PHASE.RACING) {
        this.seq += 1;
        const input = this.inputProvider ? this.inputProvider() : null;
        this.match.queueInput(this.racerId, { ...input, seq: this.seq });
      }
      this.match.step();
    }

    if (steps === 0) return;

    const snapshot = this.match.snapshot();
    this.emit('snapshot', snapshot);

    if (snapshot.phase === PHASE.FINISHED) {
      this.running = false;
      cancelAnimationFrame(this.frame);
      this.frame = null;
      this.emit('race-ended', {
        reason: 'finished',
        winner: snapshot.winner,
        results: this.match.results(),
      });
    }
  };

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  dispose() {
    this.stop();
    this.handlers.clear();
  }
}
