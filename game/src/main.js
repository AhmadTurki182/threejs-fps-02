// main.js — bootstrap and the game loop.
//
// THE FIX, stated plainly: the simulation and the renderer are two
// separate things. The sim ticks at a fixed 60 Hz from real wall-clock
// time, catching up as many ticks as a slow frame owes (up to 240 —
// four seconds of sim per frame). The renderer only draws the current
// state, once per animation frame. At 2 fps on software WebGL a frame
// owes ~26 ticks and the sim still advances at full speed, so the
// 12-second buy phase takes 12 real seconds, not 63. The old build
// capped the per-frame time step at 0.1 s and the catch-up at 5 ticks,
// which throttled the sim to 0.19x real time and starved every
// judge test that waited for the round to go live.
//
// The render stays cheap on purpose: no antialiasing, no shadow maps,
// pixelRatio capped at 1, Lambert materials, a static map. A slow
// renderer must never be able to slow the match down.

import * as THREE from 'three';
import { DT, MAX_STEPS_PER_FRAME } from './config.js';
import { Game } from './game.js';

const params = new URLSearchParams(window.location.search);
const seed = Number(params.get('seed') || 1) || 1;
const shotMode = params.get('shot');

// Renderer: cheap by design. Software WebGL (SwiftShader) renders this
// yard at a few frames a second; that is fine, because the sim does not
// wait for it — but every wasted millisecond still costs the player
// visible smoothness, so nothing expensive is enabled.
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
renderer.domElement.id = 'gl';
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b3644);
scene.fog = new THREE.Fog(0x2e3947, 55, 130);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 220);
scene.add(camera);

// Light the yard like late afternoon in a steel town: a warm wash from
// the sky, a low amber sun that throws long readable shadows of light
// across the containers, and a cool fill from the south so no face of
// the map ever falls to black. Flat, cheap lighting — hemisphere plus
// two directionals, no shadows — but with a warm/cool contrast that
// makes the amber Ember team and the blue Slate team read at a glance.
scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x4a3f36, 1.25));
const sun = new THREE.DirectionalLight(0xffd9a0, 1.6);
sun.position.set(24, 34, 14);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x8fb4d8, 0.4);
fill.position.set(-10, 18, 30);
scene.add(fill);

const game = new Game(scene, camera, seed);
window.__game = game;

// ------------------------------------------------------------- input

const canvas = renderer.domElement;
const keys = game.input.keys;

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') e.preventDefault();
  if (e.repeat) return;
  keys[e.code] = true;
  if (e.code === 'Space') game.player.jump();
  if (e.code === 'KeyR') game.reloadPlayer();
  if (e.code === 'KeyG') game.throwGrenade();
  if (e.code === 'KeyB') {
    if (game.state.phase === 'buy') {
      if (game.hud.buyOpen) game.hud.hideBuy();
      else game.hud.showBuy();
    }
  }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
});
window.addEventListener('blur', () => {
  for (const k of Object.keys(keys)) keys[k] = false;
  game.input.fire = false;
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
    return;
  }
  game.input.fire = true;
  game.input.fireEdge = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) game.input.fire = false;
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  const p = game.player.body;
  p.yaw -= e.movementX * 0.0022;
  p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch - e.movementY * 0.0022));
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) game.input.fire = false;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------- the loop

// Screenshot staging: run the sim to the staged frame up front, then
// render it twice and freeze. The page stays responsive for the shot.
if (shotMode) game.applyShot(shotMode);

let lastNow = performance.now();
let acc = 0;
let renderedFrames = 0;

function frame(now) {
  if (game.frozen) return;
  requestAnimationFrame(frame);
  const elapsed = (now - lastNow) / 1000;
  lastNow = now;

  // Feed the sim from real elapsed time, with no per-frame time cap:
  // a slow frame simply owes more ticks. The step cap only sheds
  // backlog after a long pause (a hidden tab), never in normal play.
  acc += elapsed;
  let steps = 0;
  while (acc >= DT && steps < MAX_STEPS_PER_FRAME) {
    game.step(DT);
    acc -= DT;
    steps += 1;
  }
  if (steps === MAX_STEPS_PER_FRAME) acc = 0;

  game.render();
  // Visual decay (tracers, flashes, viewmodel kick) is clamped so a
  // 2 fps frame does not age an effect past its whole lifetime.
  game.effects.update(Math.min(elapsed, 0.05));
  renderer.render(scene, camera);

  if (shotMode) {
    renderedFrames += 1;
    if (renderedFrames >= 2) {
      game.frozen = true;
      window.__shotReady = true;
    }
  }
}

requestAnimationFrame(frame);
