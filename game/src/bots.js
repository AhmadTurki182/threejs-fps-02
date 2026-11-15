// bots.js — the bot brain: five teammates and opponents that play the
// round instead of walking it.
//
// Each bot thinks every 0.12 s (perception + objective) and acts every
// sim step (movement, bursts, channels). The brain's priorities, in
// order: win the round through the objective (plant, defuse, fetch the
// dropped charge), then fight what it can see, then hold its angle.
// A bot that has been duelling the same target for a while flanks —
// it breaks off to another lane and comes back from a new angle —
// and gunfire nearby draws a look, so a loud player gets investigated.
// Reaction time, burst fire and distance-based spread keep the bots
// beatable: the player who lands the first headshot wins the duel.

import {
  BOT_HEAR_RANGE, BOT_REACT_MAX, BOT_REACT_MIN, BOT_SIGHT_RANGE,
  DEFUSE_SECONDS, PLANT_SECONDS,
} from './config.js';
import { SITES, WAYPOINTS, findPath, losBlocked } from './world.js';
import { fireShot } from './weapons.js';

// Roles: what each bot is for. A role is a job, not a label — it sets
// how far the bot watches, how close it likes to fight, and how eager
// it is to push. The five bots are five different soldiers, not five
// copies of one brain:
//   assault   — Rook pushes with the charge carrier, close and fast.
//   flanker   — Vex works the wide lane and pincers a fighting teammate.
//   anchor    — Ash and Bramble hold their site and rarely leave it.
//   rear      — Kite guards the Slate spawn line and rotates to defuse.
const ROLES = {
  assault: { holdRange: 15, prefRange: 12, push: 1.0 },
  flanker: { holdRange: 18, prefRange: 16, push: 1.2 },
  anchor: { holdRange: 20, prefRange: 18, push: 0.5 },
  rear: { holdRange: 15, prefRange: 15, push: 0.3 },
};
const BOT_ROLES = { Rook: 'assault', Vex: 'flanker', Ash: 'anchor', Bramble: 'anchor', Kite: 'rear' };

// Cover nodes: waypoints beside a container, a crate stack or a wall,
// where a hurt bot can break contact and hold without standing in the
// open. The yard's fights happen around these points.
const COVER_NODES = [WAYPOINTS[4], WAYPOINTS[6], WAYPOINTS[7], WAYPOINTS[8], WAYPOINTS[13]];

// How long a bot keeps shooting at a spot it last saw an enemy.
const MEMORY_SECONDS = 3;
// A duel that lasts this long without a kill triggers a flank.
const FLANK_AFTER = 4;
// The lane junction each attacker funnels through on the way to its
// site: A via the west junction, B via the east junction. Defenders
// spawn next to their sites and do not need a lane.
const LANE = { A: WAYPOINTS[1], B: WAYPOINTS[3] };
// How far a bot strafes before flipping direction in a fight.
const STRAFE_FLIP_MIN = 1.1;
const STRAFE_FLIP_MAX = 2.4;

function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Distance from a point to a line segment. */
function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

export class BotBrain {
  constructor(bot, game) {
    this.bot = bot;
    this.game = game;
    this.mode = 'hold'; // route | hold | fight | plant | defuse | fetch | recover
    this.path = [];
    this.pathIdx = 0;
    this.target = null;
    this.reactionAt = -99;
    this.lastSeen = { x: 0, z: 0 };
    this.lastSeenAt = -99;
    this.lastDamageAt = -99;
    this.thinkAt = 0;
    this.holdNode = null; // { x, z } the bot is holding
    this.holdYaw = 0;
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.burstLeft = 0;
    this.nextShotAt = 0;
    this.fightSince = 0;
    this.flankAt = 0; // next time a flank is allowed
    this.investigate = null; // { x, z, until }
    this.plantProgress = 0;
    this.defuseProgress = 0;
    this.stuckPos = { x: 0, z: 0 };
    this.stuckSince = 0;
    this.roamIdx = 0;
    this.roamUntil = 0;
    // The bot's role sets its watch radius: an anchor watches 20 m out
    // from its site, an assault bot 15 m. The yard is small — the sites
    // sit 16 m from the Slate spawn line and the lanes pass 16 m from
    // mid — so a longer watch radius turns every neighbour into a
    // target and the defenders shoot each other across the map.
    this.role = ROLES[BOT_ROLES[bot.name] ?? 'anchor'];
    this.holdRange = this.role.holdRange;
    this.recoverUntil = 0; // until when a hurt bot stays in cover
    this.grenadeAt = 0; // next time a flush-out grenade is allowed
  }

