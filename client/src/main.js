// Development harness for the network layer. Boots ClientNetwork, renders the
// lobby/room state and a live table of authoritative racer transforms.
// Replaced by the Three.js game bootstrap in the next pass.

import { FLAGS } from '/shared/protocol.js';
import { ClientNetwork } from './net/client-network.js';

const $ = (id) => document.getElementById(id);
const net = new ClientNetwork();

const state = {
  config: null,
  room: null,
  raceInfo: null,
  driverNames: new Map(),
  mapNames: new Map(),
  snapshotCount: 0,
  lastRenderedAt: 0,
};

const keys = new Set();
let fireHeld = false;

// ------------------------------------------------------------------ boot

net.on('ready', ({ config }) => {
  state.config = config;
  for (const driver of config.drivers) state.driverNames.set(driver.id, driver.name);
  for (const map of config.maps) state.mapNames.set(map.id, map.name);

  $('phase-badge').textContent = 'online';
  $('phase-badge').classList.add('online');

  const driverSelect = $('driver');
  driverSelect.innerHTML = '';
  for (const driver of config.drivers) {
    const option = document.createElement('option');
    option.value = driver.id;
    option.textContent = `${driver.name} · armor ${driver.stats.armor}`;
    driverSelect.append(option);
  }

  const mapSelect = $('map');
  mapSelect.innerHTML = '';
  for (const map of config.maps) {
    const option = document.createElement('option');
    option.value = map.id;
    option.textContent = map.name;
    mapSelect.append(option);
  }

  setMessage('lobby-msg', '');
});

net.on('error', (payload) => {
  setMessage('lobby-msg', payload?.message || payload?.error || 'Server error');
});

net.on('disconnected', () => {
  $('phase-badge').textContent = 'offline';
  $('phase-badge').classList.remove('online');
});

net.on('reconnected', () => {
  $('phase-badge').textContent = 'online';
  $('phase-badge').classList.add('online');
});

net.on('session-lost', ({ code }) => {
  showPanel('lobby');
  setMessage('lobby-msg', `Lost the connection to room ${code}. Create or join a new one.`);
});

net.on('latency', ({ latencyMs }) => {
  $('ping').textContent = `${latencyMs} ms`;
});

net.on('room', (room) => {
  state.room = room;
  if (!net.racing) renderRoom(room);
});

net.on('race-started', (info) => {
  state.raceInfo = info;
  state.snapshotCount = 0;
  state.lastRenderedAt = 0;
  $('stat-map').textContent = state.mapNames.get(info.map.id) || info.map.id;
  $('racer-rows').innerHTML = '';
  showPanel('race');
  setMessage('race-msg', '');
});

net.on('snapshot', () => {
  state.snapshotCount += 1;
});

net.on('race-ended', ({ reason }) => {
  showPanel('room');
  renderRoom(net.room);
  setMessage('room-msg', reason === 'empty' ? 'Everyone left the track.' : 'Race finished.');
});

// -------------------------------------------------------------- panels

function showPanel(name) {
  $('panel-lobby').classList.toggle('hidden', name !== 'lobby');
  $('panel-room').classList.toggle('hidden', name !== 'room');
  $('panel-race').classList.toggle('hidden', name !== 'race');
  $('room-badge').classList.toggle('hidden', name === 'lobby');
}

function setMessage(el, text) {
  $(el).textContent = text || '';
}

function renderRoom(room) {
  if (!room) {
    showPanel('lobby');
    $('room-badge').textContent = '----';
    return;
  }

  showPanel('room');
  $('room-code').textContent = room.code;
  $('room-badge').textContent = room.code;
  $('map').value = room.mapId;
  $('map').disabled = room.hostId !== net.socket.id;

  const list = $('players');
  list.innerHTML = '';
  const me = room.players.find((player) => player.id === net.socket.id);

  for (const player of room.players) {
    const li = document.createElement('li');

    const name = document.createElement('div');
    name.textContent = player.name;

    const driver = document.createElement('div');
    driver.className = 'driver';
    driver.textContent = state.driverNames.get(player.driverId) || player.driverId;

    const flag = document.createElement('div');
    const isHost = player.id === room.hostId;
    flag.className = isHost ? 'flag host' : player.ready ? 'flag ready' : 'flag';
    flag.textContent = isHost ? 'host' : player.ready ? 'ready' : 'waiting';

    li.append(name, driver, flag);
    list.append(li);
  }

  const isHost = room.hostId === net.socket.id;
  $('start').classList.toggle('hidden', !isHost);

  const everyoneReady = room.players.every((player) => player.id === room.hostId || player.ready);
  $('start').disabled = !everyoneReady;

  $('ready').textContent = me?.ready ? 'Cancel ready' : 'Ready up';

  if (me && $('driver').value !== me.driverId) {
    $('driver').value = me.driverId;
  }
}

