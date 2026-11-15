// game.js — the match itself: rounds, money, the charge, and the
// fixed-step simulation that main.js feeds from wall-clock time.
//
// One step is one DT tick of the whole match: player movement, bot
// brains, grenades, channels, phase timers, round ends. Rendering never
// runs inside a step — the render path only reads the state the sim
// wrote, which is what lets the sim run at full speed on a 2 fps
// renderer. The debug surface the harness uses (money, start, fire,
// skip, plant, warp, and the state/player/bots fields) lives here too.

import * as THREE from 'three';
import {
  ARMOR_MAX, ARMOR_PRICE, BOT_WEAPON, BUY_SECONDS, DETONATE_SECONDS,
  DT, GRENADE_FUSE, GRENADE_MAX_DAMAGE, GRENADE_PRICE, GRENADE_RADIUS,
  KILL_MONEY, LIVE_SECONDS, LOSS_MONEY, MAX_ROUNDS, PLANT_MONEY,
  PLANT_SECONDS, ROUNDS_TO_WIN, ROUND_END_SECONDS, START_MONEY,
  WEAPONS, WIN_MONEY,
} from './config.js';
import { Actor } from './entities.js';
import { BotBrain } from './bots.js';
import { Effects, Grenade, canFire, currentSpread, finishReload, fireShot, startReload, weaponOf } from './weapons.js';
import { Hud } from './hud.js';
import { SoundBank } from './audio.js';
import { makeRng } from './rng.js';
import { SITES, SPAWNS, buildWorldMeshes, losBlocked } from './world.js';

const BOT_DEFS = [
  { name: 'Rook', team: 'ember' },
  { name: 'Vex', team: 'ember' },
  { name: 'Ash', team: 'slate' },
  { name: 'Bramble', team: 'slate' },
  { name: 'Kite', team: 'slate' },
];

export class Game {
  constructor(scene, camera, seed) {
    this.scene = scene;
    this.camera = camera;
    this.rng = makeRng(seed);
    this.sounds = new SoundBank();
    this.effects = new Effects(scene);
    this.tmpVec = new THREE.Vector3();
    this.tmpVec2 = new THREE.Vector3();
    this.frozen = false; // shot staging stops the loop after 2 renders
    this.shake = 0;
    this.input = { keys: {}, fire: false, fireEdge: false };
    this.grenades = [];

    buildWorldMeshes(scene);

    // The state the HUD, the harness and the render path all read.
    this.state = {      phase: 'menu', // menu | buy | live | roundEnd | matchEnd
      round: 0,
      score: { ember: 0, slate: 0 },
      timer: 0,
      time: 0, // total sim seconds, the clock the fps meter reads
      charge: { status: 'carried', site: null, x: 0, z: 0, plantedAt: -99 },
      carrier: null,
      money: { ember: START_MONEY },
      winReason: '',
      winner: null,
      matchWinner: null,
    };

    // Actors: the player first, then the five bots.
    this.player = new Actor('You', 'ember', true);
    this.bots = BOT_DEFS.map((d) => new Actor(d.name, d.team, false));
    this.actors = [this.player, ...this.bots];
    this.brains = new Map();
    for (const bot of this.bots) {
      const brain = new BotBrain(bot, this);
      this.brains.set(bot, brain);
      // The actor exposes the brain's AI state (mode, target, memory)
      // through accessors, so the debug harness can read and write it
      // on the bot itself.
      bot.brain = brain;
    }

    this.buildActorMeshes();
    this.buildChargeMesh();
    this.hud = new Hud(this);
    this.hud.showMenu(
      'IRONLINE',
      'Ferroline Yard · 3v3 · first to 5 rounds · plant the charge or wipe the other team',
    );
    this.plantProgress = 0;
    this.plantNextRound = null; // debug plant that lands between rounds
    this.stepCount = 0;
    this.lastStepSoundAt = 0;
  }

  /** Current sim time in seconds. The sim systems read game.time; the
   *  canonical clock lives in state.time, and this getter is the bridge
   *  between the two — every brain, shot and timer reads through it. */
  get time() {
    return this.state.time;
  }

  // ------------------------------------------------------------- meshes

