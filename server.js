// Neon Circuit 3D — server entry point.
//
// Responsibilities: serve the client bundle, host the Socket.io endpoint, and
// shut down cleanly. Lobby logic lives in server/rooms/*, simulation in
// server/simulation/*, transport wiring in server/net/registerHandlers.js.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

import { NETWORK, ROOM, SERVER } from './config/game.js';
import { createLogger } from './server/util/logger.js';
import { RoomManager } from './server/rooms/RoomManager.js';
import { registerHandlers } from './server/net/registerHandlers.js';

const log = createLogger('server');
const root = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ http
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size });
});

// Static client. No build step yet: the browser loads ES modules directly.
app.use(
  express.static(path.join(root, 'client'), {
    extensions: ['html'],
    maxAge: SERVER.isProduction ? '1h' : 0,
  }),
);
app.use(
  '/shared',
  express.static(path.join(root, 'shared'), {
    maxAge: SERVER.isProduction ? '1h' : 0,
  }),
);

// ------------------------------------------------------------------ socket
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  // Detect dead clients in ~9s instead of the 45s default.
  pingInterval: 5000,
  pingTimeout: 4000,
  maxHttpBufferSize: 1e4,
  // Lock this down with ALLOWED_ORIGINS before deploying publicly.
  cors: { origin: SERVER.allowedOrigins.length > 0 ? SERVER.allowedOrigins : true },
});

const rooms = new RoomManager({ io, log });
registerHandlers(io, { rooms, log });

httpServer.listen(SERVER.port, SERVER.host, () => {
  log.info(`listening on http://${SERVER.host}:${SERVER.port}`);
  log.info(
    `tick ${NETWORK.TICK_HZ}Hz / snapshot ${NETWORK.SNAPSHOT_HZ}Hz / max ${ROOM.MAX_PLAYERS} players per room`,
  );
});

// ---------------------------------------------------------------- shutdown
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`${signal} received: closing rooms and connections`);

  rooms.shutdown();
  io.close();

  const forceExit = setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 5000);
  forceExit.unref();

  httpServer.close(() => {
    log.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));
process.on('uncaughtException', (error) => {
  log.error('uncaughtException', error);
  shutdown('uncaughtException');
});
