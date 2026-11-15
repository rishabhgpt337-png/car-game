// Socket.io event wiring: handshake, lobby actions, race inputs and ping.
//
// Every lobby action goes through the same guard: verified session, token
// bucket, try/catch, and a consistent { ok, code, error } ack. That keeps the
// client error handling uniform and makes malformed payloads harmless.

import { EVENTS, ERROR_CODES, NET, PROTOCOL_VERSION } from '../../shared/protocol.js';
import { ROOM } from '../../config/game.js';
import { RATE } from '../../config/game.js';
import { publicDrivers } from '../../config/roster.js';
import { DEFAULT_MAP_ID, publicMaps } from '../../config/maps.js';
import { createTokenBucket } from '../util/rateLimit.js';

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
    maxPlayers: ROOM.MAX_PLAYERS,
    defaultMapId: DEFAULT_MAP_ID,
    drivers: publicDrivers(),
    maps: publicMaps(),
  };
}

export function registerHandlers(io, { rooms, log }) {
  io.on('connection', (socket) => {
    const session = {
      verified: false,
      lobbyBucket: createTokenBucket(RATE.LOBBY_ACTIONS_PER_SECOND),
      inputBucket: createTokenBucket(RATE.INPUTS_PER_SECOND),
    };
    socket.data.session = session;

    const helloTimer = setTimeout(() => {
      if (!session.verified) {
        log.warn(`handshake timeout for ${socket.id}`);
        socket.disconnect(true);
      }
    }, NET.HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    // ------------------------------------------------------------ handshake
    socket.on(EVENTS.HELLO, (payload, ack) => {
      if (session.verified) {
        reply(ack, { ok: false, code: ERROR_CODES.BAD_REQUEST, error: 'Session already verified' });
        return;
      }

      if (Number(payload?.protocolVersion) !== PROTOCOL_VERSION) {
        reply(ack, {
          ok: false,
          code: ERROR_CODES.VERSION_MISMATCH,
          error: `Client protocol ${payload?.protocolVersion ?? '?'} != server ${PROTOCOL_VERSION}`,
        });
        socket.disconnect(true);
        return;
      }

      session.verified = true;
      clearTimeout(helloTimer);
      reply(ack, { ok: true, serverTime: Date.now(), config: serverConfig() });
    });

    // --------------------------------------------------------------- lobby
    const action = (event, handler) => {
      socket.on(
        event,
        withAck((...args) => {
          if (!session.verified) {
            return { ok: false, code: ERROR_CODES.NOT_VERIFIED, error: 'Handshake required' };
          }
          if (!session.lobbyBucket.take()) {
            return { ok: false, code: ERROR_CODES.RATE_LIMITED, error: 'Slow down' };
          }
          try {
            return handler(...args);
          } catch (error) {
            log.error(`${event} failed for ${socket.id}`, error);
            return { ok: false, code: ERROR_CODES.INTERNAL, error: 'Server error' };
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

    // ---------------------------------------------------------------- race
    socket.on(EVENTS.INPUT, (payload) => {
      if (!session.verified) return;
      if (!session.inputBucket.take()) return; // silently drop floods
      rooms.input(socket, payload);
    });

    // ---------------------------------------------------------------- ping
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
