// Browser client: lobby wiring, input capture, client-side prediction with
// server reconciliation, and interpolation of the other players.

import { ARENA, INTERP_DELAY_MS, SHIP, TICK_HZ } from '/shared/constants.js';
import { createShip, stepShip } from '/shared/physics.js';

const socket = window.io({ transports: ['websocket', 'polling'] });

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const lobbyEl = $('lobby');
const roomEl = $('room');
const hudEl = $('hud');

// Snapshot tuple layout (keep in sync with server/game.js sendSnapshot()).
const F = {
  ID: 0,
  X: 1,
  Y: 2,
  VX: 3,
  VY: 4,
  ANGLE: 5,
  TURRET: 6,
  HP: 7,
  ACK: 8,
  SCORE: 9,
  ALIVE: 10,
};

const COLORS = ['#34e7ff', '#ff3d81', '#7dff6b', '#ffd166', '#b48cff', '#ff9f45', '#4dc3ff', '#f672d9'];

// ------------------------------------------------------------------ state

let playing = false;
let myId = null;
let local = null; // predicted local ship
let pending = []; // inputs not yet acknowledged by the server
let seq = 0;
let snapshots = []; // { recvAt, snap }
let names = new Map(); // slot id -> name
let pingMs = null;
let namesSaved = '';

const keys = new Set();
const pointer = { x: 0, y: 0, seen: false };
let fireHeld = false;
const visual = { x: 0, y: 0 }; // decaying render error after reconciliation

// ----------------------------------------------------------------- canvas

let dpr = 1;

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
}

resize();
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ lobby

const savedName = localStorage.getItem('neon-circuit-name') || '';
$('name').value = savedName;

$('name').addEventListener('input', (event) => {
  namesSaved = event.target.value;
  localStorage.setItem('neon-circuit-name', namesSaved);
});

function setMessage(el, text) {
  $(el).textContent = text || '';
}

function request(event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => resolve(res || { ok: false, error: 'No response' }));
  });
}

$('create').addEventListener('click', async () => {
  setMessage('lobby-msg', '');
  const res = await request('lobby:create', { name: $('name').value });
  if (!res.ok) setMessage('lobby-msg', res.error);
});

$('join').addEventListener('click', async () => {
  setMessage('lobby-msg', '');
  const code = $('code').value.replace(/\D/g, '').slice(0, 4);
  if (code.length !== 4) {
    setMessage('lobby-msg', 'Enter the 4-digit game code');
    return;
  }
  const res = await request('lobby:join', { code, name: $('name').value });
  if (!res.ok) setMessage('lobby-msg', res.error);
});

$('code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('join').click();
});

$('name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('create').click();
});

$('start').addEventListener('click', async () => {
  setMessage('room-msg', '');
  const res = await request('lobby:start');
  if (!res.ok) setMessage('room-msg', res.error);
});

$('leave').addEventListener('click', async () => {
  await request('lobby:leave');
  showLobby();
});

socket.on('lobby:room', (room) => {
  if (!room) return;
  $('room-code').textContent = room.code;
  setMessage('room-msg', '');

  const list = $('room-players');
  list.innerHTML = '';
  for (const player of room.players) {
    const li = document.createElement('li');
    const label = document.createElement('div');
    label.textContent = player.name;
    const tag = document.createElement('span');
    tag.textContent = player.id === room.hostId ? 'host' : '';
    li.append(label, tag);
    list.append(li);
  }

  const isHost = room.hostId === socket.id;
  $('start').classList.toggle('hidden', !isHost || room.state !== 'lobby');

  if (!playing) {
    lobbyEl.classList.add('hidden');
    roomEl.classList.remove('hidden');
  }
});

socket.on('net:pong', (sentAt) => {
  pingMs = Math.max(0, Math.round(performance.now() - sentAt));
});

socket.on('disconnect', () => {
  playing = false;
  showLobby();
  setMessage('lobby-msg', 'Disconnected from the server');
});

function showLobby() {
  playing = false;
  local = null;
  pending = [];
  snapshots = [];
  roomEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
}

// ------------------------------------------------------------------- game

socket.on('game:start', (info) => {
  playing = true;
  myId = info.you;
  pending = [];
  snapshots = [];
  seq = 0;
  visual.x = 0;
  visual.y = 0;

  names = new Map(info.players.map((player) => [player.id, player.name]));
  const me = info.players.find((player) => player.id === myId);

  local = createShip(myId, me?.name || 'You', me?.x || 0, me?.y || 0, me?.angle || 0);

  $('room-tag').textContent = `ROOM ${info.code} · ${info.tickHz}Hz SIM · ${info.snapshotHz}Hz SNAP`;
  $('score').textContent = 'SCORE 0';
  $('hp-bar').firstElementChild.style.width = '100%';
  $('killfeed').innerHTML = '';

  lobbyEl.classList.add('hidden');
  roomEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
});

