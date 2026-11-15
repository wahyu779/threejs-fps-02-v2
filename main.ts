// main.ts — Pelabuhan Senja v2 entry program (Node 22, stdlib only).
//
// The hand-in step: copy this repo's game/ (the playable harbour FPS) and
// screenshots/ (real renders of it) into the output directory, then write
// dossier.json with the kit's vendored buildDossier — the exact summary the
// judge reads. Run it twice and the bytes must match: the program copies
// files and builds the dossier deterministically, no timestamps inside.
//
// Local check:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// In the grader the output directory is /output.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(outputDir, { recursive: true });
cpSync(join(repoRoot, 'game'), join(outputDir, 'game'), { recursive: true });
mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), join(outputDir, 'screenshots'), { recursive: true });
}

// Gate caps from the kit's reference/gate.json: the dossier text the judge
// reads is capped at 160 KiB; at most 4 screenshots of 256 KiB each; game/
// at most 993 entries and 48 MiB in all.
const dossier = buildDossier(outputDir, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);
