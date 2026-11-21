import './styles.css';
import { GameView, WEAPON_ICONS } from './game/GameView.js';
import { ClientNetwork } from './net/client-network.js';
import { LocalSession } from './net/local-session.js';
import { DRIVERS, DRIVER_BY_ID } from '@shared/roster.js';
import { MAPS, MAP_BY_ID } from '@shared/maps.js';
import { NET, PHASE, SNAPSHOT_FIELDS as F, WEAPONS, decodeRacer } from '@shared/constants.js';

const $ = (id) => document.getElementById(id);

const SERVER_URL = String(
  import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? 'http://localhost:3000' : ''),
).replace(/\/+$/, '');

const game = new GameView($('game'));

const state = {
  name: localStorage.getItem('neon-name') || 'Racer',
  driverId: localStorage.getItem('neon-driver') || DRIVERS[0].id,
  mapId: localStorage.getItem('neon-map') || MAPS[0].id,
  mode: null,
  session: null,
  room: null,
  roster: [],
  myId: 0,
  latest: null,
  lastHudAt: 0,
  inRace: false,
  showingResults: false,
  finishTimer: null,
  busy: false,
};

if (!DRIVER_BY_ID.has(state.driverId)) state.driverId = DRIVERS[0].id;
if (!MAP_BY_ID.has(state.mapId)) state.mapId = MAPS[0].id;

let netClient = null;
const keys = new Set();
let fireHeld = false;

// ------------------------------------------------------------------- menu

function statBar(label, value) {
  return `<div class="stat"><span>${label}</span><i style="--v:${value / 5}"></i></div>`;
}

function renderDrivers() {
  const grid = $('driver-grid');
  grid.innerHTML = '';

  for (const driver of DRIVERS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `driver-card${driver.id === state.driverId ? ' selected' : ''}`;
    card.style.setProperty('--driver', driver.css);
    card.innerHTML = `
      <span class="driver-name">${driver.name}</span>
      <span class="driver-role">${driver.role}</span>
      <p class="driver-tag">${driver.tagline}</p>
      <div class="driver-stats">
        ${statBar('SPD', driver.stats.speed)}
        ${statBar('ACC', driver.stats.accel)}
        ${statBar('HDL', driver.stats.handling)}
        ${statBar('ARM', driver.stats.armor)}
      </div>
    `;
    card.addEventListener('click', () => {
      state.driverId = driver.id;
      localStorage.setItem('neon-driver', driver.id);
      renderDrivers();
      if (state.mode === 'online' && netClient?.room?.state === 'lobby') {
        netClient.selectDriver(driver.id).catch(() => {});
      }
    });
    grid.append(card);
  }
}

function renderMapOptions() {
  const menuMap = $('menu-map');
  menuMap.innerHTML = '';
  for (const map of MAPS) {
    const option = document.createElement('option');
    option.value = map.id;
    option.textContent = `${map.name} · ${map.laps} laps`;
    menuMap.append(option);
  }
  menuMap.value = state.mapId;

  const lobbyMap = $('lobby-map');
  lobbyMap.innerHTML = '';
  for (const map of MAPS) {
    const option = document.createElement('option');
    option.value = map.id;
    option.textContent = map.name;
    lobbyMap.append(option);
  }
}

function setServerStatus() {
  const status = $('server-status');
  if (SERVER_URL) {
    status.textContent = `Online server: ${SERVER_URL}`;
    status.className = 'status online';
    $('create-room').disabled = false;
    $('join-room').disabled = false;
  } else {
    status.textContent =
      'Online rooms are offline (set VITE_SERVER_URL). Bot mode is fully playable.';
    status.className = 'status offline';
    $('create-room').disabled = true;
    $('join-room').disabled = true;
  }
}

// --------------------------------------------------------------- sessions

function attachSession(session) {
  session.on('race-started', onRaceStarted);
  session.on('snapshot', onSnapshot);
  session.on('race-ended', onRaceEnded);
  session.on('error', (payload) => toast(payload?.message || payload?.error || 'Network error', true));
  session.setInputProvider(readInput);
}