  get site() {
    return this.bot.site;
  }

  // ------------------------------------------------------------ perception

  /** Nearest enemy the bot can actually see right now, or null. */
  perceive() {
    const b = this.bot;
    const p = b.body.position;
    let best = null;
    let bestD = BOT_SIGHT_RANGE * BOT_SIGHT_RANGE;
    for (const other of this.game.actors) {
      if (other === b || !other.alive || other.team === b.team) continue;
      const q = other.body.position;
      const d2 = dist2(p.x, p.z, q.x, q.z);
      if (d2 >= bestD) continue;
      if (losBlocked(p.x, p.z, q.x, q.z)) continue;
      best = other;
      bestD = d2;
    }
    if (best) {
      const q = best.body.position;
      this.lastSeen = { x: q.x, z: q.z };
      this.lastSeenAt = this.game.time;
      if (this.target !== best) {
        this.target = best;
        this.reactionAt = this.game.time + this.game.rng.range(BOT_REACT_MIN, BOT_REACT_MAX);
        this.fightSince = this.game.time;
        this.burstLeft = 0;
      }
    }
    return best;
  }

  /** Distance to the current target, or Infinity. */
  targetDist() {
    if (!this.target || !this.target.alive) return Infinity;
    const p = this.bot.body.position;
    const q = this.target.body.position;
    return Math.sqrt(dist2(p.x, p.z, q.x, q.z));
  }

  // ------------------------------------------------------------ objectives

  /** Pick what this bot should be doing. Runs on the think tick. */
  chooseObjective() {
    const g = this.game;
    const b = this.bot;
    const S = g.state;
    const charge = S.charge;

    // The round is over for bots once the phase leaves live/buy.
    if (S.phase !== 'live' && S.phase !== 'buy') {
      this.mode = 'hold';
      return;
    }

    // A hurt bot in cover stays in cover until its recover window
    // passes; the objective can wait three seconds for a soldier who
    // is still alive to fight it.
    if (this.mode === 'recover' && this.game.time < this.recoverUntil) return;

    if (charge.status === 'planted') {
      if (b.team === 'slate') {
        // Nearest living defender owns the defuse; the rest guard it.
        const defuser = g.defuser();
        if (defuser === b) {
          this.setPath(charge.x, charge.z);
          this.mode = 'defuse';
        } else {
          this.guardCharge();
        }
      } else {
        // Ember defends the planted charge from its own site.
        this.guardCharge();
      }
      return;
    }

    if (charge.status === 'dropped') {
      if (b.team === 'ember') {
        // Nearest living Ember fetches the charge; the other holds its site.
        if (g.fetcher() === b) {
          this.setPath(charge.x, charge.z);
          this.mode = 'fetch';
          return;
        }
      }
      this.goToSite();
      return;
    }

    // Charge carried: the carrier plants, everyone else takes a site.
    if (S.carrier === b) {
      const site = SITES[b.site];
      const p = b.body.position;
      if (dist2(p.x, p.z, site.x, site.z) < site.r * site.r) {
        this.mode = 'plant';
        this.path = [];
      } else {
        // Attackers take their lane to the site, never the middle.
        this.setPathVia(LANE[b.site].x, LANE[b.site].z, site.x, site.z);
        this.mode = 'route';
      }
      return;
    }

    if (this.role === ROLES.rear) {
      this.roam();
      return;
    }
    this.goToSite();
  }

  /** Hold near the planted charge, facing the likeliest approach. */
  guardCharge() {
    const g = this.game;
    const charge = g.state.charge;
    const p = this.bot.body.position;
    const d2 = dist2(p.x, p.z, charge.x, charge.z);
    if (d2 > 8 * 8) {
      this.setPath(charge.x + (p.x > charge.x ? 3 : -3), charge.z + 3);
      this.mode = 'route';
    } else {
      this.mode = 'hold';
      this.holdNode = { x: p.x, z: p.z };
      // Face the charge's approach lane (roughly south, toward mid).
      this.holdYaw = Math.atan2(-(charge.x - p.x), -(charge.z + 8 - p.z));
    }
  }

