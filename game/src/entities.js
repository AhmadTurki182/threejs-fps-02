// entities.js — the actors of the match: the player and the five bots
// share one body. An actor is a position, a facing, a velocity and a
// health pool; movement is acceleration-based with a circle-vs-box
// collision resolve, so stopping, crouching and cornering all feel
// deliberate. The debug harness reaches into these fields directly
// (body.position, body.yaw, body.eye, health, armor, alive, fall), so
// their shapes are part of the game's contract — do not rename them.

import * as THREE from 'three';
import {
  ACTOR_RADIUS, BOT_SPEED, EYE_CROUCH, EYE_STAND, GRAVITY,
  JUMP_SPEED, PLAYER_CROUCH_SPEED, PLAYER_SPEED,
} from './config.js';
import { resolveCollision } from './world.js';

export class Actor {
  constructor(name, team, isPlayer) {
    this.name = name;
    this.team = team; // 'ember' or 'slate'
    this.isPlayer = isPlayer;
    // The harness reads and writes these fields, so they stay plain and
    // public: position is a real Vector3 (it calls .set on it).
    this.body = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      eye: EYE_STAND,
    };
    this.health = 100;
    this.armor = 0;
    this.alive = true;
    this.fall = 0; // death-fall animation, 0 upright .. 1 flat
    this.weapon = 'pistol';
    this.ammo = 12; // rounds in the magazine
    this.reserve = 36; // rounds in reserve
    this.grenades = 0;
    this.crouching = false;
    this.onGround = true;
    this.lastShotAt = -99; // sim time of the last shot
    this.reloadUntil = -99; // sim time the current reload finishes
    this.spreadBloom = 0; // extra cone from recent fire, decays
    this.moveAmount = 0; // 0..1, how hard the actor is moving (for spread)
    this.carrier = false; // carries the charge this round
  }

  get eyeHeight() {
    return this.body.eye;
  }

  // The bot brain owns the AI state (mode, target, memory), but the
  // debug harness reads and writes those fields on the ACTOR, so they
  // are exposed here as accessors that delegate to the brain. The
  // player has no brain, so the getters fall back to idle defaults.
  get mode() { return this.brain ? this.brain.mode : 'hold'; }
  set mode(m) { if (this.brain) this.brain.mode = m; }
  get target() { return this.brain ? this.brain.target : null; }
  set target(t) { if (this.brain) this.brain.target = t; }
  get lastSeen() { return this.brain ? this.brain.lastSeen : { x: 0, z: 0 }; }
  set lastSeen(v) { if (this.brain) this.brain.lastSeen = v; }
  get lastSeenAt() { return this.brain ? this.brain.lastSeenAt : -99; }
  set lastSeenAt(v) { if (this.brain) this.brain.lastSeenAt = v; }
  get reactionAt() { return this.brain ? this.brain.reactionAt : -99; }
  set reactionAt(v) { if (this.brain) this.brain.reactionAt = v; }

  eyePos(out) {
    out.set(this.body.position.x, this.body.position.y + this.body.eye, this.body.position.z);
    return out;
  }

  /** Forward vector from yaw/pitch. Yaw 0 faces north (-z). */
  forward(out) {
    const cp = Math.cos(this.body.pitch);
    out.set(-Math.sin(this.body.yaw) * cp, Math.sin(this.body.pitch), -Math.cos(this.body.yaw) * cp);
    return out;
  }

  reset(x, z, yaw) {
    this.body.position.set(x, 0, z);
    this.body.velocity.set(0, 0, 0);
    this.body.yaw = yaw;
    this.body.pitch = 0;
    this.body.eye = EYE_STAND;
    this.health = 100;
    this.alive = true;
    this.fall = 0;
    this.crouching = false;
    this.onGround = true;
    this.lastShotAt = -99;
    this.reloadUntil = -99;
    this.spreadBloom = 0;
    this.moveAmount = 0;
    this.carrier = false;
    // Armour and weapons survive between rounds (the buy menu is how the
    // player spends money); ammo is refilled by the round starter.
  }

  /** Move with acceleration toward a wish direction (unit XZ vector, or
   * null to stop). Returns the planar speed actually reached. Bots and
   * the player share this: acceleration makes starts and stops weighty,
   * and the spread model reads moveAmount, so stopping to aim pays.
   */
  move(dt, wishX, wishZ, speed) {
    const v = this.body.velocity;
    const accel = this.onGround ? 34 : 12;
    if (wishX !== 0 || wishZ !== 0) {
      v.x += wishX * accel * dt;
      v.z += wishZ * accel * dt;
    } else {
      // Friction: bleed planar velocity fast on the ground, slowly in air.
      const f = Math.max(0, 1 - (this.onGround ? 11 : 0.6) * dt);
      v.x *= f;
      v.z *= f;
    }
    // Cap planar speed.
    const sp = Math.hypot(v.x, v.z);
    if (sp > speed) {
      v.x = (v.x / sp) * speed;
      v.z = (v.z / sp) * speed;
    }
    this.moveAmount = Math.min(1, sp / speed);
    this.body.position.x += v.x * dt;
    this.body.position.z += v.z * dt;
    resolveCollision(this.body.position, ACTOR_RADIUS);
    // Vertical: gravity and the ground plane.
    if (!this.onGround || v.y !== 0) {
      v.y -= GRAVITY * dt;
      this.body.position.y += v.y * dt;
      if (this.body.position.y <= 0) {
        this.body.position.y = 0;
        v.y = 0;
        this.onGround = true;
      }
    }
    return sp;
  }

  jump() {
    if (this.onGround && this.alive) {
      this.body.velocity.y = JUMP_SPEED;
      this.onGround = false;
    }
  }

  setCrouch(on) {
    if (!this.alive) return;
    this.crouching = on;
    this.body.eye = on ? EYE_CROUCH : EYE_STAND;
  }

  get speed() {
    return this.isPlayer
      ? this.crouching ? PLAYER_CROUCH_SPEED : PLAYER_SPEED
      : BOT_SPEED;
  }

  /**
   * Take a hit. Armour absorbs half of every hit until it runs out.
   * Returns true when the hit killed the actor.
   */
  damage(amount, game) {
    if (!this.alive) return false;
    let rest = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, rest * 0.5);
      this.armor -= absorbed;
      rest -= absorbed;
    }
    this.health -= rest;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.fall = 0.0001; // start the fall animation
      return true;
    }
    return false;
  }
}
