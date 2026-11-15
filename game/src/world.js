// world.js — Ferroline Yard: the map, its collision, its sightlines and
// the waypoint graph the bots navigate.
//
// The yard is a 64 x 44 m industrial lot with two bomb sites: Foundry (A)
// on the west wall and Crane Bay (B) on the east wall. Three lanes run
// north from the Ember spawn — west, mid and east — so every round has a
// real choice of route, and the container stacks give both teams cover
// to fight around. Obstacles are axis-aligned boxes in plan view; a
// circle-vs-box test is the whole of collision, and a 2D segment test is
// the whole of line of sight. Nothing here allocates in the hot loop.

import * as THREE from 'three';

// Playable bounds. Walls stand on these lines; actors are clamped inside.
export const BOUNDS = { minX: -31, maxX: 31, minZ: -21, maxZ: 21 };

// The two bomb sites. The plant zone is a disc; its centre sits a few
// metres inside the yard so the carrier can reach it from either lane.
export const SITES = {
  A: { x: -18, z: -13, r: 6, name: 'Foundry', color: 0xff8c2e },
  B: { x: 18, z: -13, r: 6, name: 'Crane Bay', color: 0x5b8fd6 },
};

// Spawn points, in order: the player first, then the two Ember bots;
// the three Slate bots. Facing is handled by the caller (yaw 0 looks
// north, yaw PI looks south).
export const SPAWNS = {
  ember: [[0, 18], [-3, 18], [3, 18]],
  slate: [[-22, -18], [24, -18], [0, -18]],
};