socket.on('net:snapshot', (snap) => {
  snapshots.push({ recvAt: performance.now(), snap });
  if (snapshots.length > 40) snapshots.shift();

  const mine = snap.p.find((row) => row[F.ID] === myId);
  if (mine) reconcile(mine);

  for (const event of snap.e) handleEvent(event);

  $('net').textContent = `${pingMs ?? '--'} ms`;
  if (mine) {
    $('score').textContent = `SCORE ${mine[F.SCORE]}`;
    $('hp-bar').firstElementChild.style.width = `${Math.max(0, mine[F.HP])}%`;
  }
});

function reconcile(authoritative) {
  if (!local) return;

  const ax = authoritative[F.X];
  const ay = authoritative[F.Y];

  // Smooth out small prediction errors instead of snapping.
  const errorX = local.x - ax;
  const errorY = local.y - ay;
  if (Math.hypot(errorX, errorY) < 150) {
    visual.x = clamp(visual.x + errorX, -150, 150);
    visual.y = clamp(visual.y + errorY, -150, 150);
  } else {
    visual.x = 0;
    visual.y = 0;
  }

  local.x = ax;
  local.y = ay;
  local.vx = authoritative[F.VX];
  local.vy = authoritative[F.VY];
  local.angle = authoritative[F.ANGLE];
  local.turret = authoritative[F.TURRET];
  local.hp = authoritative[F.HP];
  local.alive = authoritative[F.ALIVE] === 1;
  local.score = authoritative[F.SCORE];

  // Replay the inputs the server has not consumed yet: exact same physics.
  const ack = authoritative[F.ACK];
  pending = pending.filter((entry) => entry.seq > ack);
  for (const entry of pending) stepShip(local, entry.input, 1 / TICK_HZ);
}

function handleEvent(event) {
  if (event.k === 'kill') {
    const victim = names.get(event.a) || 'Racer';
    const killer = names.get(event.b) || 'Racer';
    addFeed(`${killer} ⚡ ${victim}`);
  } else if (event.k === 'leave') {
    const name = names.get(event.a);
    if (name) addFeed(`${name} left`);
  }
}

function addFeed(text) {
  const feed = $('killfeed');
  const line = document.createElement('div');
  line.textContent = text;
  feed.append(line);
  setTimeout(() => line.remove(), 3200);
  while (feed.children.length > 5) feed.firstElementChild.remove();
}

// ------------------------------------------------------------------ input

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
    event.preventDefault();
  }
  keys.add(key);
  if (key === ' ') fireHeld = true;
});

window.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  keys.delete(key);
  if (key === ' ') fireHeld = false;
});

window.addEventListener('blur', () => {
  keys.clear();
  fireHeld = false;
});

canvas.addEventListener('mousemove', (event) => {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.seen = true;
});

canvas.addEventListener('mousedown', (event) => {
  if (event.button === 0) fireHeld = true;
});

