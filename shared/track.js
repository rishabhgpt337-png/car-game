// Track geometry helpers. Pure math, no rendering: used by the server for
// spawns/laps/pickups and by the client to build the 3D ribbon.

const SUBDIVISIONS = 18;
const RESAMPLE_COUNT = 720;

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/** Closed Catmull-Rom loop resampled to uniform arc-length samples. */
export function buildTrack(map) {
  const points = map.points;
  const n = points.length;
  const dense = [];

  for (let i = 0; i < n; i += 1) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    for (let j = 0; j < SUBDIVISIONS; j += 1) {
      const t = j / SUBDIVISIONS;
      dense.push({
        x: catmullRom(p0[0], p1[0], p2[0], p3[0], t),
        z: catmullRom(p0[1], p1[1], p2[1], p3[1], t),
      });
    }
  }

  const cumulative = [0];
  for (let i = 1; i <= dense.length; i += 1) {
    const a = dense[i - 1];
    const b = dense[i % dense.length];
    cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }

  const totalLength = cumulative[dense.length];
  const samples = [];
  let cursor = 0;

  for (let k = 0; k < RESAMPLE_COUNT; k += 1) {
    const dist = (k / RESAMPLE_COUNT) * totalLength;
    while (cursor < dense.length - 1 && cumulative[cursor + 1] < dist) cursor += 1;

    const segStart = cumulative[cursor];
    const segLength = Math.max(1e-6, cumulative[cursor + 1] - segStart);
    const t = (dist - segStart) / segLength;
    const a = dense[cursor];
    const b = dense[(cursor + 1) % dense.length];

    samples.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }

  const count = samples.length;
  for (let i = 0; i < count; i += 1) {
    const prev = samples[(i - 1 + count) % count];
    const next = samples[(i + 1) % count];
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    const sample = samples[i];
    sample.tx = tx / len;
    sample.tz = tz / len;
    sample.nx = sample.tz;
    sample.nz = -sample.tx;
    sample.s = i / count;
  }

  return { map, samples, count, totalLength, width: map.width };
}

export function pointAt(track, s) {
  const wrapped = ((s % 1) + 1) % 1;
  const count = track.count;
  const f = wrapped * count;
  const i0 = Math.floor(f) % count;
  const i1 = (i0 + 1) % count;
  const t = f - Math.floor(f);
  const a = track.samples[i0];
  const b = track.samples[i1];

  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    tx: a.tx + (b.tx - a.tx) * t,
    tz: a.tz + (b.tz - a.tz) * t,
    nx: a.nx + (b.nx - a.nx) * t,
    nz: a.nz + (b.nz - a.nz) * t,
    index: i0,
  };
}

export function projectToTrack(track, x, z) {
  const count = track.count;
  let bestD2 = Infinity;
  let bestIndex = 0;

  for (let i = 0; i < count; i += 6) {
    const sample = track.samples[i];
    const d2 = (sample.x - x) ** 2 + (sample.z - z) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIndex = i;
    }
  }

  for (let k = -6; k <= 6; k += 1) {
    const i = (bestIndex + k + count) % count;
    const sample = track.samples[i];
    const d2 = (sample.x - x) ** 2 + (sample.z - z) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIndex = i;
    }
  }

  const sample = track.samples[bestIndex];
  const lateral = (x - sample.x) * sample.nx + (z - sample.z) * sample.nz;

  return {
    s: bestIndex / count,
    lateral,
    index: bestIndex,
    onRoad: Math.abs(lateral) <= track.map.width / 2,
  };
}

/** Two-column starting grid behind the start/finish line. */
export function spawnGrid(track, slot) {
  const row = Math.floor(slot / 2);
  const col = slot % 2 === 0 ? -1 : 1;
  const s = (1 - 0.012 * (row + 1) + 1) % 1;
  const p = pointAt(track, s);
  const lateral = col * Math.min(track.map.width * 0.22, 3.4) + (row % 2 === 0 ? -0.3 : 0.3);

  return {
    x: p.x + p.nx * lateral,
    z: p.z + p.nz * lateral,
    yaw: Math.atan2(p.tx, p.tz),
    s,
  };
}

/** Evenly spaced crates, alternating sides of the racing line. */
export function cratePositions(track, count) {
  const halfWidth = track.map.width / 2;

  return Array.from({ length: count }, (_, i) => {
    const s = (i + 0.5) / count;
    const p = pointAt(track, s);
    const lateral = (i % 2 === 0 ? -1 : 1) * Math.min(halfWidth * 0.36, 3);

    return {
      s,
      x: p.x + p.nx * lateral,
      z: p.z + p.nz * lateral,
    };
  });
}

export function isGateCrossed(prev, current, gate) {
  if (current >= prev) return prev < gate && gate <= current;
  // Only a near-full-lap jump backwards is a wrap; small jitter is not.
  if (prev - current > 0.5) return gate > prev || gate <= current;
  return false;
}