// Obstacles: { x, z, hx, hz, h, kind } — centre, half extents, height,
// and a palette key. Height decides sight: anything at least 1.6 m tall
// blocks a sightline; low crates block movement but can be shot over.
export const OBSTACLES = [
  // Container stacks: the yard's spine. Two high, two low.
  { x: -10, z: -4, hx: 3.0, hz: 1.2, h: 2.6, kind: 'containerA' },
  { x: 10, z: -4, hx: 3.0, hz: 1.2, h: 2.6, kind: 'containerB' },
  { x: -10, z: 8, hx: 3.0, hz: 1.2, h: 2.6, kind: 'containerB' },
  { x: 10, z: 8, hx: 3.0, hz: 1.2, h: 2.6, kind: 'containerA' },
  // Furnace block at Foundry, crane legs at Crane Bay.
  { x: -27, z: -18, hx: 3.0, hz: 2.0, h: 4.0, kind: 'furnace' },
  { x: 19, z: -17.5, hx: 0.6, hz: 0.6, h: 7.0, kind: 'crane' },
  { x: 26, z: -10, hx: 0.6, hz: 0.6, h: 7.0, kind: 'crane' },
  // Pipe run along the north wall.
  { x: 0, z: -20.4, hx: 12, hz: 0.5, h: 1.0, kind: 'pipe' },
  // Crates: low cover, shot over but not walked through.
  { x: -6, z: 4, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: -4.6, z: 5.2, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: 6, z: -9.5, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: -16, z: 4, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: 16, z: 4, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: 4, z: -14, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: -26, z: 2, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: 26, z: 2, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: -6, z: -12, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  { x: 6, z: -12, hx: 0.7, hz: 0.7, h: 1.2, kind: 'crate' },
  // Barrels, clustered where fights happen.
  { x: -21, z: -9, hx: 0.55, hz: 0.55, h: 1.0, kind: 'barrel' },
  { x: -14, z: -16.5, hx: 0.55, hz: 0.55, h: 1.0, kind: 'barrel' },
  { x: 21, z: -9, hx: 0.55, hz: 0.55, h: 1.0, kind: 'barrel' },
  { x: 14, z: -16.5, hx: 0.55, hz: 0.55, h: 1.0, kind: 'barrel' },
  { x: -2, z: 13, hx: 0.55, hz: 0.55, h: 1.0, kind: 'barrel' },
  { x: 2, z: 13, hx: 0.55, hz: 0.55, h: 1.0, kind: 'barrel' },
];

// Waypoint graph. Nodes are open ground; edges join neighbours with a
// clear walk between them. Bots path over this graph with BFS, so a bot
// never has to steer around a container by feel — it follows nodes.
export const WAYPOINTS = [
  { x: 0, z: 18 }, // 0 Ember spawn
  { x: -20, z: 10 }, // 1 west junction
  { x: 0, z: 10 }, // 2 mid junction
  { x: 20, z: 10 }, // 3 east junction
  { x: -20, z: 0 }, // 4 west mid
  { x: 0, z: 0 }, // 5 yard centre
  { x: 20, z: 0 }, // 6 east mid
  { x: -18, z: -6 }, // 7 Foundry approach
  { x: 18, z: -6 }, // 8 Crane Bay approach
  { x: -15, z: -12 }, // 9 Foundry site
  { x: 15, z: -12 }, // 10 Crane Bay site
  { x: -22, z: -17 }, // 11 Foundry hold (defender perch)
  { x: 22, z: -17 }, // 12 Crane Bay hold (defender perch)
  { x: 0, z: -8 }, // 13 north mid
  { x: -22, z: -18 }, // 14 Slate A spawn
  { x: 24, z: -18 }, // 15 Slate B spawn
  { x: 0, z: -18 }, // 16 Slate mid spawn
];

export const EDGES = [
  [0, 1], [0, 2], [0, 3],
  [1, 2], [2, 3], [1, 4], [2, 5], [3, 6],
  [4, 5], [5, 6], [4, 7], [6, 8],
  [5, 13], [13, 7], [13, 8], [13, 16],
  [7, 9], [8, 10], [9, 11], [10, 12],
  [11, 14], [12, 15], [9, 14], [10, 15],
  [7, 4], [8, 6],
];

const ADJ = WAYPOINTS.map(() => []);
for (const [a, b] of EDGES) {
  ADJ[a].push(b);
  ADJ[b].push(a);
}

/** Nearest waypoint index to a point. */
export function nearestNode(x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < WAYPOINTS.length; i++) {
    const w = WAYPOINTS[i];
    const d = (w.x - x) * (w.x - x) + (w.z - z) * (w.z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** BFS path from a point to a target point, as a list of {x, z} nodes. */
export function findPath(fromX, fromZ, toX, toZ) {
  const start = nearestNode(fromX, fromZ);
  const goal = nearestNode(toX, toZ);
  if (start === goal) return [{ x: toX, z: toZ }];
  const prev = new Array(WAYPOINTS.length).fill(-1);
  const queue = [start];
  prev[start] = start;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (cur === goal) break;
    for (const next of ADJ[cur]) {
      if (prev[next] === -1) {
        prev[next] = cur;
        queue.push(next);
      }
    }
  }
  if (prev[goal] === -1) return [{ x: toX, z: toZ }];
  const nodes = [];
  let cur = goal;
  while (cur !== start) {
    nodes.push(WAYPOINTS[cur]);
    cur = prev[cur];
  }
  nodes.reverse();
  nodes.push({ x: toX, z: toZ });
  return nodes;
}

// ---------------------------------------------------------------- collision

/** Push a circle (x, z, radius) out of every obstacle it overlaps. */
export function resolveCollision(pos, radius) {
  for (const o of OBSTACLES) {
    const cx = Math.max(o.x - o.hx, Math.min(pos.x, o.x + o.hx));
    const cz = Math.max(o.z - o.hz, Math.min(pos.z, o.z + o.hz));
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius) {
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * radius;
        pos.z = cz + (dz / d) * radius;
      } else {
        // Dead centre inside the box: shove out along the shorter axis.
        const px = o.hx + radius - Math.abs(pos.x - o.x);
        const pz = o.hz + radius - Math.abs(pos.z - o.z);
        if (px < pz) pos.x = o.x + (pos.x >= o.x ? o.hx + radius : -(o.hx + radius));
        else pos.z = o.z + (pos.z >= o.z ? o.hz + radius : -(o.hz + radius));
      }
    }
  }
  pos.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, pos.x));
  pos.z = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, pos.z));
}