function getNet() {
  if (!SERVER_URL) {
    toast('Online play needs VITE_SERVER_URL. Try Race bots.', true);
    return null;
  }

  if (!netClient) {
    netClient = new ClientNetwork({ url: SERVER_URL });
    netClient.on('room', onRoom);
    netClient.on('disconnected', () => {
      if (state.mode === 'online') toast('Disconnected from the server', true);
    });
    attachSession(netClient);
  }

  return netClient;
}

async function createRoom() {
  const net = getNet();
  if (!net) return;

  setBusy(true);
  try {
    await net.connect();
    const res = await net.createRoom({ name: state.name, driverId: state.driverId });
    if (!res.ok) throw new Error(res.error || 'Could not create room');

    state.mode = 'online';
    state.session = net;
    state.showingResults = false;
    state.inRace = false;
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function joinRoom() {
  const code = $('room-code-input').value.replace(/\D/g, '').slice(0, 4);
  if (code.length !== 4) {
    toast('Enter the 4-digit game code', true);
    return;
  }

  const net = getNet();
  if (!net) return;

  setBusy(true);
  try {
    await net.connect();
    const res = await net.joinRoom({ code, name: state.name, driverId: state.driverId });
    if (!res.ok) throw new Error(res.error || 'Could not join room');

    state.mode = 'online';
    state.session = net;
    state.showingResults = false;
    state.inRace = false;
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
  }
}

function startLocal() {
  cleanupSession();

  const session = new LocalSession({
    mapId: state.mapId,
    driverId: state.driverId,
    name: state.name,
    botCount: 3,
  });

  attachSession(session);
  state.mode = 'local';
  state.session = session;
  state.showingResults = false;
  session.start();
}

function cleanupSession() {
  if (state.finishTimer) {
    clearTimeout(state.finishTimer);
    state.finishTimer = null;
  }

  if (state.session) {
    if (state.mode === 'online') {
      state.session.leaveRoom?.();
      state.session.dispose?.();
      netClient = null;
    } else {
      state.session.dispose?.();
    }
  }

  state.session = null;
  state.mode = null;
  state.inRace = false;
  state.showingResults = false;
  state.roster = [];
  state.myId = 0;
  state.latest = null;
}

// ------------------------------------------------------------- online room

function onRoom(room) {
  state.room = room;

  if (!room) {
    if (!state.showingResults) showScreen('menu');
    return;
  }

  if (room.state === 'racing') {
    state.inRace = true;
    return;
  }

  if (state.inRace || state.showingResults) return;
  renderLobby(room);
  showScreen('lobby');
}

function renderLobby(room) {
  $('lobby-code').textContent = room.code;
  $('lobby-map').value = room.mapId;
  $('lobby-map').disabled = room.hostId !== netClient?.id;

  const list = $('lobby-players');
  list.innerHTML = '';

  for (const player of room.players) {
    const driver = DRIVER_BY_ID.get(player.driverId) || DRIVERS[0];
    const li = document.createElement('li');
    li.style.setProperty('--driver', driver.css);

    const isHost = player.id === room.hostId;
    const tagClass = isHost ? 'tag host' : player.ready ? 'tag ready' : 'tag';
    const tagText = isHost ? 'HOST' : player.ready ? 'READY' : 'WAITING';

    li.innerHTML = `
      <span class="dot"></span>
      <span class="who">${escapeHtml(player.name)}<small>${driver.name}</small></span>
      <span class="${tagClass}">${tagText}</span>
      <span class="tag">${room.maxPlayers} SLOTS</span>
    `;
    list.append(li);
  }

  const me = room.players.find((player) => player.id === netClient?.id);
  const isHost = room.hostId === netClient?.id;
  const allReady = room.players.every((player) => player.id === room.hostId || player.ready);

  $('lobby-ready').textContent = me?.ready ? 'Cancel ready' : 'Ready up';
  $('lobby-start').style.display = isHost ? '' : 'none';
  $('lobby-start').disabled = !allReady || room.players.length < 1;
}

// -------------------------------------------------------------------- race

function onRaceStarted(info) {
  state.inRace = true;
  state.showingResults = false;
  state.roster = info.racers ?? [];
  state.myId = info.you;
  state.latest = null;
  state.lastHudAt = 0;

  const map = info.map;
  state.mapId = map.id;
  localStorage.setItem('neon-map', map.id);

  const me = state.roster.find((racer) => racer.id === state.myId);
  const driver = DRIVER_BY_ID.get(me?.driverId) || DRIVERS[0];

  const hud = $('hud');
  hud.style.setProperty('--driver', driver.css);
  $('hud-driver').textContent = driver.name.toUpperCase();
  $('hud-driver-role').textContent = driver.role;
  $('hud-hp').style.width = '100%';
  $('hud-armor').style.width = '100%';
  $('hud-weapon').textContent = 'NO WEAPON';
  $('hud-ammo').textContent = 'Drive over a crate';
  $('hud-weapon-icon').textContent = WEAPON_ICONS[0];
  $('hud-lap').textContent = `LAP 1/${map.laps}`;
  $('hud-time').textContent = '00:00';
  $('hud-speed').innerHTML = '0 <em>KM/H</em>';
  $('hud-place').textContent = '—';
  $('hud-standings').innerHTML = '';

  game.loadMap(map.id, {
    roster: state.roster,
    myId: state.myId,
    interpDelay: state.mode === 'local' ? NET.LOCAL_INTERP_DELAY_MS : NET.INTERP_DELAY_MS,
  });

  showScreen('race');
}

function onSnapshot(snapshot) {
  state.latest = snapshot;
  game.pushSnapshot(snapshot);

  for (const event of snapshot.e ?? []) game.handleEvent(event);

  updateCountdown(snapshot);

  const now = performance.now();
  if (now - state.lastHudAt > 70) {
    state.lastHudAt = now;
    updateHud(snapshot);
  }

  if (snapshot.phase === PHASE.FINISHED && !state.showingResults && !state.finishTimer) {
    state.finishTimer = setTimeout(() => {
      state.finishTimer = null;
      if (!state.showingResults) {
        showResults({
          reason: 'finished',
          winner: snapshot.winner,
          results: buildResults(snapshot),
        });
      }
    }, 900);
  }
}

function onRaceEnded(payload) {
  if (state.showingResults) return;
  showResults(payload);
}

function updateCountdown(snapshot) {
  const el = $('countdown');

  if (snapshot.phase === PHASE.COUNTDOWN) {
    const seconds = Math.min(3, Math.max(1, Math.ceil((snapshot.countdownMs ?? 0) / 1000)));
    el.textContent = String(seconds);
    el.classList.remove('hidden', 'go');
    return;
  }

  if (snapshot.phase === PHASE.RACING && snapshot.raceTime < 1.1) {
    el.textContent = 'GO';
    el.classList.add('go');
    el.classList.remove('hidden');
    return;
  }

  el.classList.add('hidden');
}

function orderedRows(snapshot) {
  return snapshot.p.slice().sort((a, b) => {
    const placeA = a[F.PLACE] || 0;
    const placeB = b[F.PLACE] || 0;
    if (placeA && placeB) return placeA - placeB;
    if (placeA) return -1;
    if (placeB) return 1;
    return b[F.PROGRESS] - a[F.PROGRESS];
  });
}

function updateHud(snapshot) {
  const me = snapshot.p.find((row) => row[F.ID] === state.myId);
  if (!me) return;

  const meInfo = state.roster.find((racer) => racer.id === state.myId);
  const driver = DRIVER_BY_ID.get(meInfo?.driverId) || DRIVERS[0];

  const speed = Math.hypot(me[F.VX], me[F.VZ]) * 3.6;
  $('hud-speed').innerHTML = `${Math.round(speed)} <em>KM/H</em>`;

  $('hud-hp').style.width = `${Math.max(0, Math.min(100, me[F.HEALTH]))}%`;
  const armorMax = driver.combat.armorMax || 100;
  $('hud-armor').style.width = `${Math.max(0, Math.min(100, (me[F.ARMOR] / armorMax) * 100))}%`;

  $('hud-lap').textContent = `LAP ${Math.min(me[F.LAP] + 1, snapshot.laps)}/${snapshot.laps}`;
  $('hud-time').textContent = formatTime(snapshot.raceTime);

  const order = orderedRows(snapshot);
  const place = order.findIndex((row) => row[F.ID] === state.myId) + 1;
  const suffix = place === 1 ? 'ST' : place === 2 ? 'ND' : place === 3 ? 'RD' : 'TH';
  $('hud-place').textContent = `${place}${suffix}`;

  const weaponSpec = WEAPONS[me[F.WEAPON]];
  $('hud-weapon').textContent = weaponSpec ? weaponSpec.name.toUpperCase() : 'NO WEAPON';
  $('hud-ammo').textContent = weaponSpec ? `${me[F.AMMO]} uses left` : 'Drive over a crate';
  $('hud-weapon-icon').textContent = WEAPON_ICONS[me[F.WEAPON]] ?? '∅';
  $('hud-weapon').style.color = weaponSpec ? colorHex(weaponSpec.color) : '';

  const standings = $('hud-standings');
  standings.innerHTML = '';
  for (const row of order.slice(0, 4)) {
    const info = state.roster.find((racer) => racer.id === row[F.ID]);
    const driverInfo = DRIVER_BY_ID.get(info?.driverId) || DRIVERS[0];
    const li = document.createElement('li');
    if (row[F.ID] === state.myId) li.className = 'me';
    li.innerHTML = `
      <span class="pos">${order.indexOf(row) + 1}</span>
      <span class="dot" style="--driver:${driverInfo.css}"></span>
      <span>${escapeHtml(info?.name ?? 'Racer')}</span>
      <span class="lap">L${Math.min(row[F.LAP] + 1, snapshot.laps)}</span>
    `;
    standings.append(li);
  }
}

function buildResults(snapshot) {
  const order = orderedRows(snapshot);

  return order.map((row, index) => {
    const info = state.roster.find((racer) => racer.id === row[F.ID]);
    return {
      id: row[F.ID],
      name: info?.name ?? `Racer ${row[F.ID]}`,
      driverId: info?.driverId ?? DRIVERS[0].id,
      place: row[F.PLACE] || index + 1,
      lap: Math.min(row[F.LAP] + 1, snapshot.laps),
      finished: row[F.PLACE] > 0,
    };
  });
}

function showResults(payload) {
  state.showingResults = true;
  state.inRace = false;
  $('countdown').classList.add('hidden');

  const results = payload?.results?.length ? payload.results : buildResults(state.latest ?? { p: [], laps: 1 });
  const winner = results.find((entry) => entry.place === 1);

  $('results-kicker').textContent = payload?.reason === 'empty' ? 'RACE ABANDONED' : 'RACE COMPLETE';
  $('results-title').textContent = winner ? `${winner.name} WINS` : 'RACE COMPLETE';

  const table = $('results-table');
  table.innerHTML = '';

  for (const entry of results) {
    const driver = DRIVER_BY_ID.get(entry.driverId) || DRIVERS[0];
    const li = document.createElement('li');
    if (entry.place === 1) li.className = 'first';
    li.innerHTML = `
      <span class="pos">${entry.place}${placeSuffix(entry.place)}</span>
      <span class="dot" style="--driver:${driver.css}"></span>
      <span>${escapeHtml(entry.name)}</span>
      <small>${entry.finished ? 'FINISHED' : `LAP ${entry.lap}`}</small>
    `;
    table.append(li);
  }

  $('results-again').textContent = state.mode === 'local' ? 'Race again' : 'Back to lobby';
  showScreen('results');
}

function placeSuffix(place) {
  if (place === 1) return 'ST';
  if (place === 2) return 'ND';
  if (place === 3) return 'RD';
  return 'TH';
}

function formatTime(seconds = 0) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function colorHex(value) {
  return `#${Number(value).toString(16).padStart(6, '0')}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

// ----------------------------------------------------------------- screens

const SCREEN_IDS = { menu: 'screen-menu', lobby: 'screen-lobby', results: 'screen-results' };

function showScreen(name) {
  for (const [key, id] of Object.entries(SCREEN_IDS)) {
    $(id).classList.toggle('hidden', key !== name);
  }
  $('hud').classList.toggle('hidden', name !== 'race');
  if (name !== 'race') $('countdown').classList.add('hidden');
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['play-bots', 'create-room', 'join-room', 'lobby-ready', 'lobby-start', 'lobby-leave']) {
    $(id).disabled = busy;
  }
  if (!busy) setServerStatus();
}

let toastTimer = null;

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = String(message ?? 'Something went wrong');
  el.className = `toast${isError ? ' error' : ''}`;
  el.classList.remove('hidden');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3600);
}

// ------------------------------------------------------------------- input

function readInput() {
  const throttle = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const steer = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);

  return {
    throttle,
    steer,
    drift: keys.has('shift'),
    brake: keys.has('x'),
    fire: fireHeld,
  };
}

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
  keys.add(key === 'shift' ? 'shift' : key);
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.key.toLowerCase());
});

window.addEventListener('blur', () => {
  keys.clear();
  fireHeld = false;
});

$('game').addEventListener('mousedown', (event) => {
  if (event.button === 0 && state.inRace) fireHeld = true;
});

window.addEventListener('mouseup', () => {
  fireHeld = false;
});

$('game').addEventListener('contextmenu', (event) => event.preventDefault());

// ----------------------------------------------------------------- buttons

$('play-bots').addEventListener('click', () => startLocal());

$('create-room').addEventListener('click', createRoom);
$('join-room').addEventListener('click', joinRoom);

$('room-code-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinRoom();
});

$('player-name').addEventListener('input', (event) => {
  const value = event.target.value.trim().slice(0, 16);
  state.name = value || 'Racer';
  localStorage.setItem('neon-name', state.name);
});

$('menu-map').addEventListener('change', (event) => {
  state.mapId = event.target.value;
  localStorage.setItem('neon-map', state.mapId);
});

$('lobby-map').addEventListener('change', async (event) => {
  if (!netClient) return;
  const res = await netClient.selectMap(event.target.value);
  if (!res.ok) toast(res.error, true);
});

$('lobby-ready').addEventListener('click', async () => {
  if (!netClient) return;
  const me = state.room?.players.find((player) => player.id === netClient.id);
  const res = await netClient.setReady(!me?.ready);
  if (!res.ok) toast(res.error, true);
});

$('lobby-start').addEventListener('click', async () => {
  if (!netClient) return;
  const res = await netClient.startRace();
  if (!res.ok) toast(res.error, true);
});

$('lobby-leave').addEventListener('click', async () => {
  if (!netClient) return;
  await netClient.leaveRoom();
  state.room = null;
  cleanupSession();
  showScreen('menu');
});

$('copy-code').addEventListener('click', async () => {
  const code = $('lobby-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast(`Code ${code} copied`);
  } catch {
    toast(`Game code: ${code}`);
  }
});

$('results-again').addEventListener('click', () => {
  if (state.mode === 'local') {
    startLocal();
    return;
  }

  state.showingResults = false;
  if (netClient?.room) {
    renderLobby(netClient.room);
    showScreen('lobby');
  } else {
    showScreen('menu');
  }
});

$('results-menu').addEventListener('click', () => {
  cleanupSession();
  state.room = null;
  game.resetForMenu();
  showScreen('menu');
});

// -------------------------------------------------------------------- boot

$('player-name').value = state.name;
renderDrivers();
renderMapOptions();
setServerStatus();
showScreen('menu');
