// weapons.js — gunfire, grenades and the feedback that makes a shot
// feel like a shot.
//
// Hits are checked analytically, never with THREE.Raycaster: a ray
// against each enemy's body cylinder and head sphere, and against the
// world's boxes, nearest hit wins. Spread grows with movement and with
// recent fire, and recoil kicks the aim up, so stopping to aim pays —
// the way the bounty asks. Muzzle flashes, tracers and impact sparks
// come from small pools, so a firefight allocates nothing.

import * as THREE from 'three';
import { BOT_WEAPON, WEAPONS } from './config.js';
import { rayHitWall } from './world.js';

const BODY_RADIUS = 0.42;
const BODY_TOP = 1.45;
const HEAD_RADIUS = 0.28;
const HEAD_LIFT = 0.13; // head centre sits this far above the eye line

/** The weapon table for an actor (bots all carry the Slate rifle). */
export function weaponOf(actor) {
  return actor.isPlayer ? WEAPONS[actor.weapon] : BOT_WEAPON;
}

/** Seconds between shots for a weapon table entry. */
export function shotInterval(w) {
  return 60 / w.rpm;
}

export function canFire(actor, time) {
  const w = weaponOf(actor);
  if (!actor.alive) return false;
  if (actor.ammo <= 0) return false;
  if (time < actor.reloadUntil) return false;
  if (time - actor.lastShotAt < shotInterval(w) - 1e-6) return false;
  return true;
}

/** Start a reload; finishes at actor.reloadUntil (sim time). */
export function startReload(actor, time) {
  const w = weaponOf(actor);
  if (actor.ammo >= w.mag || actor.reserve <= 0) return false;
  if (time < actor.reloadUntil) return false;
  actor.reloadUntil = time + w.reload;
  return true;
}

/** Finish a reload whose time has come: move rounds into the magazine. */
export function finishReload(actor) {
  const w = weaponOf(actor);
  const need = w.mag - actor.ammo;
  const take = Math.min(need, actor.reserve);
  actor.ammo += take;
  actor.reserve -= take;
}

// Ray vs a vertical cylinder (the body). Returns distance or Infinity.
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, top) {
  // Solve in XZ: |o + t d - c|^2 = r^2.
  const ex = ox - cx;
  const ez = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-12) return Infinity;
  const b = 2 * (ex * dx + ez * dz);
  const c = ex * ex + ez * ez - BODY_RADIUS * BODY_RADIUS;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const root = Math.sqrt(disc);
  let t = (-b - root) / (2 * a);
  if (t < 0) t = (-b + root) / (2 * a);
  if (t < 0) return Infinity;
  const y = oy + t * dy;
  if (y < 0 || y > top) return Infinity;
  return t;
}

// Ray vs a sphere (the head). Returns distance or Infinity.
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const ex = ox - cx;
  const ey = oy - cy;
  const ez = oz - cz;
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? Infinity : t;
}

/**
 * Fire one hitscan shot from an actor. `aim` is the shooter's current
 * aim as {yaw, pitch}; the shot's cone is perturbed by spread and the
 * shooter's movement. Returns { hit, headshot, killed, target, point,
 * distance } — hit is false when the round struck a wall or nothing.
 */
