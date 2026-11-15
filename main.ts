// main.ts — IRONLINE's entry program (Node 22, standard library only).
//
// It hands the game in: game/ (static ES modules, three.js vendored)
// and screenshots/ (four renders of the game's own code) are copied
// beside this file into /output, and /output/dossier.json is written
// with the kit's buildDossier, the summary the judge reads.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output.
// Serve the game locally with `node serve.ts`, then open
// http://localhost:8080.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// The scorer's own caps (the kit's reference/gate.json): only
// text_max_bytes shapes the dossier's bytes; the rest refuse an entry
// the scorer would refuse — more than 4 screenshots or one over
// 256 KiB, more than 993 entries in game/ or 48 MiB of game files.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
  }),
);