window.addEventListener('mouseup', (event) => {
  if (event.button === 0) fireHeld = false;
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

setInterval(() => socket.emit('net:ping', performance.now()), 2000);

function aimAngle() {
  if (!local) return 0;
  if (!pointer.seen) return local.angle;

  // The camera keeps the local ship centered, so screen -> world is an offset.
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const wx = local.x + (pointer.x - cx);
  const wy = local.y + (pointer.y - cy);
  return Math.atan2(wy - local.y, wx - local.x);
}

function readInput() {
  let t = 0;
  let r = 0;
  if (keys.has('w') || keys.has('arrowup')) t += 1;
  if (keys.has('s') || keys.has('arrowdown')) t -= 1;
  if (keys.has('a') || keys.has('arrowleft')) r -= 1;
  if (keys.has('d') || keys.has('arrowright')) r += 1;

  return { t, r, a: aimAngle(), f: fireHeld };
}

// ------------------------------------------------------------------- loop

let lastFrame = 0;
let accumulator = 0;

function frame(now) {
  requestAnimationFrame(frame);

  const dt = Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : 0);
  lastFrame = now;

  if (!playing) return;

  // Fixed 60 Hz prediction step. One step == one server tick == one input.
  accumulator += dt;
  const step = 1 / TICK_HZ;
  let steps = 0;

  while (accumulator >= step && steps < 5) {
    accumulator -= step;
    steps += 1;

    const input = readInput();
    input.seq = ++seq;

    socket.emit('game:input', input);
    if (local && local.alive) stepShip(local, input, step);
    pending.push({ seq: input.seq, input });
  }

  if (pending.length > 240) pending.splice(0, pending.length - 240);

  // Decay the reconciliation offset.
  visual.x *= 0.85;
  visual.y *= 0.85;
  if (Math.abs(visual.x) < 0.05) visual.x = 0;
  if (Math.abs(visual.y) < 0.05) visual.y = 0;

  $('dead').classList.toggle('hidden', !local || local.alive);

  draw(now);
}

requestAnimationFrame(frame);

// --------------------------------------------------------------- rendering

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function lerpAngle(a, b, t) {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

function sampleAt(time) {
  if (snapshots.length === 0) return null;
  if (time <= snapshots[0].recvAt || snapshots.length === 1) {
    return { ships: snapshots[0].snap.p, bullets: snapshots[0].snap.b };
  }

  for (let i = snapshots.length - 1; i > 0; i -= 1) {
    const newer = snapshots[i];
    const older = snapshots[i - 1];
    if (newer.recvAt >= time) {
      const span = Math.max(1, newer.recvAt - older.recvAt);
      const alpha = clamp((time - older.recvAt) / span, 0, 1);
      return {
        ships: mergeShips(older.snap.p, newer.snap.p, alpha),
        bullets: mergeBullets(older.snap.b, newer.snap.b, alpha),
      };
    }
  }

  const last = snapshots[snapshots.length - 1].snap;
  return { ships: last.p, bullets: last.b };
}

function mergeShips(older, newer, alpha) {
  const byId = new Map(older.map((row) => [row[F.ID], row]));
  return newer.map((row) => {
    const prev = byId.get(row[F.ID]);
    if (!prev || prev[F.ALIVE] === 0 || row[F.ALIVE] === 0) return row;

    const out = row.slice();
    out[F.X] = prev[F.X] + (row[F.X] - prev[F.X]) * alpha;
    out[F.Y] = prev[F.Y] + (row[F.Y] - prev[F.Y]) * alpha;
    out[F.ANGLE] = lerpAngle(prev[F.ANGLE], row[F.ANGLE], alpha);
    out[F.TURRET] = lerpAngle(prev[F.TURRET], row[F.TURRET], alpha);
    return out;
  });
}

function mergeBullets(older, newer, alpha) {
  const byId = new Map(older.map((row) => [row[0], row]));
  return newer.map((row) => {
    const prev = byId.get(row[0]);
    if (!prev) return row;
    return [row[0], prev[1] + (row[1] - prev[1]) * alpha, prev[2] + (row[2] - prev[2]) * alpha, row[3]];
  });
}

function draw(now) {
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, width, height);

  if (!local) return;

  const camX = local.x + visual.x;
  const camY = local.y + visual.y;

  ctx.save();
  ctx.translate(width / 2 - camX, height / 2 - camY);

  drawArena();

  const view = sampleAt(now - INTERP_DELAY_MS);
  if (view) {
    for (const bullet of view.bullets) drawBullet(bullet);

    for (const ship of view.ships) {
      if (ship[F.ID] === myId || ship[F.ALIVE] === 0) continue;
      drawShip({
        x: ship[F.X],
        y: ship[F.Y],
        angle: ship[F.ANGLE],
        turret: ship[F.TURRET],
        hp: ship[F.HP],
        color: COLORS[ship[F.ID] % COLORS.length],
        name: names.get(ship[F.ID]) || '',
        local: false,
      });
    }
  }

  if (local.alive) {
    drawShip({
      x: local.x + visual.x,
      y: local.y + visual.y,
      angle: local.angle,
      turret: local.turret,
      hp: local.hp,
      color: COLORS[myId % COLORS.length],
      name: local.name,
      local: true,
    });
  }

  ctx.restore();
}

function drawArena() {
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(31, 51, 85, 0.7)';

  ctx.beginPath();
  for (let x = 0; x <= ARENA.width; x += 100) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ARENA.height);
  }
  for (let y = 0; y <= ARENA.height; y += 100) {
    ctx.moveTo(0, y);
    ctx.lineTo(ARENA.width, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(52, 231, 255, 0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);
}

function drawBullet(bullet) {
  ctx.beginPath();
  ctx.arc(bullet[1], bullet[2], 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd166';
  ctx.shadowColor = '#ffd166';
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;
}

function drawShip({ x, y, angle, turret, hp, color, name, local: isLocal }) {
  const r = SHIP.radius;

  ctx.save();
  ctx.translate(x, y);

  // Engine glow behind the ship.
  ctx.beginPath();
  ctx.moveTo(-r * -0.9, -r * 0.55);
  ctx.lineTo(-r * 1.8, 0);
  ctx.lineTo(-r * -0.9, r * 0.55);
  ctx.closePath();
  ctx.fillStyle = 'rgba(52, 231, 255, 0.16)';
  ctx.fill();

  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(-r * 0.75, -r * 0.8);
  ctx.lineTo(-r * 0.35, 0);
  ctx.lineTo(-r * 0.75, r * 0.8);
  ctx.closePath();
  ctx.fillStyle = '#0d1728';
  ctx.strokeStyle = color;
  ctx.lineWidth = isLocal ? 2.5 : 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Turret barrel.
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(turret);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(r * 1.5, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  // Health bar + name for the other players.
  if (!isLocal) {
    const barWidth = 42;
    const ratio = clamp(hp / SHIP.maxHp, 0, 1);
    ctx.fillStyle = 'rgba(13, 23, 40, 0.9)';
    ctx.fillRect(x - barWidth / 2, y - r - 16, barWidth, 4);
    ctx.fillStyle = ratio > 0.4 ? color : '#ff3d81';
    ctx.fillRect(x - barWidth / 2, y - r - 16, barWidth * ratio, 4);

    ctx.fillStyle = 'rgba(216, 230, 255, 0.75)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(name, x, y - r - 22);
  }
}