export function fireShot(game, shooter, aimYaw, aimPitch, spreadDeg) {
  const w = weaponOf(shooter);
  const time = game.time;
  shooter.ammo -= 1;
  shooter.lastShotAt = time;
  shooter.spreadBloom = Math.min(2.2, shooter.spreadBloom + w.kick * 0.28);

  // Aim with error: a gaussian-ish cone around the aim direction.
  const spread = (spreadDeg * Math.PI) / 180;
  const ex = game.rng.gauss() * spread;
  const ey = game.rng.gauss() * spread;
  const yaw = aimYaw + ex;
  const pitch = aimPitch + ey;
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp;
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * cp;

  const origin = game.tmpVec;
  shooter.eyePos(origin);
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;

  // Nearest wall.
  let bestT = rayHitWall(ox, oy, oz, dx, dy, dz, 120);
  let bestTarget = null;
  let bestHead = false;

  // Nearest enemy body or head.
  for (const other of game.actors) {
    if (other === shooter || !other.alive || other.team === shooter.team) continue;
    const p = other.body.position;
    const headY = p.y + other.body.eye + HEAD_LIFT;
    const tHead = raySphere(ox, oy, oz, dx, dy, dz, p.x, headY, p.z, HEAD_RADIUS);
    if (tHead < bestT) {
      bestT = tHead;
      bestTarget = other;
      bestHead = true;
    }
    const tBody = rayCylinder(ox, oy, oz, dx, dy, dz, p.x, p.z, p.y + BODY_TOP);
    if (tBody < bestT) {
      bestT = tBody;
      bestTarget = other;
      bestHead = false;
    }
  }

  const point = {
    x: ox + dx * bestT,
    y: oy + dy * bestT,
    z: oz + dz * bestT,
  };
  const result = { hit: false, headshot: false, killed: false, target: null, point, distance: bestT };

  if (bestTarget) {
    // Damage falls off with range past the weapon's falloff start.
    const fall = bestT <= w.falloffStart
      ? 1
      : Math.max(w.falloffMin, 1 - ((bestT - w.falloffStart) / 60) * (1 - w.falloffMin));
    const amount = w.damage * (bestHead ? w.headMul : 1) * fall;
    const killed = bestTarget.damage(amount, game);
    result.hit = true;
    result.headshot = bestHead;
    result.killed = killed;
    result.target = bestTarget;
    game.onKillCheck(shooter, bestTarget, killed);
  }
  game.effects.tracer(ox, oy, oz, point.x, point.y, point.z);
  game.effects.muzzle(origin, dx, dy, dz);
  if (!bestTarget && bestT < 120) game.effects.spark(point.x, point.y, point.z);
  return result;
}

/** Current hip-fire cone for an actor, in degrees. */
export function currentSpread(actor) {
  const w = weaponOf(actor);
  const moving = actor.moveAmount * 1.1;
  const airborne = actor.onGround ? 0 : 0.9;
  const crouch = actor.crouching ? -0.25 : 0;
  return Math.max(0.1, w.spread + moving + airborne + crouch + actor.spreadBloom);
}

// ---------------------------------------------------------------- grenades

export class Grenade {
  constructor(owner, x, y, z, vx, vy, vz, fuse) {
    this.owner = owner;
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3(vx, vy, vz);
    this.fuse = fuse;
    this.dead = false;
  }

  update(dt, game) {
    if (this.dead) return;
    this.vel.y -= 18 * dt;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < 0.25) {
      this.pos.y = 0.25;
      this.vel.y = Math.abs(this.vel.y) * 0.35;
      this.vel.x *= 0.6;
      this.vel.z *= 0.6;
    }
    this.fuse -= dt;
    if (this.fuse <= 0) {
      this.dead = true;
      game.explodeGrenade(this);
    }
  }
}

// ---------------------------------------------------------------- effects

