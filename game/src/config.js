// config.js — every number that tunes IRONLINE lives here, in one place.
//
// The sim runs on a fixed step (DT) that is deliberately kept apart from
// rendering: main.js feeds the sim from real wall-clock time, so the match
// advances at full speed even when the renderer is crawling at 2 fps on
// software WebGL. Nothing in here caps the sim — see main.js.

// Fixed-step simulation: 60 ticks a second, the heartbeat of the match.
export const DT = 1 / 60;
// How many sim ticks one rendered frame may catch up at most (4 s of sim).
// At ~2 fps a frame owes ~26 ticks, so this cap never binds in practice —
// it only sheds backlog after a long tab switch instead of spiralling.
export const MAX_STEPS_PER_FRAME = 240;

// Round flow, in sim seconds.
export const BUY_SECONDS = 12; // buy phase before each round goes live
export const LIVE_SECONDS = 100; // live round clock when the charge is not planted
export const DETONATE_SECONDS = 35; // countdown once the charge is planted
export const ROUND_END_SECONDS = 4; // banner pause between rounds
export const ROUNDS_TO_WIN = 5; // first to 5 takes the match
export const MAX_ROUNDS = 9; // hard cap, so a match always ends
export const PLANT_SECONDS = 3; // hold E at a site to plant
export const DEFUSE_SECONDS = 5; // hold E at the charge to defuse

// Economy, in dollars.
export const START_MONEY = 800;
export const WIN_MONEY = 3250;
export const LOSS_MONEY = 1900;
export const KILL_MONEY = 300;
export const PLANT_MONEY = 300;

// Movement, in metres / seconds.
export const PLAYER_SPEED = 5.2;
export const PLAYER_CROUCH_SPEED = 2.6;
export const BOT_SPEED = 4.6;
export const JUMP_SPEED = 6.5;
export const GRAVITY = 18;
export const ACTOR_RADIUS = 0.45;
export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.1;

// Bot senses.
export const BOT_SIGHT_RANGE = 30; // metres, line of sight required
export const BOT_HEAR_RANGE = 18; // metres, gunfire draws a look
export const BOT_REACT_MIN = 0.25; // seconds before a bot's first shot
export const BOT_REACT_MAX = 0.6;

// Weapons. damage is the body-shot value at close range; headMul applies
// to head hits; falloff shrinks damage past falloffStart. spread is the
// standing hip-fire cone in degrees; moving and firing grow it.
export const WEAPONS = {
  pistol: {
    name: 'P9 Sidearm', price: 0, damage: 34, headMul: 2.0,
    rpm: 300, mag: 12, reserve: 36, spread: 0.55, auto: false,
    reload: 1.15, kick: 0.55, falloffStart: 22, falloffMin: 0.75,
  },
  smg: {
    name: 'VK-9 Ripper', price: 1500, damage: 26, headMul: 2.0,
    rpm: 750, mag: 30, reserve: 90, spread: 1.05, auto: true,
    reload: 1.9, kick: 0.5, falloffStart: 18, falloffMin: 0.6,
  },
  rifle: {
    name: 'AR-77 Longline', price: 2700, damage: 33, headMul: 2.0,
    rpm: 600, mag: 30, reserve: 90, spread: 0.65, auto: true,
    reload: 2.1, kick: 0.8, falloffStart: 30, falloffMin: 0.8,
  },
  sniper: {
    name: 'LR-50 Deadeye', price: 4750, damage: 88, headMul: 2.0,
    rpm: 55, mag: 5, reserve: 15, spread: 0.12, auto: false,
    reload: 3.0, kick: 2.4, falloffStart: 40, falloffMin: 0.9,
  },
};

// The bots' rifle: same shape as the player's rifle, a touch softer so a
// fair duel still favours the player who lands the first headshot.
export const BOT_WEAPON = {
  name: 'Slate Rifle', price: 0, damage: 22, headMul: 2.0,
  rpm: 480, mag: 30, reserve: 9999, spread: 1.4, auto: true,
  reload: 2.0, kick: 0.4, falloffStart: 25, falloffMin: 0.7,
};

export const ARMOR_PRICE = 650;
export const ARMOR_MAX = 50; // armour points; absorbs half of each hit
export const GRENADE_PRICE = 300;
export const GRENADE_FUSE = 1.6; // seconds after the throw
export const GRENADE_RADIUS = 6; // metres
export const GRENADE_MAX_DAMAGE = 100;

// Palette: rusted amber for Ember, cold slate blue for the defenders,
// hazard yellow for the yard itself.
export const PALETTE = {
  ember: 0xff8c2e,
  emberDark: 0xb35c12,
  slate: 0x5b8fd6,
  slateDark: 0x2e4a6b,
  hazard: 0xf5c518,
  ground: 0x3d3a36,
  wall: 0x4a4640,
  fog: 0x232a33,
  sky: 0x2b3644,
};
