// Socket.io wiring. Every lobby action runs through the same guard:
// verified session -> token bucket -> try/catch -> consistent ack shape.

import { EVENTS, NET, PROTOCOL_VERSION } from '../../../shared/constants.js';
import { publicDrivers } from '../../../shared/roster.js';
import { DEFAULT_MAP_ID, publicMaps } from '../../../shared/maps.js';
import { createTokenBucket } from '../util/rateLimit.js';

const MAX_PLAYERS = 4;
const LOBBY_ACTIONS_PER_SECOND = 10;
const INPUTS_PER_SECOND = 90;

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

/** Accept both emit(event, payload, ack) and emit(event, ack). */
function withAck(handler) {
  return (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const result = handler(...args);
    if (result !== undefined) reply(ack, result);
  };
}

function serverConfig() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    network: NET,
    maxPlayers: MAX_PLAYERS,
    defaultMapId: DEFAULT_MAP_ID,
    drivers: publicDrivers(),
    maps: publicMaps(),
  };
}

export function registerHandlers(io, { rooms, log }) {
  io.on('connection', (socket) => {
    const session = {
      verified: false,
      lobbyBucket: createTokenBucket(LOBBY_ACTIONS_PER_SECOND),
      inputBucket: createTokenBucket(INPUTS_PER_SECOND),
    };
    socket.data.session = session;

    const helloTimer = setTimeout(() => {
      if (!session.verified) {
        log.warn(`handshake timeout for ${socket.id}`);
        socket.disconnect(true);
      }
    }, NET.HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    socket.on(EVENTS.HELLO, (payload, ack) => {
      if (session.verified) {
        reply(ack, { ok: false, code: 'BAD_REQUEST', error: 'Session already verified' });
        return;
      }

      if (Number(payload?.protocolVersion) !== PROTOCOL_VERSION) {
        reply(ack, {
          ok: false,
          code: 'VERSION_MISMATCH',
          error: `Client protocol ${payload?.protocolVersion ?? '?'} != server ${PROTOCOL_VERSION}`,
        });
        socket.disconnect(true);
        return;
      }

      session.verified = true;
      clearTimeout(helloTimer);
      reply(ack, { ok: true, serverTime: Date.now(), config: serverConfig() });
    });

    const action = (event, handler) => {
      socket.on(
        event,
        withAck((...args) => {
          if (!session.verified) {
            return { ok: false, code: 'NOT_VERIFIED', error: 'Handshake required' };
          }
          if (!session.lobbyBucket.take()) {
            return { ok: false, code: 'RATE_LIMITED', error: 'Slow down' };
          }
          try {
            return handler(...args);
          } catch (error) {
            log.error(`${event} failed for ${socket.id}`, error);
            return { ok: false, code: 'INTERNAL', error: 'Server error' };
          }
        }),
      );
    };

    action(EVENTS.CREATE_ROOM, (payload) => rooms.create(socket, payload ?? {}));
    action(EVENTS.JOIN_ROOM, (payload) => rooms.join(socket, payload ?? {}));
    action(EVENTS.LEAVE_ROOM, () => rooms.leave(socket));
    action(EVENTS.SELECT_DRIVER, (payload) => rooms.selectDriver(socket, payload?.driverId));
    action(EVENTS.SELECT_MAP, (payload) => rooms.selectMap(socket, payload?.mapId));
    action(EVENTS.SET_READY, (payload) => rooms.setReady(socket, payload?.ready === true));
    action(EVENTS.START_RACE, () => rooms.start(socket));

    socket.on(EVENTS.INPUT, (payload) => {
      if (!session.verified) return;
      if (!session.inputBucket.take()) return;
      rooms.input(socket, payload);
    });

    socket.on(EVENTS.PING, (payload, ack) => {
      reply(ack, { t: payload?.t ?? 0, serverTime: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      clearTimeout(helloTimer);
      rooms.leave(socket);
      log.debug(`disconnected ${socket.id} (${reason})`);
    });
  });
}
