// rng.js — a tiny deterministic random source for IRONLINE.
//
// The whole match runs off one mulberry32 stream seeded from the URL
// (?seed=N, default 1). Bot decisions, spread rolls and round assignments
// all draw from it, so a match with the same seed and the same inputs
// plays out the same way twice — the debug harness and the screenshots
// lean on that.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    // Uniform float in [min, max).
    range(min, max) {
      return min + next() * (max - min);
    },
    // Uniform integer in [min, max].
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    // True with probability p.
    chance(p) {
      return next() < p;
    },
    // One element of an array.
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
    // Box-Muller-ish normal, mean 0, spread ~1, clamped to [-2, 2].
    gauss() {
      const v = (next() + next() + next() - 1.5) * 1.15;
      return Math.max(-2, Math.min(2, v));
    },
  };
}
