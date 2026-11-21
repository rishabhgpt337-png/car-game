// Builds the static track: road ribbon, edge stripes, barriers, checkpoint
// arches, start line and low-poly scenery. One group per map.

import * as THREE from 'three';
import { pointAt } from '@shared/track.js';

function ribbonGeometry(track, halfWidth, lateralOffset = 0, y = 0) {
  const { samples, count } = track;
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= count; i += 1) {
    const s = samples[i % count];
    const left = lateralOffset - halfWidth;
    const right = lateralOffset + halfWidth;

    positions.push(s.x + s.nx * left, y, s.z + s.nz * left);
    positions.push(s.x + s.nx * right, y, s.z + s.nz * right);
    uvs.push(0, i / count, 1, i / count);
  }

  for (let i = 0; i < count; i += 1) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeGate(map, s, group) {
  const p = pointAt(trackRef, s);
  const half = map.width / 2 + 0.6;
  const height = map.env === 'highway' ? 7 : 5.4;
  const accent = map.theme.accent;

  const postGeo = new THREE.BoxGeometry(0.7, height, 0.7);
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x1a2434,
    emissive: accent,
    emissiveIntensity: 0.35,
    roughness: 0.6,
    metalness: 0.3,
  });

  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(p.x + p.nx * half * side, height / 2, p.z + p.nz * half * side);
    group.add(post);
  }

  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(half * 2, 0.55, 0.6),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.7 }),
  );
  beam.position.set(p.x, height - 0.2, p.z);
  beam.rotation.y = Math.atan2(p.tx, p.tz);
  group.add(beam);
}

let trackRef = null;

export function buildTrackGroup(track) {
  trackRef = track;

  const map = track.map;
  const theme = map.theme;
  const group = new THREE.Group();
  group.name = `track-${map.id}`;

  // Ground.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 2400),
    new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  group.add(ground);

  // Road surface.
  const road = new THREE.Mesh(
    ribbonGeometry(track, map.width / 2),
    new THREE.MeshStandardMaterial({
      color: theme.road,
      roughness: 0.92,
      metalness: 0.08,
      side: THREE.DoubleSide,
    }),
  );
  group.add(road);

  // Edge stripes.
  for (const side of [-1, 1]) {
    const stripe = new THREE.Mesh(
      ribbonGeometry(track, 0.34, side * (map.width / 2 - 0.5), 0.02),
      new THREE.MeshBasicMaterial({ color: theme.roadEdge, side: THREE.DoubleSide }),
    );
    group.add(stripe);
  }

  // Faint centre line.
  const centre = new THREE.Mesh(
    ribbonGeometry(track, 0.12, 0, 0.015),
    new THREE.MeshBasicMaterial({
      color: theme.roadEdge,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
    }),
  );
  group.add(centre);

  // Barriers / canyon walls.
  const barrierHeight = map.env === 'canyon' ? 4.6 : map.env === 'highway' ? 0.8 : 1.15;
  const barrierSpacing = 8;
  const barrierCount = Math.ceil(track.count / barrierSpacing) * 2 + 2;
  const barrierGeo = new THREE.BoxGeometry(map.env === 'canyon' ? 1.1 : 0.7, barrierHeight, 4.4);
  const barrierMat = new THREE.MeshStandardMaterial({
    color: theme.barrier,
    roughness: 0.9,
    metalness: 0.08,
  });
  const barriers = new THREE.InstancedMesh(barrierGeo, barrierMat, barrierCount);
  barriers.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  const dummy = new THREE.Object3D();
  let barrierIndex = 0;
  for (let i = 0; i < track.count; i += barrierSpacing) {
    const s = track.samples[i];
    const yaw = Math.atan2(s.tx, s.tz);

    for (const side of [-1, 1]) {
      dummy.position.set(
        s.x + s.nx * side * (map.width / 2 + 1.3),
        barrierHeight / 2,
        s.z + s.nz * side * (map.width / 2 + 1.3),
      );
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      barriers.setMatrixAt(barrierIndex, dummy.matrix);
      barrierIndex += 1;
    }
  }
  barriers.count = barrierIndex;
  barriers.instanceMatrix.needsUpdate = true;
  group.add(barriers);

  // Checkpoint arches.
  for (const s of [0.25, 0.5, 0.75]) makeGate(map, s, group);

  // Start / finish line.
  const start = pointAt(track, 0);
  const tiles = 12;
  const tileWidth = map.width / tiles;
  for (let i = 0; i < tiles; i += 1) {
    const offset = -map.width / 2 + tileWidth * (i + 0.5);
    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(tileWidth, 0.04, 2.6),
      new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0xf2f7ff : 0x0b0f16 }),
    );
    tile.position.set(start.x + start.nx * offset, 0.03, start.z + start.nz * offset);
    tile.rotation.y = Math.atan2(start.tx, start.tz);
    group.add(tile);
  }

  // Scenery.
  const decorCount = map.env === 'highway' ? 44 : 96;
  const decorGeo =
    theme.decor === 'pylons'
      ? new THREE.CylinderGeometry(0.22, 0.34, 9, 6)
      : new THREE.IcosahedronGeometry(1, 0);
  const decorMat = new THREE.MeshStandardMaterial({
    color: theme.rock,
    roughness: 0.95,
    metalness: 0.05,
    emissive: theme.decor === 'pylons' ? theme.accent : 0x000000,
    emissiveIntensity: theme.decor === 'pylons' ? 0.35 : 0,
  });
  const decor = new THREE.InstancedMesh(decorGeo, decorMat, decorCount);

  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  for (let i = 0; i < decorCount; i += 1) {
    const s = rand();
    const p = pointAt(track, s);
    const side = rand() > 0.5 ? 1 : -1;
    const distance = map.width / 2 + 8 + rand() * 52;
    const scale = theme.decor === 'pylons' ? 1 : 0.7 + rand() * 2.6;

    dummy.position.set(
      p.x + p.nx * side * distance,
      theme.decor === 'pylons' ? 4.5 : scale * 0.35,
      p.z + p.nz * side * distance,
    );
    dummy.rotation.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    decor.setMatrixAt(i, dummy.matrix);
  }
  decor.instanceMatrix.needsUpdate = true;
  group.add(decor);

  return group;
}

export function disposeGroup(group) {
  group.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    }
  });
}