  /** Walk to this bot's assigned site, then hold it. */
  goToSite() {
    const site = SITES[this.bot.site];
    const p = this.bot.body.position;
    const d2 = dist2(p.x, p.z, site.x, site.z);
    if (d2 < 2.5 * 2.5) {
      this.mode = 'hold';
      this.holdNode = { x: site.x, z: site.z };
      // Face the approach: sites are north, so look south toward mid.
      this.holdYaw = Math.PI;
      this.path = [];
    } else if (this.bot.team === 'ember') {
      // Attackers take their lane junction to the site. A plain
      // shortest-path call ties between the mid route and the lane
      // route (both four hops), and the mid route walks the attackers
      // straight into the mid anchor's sights for no reason.
      this.setPathVia(LANE[this.bot.site].x, LANE[this.bot.site].z, site.x, site.z);
      this.mode = 'route';
    } else {
      this.setPath(site.x, site.z);
      this.mode = 'route';
    }
  }

  /** Kite's job: rear guard on the Slate spawn line at (0,-18), facing
   *  south down the yard. It sits 16 m from both site holds — outside
   *  every watch radius — so it never gets drawn into a duel it cannot
   *  win, and it never crosses the Ember lanes on the way to a mid
   *  anchor. When the charge is planted it rotates to defuse; when
   *  gunfire sounds nearby it goes to look. */
  roam() {
    const g = this.game;
    const p = this.bot.body.position;
    const anchor = { x: 0, z: -18 }; // the Slate spawn line
    if (Math.hypot(p.x - anchor.x, p.z - anchor.z) > 1.5) {
      this.setPath(anchor.x, anchor.z);
      this.mode = 'route';
      return;
    }
    this.mode = 'hold';
    this.holdNode = { x: anchor.x, z: anchor.z };
    // Face south, down the mid lane toward the Ember spawn.
    this.holdYaw = Math.PI;
    this.path = [];
  }

  /** True when the current path was built from somewhere else: after a
   *  warp the bot can sit metres from its route, and following the old
   *  nodes would walk it on a long detour. The test is the distance to
   *  the remaining ROUTE — the polyline from the leg the bot is on,
   *  not to a single node. A bot walking a long leg is legitimately
   *  metres from both ends of it; only a bot that has left the
   *  polyline entirely has been warped. */
  pathStale() {
    if (this.path.length === 0 || this.pathIdx >= this.path.length) return false;
    const p = this.bot.body.position;
    const start = Math.max(0, this.pathIdx - 1);
    if (this.path.length - start < 2) {
      const n = this.path[this.path.length - 1];
      return Math.hypot(n.x - p.x, n.z - p.z) > 6;
    }
    let nearest = Infinity;
    for (let i = start; i < this.path.length - 1; i++) {
      const a = this.path[i];
      const b = this.path[i + 1];
      const d = distToSegment(p.x, p.z, a.x, a.z, b.x, b.z);
      if (d < nearest) nearest = d;
    }
    return nearest > 6;
  }

  setPath(x, z) {
    const last = this.path[this.path.length - 1];
    const sameDest = last && Math.abs(last.x - x) < 0.5 && Math.abs(last.z - z) < 0.5 && this.path.length > 0;
    if (sameDest && !this.pathStale()) return;
    const p = this.bot.body.position;
    this.path = findPath(p.x, p.z, x, z);
    this.pathIdx = 0;
  }

  /** Path to a destination through a forced waypoint (a lane junction).
   *  findPath returns waypoints ending with the exact destination, so
   *  the two legs join cleanly with no duplicated node. */
  setPathVia(viaX, viaZ, destX, destZ) {
    const last = this.path[this.path.length - 1];
    const sameDest = last && Math.abs(last.x - destX) < 0.5 && Math.abs(last.z - destZ) < 0.5 && this.path.length > 0;
    if (sameDest && !this.pathStale()) return;
    const p = this.bot.body.position;
    const leg1 = findPath(p.x, p.z, viaX, viaZ);
    const leg2 = findPath(viaX, viaZ, destX, destZ);
    this.path = leg1.concat(leg2);
    this.pathIdx = 0;
  }

