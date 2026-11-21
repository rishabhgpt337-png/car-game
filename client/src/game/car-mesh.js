// Low-poly kart built from boxes and cylinders. Forward is +Z so setting
// group.rotation.y = yaw lines up with the server's yaw convention.

import * as THREE from 'three';

export function createCar(colorHex) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.42, metalness: 0.32 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x171d27, roughness: 0.8, metalness: 0.2 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 0.18, metalness: 0.65 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0a0c11, roughness: 1 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.46, 3.9), bodyMat);
  body.position.y = 0.62;
  group.add(body);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.24, 1.1), bodyMat);
  nose.position.set(0, 0.46, 2.15);
  group.add(nose);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.65), glassMat);
  cabin.position.set(0, 1.05, -0.3);
  group.add(cabin);

  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.5), darkMat);
  spoiler.position.set(0, 1.16, -1.98);
  group.add(spoiler);

  for (const x of [-0.72, 0.72]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.1), darkMat);
    post.position.set(x, 0.96, -1.98);
    group.add(post);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.38, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheels = [];
  for (const [x, z] of [
    [-1.06, 1.3],
    [1.06, 1.3],
    [-1.06, -1.35],
    [1.06, -1.35],
  ]) {
    const wheel = new THREE.Mesh(wheelGeo, tireMat);
    wheel.position.set(x, 0.42, z);
    group.add(wheel);
    wheels.push(wheel);
  }

  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff4c9 });
  for (const x of [-0.6, 0.6]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.08), lightMat);
    light.position.set(x, 0.7, 2.72);
    group.add(light);
  }

  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 1.7, 8),
    new THREE.MeshBasicMaterial({ color: 0xff6bd6, transparent: true, opacity: 0.85 }),
  );
  flame.rotation.x = -Math.PI / 2;
  flame.position.set(0, 0.55, -2.95);
  flame.visible = false;
  group.add(flame);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.7, 18),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.43;
  group.add(shadow);

  return { group, wheels, flame };
}