// -------------------------------------------------------------- actions

$('create').addEventListener('click', async () => {
  setMessage('lobby-msg', '');
  const res = await net.createRoom({
    name: $('name').value,
    driverId: $('driver').value || undefined,
  });
  if (!res.ok) setMessage('lobby-msg', res.error);
});

$('join').addEventListener('click', async () => {
  setMessage('lobby-msg', '');
  const code = $('code').value.replace(/\D/g, '').slice(0, 4);
  if (code.length !== 4) {
    setMessage('lobby-msg', 'Enter the 4-digit game code');
    return;
  }
  const res = await net.joinRoom({
    code,
    name: $('name').value,
    driverId: $('driver').value || undefined,
  });
  if (!res.ok) setMessage('lobby-msg', res.error);
});

$('code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('join').click();
});

$('driver').addEventListener('change', async (event) => {
  if (!net.room) return;
  const res = await net.selectDriver(event.target.value);
  if (!res.ok) {
    setMessage('room-msg', res.error);
    renderRoom(net.room);
  }
});

$('map').addEventListener('change', async (event) => {
  const res = await net.selectMap(event.target.value);
  if (!res.ok) setMessage('room-msg', res.error);
});

$('ready').addEventListener('click', async () => {
  const me = net.room?.players.find((player) => player.id === net.socket.id);
  const res = await net.setReady(!me?.ready);
  if (!res.ok) setMessage('room-msg', res.error);
});

$('start').addEventListener('click', async () => {
  const res = await net.startRace();
  if (!res.ok) setMessage('room-msg', res.error);
});

$('leave').addEventListener('click', async () => {
  await net.leaveRoom();
  showPanel('lobby');
  $('room-badge').textContent = '----';
});

$('abort').addEventListener('click', async () => {
  await net.leaveRoom();
  showPanel('lobby');
  $('room-badge').textContent = '----';
});

// ---------------------------------------------------------------- input

window.addEventListener('keydown', (event) => {
  const key = event.key;
  const lower = key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(lower)) {
    event.preventDefault();
  }
  keys.add(lower);
  if (key === 'Shift') fireHeld = true;
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.key.toLowerCase());
  if (event.key === 'Shift') fireHeld = false;
});

window.addEventListener('blur', () => {
  keys.clear();
  fireHeld = false;
});

net.setInputProvider(() => ({
  throttle: (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0),
  steer: (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0),
  drift: fireHeld,
  brake: keys.has(' '),
}));

// --------------------------------------------------------------- render

// Debug table only; the real renderer will drive from getInterpolatedRacers().
function tick(now) {
  requestAnimationFrame(tick);

  if (net.racing) {
    $('stat-tick').textContent = String(net.snapshots.at(-1)?.snapshot.t ?? 0);
    $('stat-snaps').textContent = String(state.snapshotCount);
    $('stat-pending').textContent = String(net.pendingInputs.length);
    $('stat-ack').textContent = String(net.localState?.ack ?? 0);

    if (now - state.lastRenderedAt > 80) {
      state.lastRenderedAt = now;
      renderRacers();
    }
  }
}

function renderRacers() {
  const snapshot = net.snapshots.at(-1)?.snapshot;
  if (!snapshot) return;

  const rows = $('racer-rows');
  rows.innerHTML = '';

  for (const [id, x, y, z, vx, vy, vz, yaw, health, armor, ack, flags] of snapshot.p) {
    const roster = state.raceInfo?.racers.find((racer) => racer.id === id);
    const tr = document.createElement('tr');
    if (id === net.myRacerId) tr.className = 'mine';

    const speed = Math.hypot(vx, vz);
    const cells = [
      roster ? state.driverNames.get(roster.driverId) || roster.driverId : '?',
      `${id}${id === net.myRacerId ? ' (you)' : ''}`,
      x.toFixed(1),
      y.toFixed(1),
      z.toFixed(1),
      yaw.toFixed(2),
      `${(speed * 3.6).toFixed(0)} km/h`,
      String(health),
      String(armor),
    ];

    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }

    if ((flags & FLAGS.ALIVE) === 0) tr.style.opacity = '0.4';
    if ((flags & FLAGS.DRIFTING) !== 0) tr.style.color = '#ffd166';

    rows.append(tr);
  }

  const mine = snapshot.p.find((row) => row[0] === net.myRacerId);
  if (mine) {
    $('stat-pending').textContent = String(net.pendingInputs.length);
    $('stat-ack').textContent = String(mine[10]);
  }
}

requestAnimationFrame(tick);

// Start the handshake only after every listener above is registered.
net.connect().catch((error) => {
  setMessage('lobby-msg', error.message);
});

// Expose for manual poking in devtools.
window.neonNet = net;