  // ------------------------------------------------------------ acting

  update(dt) {
    const g = this.game;
    const b = this.bot;
    if (!b.alive) return;
    const now = g.time;

    // Bots only play while the round is live. During the buy phase they
    // hold at spawn with the player; between rounds they stand down.
    if (g.state.phase !== 'live') {
      b.body.velocity.x = 0;
      b.body.velocity.z = 0;
      return;
    }

    // Think tick: perception + objective, a few times a second.
    if (now >= this.thinkAt) {
      this.thinkAt = now + 0.12;
      const seen = this.perceive();
      if (this.target && !this.target.alive) this.target = null;
      this.chooseObjective();
      // Flush-out grenade: the enemy is dug in behind cover and has
      // not shown itself for a while — lob a frag at its last known
      // spot. Only the memory counts (never the live position), and
      // only inside 22 m, so a bot cannot snipe a grenade across the
      // map at someone it has never seen.
      if (this.target && this.target.alive && b.grenades > 0 && now >= this.grenadeAt) {
        const p = b.body.position;
        const ld = Math.hypot(this.lastSeen.x - p.x, this.lastSeen.z - p.z);
        if (now - this.lastSeenAt > 2.5 && ld > 4 && ld < 22) {
          if (g.throwBotGrenade(b, this.lastSeen.x, this.lastSeen.z)) this.grenadeAt = now + 15;
        }
      }
      // A fresh noise report sends a holding bot to have a look.
      if (this.investigate && this.mode === 'hold' && !seen) {
        if (now < this.investigate.until) {
          this.setPath(this.investigate.x, this.investigate.z);
          this.mode = 'route';
        } else {
          this.investigate = null;
        }
      }
    }

    const seenRecently = now - this.lastSeenAt < 0.3;
    // Hurt and exposed: below 40 HP the bot breaks contact, falls back
    // to the nearest cover node, and holds there for a few seconds
    // instead of standing in the open to die. A bot that survives a
    // duel comes back — a bot that never retreats never learns.
    if (b.health < 40 && this.mode !== 'recover' && now - this.lastDamageAt < 1.0 && now >= this.recoverUntil) {
      const p = b.body.position;
      let cover = COVER_NODES[0];
      let bestD = Infinity;
      for (const n of COVER_NODES) {
        const d = (n.x - p.x) * (n.x - p.x) + (n.z - p.z) * (n.z - p.z);
        if (d < bestD) {
          bestD = d;
          cover = n;
        }
      }
      this.setPath(cover.x, cover.z);
      this.mode = 'recover';
      this.recoverUntil = now + 3;
      this.target = null;
    }
    // Engagement range depends on the job: a bot on the move only
    // duels close enemies (it has somewhere to be), a bot holding an
    // angle watches further out, and a bot already fighting — or one
    // that just took fire — answers at full range.
    const tookFire = now - this.lastDamageAt < 1.5;
    let fightRange = this.holdRange;
    if (this.mode === 'route' || this.mode === 'fetch') fightRange = 15;
    if (this.mode === 'fight' || tookFire) fightRange = 30;
    const enemyNear = this.target && seenRecently && this.targetDist() < fightRange;

    // Plant / defuse channels: standing still, hands busy. A close enemy
    // breaks the channel into a fight; a distant one is ignored — the
    // objective is worth more than a potshot at 25 metres.
    if (this.mode === 'plant' && b.carrier) {
      if (enemyNear && this.targetDist() < 12) {
        this.mode = 'fight';
      } else {
        this.plantProgress += dt;
        b.body.velocity.x = 0;
        b.body.velocity.z = 0;
        if (this.plantProgress >= PLANT_SECONDS) {
          this.plantProgress = 0;
          g.plantCharge(b);
        }
        return;
      }
    }
    if (this.mode === 'defuse') {
      const charge = g.state.charge;
      const p = b.body.position;
      const d2 = dist2(p.x, p.z, charge.x, charge.z);
      if (d2 < 2.5 * 2.5) {
        if (enemyNear && this.targetDist() < 10) {
          this.mode = 'fight';
        } else if (now - this.lastDamageAt > 1) {
          // Taking fire interrupts the defuse; the progress holds.
          this.defuseProgress += dt;
          b.body.velocity.x = 0;
          b.body.velocity.z = 0;
          if (this.defuseProgress >= DEFUSE_SECONDS) {
            this.defuseProgress = 0;
            g.defuseCharge(b);
          }
          return;
        }
      } else {
        // Not at the charge yet: walk the path to it instead of
        // standing still in 'defuse' mode.
        this.followPath(dt);
        return;
      }
    }

    // Fight: a visible enemy inside 30 m. Strafe, keep a preferred
    // range, and shoot in bursts once the reaction delay has passed.
    if (enemyNear && (this.mode === 'fight' || this.mode === 'route' || this.mode === 'hold' || this.mode === 'fetch')) {
      const d = this.targetDist();
      if (this.mode !== 'fight') {
        this.mode = 'fight';
        this.fightSince = now;
      }
      // A long duel means the angle is dead: flank to another lane.
      // Pincer: if a teammate is fighting the same target, flank down
      // the lane opposite the teammate's lane, so the target gets shot
      // from two directions at once. Otherwise take any open lane.
      if (now - this.fightSince > FLANK_AFTER && now >= this.flankAt) {
        this.flankAt = now + 6;
        this.fightSince = now;
        const mate = this.game.actors.find((a) => a !== this.bot && a.team === this.bot.team
          && a.alive && a.mode === 'fight' && a.target === this.target);
        const lane = mate
          ? (mate.body.position.x < 0 ? WAYPOINTS[3] : WAYPOINTS[1])
          : this.game.rng.pick([WAYPOINTS[5], WAYPOINTS[13], WAYPOINTS[2]]);
        this.setPath(lane.x, lane.z);
        this.mode = 'route';
        return;
      }
      this.fightMove(dt, d);
      this.fightShoot(dt, d);
      return;
    }

    // No live target: follow the objective path, or hold the angle.
    // A recovering bot walks its cover path the same way a routing bot
    // walks its objective path; arriving at cover drops it to 'hold'.
    if (this.mode === 'route' || this.mode === 'fetch' || this.mode === 'recover') {
      this.followPath(dt);
      return;
    }
    if (this.mode === 'hold') {
      b.body.velocity.x = 0;
      b.body.velocity.z = 0;
      // Slow scan across the lane, so a hold reads as watching, not idle.
      const sway = Math.sin(now * 0.5 + b.name.length) * 0.35;
      b.body.yaw = this.holdYaw + sway;
      return;
    }

    // Target remembered but not seen: a holding bot suppresses the last
    // known spot instead of pushing — it owns this angle. A bot with
    // somewhere to be pushes to the last known spot instead.
    if (this.target && now - this.lastSeenAt < MEMORY_SECONDS) {
      if (this.mode === 'hold' && now - this.lastSeenAt > 1.5) {
        this.suppressShoot(dt);
        return;
      }
      this.setPath(this.lastSeen.x, this.lastSeen.z);
      this.mode = 'route';
      this.followPath(dt);
    }
  }