/**
 * Pooled muzzle flashes, tracers, impact sparks and the explosion.
 * Everything here is created once and reused; a firefight allocates
 * nothing, which keeps the fixed-step sim cheap at any frame rate.
 */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    // Tracers: 24 line segments, round-robin.
    this.tracers = [];
    for (let i = 0; i < 24; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0 }));
      line.frustumCulled = false;
      scene.add(line);
      this.tracers.push({ line, life: 0 });
    }
    this.tracerIdx = 0;
    // Muzzle flash: one small additive sprite, moved to the gun.
    const flashGeo = new THREE.PlaneGeometry(0.34, 0.34);
    this.flash = new THREE.Mesh(
      flashGeo,
      new THREE.MeshBasicMaterial({ color: 0xffc861, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.flashLife = 0;
    scene.add(this.flash);
    // Impact sparks: 10 tiny spheres, round-robin.
    this.sparks = [];
    for (let i = 0; i < 10; i++) {
      const spark = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0 }),
      );
      scene.add(spark);
      this.sparks.push({ mesh: spark, life: 0 });
    }
    this.sparkIdx = 0;
    // Explosion: one sphere that scales up and fades.
    this.blast = new THREE.Mesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xff7a1e, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.blastLife = 0;
    scene.add(this.blast);
    // The gun the player sees: a rifle that reads as a rifle — a slim
    // receiver in light gunmetal, a long barrel with a muzzle brake, a
    // front sight post and a team-amber accent rail — held low and to
    // the right so it frames the crosshair instead of covering it.
    this.viewmodel = new THREE.Group();
    const gunMat = new THREE.MeshLambertMaterial({ color: 0x3a3f47 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x22242a });
    const accentMat = new THREE.MeshLambertMaterial({ color: 0xff8c2e });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.42), gunMat);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), darkMat);
    barrel.position.set(0, 0.03, -0.34);
    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.07), darkMat);
    muzzle.position.set(0, 0.03, -0.5);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.018, 0.26), accentMat);
    rail.position.set(0, 0.065, -0.06);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.05, 0.015), darkMat);
    sight.position.set(0, 0.09, -0.44);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.08), darkMat);
    grip.position.set(0, -0.12, 0.12);
    grip.rotation.x = 0.35;
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.07), darkMat);
    mag.position.set(0, -0.1, -0.05);
    mag.rotation.x = 0.15;
    this.viewmodel.add(body, barrel, muzzle, rail, sight, grip, mag);
    this.viewmodel.position.set(0.24, -0.22, -0.5);
    this.viewmodelKick = 0;
    this.viewmodelDip = 0;
  }

  tracer(x1, y1, z1, x2, y2, z2) {
    const t = this.tracers[this.tracerIdx];
    this.tracerIdx = (this.tracerIdx + 1) % this.tracers.length;
    const attr = t.line.geometry.getAttribute('position');
    attr.setXYZ(0, x1, y1, z1);
    attr.setXYZ(1, x2, y2, z2);
    attr.needsUpdate = true;
    t.line.material.opacity = 0.9;
    t.life = 0.07;
  }

  muzzle(origin, dx, dy, dz) {
    this.flash.position.set(origin.x + dx * 0.7, origin.y + dy * 0.7, origin.z + dz * 0.7);
    this.flash.material.opacity = 0.95;
    this.flashLife = 0.05;
  }

  spark(x, y, z) {
    const s = this.sparks[this.sparkIdx];
    this.sparkIdx = (this.sparkIdx + 1) % this.sparks.length;
    s.mesh.position.set(x, y, z);
    s.mesh.material.opacity = 1;
    s.life = 0.18;
  }

  explosion(x, y, z, radius) {
    this.blast.position.set(x, Math.max(0.6, y), z);
    this.blast.scale.setScalar(0.4);
    this.blast.material.opacity = 0.85;
    this.blastLife = 0.5;
    this.blastRadius = radius;
  }

  /** Per-frame visual decay. Called from the render path, not the sim. */
  update(dt) {
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        if (t.life <= 0) t.line.material.opacity = 0;
      }
    }
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      if (this.flashLife <= 0) this.flash.material.opacity = 0;
    }
    for (const s of this.sparks) {
      if (s.life > 0) {
        s.life -= dt;
        s.mesh.scale.setScalar(Math.max(0.01, s.life / 0.18));
        if (s.life <= 0) s.mesh.material.opacity = 0;
      }
    }
    if (this.blastLife > 0) {
      this.blastLife -= dt;
      const k = 1 - this.blastLife / 0.5;
      this.blast.scale.setScalar(0.4 + k * (this.blastRadius ?? 6));
      this.blast.material.opacity = Math.max(0, 0.85 * (1 - k));
    }
    // Viewmodel kick and reload dip decay back to rest.
    this.viewmodelKick = Math.max(0, this.viewmodelKick - dt * 6);
    this.viewmodelDip = Math.max(0, this.viewmodelDip - dt * 2.2);
    this.viewmodel.position.z = -0.5 + this.viewmodelKick * 0.09 + this.viewmodelDip * 0.16;
    this.viewmodel.position.y = -0.24 - this.viewmodelDip * 0.1;
    this.viewmodel.rotation.x = this.viewmodelKick * 0.12;
  }
}