  buildActorMeshes() {
    this.meshes = new Map();
    for (const bot of this.bots) {
      const group = new THREE.Group();
      const color = bot.team === 'ember' ? 0xff8c2e : 0x5b8fd6;
      const suit = new THREE.MeshLambertMaterial({ color: bot.team === 'ember' ? 0x7a4a1e : 0x2e4a6b });
      const accent = new THREE.MeshLambertMaterial({ color });
      const dark = new THREE.MeshLambertMaterial({ color: 0x1c1e24 });
      // Legs, so a bot reads as a soldier walking, not a floating box.
      const legGeo = new THREE.BoxGeometry(0.22, 0.55, 0.26);
      for (const sx of [-0.18, 0.18]) {
        const leg = new THREE.Mesh(legGeo, dark);
        leg.position.set(sx, 0.28, 0);
        group.add(leg);
      }
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.05, 0.42), suit);
      body.position.y = 0.85;
      // Chest plate in the team colour, front-facing, so the team reads
      // at a glance even at 20 m.
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.06), accent);
      plate.position.set(0, 0.92, -0.23);
      // Shoulder pads.
      const padGeo = new THREE.BoxGeometry(0.2, 0.16, 0.42);
      for (const sx of [-0.42, 0.42]) {
        const pad = new THREE.Mesh(padGeo, suit);
        pad.position.set(sx, 1.3, 0);
        group.add(pad);
      }
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), accent);
      head.position.y = 1.58;
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.1), new THREE.MeshBasicMaterial({ color: 0x111418 }));
      visor.position.set(0, 1.6, -0.22);
      // Helmet stripe, team colour across the crown.
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.5), new THREE.MeshBasicMaterial({ color }));
      stripe.position.set(0, 1.82, 0);
      // The rifle, held forward: receiver, barrel and a front sight.
      const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.62), dark);
      gun.position.set(0.3, 1.05, -0.2);
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.34), dark);
      barrel.position.set(0.3, 1.08, -0.62);
      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.03), accent);
      sight.position.set(0.3, 1.16, -0.68);
      group.add(body, plate, head, visor, stripe, gun, barrel, sight);
      group.traverse((m) => { if (m.isMesh) m.castShadow = false; });
      this.scene.add(group);
      this.meshes.set(bot, group);
    }
  }

  buildChargeMesh() {
    const group = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.32, 0.34),
      new THREE.MeshLambertMaterial({ color: 0x2a2d33 }),
    );
    box.position.y = 0.16;
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff2e2e }),
    );
    light.position.set(0.14, 0.36, 0);
    group.add(box, light);
    this.chargeLight = light;
    this.chargeMesh = group;
    group.visible = false;
    this.scene.add(group);
  }

  // ------------------------------------------------------------- flow

  /** The Play button (and the harness's start()): begin the match. */
  start() {
    if (this.state.phase !== 'menu') return;
    this.sounds.ensure();
    this.state.score = { ember: 0, slate: 0 };
    this.state.money.ember = START_MONEY;
    this.state.matchWinner = null;
    this.hud.hideMenu();
    this.startRound(1);
  }

  uiStart() {
    this.sounds.ensure();
    this.sounds.click();
    this.start();
  }

  startRound(n) {
    const S = this.state;
    S.round = n;
    S.phase = 'buy';
    S.timer = BUY_SECONDS;
    S.winReason = '';
    S.winner = null;
    S.charge = { status: 'carried', site: null, x: 0, z: 0, plantedAt: -99 };
    S.carrier = this.player;
    this.plantProgress = 0;

    // Spawns: Ember south, Slate north, facing each other.
    const emberSpawns = SPAWNS.ember;
    const slateSpawns = SPAWNS.slate;
    this.player.reset(emberSpawns[0][0], emberSpawns[0][1], 0);
    this.player.carrier = true;
    this.refillAmmo(this.player);
    this.bots[0].reset(emberSpawns[1][0], emberSpawns[1][1], 0);
    this.bots[1].reset(emberSpawns[2][0], emberSpawns[2][1], 0);
    this.bots[2].reset(slateSpawns[0][0], slateSpawns[0][1], Math.PI);
    this.bots[3].reset(slateSpawns[1][0], slateSpawns[1][1], Math.PI);
    this.bots[4].reset(slateSpawns[2][0], slateSpawns[2][1], Math.PI);
    for (const bot of this.bots) {
      bot.weapon = 'rifle';
      bot.ammo = BOT_WEAPON.mag;
      bot.reserve = 999;
      // One frag per bot per round: the flush-out throw. The player
      // still has to buy theirs.
      bot.grenades = 1;
    }
    // Site assignments: the Ember bots split A/B at random; Ash holds
    // Foundry, Bramble holds Crane Bay, Kite patrols the middle.
    const emberSites = this.rng.chance(0.5) ? ['A', 'B'] : ['B', 'A'];
    this.bots[0].site = emberSites[0];
    this.bots[1].site = emberSites[1];
    this.bots[2].site = 'A';
    this.bots[3].site = 'B';
    this.bots[4].site = 'A';
    for (const bot of this.bots) {
      const brain = this.brains.get(bot);
      brain.mode = 'hold';
      brain.path = [];
      brain.target = null;
      brain.plantProgress = 0;
      brain.defuseProgress = 0;
      brain.investigate = null;
      brain.holdNode = { x: bot.body.position.x, z: bot.body.position.z };
      brain.holdYaw = bot.body.yaw;
    }
    // A debug plant that landed between rounds starts this round planted.
    if (this.plantNextRound) {
      const p = this.plantNextRound;
      this.plantNextRound = null;
      S.charge = { status: 'planted', site: p.site, x: p.x, z: p.z, plantedAt: S.time };
      S.carrier = null;
      this.player.carrier = false;
    }
    this.hud.banner(`ROUND ${n}`, n === 1 ? 'Plant the charge at A or B — or wipe Slate out' : 'Buy up — B opens the shop', '');
    this.hud.hideBuy();
  }

  endRound(winner, reason) {
    const S = this.state;
    S.score[winner] += 1;
    S.winReason = reason;
    S.winner = winner;
    S.phase = 'roundEnd';
    S.timer = ROUND_END_SECONDS;
    if (winner === 'ember') {
      S.money.ember += WIN_MONEY;
      this.sounds.roundWin();
      const text = reason === 'detonation'
        ? 'CHARGE DETONATED'
        : reason === 'elimination' ? 'SLATE WIPED OUT' : 'ROUND WON';
      this.hud.banner(text, `Ember takes round ${S.round} · +$${WIN_MONEY}`, 'win');
    } else {
      S.money.ember += LOSS_MONEY;
      this.sounds.roundLose();
      const text = reason === 'defuse'
        ? 'CHARGE DEFUSED'
        : reason === 'time' ? 'TIME EXPIRED' : 'EMBER WIPED OUT';
      this.hud.banner(text, `Slate takes round ${S.round} · +$${LOSS_MONEY}`, 'lose');
    }
    this.hud.hideBuy();
  }

  endMatch() {
    const S = this.state;
    S.matchWinner = S.score.ember > S.score.slate ? 'ember' : 'slate';
    S.phase = 'matchEnd';
    const won = S.matchWinner === 'ember';
    this.hud.showMenu(
      won ? 'EMBER WINS THE MATCH' : 'SLATE WINS THE MATCH',
      `Final score ${S.score.ember} — ${S.score.slate} · Ferroline Yard · refresh to play again`,
    );
    if (won) this.sounds.roundWin();
    else this.sounds.roundLose();
  }

  // ------------------------------------------------------------- the step

  /** One fixed DT tick of the whole match. No rendering in here. */
  step(dt) {
    const S = this.state;
    S.time += dt;
    this.stepCount += 1;

    // Reloads finish on sim time.
    for (const a of this.actors) {
      if (a.reloadUntil > 0 && S.time >= a.reloadUntil) {
        a.reloadUntil = -99;
        finishReload(a);
      }
      a.spreadBloom = Math.max(0, a.spreadBloom - dt * 1.6);
    }

    if (S.phase === 'buy' || S.phase === 'live') {
      this.updatePlayer(dt);
      for (const bot of this.bots) this.brains.get(bot).update(dt);
      this.separateActors();
      this.updateCharge(dt);
    }

    for (const g of this.grenades) g.update(dt, this);
    this.grenades = this.grenades.filter((g) => !g.dead);

    // Death falls animate even between rounds.
    for (const a of this.actors) {
      if (!a.alive && a.fall > 0 && a.fall < 1) a.fall = Math.min(1, a.fall + dt * 1.6);
    }

    // Phase timers.
    if (S.phase === 'buy') {
      S.timer -= dt;
      if (S.timer <= 0) {
        S.phase = 'live';
        // A charge planted during the buy phase keeps its own clock.
        S.timer = S.charge.status === 'planted'
          ? Math.max(1, S.charge.plantedAt + DETONATE_SECONDS - S.time)
          : LIVE_SECONDS;
        this.hud.banner('GO', 'Plant the charge — or hold the yard', '');
      }
    } else if (S.phase === 'live') {
      S.timer -= dt;
      if (S.timer <= 0) {
        if (S.charge.status === 'planted') this.endRound('ember', 'detonation');
        else this.endRound('slate', 'time');
      } else {
        const emberAlive = this.actors.some((a) => a.team === 'ember' && a.alive);
        const slateAlive = this.actors.some((a) => a.team === 'slate' && a.alive);
        // Elimination only ends a round the charge has not been planted in:
        // once it is down, the round plays out to detonation or defuse.
        if (S.charge.status !== 'planted') {
          if (!slateAlive) this.endRound('ember', 'elimination');
          else if (!emberAlive) this.endRound('slate', 'elimination');
        }
      }
    } else if (S.phase === 'roundEnd') {
      S.timer -= dt;
      if (S.timer <= 0) {
        if (S.score.ember >= ROUNDS_TO_WIN || S.score.slate >= ROUNDS_TO_WIN || S.round >= MAX_ROUNDS) {
          this.endMatch();
        } else {
          this.startRound(S.round + 1);
        }
      }
    }

    this.hud.refresh();
  }

  updatePlayer(dt) {
    const p = this.player;
    const S = this.state;
    if (!p.alive) return;
    const keys = this.input.keys;
    // Wish direction from WASD, relative to the facing.
    const fwd = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const strafe = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const sin = Math.sin(p.body.yaw);
    const cos = Math.cos(p.body.yaw);
    let wx = -sin * fwd + cos * strafe;
    let wz = -cos * fwd - sin * strafe;
    const len = Math.hypot(wx, wz);
    if (len > 0) {
      wx /= len;
      wz /= len;
    }
    p.setCrouch(!!keys.ControlLeft);
    p.move(dt, wx, wz, p.speed);
    // Footsteps while moving on the ground.
    if (len > 0 && p.onGround && S.time - this.lastStepSoundAt > 0.38) {
      this.lastStepSoundAt = S.time;
      this.sounds.step();
    }
    // Held fire (auto weapons keep firing; semi weapons need a fresh edge).
    if (this.input.fire && S.phase === 'live') {
      const w = weaponOf(p);
      if (w.auto || this.input.fireEdge) this.playerShoot();
    }
    this.input.fireEdge = false;
    // Hold E to plant while carrying the charge at a site.
    if (S.phase === 'live' && S.carrier === p && keys.KeyE) {
      const site = this.siteAt(p.body.position.x, p.body.position.z);
      if (site) {
        this.plantProgress += dt;
        if (this.plantProgress >= PLANT_SECONDS) {
          this.plantProgress = 0;
          this.plantCharge(p);
        }
      } else {
        this.plantProgress = 0;
      }
    } else {
      this.plantProgress = 0;
    }
  }

  /** The charge: pickup when dropped, carried position when held. */
  updateCharge(dt) {
    const S = this.state;
    const c = S.charge;
    if (c.status === 'dropped') {
      for (const a of this.actors) {
        if (a.team !== 'ember' || !a.alive) continue;
        const p = a.body.position;
        if (Math.hypot(p.x - c.x, p.z - c.z) < 1.3) {
          c.status = 'carried';
          S.carrier = a;
          a.carrier = true;
          if (a.isPlayer) this.hud.flashHint('Charge picked up — plant it at A or B');
          break;
        }
      }
    } else if (c.status === 'carried' && S.carrier) {
      const p = S.carrier.body.position;
      c.x = p.x;
      c.z = p.z;
    }
  }

  /** Push overlapping actors apart so bots never stand inside each other. */
  separateActors() {
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this.actors.length; j++) {
        const b = this.actors[j];
        if (!b.alive) continue;
        const pa = a.body.position;
        const pb = b.body.position;
        const dx = pb.x - pa.x;
        const dz = pb.z - pa.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 0.81 && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (0.9 - d) / 2;
          const nx = dx / d;
          const nz = dz / d;
          // A pure head-on push deadlocks: two bots walking into each
          // other approach exactly as fast as they are pushed apart,
          // so they sit nose to nose forever. A small lateral shove
          // (each bot to its own side of the line) lets them slide
          // past each other instead.
          const lat = 0.09;
          const px = -nz;
          const pz = nx;
          pa.x -= nx * push + px * lat;
          pa.z -= nz * push + pz * lat;
          pb.x += nx * push + px * lat;
          pb.z += nz * push + pz * lat;
        }
      }
    }
  }

  siteAt(x, z) {
    for (const [key, site] of Object.entries(SITES)) {
      if (Math.hypot(x - site.x, z - site.z) <= site.r) return key;
    }
    return null;
  }

  // ------------------------------------------------------------- combat

  refillAmmo(a) {
    const w = weaponOf(a);
    a.ammo = w.mag;
    a.reserve = w.reserve;
  }

  playerShoot() {
    const p = this.player;
    const S = this.state;
    if (S.phase !== 'live' || !p.alive) return null;
    if (S.time < p.reloadUntil) return null;
    if (p.ammo <= 0) {
      this.sounds.dryFire();
      this.reloadPlayer();
      return null;
    }
    if (!canFire(p, S.time)) return null;
    const w = weaponOf(p);
    const spread = currentSpread(p);
    const result = fireShot(this, p, p.body.yaw, p.body.pitch, spread);
    // Recoil kicks the aim up a touch; the player pulls it back down.
    p.body.pitch = Math.min(1.2, p.body.pitch + w.kick * 0.011);
    this.effects.viewmodelKick = 1;
    this.sounds.shot(p.weapon);
    this.noise(p.body.position.x, p.body.position.z);
    if (result.hit) {
      this.hud.hitmarker(result.headshot, result.killed);
      this.sounds.hit(result.headshot);
      if (result.killed) this.sounds.kill();
    }
    return result;
  }

  /** A bot fires at its target with distance-based aim error. */
  botShoot(bot, target, dist) {
    const tp = target.body.position;
    const bp = bot.body.position;
    // Aim at the chest; one shot in ten goes for the head.
    const head = this.rng.chance(0.1);
    const ty = tp.y + (head ? target.body.eye + 0.13 : target.body.eye - 0.35);
    const dx = tp.x - bp.x;
    const dy = ty - (bp.y + bot.body.eye);
    const dz = tp.z - bp.z;
    const baseYaw = Math.atan2(-dx, -dz);
    const basePitch = Math.atan2(dy, Math.hypot(dx, dz));
    // Error grows with range, target speed and the bot's own movement.
    // Duels stay winnable for a player who lands the first headshot.
    const errDeg = 1.3 + dist * 0.06 + target.moveAmount * 0.55 + bot.moveAmount * 0.7;
    const err = (errDeg * Math.PI) / 180;
    const yaw = baseYaw + this.rng.gauss() * err;
    const pitch = basePitch + this.rng.gauss() * err;
    const result = fireShot(this, bot, yaw, pitch, 0.35);
    const dPlayer = Math.hypot(bp.x - this.player.body.position.x, bp.z - this.player.body.position.z);
    this.sounds.shot('rifle', dPlayer > 12);
    this.noise(bp.x, bp.z);
    return result;
  }

  reloadPlayer() {
    const p = this.player;
    if (startReload(p, this.state.time)) {
      this.sounds.reload();
      this.effects.viewmodelDip = 1;
    }
  }

  reloadBot(bot) {
    startReload(bot, this.state.time);
  }

  throwGrenade() {
    const p = this.player;
    const S = this.state;
    if (S.phase !== 'live' || !p.alive || p.grenades <= 0) return false;
    p.grenades -= 1;
    const eye = this.tmpVec;
    p.eyePos(eye);
    p.forward(this.tmpVec2);
    const f = this.tmpVec2;
    const g = new Grenade(
      p,
      eye.x + f.x * 0.5, eye.y + f.y * 0.5, eye.z + f.z * 0.5,
      f.x * 11 + p.body.velocity.x, f.y * 11 + 3.2, f.z * 11 + p.body.velocity.z,
      GRENADE_FUSE,
    );
    this.grenades.push(g);
    this.sounds.click();
    return true;
  }

  /** A bot lobs its one grenade at a point (its flush-out throw). The
   *  arc is the player's arc — flat direction, up 3.2, speed 11 — so a
   *  bot grenade flies where a player would expect it to. */
  throwBotGrenade(bot, tx, tz) {
    const S = this.state;
    if (S.phase !== 'live' || !bot.alive || bot.grenades <= 0) return false;
    bot.grenades -= 1;
    const eye = this.tmpVec;
    bot.eyePos(eye);
    const dx = tx - eye.x;
    const dz = tz - eye.z;
    const d = Math.hypot(dx, dz) || 1;
    const g = new Grenade(
      bot,
      eye.x, eye.y, eye.z,
      (dx / d) * 11, 3.2, (dz / d) * 11,
      GRENADE_FUSE,
    );
    this.grenades.push(g);
    this.sounds.click();
    return true;
  }

  explodeGrenade(g) {
    this.effects.explosion(g.pos.x, g.pos.y, g.pos.z, GRENADE_RADIUS);
    this.sounds.explode();
    this.shake = 1;
    for (const a of this.actors) {
      if (!a.alive || a === g.owner) continue;
      const p = a.body.position;
      const d = Math.hypot(p.x - g.pos.x, p.z - g.pos.z);
      if (d > GRENADE_RADIUS) continue;
      if (losBlocked(g.pos.x, g.pos.z, p.x, p.z)) continue;
      const amount = Math.max(15, GRENADE_MAX_DAMAGE * (1 - d / GRENADE_RADIUS));
      const killed = a.damage(amount, this);
      this.onKillCheck(g.owner, a, killed);
    }
  }

  /** A gunshot at (x, z): nearby bots come and look. */
  noise(x, z) {
    for (const bot of this.bots) {
      if (bot.alive) this.brains.get(bot).hear(x, z);
    }
  }

  /**
   * Called by fireShot on every hit. Handles hurt feedback, the kill
   * feed, kill money and the charge dropping when its carrier dies.
   */
  onKillCheck(shooter, victim, killed) {
    if (victim.isPlayer) {
      this.sounds.tone(170, 0.12, 0.2, 90, 'sawtooth');
    }
    // Any damage interrupts a bot's defuse channel for a second.
    const brain = this.brains.get(victim);
    if (brain) brain.lastDamageAt = this.state.time;
    if (!killed) return;
    const wname = weaponOf(shooter).name;
    const sk = shooter.team === 'ember' ? 'ember' : 'slate';
    const vk = victim.team === 'ember' ? 'ember' : 'slate';
    this.hud.killfeed(`<b class="${sk}">${shooter.name}</b> <span class="dim">${wname} ▸</span> <b class="${vk}">${victim.name}</b>`);
    if (shooter.team === 'ember') {
      this.state.money.ember += KILL_MONEY;
    }
    if (victim.carrier) {
      victim.carrier = false;
      this.state.carrier = null;
      const p = victim.body.position;
      this.state.charge = { status: 'dropped', site: null, x: p.x, z: p.z, plantedAt: -99 };
      this.hud.killfeed('<span class="dim">The charge was dropped</span>');
    }
  }

  // ------------------------------------------------------------- objective

  plantCharge(actor) {
    const S = this.state;
    const p = actor.body.position;
    const site = this.siteAt(p.x, p.z);
    if (!site) return false;
    S.charge = { status: 'planted', site, x: SITES[site].x, z: SITES[site].z, plantedAt: S.time };
    S.carrier = null;
    actor.carrier = false;
    if (S.phase === 'live') S.timer = DETONATE_SECONDS;
    if (actor.team === 'ember') {
      S.money.ember += PLANT_MONEY;
      this.hud.killfeed(`<b class="ember">${actor.name}</b> <span class="dim">planted the charge at ${site} (+$${PLANT_MONEY})</span>`);
    }
    this.sounds.planted();
    this.hud.banner('CHARGE PLANTED', `Detonation in ${DETONATE_SECONDS}s — Slate must defuse`, 'planted');
    return true;
  }

  defuseCharge(actor) {
    const S = this.state;
    if (S.charge.status !== 'planted') return false;
    S.charge = { status: 'carried', site: null, x: 0, z: 0, plantedAt: -99 };
    this.hud.killfeed(`<b class="slate">${actor.name}</b> <span class="dim">defused the charge</span>`);
    this.endRound('slate', 'defuse');
    return true;
  }

  /** Nearest living Slate bot to the planted charge: the defuser. */
  defuser() {
    const c = this.state.charge;
    if (c.status !== 'planted') return null;
    let best = null;
    let bestD = Infinity;
    for (const bot of this.bots) {
      if (bot.team !== 'slate' || !bot.alive) continue;
      const p = bot.body.position;
      const d = (p.x - c.x) * (p.x - c.x) + (p.z - c.z) * (p.z - c.z);
      if (d < bestD) {
        bestD = d;
        best = bot;
      }
    }
    return best;
  }

  /** Nearest living Ember bot to the dropped charge: the fetcher. */
  fetcher() {
    const c = this.state.charge;
    if (c.status !== 'dropped') return null;
    let best = null;
    let bestD = Infinity;
    for (const bot of this.bots) {
      if (bot.team !== 'ember' || !bot.alive) continue;
      const p = bot.body.position;
      const d = (p.x - c.x) * (p.x - c.x) + (p.z - c.z) * (p.z - c.z);
      if (d < bestD) {
        bestD = d;
        best = bot;
      }
    }
    return best;
  }

  /** Plant/defuse progress for the HUD bar, or null. */
  channelProgress() {
    if (this.state.phase === 'live' && this.state.carrier === this.player && this.plantProgress > 0) {
      return { label: 'Planting charge…', frac: this.plantProgress / PLANT_SECONDS };
    }
    return null;
  }

  // ------------------------------------------------------------- economy

  buy(item) {
    const S = this.state;
    const p = this.player;
    if (S.phase !== 'buy') {
      this.sounds.denied();
      return false;
    }
    const price = item === 'armor'
      ? ARMOR_PRICE
      : item === 'grenade' ? GRENADE_PRICE : WEAPONS[item].price;
    if (S.money.ember < price) {
      this.sounds.denied();
      this.hud.flashHint('Not enough money');
      return false;
    }
    if (item === 'armor') {
      if (p.armor >= ARMOR_MAX) {
        this.sounds.denied();
        return false;
      }
      S.money.ember -= price;
      p.armor = ARMOR_MAX;
    } else if (item === 'grenade') {
      if (p.grenades >= 1) {
        this.sounds.denied();
        return false;
      }
      S.money.ember -= price;
      p.grenades = 1;
    } else {
      S.money.ember -= price;
      p.weapon = item;
      this.refillAmmo(p);
    }
    this.sounds.buy();
    this.hud.showBuy();
    return true;
  }

  // ------------------------------------------------------------- debug API

  money() {
    return this.state.money.ember;
  }

  /** One shot from the player's current aim. Returns the shot result. */
  fire() {
    return this.playerShoot();
  }

  /** Fast-forward the sim by `seconds` of fixed steps. */
  skip(seconds) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) this.step(DT);
  }

  /** Debug plant: instant, from a site, in buy or live (or between rounds). */
  plant() {
    const S = this.state;
    const p = this.player;
    if (S.carrier !== p) return false;
    if (S.phase !== 'buy' && S.phase !== 'live' && S.phase !== 'roundEnd') return false;
    if (!this.siteAt(p.body.position.x, p.body.position.z)) return false;
    if (S.phase === 'roundEnd') {
      this.plantNextRound = { site: this.siteAt(p.body.position.x, p.body.position.z), x: p.body.position.x, z: p.body.position.z };
      return true;
    }
    return this.plantCharge(p);
  }

  /** Debug warp: move the player, used by the harness and the shots. */
  warp(x, z) {
    this.player.body.position.set(x, 0, z);
    this.player.body.velocity.set(0, 0, 0);
  }

  // ------------------------------------------------------------- render

  /** Sync every mesh and the camera from the sim state. Render path only. */
  render() {
    const p = this.player;
    // Camera: the player's eyes, or a dead player's teammate.
    let eye = this.tmpVec;
    let yaw = p.body.yaw;
    let pitch = p.body.pitch;
    if (p.alive) {
      p.eyePos(eye);
    } else {
      const mate = this.actors.find((a) => a.team === 'ember' && a.alive && !a.isPlayer);
      if (mate) {
        mate.eyePos(eye);
        yaw = mate.body.yaw;
        pitch = mate.body.pitch;
      } else {
        eye.set(0, 14, 18);
        yaw = 0;
        pitch = -0.6;
      }
    }
    // Camera shake from the last explosion, decaying fast. Render-path
    // only: Math.random here keeps the sim's rng stream deterministic.
    this.shake = Math.max(0, this.shake - 0.03);
    const sh = this.shake * this.shake * 0.12;
    const shx = sh ? (Math.random() - 0.5) * sh : 0;
    const shy = sh ? (Math.random() - 0.5) * sh : 0;
    this.camera.position.set(eye.x + shx, eye.y + shy, eye.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(yaw);
    this.camera.rotateX(pitch);
    // The gun rides with the camera.
    if (!this.camera.children.includes(this.effects.viewmodel)) {
      this.camera.add(this.effects.viewmodel);
    }
    this.effects.viewmodel.visible = p.alive && this.state.phase !== 'menu';

    // Bots: position, facing, death fall.
    for (const bot of this.bots) {
      const g = this.meshes.get(bot);
      const pos = bot.body.position;
      g.position.set(pos.x, pos.y, pos.z);
      g.rotation.set(0, bot.body.yaw, 0);
      if (!bot.alive) {
        g.rotation.x = -bot.fall * Math.PI * 0.5;
        g.position.y = pos.y + bot.fall * 0.1;
      }
      g.visible = this.state.phase !== 'menu';
    }

    // The charge: visible when dropped or planted, blinking when planted.
    const c = this.state.charge;
    if (c.status === 'dropped' || c.status === 'planted') {
      this.chargeMesh.visible = true;
      this.chargeMesh.position.set(c.x, 0, c.z);
      const blink = c.status === 'planted' ? (Math.sin(this.state.time * 9) > 0 ? 0xff2e2e : 0x881111) : 0xff2e2e;
      this.chargeLight.material.color.setHex(blink);
    } else {
      this.chargeMesh.visible = false;
    }

    // Crosshair spread follows the live cone.
    const spreadPx = 4 + currentSpread(p) * 9;
    this.hud.setSpread(spreadPx);
  }

  // ------------------------------------------------------------- shot staging

  /**
   * Stage a deterministic frame for a screenshot (?shot=start|play|buy|end).
   * Runs the sim synchronously, then the loop renders it twice and freezes.
   */
  applyShot(mode) {
    if (mode === 'start') {
      // Menu over the yard: the camera sits at the south-east corner,
      // looking north-west down the west lane — containers, the Foundry
      // beam and the skyline in frame behind the title.
      this.player.body.position.set(14, 0, 19);
      this.player.body.yaw = 0.5;
      this.player.body.pitch = -0.05;
      return;
    }
    this.start();
    if (mode === 'buy') {
      this.hud.showBuy();
      return;
    }
    if (mode === 'play') {
      this.skip(BUY_SECONDS + 6);
      // A live firefight down the west lane, for the cover: the player
      // aims at Kite holding the mid container, Ash flanking left, and
      // a frag going off by the east containers. The GO banner is
      // cleared so the frame shows the fight, not the announcement.
      this.hud.hideBanner();
      const kite = this.bots[4];
      kite.alive = true;
      kite.health = 100;
      kite.fall = 0;
      kite.body.position.set(2, 0, -8);
      kite.body.yaw = Math.PI;
      const ash = this.bots[2];
      ash.alive = true;
      ash.health = 100;
      ash.fall = 0;
      ash.body.position.set(-8, 0, -2);
      ash.body.yaw = Math.PI * 0.75;
      this.player.health = 100;
      this.player.weapon = 'rifle';
      this.refillAmmo(this.player);
      this.warp(0, 6);
      const bp = kite.body.position;
      const pp = this.player.body.position;
      this.player.body.yaw = Math.atan2(-(bp.x - pp.x), -(bp.z - pp.z));
      this.player.body.pitch = 0.02;
      // A frag detonating by the east containers: the blast is still
      // expanding when the frame is taken, two renders later. Far from
      // every actor, so it is pure spectacle — nobody takes damage.
      this.explodeGrenade({ pos: new THREE.Vector3(10, 0.5, -8), owner: ash });
      return;
    }
    if (mode === 'end') {
      // Plant, clear the defenders, let the charge blow: the end banner.
      // The player keeps a believable 78 HP — a fighter who took a
      // graze on the way in, not an invulnerable debug number.
      this.warp(-15, -12);
      this.plant();
      for (const bot of this.bots) {
        if (bot.team === 'slate') {
          bot.alive = false;
          bot.fall = 1;
        }
      }
      this.player.health = 78;
      this.skip(DETONATE_SECONDS + 1.5);
      // Face the nearest fallen defender, so the frame holds the
      // planted site and the cost of taking it.
      const fallen = this.bots.find((b) => b.team === 'slate');
      if (fallen) {
        const fp = fallen.body.position;
        const pp = this.player.body.position;
        this.player.body.yaw = Math.atan2(-(fp.x - pp.x), -(fp.z - pp.z));
        this.player.body.pitch = -0.05;
      }
    }
  }
}
