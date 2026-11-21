// Three.js presentation layer: scene, track, cars, pickups, projectiles,
// effects and chase camera. Reads snapshots only; owns no game rules.

import * as THREE from 'three';
import { buildTrack } from '@shared/track.js';
import { MAP_BY_ID } from '@shared/maps.js';
import { DRIVER_BY_ID } from '@shared/roster.js';
import { FLAGS, NET, WEAPON } from '@shared/constants.js';
import { buildTrackGroup, disposeGroup } from './track-mesh.js';
import { createCar } from './car-mesh.js';

const lerpAngle = (a, b, t) => {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
};

export class GameView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070d);

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2200);
    this.camera.position.set(0, 8, 14);

    this.scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x2a2118, 1.25));
    const sun = new THREE.DirectionalLight(0xffffff, 2.1);
    sun.position.set(90, 160, 70);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    this.clock = new THREE.Clock();
    this.map = null;
    this.track = null;
    this.mapGroup = null;
    this.cars = new Map();
    this.crates = new Map();
    this.bullets = new Map();
    this.mines = new Map();
    this.effects = [];
    this.snapshots = [];
    this.myId = 0;
    this.interpDelay = NET.INTERP_DELAY_MS;
    this.focus = null;
    this.cameraPos = new THREE.Vector3(0, 10, 20);
    this.cameraTarget = new THREE.Vector3();
    this.cameraPrimed = false;
    this.time = 0;

    this.bulletGeo = new THREE.SphereGeometry(0.3, 8, 6);
    this.bulletMat = new THREE.MeshBasicMaterial({ color: 0x9cf7ff });
    this.mineGeo = new THREE.CylinderGeometry(1.15, 1.15, 0.3, 12);
    this.mineMat = new THREE.MeshStandardMaterial({
      color: 0xffd166,
      emissive: 0xffa621,
      emissiveIntensity: 0.9,
      roughness: 0.5,
    });
    this.crateGeo = new THREE.BoxGeometry(1.7, 1.7, 1.7);
    this.crateMat = new THREE.MeshStandardMaterial({
      color: 0xffd166,
      emissive: 0xff9f2e,
      emissiveIntensity: 0.55,
      roughness: 0.45,
      metalness: 0.25,
    });
    this.crateLineMat = new THREE.LineBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.85 });
    this.crateEdgeGeo = new THREE.EdgesGeometry(this.crateGeo);

    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ map

  loadMap(mapId, { roster = [], myId = 0, interpDelay = NET.INTERP_DELAY_MS } = {}) {
    const map = MAP_BY_ID.get(mapId) ?? MAP_BY_ID.values().next().value;

    this.disposeMap();
    this.clearDynamic();

    this.map = map;
    this.track = buildTrack(map);
    this.mapGroup = buildTrackGroup(this.track);
    this.scene.add(this.mapGroup);

    this.scene.background = new THREE.Color(map.theme.sky);
    this.scene.fog = new THREE.Fog(map.theme.fog, 150, 700);

    this.myId = myId;
    this.interpDelay = interpDelay;
    this.snapshots = [];
    this.focus = null;
    this.cameraPrimed = false;

    this.setRacers(roster);
  }

  setRacers(roster) {
    for (const entry of roster) {
      const driver = DRIVER_BY_ID.get(entry.driverId);
      const car = createCar(driver?.color ?? 0xffffff);
      car.group.visible = false;
      this.scene.add(car.group);
      this.cars.set(entry.id, car);
    }
  }

  disposeMap() {
    if (!this.mapGroup) return;
    this.scene.remove(this.mapGroup);
    disposeGroup(this.mapGroup);
    this.mapGroup = null;
  }

  clearDynamic() {
    for (const store of [this.cars, this.crates, this.bullets, this.mines]) {
      for (const entry of store.values()) {
        const object = entry.group ?? entry;
        this.scene.remove(object);
      }
      store.clear();
    }

    for (const effect of this.effects) {
      this.scene.remove(effect.mesh);
      effect.mesh.geometry.dispose();
      effect.mesh.material.dispose();
    }
    this.effects = [];
  }

  // ------------------------------------------------------------ snapshots

  pushSnapshot(snapshot) {
    this.snapshots.push({ at: performance.now(), snapshot });
    if (this.snapshots.length > 50) this.snapshots.shift();
    this.applySnapshot(snapshot);
  }

  bracket(time) {
    const list = this.snapshots;
    if (list.length === 0) return null;
    if (time <= list[0].at) return { a: list[0], b: list[0], alpha: 0 };
    const last = list[list.length - 1];
    if (time >= last.at) return { a: last, b: last, alpha: 0 };

    for (let i = list.length - 1; i > 0; i -= 1) {
      if (list[i - 1].at <= time) {
        return {
          a: list[i - 1],
          b: list[i],
          alpha: (time - list[i - 1].at) / Math.max(1, list[i].at - list[i - 1].at),
        };
      }
    }
    return { a: last, b: last, alpha: 0 };
  }

  sampleAt(time) {
    const bracket = this.bracket(time);
    if (!bracket) return null;

    const { a, b, alpha } = bracket;
    return {
      racers: mergeRows(a.snapshot.p, b.snapshot.p, alpha, [
        [1, false],
        [2, false],
        [3, false],
        [4, true],
      ]),
      bullets: mergeRows(a.snapshot.b, b.snapshot.b, alpha, [
        [1, false],
        [2, false],
        [3, false],
      ]),
      crates: b.snapshot.c,
      mines: b.snapshot.m,
      latest: b.snapshot,
    };
  }

  // --------------------------------------------------------------- render

  animate() {
    requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;

    if (!this.mapGroup) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const sample = this.sampleAt(performance.now() - this.interpDelay);
    if (sample) {
      this.applyRacers(sample.racers, dt);
      this.applyCrates(sample.crates);
      this.applyBullets(sample.bullets);
      this.applyMines(sample.mines);
    }

    this.updateEffects(dt);
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }

  applySnapshot(snapshot) {
    // Kept for callers that want an immediate (non-interpolated) frame.
    this.applyCrates(snapshot.c);
    this.applyBullets(snapshot.b);
    this.applyMines(snapshot.m);
  }

  applyRacers(rows, dt) {
    const seen = new Set();

    for (const row of rows) {
      const id = row[0];
      const car = this.cars.get(id);
      if (!car) continue;
      seen.add(id);

      const x = row[1];
      const y = row[2];
      const z = row[3];
      const yaw = row[4];
      const speed = Math.hypot(row[5], row[6]);
      const flags = row[10];

      car.group.visible = true;
      car.group.position.set(x, y, z);
      car.group.rotation.y = yaw;

      for (const wheel of car.wheels) wheel.rotation.x += speed * dt * 1.4;

      car.flame.visible = (flags & FLAGS.BOOSTING) !== 0;
      if (car.flame.visible) {
        const flicker = 0.75 + Math.random() * 0.45;
        car.flame.scale.set(1, flicker, 1);
      }

      if (id === this.myId) {
        this.focus = { x, y, z, yaw, speed };
      }
    }

    for (const [id, car] of this.cars) {
      if (!seen.has(id)) car.group.visible = false;
    }
  }

  applyCrates(rows) {
    const seen = new Set();

    for (const row of rows) {
      const [id, x, z, weapon, active] = row;
      if (!active) continue;
      seen.add(id);

      let mesh = this.crates.get(id);
      if (!mesh) {
        const group = new THREE.Group();
        const box = new THREE.Mesh(this.crateGeo, this.crateMat.clone());
        const edges = new THREE.LineSegments(this.crateEdgeGeo, this.crateLineMat);
        group.add(box, edges);
        this.scene.add(group);
        this.crates.set(id, group);
        mesh = group;
      }

      const bob = Math.sin(this.time * 2 + id) * 0.18;
      mesh.position.set(x, 1.5 + bob, z);
      mesh.rotation.y = this.time * 0.9 + id;
      mesh.userData.weapon = weapon;
    }

    for (const [id, mesh] of this.crates) {
      if (!seen.has(id)) mesh.visible = false;
    }
  }

  applyBullets(rows) {
    const seen = new Set();

    for (const row of rows) {
      const [id, x, y, z] = row;
      seen.add(id);

      let mesh = this.bullets.get(id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.bulletGeo, this.bulletMat);
        this.scene.add(mesh);
        this.bullets.set(id, mesh);
      }
      mesh.position.set(x, y, z);
    }

    for (const [id, mesh] of this.bullets) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.bullets.delete(id);
      }
    }
  }

  applyMines(rows) {
    const seen = new Set();

    for (const row of rows) {
      const [id, x, z, armed] = row;
      seen.add(id);

      let mesh = this.mines.get(id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.mineGeo, this.mineMat.clone());
        this.scene.add(mesh);
        this.mines.set(id, mesh);
      }

      mesh.position.set(x, 0.18, z);
      mesh.material.opacity = armed ? 1 : 0.5;
      mesh.material.transparent = true;
      mesh.scale.setScalar(armed ? 1 : 0.75 + Math.sin(this.time * 12) * 0.12);
    }

    for (const [id, mesh] of this.mines) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.mines.delete(id);
      }
    }
  }

  handleEvent(event) {
    if (event.k === 'explode') {
      this.spawnBurst(event.x, event.z, 0xffb347, 7, 0.5);
    } else if (event.k === 'hit') {
      this.spawnBurst(event.x, event.z, 0x9cf7ff, 2.2, 0.28);
    } else if (event.k === 'wrecked') {
      const row = this.snapshots.at(-1)?.snapshot.p.find((entry) => entry[0] === event.a);
      if (row) this.spawnBurst(row[1], row[3], 0xff3d81, 4, 0.5);
    } else if (event.k === 'respawn' || event.k === 'pickup' || event.k === 'boost') {
      this.spawnBurst(event.x ?? 0, event.z ?? 0, 0x34e7ff, 1.6, 0.25);
    }
  }

  spawnBurst(x, z, color, size, life) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, wireframe: true }),
    );
    mesh.position.set(x, 1, z);
    this.scene.add(mesh);
    this.effects.push({ mesh, life, max: life, size });
  }

  updateEffects(dt) {
    const survivors = [];

    for (const effect of this.effects) {
      effect.life -= dt;
      if (effect.life <= 0) {
        this.scene.remove(effect.mesh);
        effect.mesh.geometry.dispose();
        effect.mesh.material.dispose();
        continue;
      }

      const progress = 1 - effect.life / effect.max;
      effect.mesh.scale.setScalar(1 + progress * effect.size * 3);
      effect.mesh.material.opacity = 0.85 * (1 - progress);
      survivors.push(effect);
    }

    this.effects = survivors;
  }

  updateCamera(dt) {
    if (!this.focus) return;

    const { x, y, z, yaw, speed } = this.focus;
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const distance = 9.4 + Math.min(4.5, speed * 0.06);
    const desired = new THREE.Vector3(x, y + 4.4, z).addScaledVector(forward, -distance);

    const look = new THREE.Vector3(x, y + 1.1, z).addScaledVector(forward, 5.5);

    if (!this.cameraPrimed) {
      this.cameraPos.copy(desired);
      this.cameraTarget.copy(look);
      this.cameraPrimed = true;
    } else {
      this.cameraPos.lerp(desired, 1 - Math.exp(-5.5 * dt));
      this.cameraTarget.lerp(look, 1 - Math.exp(-8 * dt));
    }

    this.camera.position.copy(this.cameraPos);
    this.camera.lookAt(this.cameraTarget);

    const targetFov = 62 + Math.min(10, speed * 0.18);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
    }
  }

  resetForMenu() {
    this.snapshots = [];
    this.focus = null;
    this.cameraPrimed = false;
  }
}

function mergeRows(older, newer, alpha, lanes) {
  if (!older.length || alpha <= 0) return newer;
  const byId = new Map(older.map((row) => [row[0], row]));

  return newer.map((row) => {
    const previous = byId.get(row[0]);
    if (!previous) return row;

    const merged = row.slice();
    for (const [index, isAngle] of lanes) {
      merged[index] = isAngle
        ? lerpAngle(previous[index], row[index], alpha)
        : previous[index] + (row[index] - previous[index]) * alpha;
    }
    return merged;
  });
}

export const WEAPON_ICONS = {
  [WEAPON.NONE]: '∅',
  [WEAPON.MACHINEGUN]: '≡',
  [WEAPON.MINE]: '◉',
  [WEAPON.BOOST]: '»',
};