// 2D segment vs AABB, for one obstacle. True when the segment crosses it.
function segmentHitsBox(x1, z1, x2, z2, o) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  let tmin = 0;
  let tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x1 < o.x - o.hx || x1 > o.x + o.hx) return false;
  } else {
    let t1 = (o.x - o.hx - x1) / dx;
    let t2 = (o.x + o.hx - x1) / dx;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-9) {
    if (z1 < o.z - o.hz || z1 > o.z + o.hz) return false;
  } else {
    let t1 = (o.z - o.hz - z1) / dz;
    let t2 = (o.z + o.hz - z1) / dz;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  // A single-point touch (the segment starts or ends exactly on a face)
  // is not a wall between the two points: only a real crossing blocks.
  return tmax - tmin > 1e-9;
}

/** True when a tall obstacle stands between two ground points. */
export function losBlocked(x1, z1, x2, z2) {
  for (const o of OBSTACLES) {
    if (o.h < 1.6) continue;
    if (segmentHitsBox(x1, z1, x2, z2, o)) return true;
  }
  return false;
}

/**
 * Ray vs the world's boxes (3D slab test). Returns the nearest hit
 * distance along the ray, or Infinity when nothing is in the way.
 */
export function rayHitWall(ox, oy, oz, dx, dy, dz, maxDist) {
  let best = Infinity;
  for (const o of OBSTACLES) {
    let tmin = 0;
    let tmax = maxDist;
    // X slab.
    if (Math.abs(dx) < 1e-9) {
      if (ox < o.x - o.hx || ox > o.x + o.hx) continue;
    } else {
      let t1 = (o.x - o.hx - ox) / dx;
      let t2 = (o.x + o.hx - ox) / dx;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    // Z slab.
    if (Math.abs(dz) < 1e-9) {
      if (oz < o.z - o.hz || oz > o.z + o.hz) continue;
    } else {
      let t1 = (o.z - o.hz - oz) / dz;
      let t2 = (o.z + o.hz - oz) / dz;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    // Y slab (boxes sit on the ground, 0..h).
    if (Math.abs(dy) < 1e-9) {
      if (oy < 0 || oy > o.h) continue;
    } else {
      let t1 = (0 - oy) / dy;
      let t2 = (o.h - oy) / dy;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    // A single-point graze is not a wall: only a real crossing counts.
    if (tmax - tmin <= 1e-9) continue;
    if (tmin < best) best = tmin;
  }
  return best;
}

// ---------------------------------------------------------------- visuals

const KIND_COLORS = {
  containerA: 0xc96a1e,
  containerB: 0x3f6d8e,
  furnace: 0x4d4a48,
  crane: 0xd8a41c,
  pipe: 0x6e6a64,
  crate: 0x8a6b42,
  barrel: 0xa33d2a,
};

const KIND_EMISSIVE = {
  furnace: 0x662200,
  crane: 0x000000,
  containerA: 0x000000,
  containerB: 0x000000,
  pipe: 0x000000,
  crate: 0x000000,
  barrel: 0x000000,
};

/** One canvas, one texture: all of the yard's surface detail is drawn
 *  once at load (no image files, no network) and reused by every mesh
 *  that needs it. Canvas textures are cheap on software WebGL — a
 *  single 256x256 map per surface — and they are what turns flat
 *  coloured boxes into a place: concrete joints, container ribs, a
 *  dusk sky. */
function canvasTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 1;
  return tex;
}

/** The yard floor: poured concrete slabs with expansion joints, oil
 *  stains and tyre scuffs. One tile repeats 8x6 over the 64x44 m lot,
 *  so every lane reads as worn industrial ground instead of a flat
 *  brown plane. */
function groundTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#43403b';
    ctx.fillRect(0, 0, w, h);
    // Slab joints: a 2x2 grid of darker seams per tile.
    ctx.strokeStyle = '#2e2b28';
    ctx.lineWidth = 3;
    ctx.strokeRect(1, 1, w / 2 - 1, h / 2 - 1);
    ctx.strokeRect(w / 2, 1, w / 2 - 1, h / 2 - 1);
    ctx.strokeRect(1, h / 2, w / 2 - 1, h / 2 - 1);
    ctx.strokeRect(w / 2, h / 2, w / 2 - 1, h / 2 - 1);
    // Stains and scuffs: soft dark blotches, deterministic per tile.
    const blotches = [[40, 60, 46], [190, 150, 60], [120, 210, 34], [210, 40, 26], [70, 180, 30]];
    for (const [x, y, r] of blotches) {
      const g = ctx.createRadialGradient(x, y, 2, x, y, r);
      g.addColorStop(0, 'rgba(20,18,16,0.35)');
      g.addColorStop(1, 'rgba(20,18,16,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Faint tyre arcs, the yard's traffic.
    ctx.strokeStyle = 'rgba(25,22,20,0.28)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(200, 210, 90, Math.PI * 0.9, Math.PI * 1.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(60, 40, 70, Math.PI * 1.9, Math.PI * 0.4);
    ctx.stroke();
  }, 8, 6);
}

/** Container ribs: vertical corrugation, drawn once in grey and
 *  multiplied by each container's own colour, so one texture serves
 *  both the amber and the blue stacks. */
function containerTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {
      ctx.fillStyle = '#c9c9c9';
      ctx.fillRect(x, 0, 5, h);
      ctx.fillStyle = '#8f8f8f';
      ctx.fillRect(x + 5, 0, 3, h);
    }
    // Rust weep from the top edge.
    ctx.fillStyle = 'rgba(120,70,30,0.25)';
    ctx.fillRect(0, 0, w, 10);
  });
}

