// Entry point: static client hosting + Socket.io wiring.
//
// Client -> server events
//   net:ping        (clientTime)                -> net:pong (clientTime)
//   lobby:create    ({ name }, ack)             -> ack { ok, code } | { ok:false, error }
//   lobby:join      ({ code, name }, ack)       -> ack { ok, code } | { ok:false, error }
//   lobby:leave     (ack)
//   lobby:start     (ack)                       host only
//   game:input      ({ seq, t, r, a, f })       60 Hz, fire-and-forget
//
// Server -> client events
//   lobby:room      { code, hostId, state, maxPlayers, players[] }
//   game:start      { code, you, players[], arena, tickHz, snapshotHz, interpDelayMs }
//   net:snapshot    { t, p:[[...]], b:[[...]], e:[...] }
//   net:pong        (clientTime)

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(root, 'public')));
app.use(
  '/shared',
  express.static(path.join(root, 'shared'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  }),
);
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const server = http.createServer(app);
const io = new Server(server, {
  // Tight heartbeats: a dropped client is noticed in <= ~9s instead of 45s.
  pingInterval: 5000,
  pingTimeout: 4000,
  maxHttpBufferSize: 1e4,
  cors: { origin: true, credentials: false },
});

const rooms = new RoomManager(io);

const reply = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

// Tolerate both `emit(event, payload, ack)` and `emit(event, ack)`: Socket.io
// turns a missing payload into a trailing null, so the ack is the last function.
const withAck = (handler) =>
  (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    reply(ack, handler(...args));
  };

io.on('connection', (socket) => {
  socket.data.code = null;

  socket.on('net:ping', (clientTime) => {
    socket.emit('net:pong', clientTime);
  });

  socket.on(
    'lobby:create',
    withAck((payload) => rooms.create(socket, payload?.name)),
  );

  socket.on(
    'lobby:join',
    withAck((payload) => rooms.join(socket, payload?.code, payload?.name)),
  );

  socket.on('lobby:leave', withAck(() => rooms.leave(socket)));
  socket.on('lobby:start', withAck(() => rooms.start(socket)));

  socket.on('game:input', (message) => {
    rooms.input(socket, message);
  });

  socket.on('disconnect', () => {
    rooms.leave(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Neon Circuit listening on http://localhost:${PORT}`);
});
