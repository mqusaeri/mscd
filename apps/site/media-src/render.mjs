#!/usr/bin/env node
// Renders the hero film of the landing site from thread.html and encodes it.
//
//   node apps/site/media-src/render.mjs                 full render into apps/site/assets/media
//   node apps/site/media-src/render.mjs --preview 120   one PNG frame into the work folder
//
// Output: thread.mp4 (H.264), thread.webm (VP9) and thread-poster.jpg.
// Needs ffmpeg on the PATH and @playwright/test with Chromium (as the site check).
/* global window */
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../assets/media');
const W = 1920;
const H = 1080;
const FPS = 24;
const SECONDS = 12;
const FRAMES = FPS * SECONDS;
const POSTER_FRAME = 132;

const args = process.argv.slice(2);
const previewIdx = args.indexOf('--preview');
const preview = previewIdx >= 0 ? Number(args[previewIdx + 1] ?? POSTER_FRAME) : null;
const work = mkdtempSync(join(tmpdir(), 'mscd-thread-'));

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} failed with status ${r.status}`);
}

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const url = pathToFileURL(join(here, 'thread.html')).href + `?w=${W}&h=${H}&frames=${FRAMES}`;
  await page.goto(url);
  await page.waitForFunction(() => window.ready === true);
  const frames = preview === null ? [...Array(FRAMES).keys()] : [preview];
  const started = Date.now();
  for (const i of frames) {
    const dataUrl = await page.evaluate((n) => window.renderFrame(n), i);
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    writeFileSync(join(work, `f${String(i).padStart(4, '0')}.png`), png);
    if (i % 24 === 0) {
      const s = ((Date.now() - started) / 1000).toFixed(0);
      process.stdout.write(`frame ${i + 1} of ${frames.length}, ${s} s\n`);
    }
  }
} finally {
  await browser.close();
}

if (preview !== null) {
  process.stdout.write(`Preview frame: ${join(work, `f${String(preview).padStart(4, '0')}.png`)}\n`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const input = ['-y', '-framerate', String(FPS), '-i', join(work, 'f%04d.png')];
run('ffmpeg', [...input, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-profile:v', 'high',
  '-pix_fmt', 'yuv420p', '-g', String(FPS * 2), '-movflags', '+faststart', join(outDir, 'thread.mp4')]);
run('ffmpeg', [...input, '-an', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1',
  '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', join(outDir, 'thread.webm')]);
run('ffmpeg', ['-y', '-i', join(work, `f${String(POSTER_FRAME).padStart(4, '0')}.png`),
  '-q:v', '3', join(outDir, 'thread-poster.jpg')]);
for (const f of ['thread.mp4', 'thread.webm', 'thread-poster.jpg']) {
  const mb = statSync(join(outDir, f)).size / 1e6;
  process.stdout.write(`${f}: ${mb.toFixed(2)} MB\n`);
}
rmSync(work, { recursive: true, force: true });
