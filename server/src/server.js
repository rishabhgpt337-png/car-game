// Neon Circuit 3D backend.
// Deploy on any Node host (Render, Railway, Fly, a VPS). The Vite client is
// deployed separately on Vercel and points at this server via VITE_SERVER_URL.

import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';

import { createLogger } from './util/logger.js';
import { RoomManager } from './rooms/RoomManager.js';
import { registerHandlers } from './net/registerHandlers.js';

const log = createLogger('server');
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'neon-circuit-server', rooms: rooms.size });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  pingInterval: 5000,
  pingTimeout: 4000,
  maxHttpBufferSize: 1e4,
  cors: {
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : '*',
    methods: ['GET', 'POST'],
  },
});

const rooms = new RoomManager({ io, log });
registerHandlers(io, { rooms, log });

httpServer.listen(PORT, '0.0.0.0', () => {
  log.info(`listening on port ${PORT}`);
  log.info(`allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '*'}`);
});

let shuttingDown = false;

function shutdown(signal) {
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