  /** Strafe + range control while fighting. */
  fightMove(dt, d) {
    const g = this.game;
    const b = this.bot;
    const now = g.time;
    if (now >= this.strafeUntil) {
      this.strafeDir = -this.strafeDir;
      this.strafeUntil = now + g.rng.range(STRAFE_FLIP_MIN, STRAFE_FLIP_MAX);
    }
    const t = this.target.body.position;
    const p = b.body.position;
    // Face the target.
    b.body.yaw = Math.atan2(-(t.x - p.x), -(t.z - p.z));
    // Strafe perpendicular, drift toward the role's preferred range:
    // an assault bot closes to 12 m, an anchor holds its 18 m line.
    const pref = this.role.prefRange;
    const fx = (t.x - p.x) / (d || 1);
    const fz = (t.z - p.z) / (d || 1);
    const px = -fz * this.strafeDir;
    const pz = fx * this.strafeDir;
    let wx = px;
    let wz = pz;
    if (d > pref + 6) {
      wx += fx * 0.7;
      wz += fz * 0.7;
    } else if (d < pref - 6) {
      wx -= fx * 0.7;
      wz -= fz * 0.7;
    }
    const len = Math.hypot(wx, wz) || 1;
    b.move(dt, wx / len, wz / len, b.speed * 0.62);
  }