/** Dusk sky, painted with vertex colours instead of a texture: a
 *  texture on a sphere that fills the screen costs the software
 *  renderer a sample per pixel (about 5 fps here), while vertex
 *  colours interpolate for free. Deep blue overhead, warming to amber
 *  at the horizon — the colour the fog and the lights already lean
 *  toward. */
function skyDome() {
  const geo = new THREE.SphereGeometry(150, 24, 12);
  const top = new THREE.Color(0x1a2636);
  const mid = new THREE.Color(0x2b3644);
  const hor = new THREE.Color(0x8a5a28);
  const low = new THREE.Color(0x14181d);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 150; // -1..1, 0 is the horizon
    if (y >= 0.5) c.copy(mid).lerp(top, (y - 0.5) / 0.5);
    else if (y >= 0) c.copy(hor).lerp(mid, y / 0.5);
    else c.copy(hor).lerp(low, Math.min(1, -y * 2));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }),
  );
}

/** A small canvas texture with one big letter, for the site markers. */
function letterTexture(letter, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(128, 128, 108, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = 'bold 150px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 128, 136);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 1;
  return tex;
}

/**
 * Build the yard's meshes into a scene. One shared Lambert material per
 * palette key, no shadows, no per-frame allocation — the whole map is
 * static geometry, which is exactly what software rendering wants.
 */
export function buildWorldMeshes(scene) {
  const materials = {};
  for (const [kind, color] of Object.entries(KIND_COLORS)) {
    materials[kind] = new THREE.MeshLambertMaterial({
      color,
      emissive: KIND_EMISSIVE[kind] ?? 0x000000,
    });
  }
  const groundMat = new THREE.MeshLambertMaterial({ map: groundTexture() });
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x55504a });
  const laneMat = new THREE.MeshLambertMaterial({ color: 0x35322e });
  const hazardMat = new THREE.MeshLambertMaterial({ color: 0xf5c518 });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x1c1f24 });
  const ribTex = containerTexture();
  materials.containerA.map = ribTex;
  materials.containerB.map = ribTex;

  // Dusk sky dome: the yard's backdrop, so the horizon is never a flat
  // colour. Radius 150 sits inside the camera's far plane (220).
  scene.add(skyDome());

  // Ground.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(64, 44), groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Lane strips, slightly above the ground so they read at a glance.
  const lanes = [
    { x: -20, z: -2, w: 5, l: 38 },
    { x: 0, z: -2, w: 5, l: 38 },
    { x: 20, z: -2, w: 5, l: 38 },
  ];
  for (const lane of lanes) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(lane.w, lane.l), laneMat);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(lane.x, 0.01, lane.z);
    scene.add(strip);
  }

  // Perimeter walls.
  const wallGeoH = new THREE.BoxGeometry(64, 3.2, 0.8);
  const wallGeoV = new THREE.BoxGeometry(0.8, 3.2, 44);
  const walls = [
    { geo: wallGeoH, x: 0, z: -22.2 },
    { geo: wallGeoH, x: 0, z: 22.2 },
    { geo: wallGeoV, x: -32.2, z: 0 },
    { geo: wallGeoV, x: 32.2, z: 0 },
  ];
  for (const w of walls) {
    const mesh = new THREE.Mesh(w.geo, wallMat);
    mesh.position.set(w.x, 1.6, w.z);
    scene.add(mesh);
  }

  // Obstacles, with a second container stacked on the tall ones.
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  for (const o of OBSTACLES) {
    const mesh = new THREE.Mesh(boxGeo, materials[o.kind]);
    mesh.scale.set(o.hx * 2, o.h, o.hz * 2);
    mesh.position.set(o.x, o.h / 2, o.z);
    scene.add(mesh);
    if (o.kind === 'containerA' || o.kind === 'containerB') {
      const top = new THREE.Mesh(boxGeo, materials[o.kind === 'containerA' ? 'containerB' : 'containerA']);
      top.scale.set(o.hx * 2, 1.1, o.hz * 2);
      top.position.set(o.x, o.h + 0.55, o.z);
      scene.add(top);
    }
  }

  // Crane beam over Crane Bay.
  const beam = new THREE.Mesh(new THREE.BoxGeometry(9, 0.7, 0.7), materials.crane);
  beam.position.set(23, 7, -13.2);
  scene.add(beam);

  // Site markers: a glowing ring on the ground and a floating letter.
  for (const [key, site] of Object.entries(SITES)) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.r - 0.35, site.r, 40),
      new THREE.MeshBasicMaterial({ color: site.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.03, site.z);
    scene.add(ring);
    const letter = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2),
      new THREE.MeshBasicMaterial({
        map: letterTexture(key, key === 'A' ? '#ff8c2e' : '#5b8fd6'),
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    letter.position.set(site.x, 4.4, site.z);
    scene.add(letter);
    // A light beam over the site, so the objective reads from anywhere
    // in the yard: a tall, faint, additive column in the site's colour.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 1.1, 16, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: site.color, transparent: true, opacity: 0.13,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beam.position.set(site.x, 8, site.z);
    scene.add(beam);
    // A soft glow disc on the ground inside the ring.
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(site.r - 0.6, 32),
      new THREE.MeshBasicMaterial({ color: site.color, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(site.x, 0.025, site.z);
    scene.add(glow);
    // Hazard strip in front of each site.
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.5), hazardMat);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(site.x, 0.02, site.z + site.r + 0.6);
    scene.add(strip);
  }

  // Distant skyline silhouettes, outside the walls, for depth. A few
  // carry lit windows — warm dots against the dusk — so the background
  // reads as a town, not a black void.
  for (let i = 0; i < 10; i++) {
    const w = 6 + ((i * 37) % 9);
    const h = 8 + ((i * 53) % 14);
    const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, 4), darkMat);
    const angle = (i / 10) * Math.PI * 2;
    block.position.set(Math.cos(angle) * 58, h / 2, Math.sin(angle) * 48);
    scene.add(block);
    if (i % 3 === 0) {
      const wins = new THREE.Mesh(
        new THREE.PlaneGeometry(w * 0.55, h * 0.4),
        new THREE.MeshBasicMaterial({ color: 0xffc861, transparent: true, opacity: 0.5 }),
      );
      wins.position.set(block.position.x, h * 0.55, block.position.z + 2.05);
      wins.lookAt(0, h * 0.55, 0);
      scene.add(wins);
    }
  }
}