  /** Burst fire at the current target. */
  fightShoot(dt, d) {
    const g = this.game;
    const b = this.bot;
    const now = g.time;
    if (now < this.reactionAt || now < b.reloadUntil) return;
    if (now < this.nextShotAt) return;
    if (this.burstLeft <= 0) {
      this.burstLeft = g.rng.int(3, 5);
      this.nextShotAt = now + g.rng.range(0.7, 1.2);
      return;
    }
    // Reload mid-fight when the mag runs dry.
    if (b.ammo <= 0) {
      g.reloadBot(b);
      this.burstLeft = 0;
      return;
    }
    g.botShoot(b, this.target, d);
    this.burstLeft -= 1;
    this.nextShotAt = now + 60 / 480;
  }

  /** Suppressive fire at the last known spot. The enemy is gone behind
   *  cover, but the bot knows where — it hoses the cover edge in short
   *  bursts so the enemy cannot sit there and heal. Volume, not
   *  precision: a wider cone than aimed fire, and no noise call (the
   *  shots themselves are the message). */
  suppressShoot(dt) {
    const g = this.game;
    const b = this.bot;
    const now = g.time;
    if (now < this.reactionAt || now < b.reloadUntil) return;
    if (now < this.nextShotAt) return;
    if (this.burstLeft <= 0) {
      this.burstLeft = g.rng.int(2, 3);
      this.nextShotAt = now + g.rng.range(0.8, 1.4);
      return;
    }
    if (b.ammo <= 0) {
      g.reloadBot(b);
      this.burstLeft = 0;
      return;
    }
    const bp = b.body.position;
    const dx = this.lastSeen.x - bp.x;
    const dz = this.lastSeen.z - bp.z;
    const yaw = Math.atan2(-dx, -dz) + g.rng.gauss() * 0.02;
    const pitch = g.rng.gauss() * 0.015;
    fireShot(g, b, yaw, pitch, 1.2);
    this.burstLeft -= 1;
    this.nextShotAt = now + 60 / 480;
  }

  /** Walk the current path, one node at a time. */
  followPath(dt) {
    const b = this.bot;
    if (this.pathIdx >= this.path.length) {
      this.path = [];
      return;
    }
    const p = b.body.position;
    // Shortcut: if the bot is already closer to a later node than to
    // the node it is heading for — a warp, a shove, a flank that cut
    // the corner — skip ahead instead of walking back along the route
    // it already passed.
    let node = this.path[this.pathIdx];
    let d = Math.hypot(node.x - p.x, node.z - p.z);
    for (let i = this.pathIdx + 1; i < this.path.length; i++) {
      const n = this.path[i];
      const dd = Math.hypot(n.x - p.x, n.z - p.z);
      if (dd < d - 1) {
        this.pathIdx = i;
        node = n;
        d = dd;
      }
    }
    if (d < 1.1) {
      this.pathIdx += 1;
      if (this.pathIdx >= this.path.length) {
        // Arrived: hold here (or re-decide next think tick).
        this.path = [];
        this.mode = 'hold';
        this.holdNode = { x: node.x, z: node.z };
        this.holdYaw = b.body.yaw;
      }
      return;
    }
    const dx = node.x - p.x;
    const dz = node.z - p.z;
    b.body.yaw = Math.atan2(-dx, -dz);
    b.move(dt, dx / d, dz / d, b.speed);
    // Stuck guard: no progress along the route for 3 s means the path
    // is blocked — skip the node instead of grinding against a wall.
    const moved = dist2(p.x, p.z, this.stuckPos.x, this.stuckPos.z);
    if (moved > 0.25) {
      this.stuckPos = { x: p.x, z: p.z };
      this.stuckSince = this.game.time;
    } else if (this.game.time - this.stuckSince > 3) {
      this.pathIdx += 1;
      this.stuckPos = { x: p.x, z: p.z };
      this.stuckSince = this.game.time;
    }
  }

  /** A gunshot nearby: come and look, unless busy with the objective. */
  hear(x, z) {
    const p = this.bot.body.position;
    if (dist2(p.x, p.z, x, z) > BOT_HEAR_RANGE * BOT_HEAR_RANGE) return;
    if (this.mode === 'plant' || this.mode === 'defuse' || this.mode === 'fight') return;
    this.investigate = { x, z, until: this.game.time + 6 };
  }
}
