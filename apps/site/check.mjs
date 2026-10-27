#!/usr/bin/env node
// Quality check of the landing site (MOT-01). Serves apps/site on a free local port, opens both
// languages at 1440x900, 740x360, 390x844, 360x800 and 320x640 in light and dark, saves
// screenshots, and fails on:
//   a request to another origin, horizontal overflow, text cut off by a clipping box, text under
//   12px, text contrast under 4.5:1 (background sampled at the text position, over several frames
//   of the hero film), a missing <title> or meta description, console errors, broken media (the
//   H.264 file is checked on disk, because Playwright's Chromium cannot decode it), links that
//   differ from site.config.mjs, labels of the chain rows set closer to each other than the space
//   inside one label (at the five sizes and at every width from 320 to 1440 px), and, with reduced
//   motion, any running animation, loop or video.
//
//   node apps/site/check.mjs [--out <folder for screenshots>] [--only en|id]
// The functions passed to page.evaluate run in the browser, so they use its globals.
/* global window, document, NodeFilter, getComputedStyle, requestAnimationFrame, scrollX, scrollY, innerHeight, Image */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, DEMO_EMAIL } from './site.config.mjs';
import { applyConfig, PAGES as PAGE_FILES } from './apply-config.mjs';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}
const { chromium } = await import('@playwright/test');

const SITE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = resolve(outArg >= 0 ? args[outArg + 1] : join(tmpdir(), 'mscd-site-check'));
mkdirSync(OUT, { recursive: true });

const MIN_FONT_PX = 12;
const MIN_CONTRAST = 4.5;
const FILM_TIMES = [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5];
const onlyArg = args.indexOf('--only');
const PAGES = [
  { name: 'en', path: '/', lang: 'en' },
  { name: 'id', path: '/id/', lang: 'id' },
].filter((p) => onlyArg < 0 || p.name === args[onlyArg + 1]);
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  // A phone held sideways: the shortest hero, and the 641 to 760 px layout (film band, chain in rows).
  { name: 'landscape', width: 740, height: 360, isMobile: true, hasTouch: true },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
  // 360 CSS px is the most common Android width.
  { name: 'small', width: 360, height: 800, isMobile: true, hasTouch: true },
  // 320 CSS px is the WCAG reflow width and the narrowest phone in use.
  { name: 'narrow', width: 320, height: 640, isMobile: true, hasTouch: true },
];
const SCHEMES = ['light', 'dark'];
// Rows of short labels with no box around each label. The space between two labels must be
// clearly larger than the space inside one label ("04" and "Document"), or a row such as
// "04 Document 05 Evidence" reads as "04 Document05 Evidence".
const LABEL_ROWS = ['.chain__list', '.hs__chain'];
const LABEL_GAP_FACTOR = 1.5;
const MIN_LABEL_GAP = 12;
const SWEEP = { from: 320, to: 1440, step: 4 };

const failures = [];
const fail = (where, message) => failures.push(`[${where}] ${message}`);
const log = (s) => process.stdout.write(`${s}\n`);

// ---------- Static server with range support (video needs it) ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
};
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = normalize(join(SITE, decodeURIComponent(url.pathname)));
  if (file !== SITE && !file.startsWith(SITE + sep)) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: `${url.pathname}/` }).end(); return; }
    file = join(file, 'index.html');
  }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
  const size = statSync(file).size;
  const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
log(`Serving ${SITE} at ${ORIGIN}`);

// ---------- Static checks of the configured links ----------
for (const page of PAGE_FILES) {
  if (!existsSync(join(SITE, page))) { fail(page, 'page is missing'); continue; }
  const html = readFileSync(join(SITE, page), 'utf8');
  if (applyConfig(html) !== html) fail(page, 'links differ from site.config.mjs: run node apps/site/apply-config.mjs');
}

// ---------- Media files on disk ----------
// Playwright's Chromium has no H.264 decoder, so it plays the WebM and never opens the MP4 that
// Safari and iOS use. Check every film file the pages reference: the MP4 box structure always,
// and a full decode with ffprobe and ffmpeg when they are installed.
function mp4Boxes(buf, start, end) {
  const boxes = [];
  for (let at = start; at + 8 <= end;) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(at + 8)); header = 16; } else if (size === 0) size = end - at;
    if (size < header || at + size > end) { boxes.push({ type, start: at, end: at + size, header, broken: true }); break; }
    boxes.push({ type, start: at, end: at + size, header });
    at += size;
  }
  return boxes;
}

function checkMp4(file) {
  const problems = [];
  const buf = readFileSync(file);
  const top = mp4Boxes(buf, 0, buf.length);
  if (!top.length || top[0].type !== 'ftyp') problems.push('does not start with an ftyp box');
  if (top.some((b) => b.broken)) problems.push('a top-level box runs past the end of the file');
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  if (!moov) problems.push('no moov box');
  if (!mdat || mdat.end - mdat.start <= mdat.header) problems.push('no media data');
  if (moov && mdat && moov.start > mdat.start) problems.push('moov box after the media data (the film cannot start before it has fully loaded)');
  const entries = [];
  const walk = (box) => {
    const inner = box.type === 'stsd' ? box.start + box.header + 8 : box.start + box.header;
    for (const child of mp4Boxes(buf, inner, box.end)) {
      if (box.type === 'stsd') entries.push({ type: child.type, width: buf.readUInt16BE(child.start + 32), height: buf.readUInt16BE(child.start + 34) });
      else if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'].includes(child.type)) walk(child);
    }
  };
  if (moov) walk(moov);
  const avc = entries.find((e) => e.type === 'avc1' || e.type === 'avc3');
  if (!avc) problems.push(`no H.264 sample entry (found ${entries.map((e) => e.type).join(', ') || 'none'})`);
  else if (!avc.width || !avc.height) problems.push('H.264 sample entry has no frame size');
  return problems;
}

function decodeFilm(file) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'json', file], { encoding: 'utf8' });
  if (probe.error) return { skipped: true };
  if (probe.status !== 0) return { problems: [`ffprobe failed: ${probe.stderr.trim()}`] };
  const stream = (JSON.parse(probe.stdout).streams || [])[0];
  if (!stream) return { problems: ['ffprobe finds no video stream'] };
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' });
  if (decode.error) return { stream, problems: [] };
  const problems = [];
  if (decode.status !== 0 || decode.stderr.trim()) problems.push(`ffmpeg cannot decode every frame: ${decode.stderr.trim().split('\n')[0] || `exit ${decode.status}`}`);
  return { stream, problems };
}

const films = new Map();
for (const page of PAGE_FILES) {
  const file = join(SITE, page);
  if (!existsSync(file)) continue;
  for (const m of readFileSync(file, 'utf8').matchAll(/<source\s[^>]*src="([^"]+)"[^>]*type="([^"]+)"/g)) {
    films.set(normalize(join(dirname(file), m[1])), m[2]);
  }
}
if (![...films.values()].includes('video/mp4')) fail('media', 'no MP4 source for browsers without WebM support');
for (const [file, type] of films) {
  const name = file.slice(SITE.length + 1);
  if (!existsSync(file)) { fail('media', `${name} is missing`); continue; }
  const problems = type === 'video/mp4' ? checkMp4(file) : [];
  const decoded = decodeFilm(file);
  const s = decoded.stream;
  if (!decoded.skipped) problems.push(...decoded.problems);
  if (s) {
    const want = type === 'video/mp4' ? 'h264' : 'vp9';
    if (s.codec_name !== want) problems.push(`codec ${s.codec_name}, expected ${want}`);
    if (type === 'video/mp4' && s.pix_fmt !== 'yuv420p') problems.push(`pixel format ${s.pix_fmt}, Safari needs yuv420p`);
  }
  problems.forEach((p) => fail('media', `${name}: ${p}`));
  if (problems.length) log(`FAIL media ${name}: ${problems.join('; ')}`);
  else if (decoded.skipped) log(`ok   media ${name}: file structure (ffprobe not installed, frames not decoded)`);
  else log(`ok   media ${name}: ${s.codec_name} ${s.width}x${s.height} ${s.pix_fmt}, every frame decodes`);
}

// ---------- In-page helpers (run in the browser) ----------
const PAGE_HELPERS = () => {
  const parse = (c) => {
    let m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\)/.exec(c);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [Number(m[1]), Number(m[2]), Number(m[3]), a];
    }
    m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : Number(m[4])];
    return null;
  };
  const isClippedAway = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.clip && cs.clip !== 'auto') return true;
      const r = e.getBoundingClientRect();
      if ((cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowX === 'clip') && (r.width <= 2 || r.height <= 2)) return true;
    }
    return false;
  };
  const opacityOf = (el) => {
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
    return op;
  };
  /** Every visible text run under `root`, with its boxes in page coordinates. */
  window.__texts = (selector = 'body') => {
    const out = [];
    for (const root of document.querySelectorAll(selector)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const el = n.parentElement;
        if (!el || el.closest('script,style,noscript,template,title')) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility !== 'visible') continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
        if (!rects.length || isClippedAway(el)) continue;
        if (rects.every((r) => r.bottom + scrollY <= 0 || r.right + scrollX <= 0)) continue;
        out.push({
          text: text.slice(0, 60),
          rects: rects.map((r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height })),
          color: parse(cs.webkitTextFillColor) || parse(cs.color),
          size: parseFloat(cs.fontSize),
          opacity: opacityOf(el),
          tag: el.tagName.toLowerCase(),
          cls: el.className && typeof el.className === 'string' ? el.className : '',
        });
      }
    }
    return out;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /**
   * Worst contrast of each text run against the pixels of `shots` (text hidden), each shot being
   * {data (base64 PNG), x, y (page position of its top left corner), label}.
   */
  window.__contrast = async (texts, shots) => {
    const decoded = [];
    for (const s of shots) {
      const img = new Image();
      img.src = `data:image/png;base64,${s.data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      decoded.push({ ...s, w: c.width, h: c.height, px: ctx.getImageData(0, 0, c.width, c.height).data });
    }
    const results = [];
    for (const t of texts) {
      if (!t.color) continue;
      const alpha = t.color[3] * t.opacity;
      let worst = Infinity; let worstLabel = '';
      for (const s of decoded) {
        const ratios = [];
        for (const r of t.rects) {
          const x0 = Math.ceil(r.x - s.x + 1); const x1 = Math.floor(r.x - s.x + r.w - 1);
          const y0 = Math.ceil(r.y - s.y + 1); const y1 = Math.floor(r.y - s.y + r.h - 1);
          if (x1 < 0 || y1 < 0 || x0 >= s.w || y0 >= s.h || x1 < x0 || y1 < y0) continue;
          const stepX = Math.max(1, Math.floor((x1 - x0) / 24));
          const stepY = Math.max(1, Math.floor((y1 - y0) / 6));
          for (let y = Math.max(0, y0); y <= Math.min(s.h - 1, y1); y += stepY) {
            for (let x = Math.max(0, x0); x <= Math.min(s.w - 1, x1); x += stepX) {
              const i = (y * s.w + x) * 4;
              const bg = [s.px[i], s.px[i + 1], s.px[i + 2]];
              const fg = [0, 1, 2].map((k) => alpha * t.color[k] + (1 - alpha) * bg[k]);
              ratios.push(ratio(fg, bg));
            }
          }
        }
        if (!ratios.length) continue;
        ratios.sort((a, b) => a - b);
        const value = ratios[Math.floor(ratios.length * 0.02)];
        if (value < worst) { worst = value; worstLabel = s.label; }
      }
      if (worst !== Infinity) results.push({ text: t.text, ratio: worst, label: worstLabel });
    }
    return results;
  };
  /**
   * Labels of the rows matched by `selectors` that sit too close to the next label in the same
   * row: the gap between their text must be at least `factor` times the largest gap between the
   * text runs inside either label, and at least `minGap` pixels.
   */
  window.__labelGaps = (selectors, factor, minGap) => {
    const out = [];
    for (const list of document.querySelectorAll(selectors.join(','))) {
      const items = [];
      for (const li of list.children) {
        const boxes = [];
        const words = [];
        const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.nodeValue.trim() || getComputedStyle(n.parentElement).visibility !== 'visible') continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
          if (!rects.length) continue;
          words.push(n.nodeValue.trim());
          boxes.push(...rects);
        }
        if (!boxes.length) continue;
        const top = Math.min(...boxes.map((b) => b.top));
        const line = boxes.filter((b) => b.top - top < 2).sort((a, b) => a.left - b.left);
        let inner = 0;
        for (let i = 1; i < line.length; i += 1) inner = Math.max(inner, line[i].left - line[i - 1].right);
        items.push({ text: words.join(' '), left: line[0].left, right: line[line.length - 1].right, top, inner });
      }
      for (let i = 1; i < items.length; i += 1) {
        const a = items[i - 1]; const b = items[i];
        if (Math.abs(a.top - b.top) > 2) continue; // the next label starts a new row
        const gap = b.left - a.right;
        const inner = Math.max(a.inner, b.inner);
        const need = Math.max(minGap, factor * inner);
        if (gap < need) out.push({ a: a.text, b: b.text, gap: Math.round(gap), inner: Math.round(inner), need: Math.round(need) });
      }
    }
    return out;
  };
  // Counts animation frames requested after the page settles (reduced-motion check).
  window.__raf = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__raf += 1; return raf(cb); };
};

const HIDE_TEXT = `*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;transition:none!important}`;

async function hideText(page, on) {
  await page.evaluate(([css, show]) => {
    let s = document.getElementById('__hide-text');
    if (show && !s) { s = document.createElement('style'); s.id = '__hide-text'; s.textContent = css; document.head.append(s); }
    if (!show && s) s.remove();
  }, [HIDE_TEXT, on]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (!on) await finishAnimations(page);
}

async function finishAnimations(page) {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      if (timing && Number.isFinite(timing.endTime)) a.finish();
    }
  });
}

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = Math.max(200, Math.floor(innerHeight * 0.5));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await wait(150);
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    await wait(300);
    // A busy machine can miss a reveal during the fast pass: bring every still-hidden text
    // into view once more, so only content that never appears is reported.
    if (window.__texts) {
      const hidden = new Set();
      for (const t of window.__texts()) if (t.opacity < 0.99) hidden.add(Math.round(t.rects[0].y));
      for (const y of hidden) {
        window.scrollTo({ top: Math.max(0, y - innerHeight / 2), behavior: 'instant' });
        await wait(400);
      }
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    await wait(250);
  });
}

function checkContrast(where, results) {
  for (const r of results) {
    if (r.ratio < MIN_CONTRAST) fail(where, `contrast ${r.ratio.toFixed(2)} < ${MIN_CONTRAST} for "${r.text}"${r.label ? ` (${r.label})` : ''}`);
  }
}

async function openPage(browser, pageDef, vp, scheme, extra = {}) {
  const where = `${pageDef.name} ${vp.name} ${scheme}${extra.reducedMotion === 'reduce' ? ' reduced-motion' : ''}${extra.javaScriptEnabled === false ? ' no-js' : ''}`;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch,
    colorScheme: scheme, reducedMotion: 'no-preference', ...extra,
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.origin === ORIGIN) return route.continue();
    fail(where, `request to another origin: ${route.request().url()}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') fail(where, `console error: ${m.text()}`); });
  page.on('pageerror', (e) => fail(where, `page error: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) fail(where, `HTTP ${r.status()} for ${r.url()}`); });
  page.on('requestfailed', (r) => {
    const err = r.failure() ? r.failure().errorText : '';
    // Media elements cancel range requests they no longer need; that is not a broken file.
    if (r.resourceType() === 'media' && /ERR_ABORTED/.test(err)) return;
    if (new URL(r.url()).origin !== ORIGIN) return; // already reported as another origin
    fail(where, `request failed: ${r.url()} ${err}`);
  });
  if (extra.javaScriptEnabled !== false) await page.addInitScript(PAGE_HELPERS);
  await page.goto(ORIGIN + pageDef.path, { waitUntil: 'load' });
  return { context, page, where };
}

async function basics(page, where, pageDef) {
  const info = await page.evaluate(() => ({
    title: document.title.trim(),
    description: (document.querySelector('meta[name="description"]') || {}).content || '',
    lang: document.documentElement.lang,
  }));
  if (!info.title) fail(where, 'missing <title>');
  if (info.description.trim().length < 50) fail(where, 'missing or too short meta description');
  if (info.lang !== pageDef.lang) fail(where, `html lang is "${info.lang}", expected "${pageDef.lang}"`);
}

async function checkLayout(page, where) {
  const issues = await page.evaluate((minFont) => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`horizontal overflow: page is ${document.documentElement.scrollWidth}px wide, viewport ${vw}px`);
    const clippedByAncestor = (el) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (/(hidden|clip)/.test(cs.overflowX) || /(hidden|clip)/.test(cs.overflow)) {
          const r = e.getBoundingClientRect();
          if (r.left >= -1 && r.right <= vw + 1) return true;
        }
      }
      return false;
    };
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility !== 'visible' || cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if ((r.right > vw + 1 || r.left < -1) && !clippedByAncestor(el)) {
        out.push(`horizontal overflow: <${el.tagName.toLowerCase()} class="${el.className && el.className.baseVal === undefined ? el.className : ''}"> spans ${Math.round(r.left)} to ${Math.round(r.right)}`);
      }
    }
    for (const t of window.__texts()) {
      if (t.size < minFont) out.push(`text under ${minFont}px (${t.size}px): "${t.text}"`);
    }
    // Text cut off by a box that hides its overflow (or by the page edge). A box that ends its
    // text with an ellipsis (text-overflow) is a deliberate shortening and is not reported.
    const describe = (e) => `<${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? ` class="${e.className}"` : ''}>`;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.replace(/\s+/g, ' ').trim();
      const el = n.parentElement;
      if (!text || !el || el.closest('script,style,noscript,template')) continue;
      if (getComputedStyle(el).visibility !== 'visible') continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      if (!rects.length) continue;
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.clip && cs.clip !== 'auto') break; // visually hidden on purpose
        const clipX = /(hidden|clip)/.test(cs.overflowX);
        const clipY = /(hidden|clip)/.test(cs.overflowY);
        if ((clipX || clipY) && cs.textOverflow === 'ellipsis') break; // shortened on purpose, with an ellipsis
        if (clipX || clipY) {
          const b = e.getBoundingClientRect();
          if (b.width <= 2 || b.height <= 2) break;
          const cut = rects.find((r) => (clipX && (r.left < b.left - 1 || r.right > b.right + 1)) || (clipY && (r.top < b.top - 1 || r.bottom > b.bottom + 1)));
          if (cut) {
            out.push(`text cut off by ${describe(e)}: "${text.slice(0, 60)}" spans ${Math.round(cut.left)} to ${Math.round(cut.right)}, box ${Math.round(b.left)} to ${Math.round(b.right)}`);
            break;
          }
        }
        if (cs.position === 'fixed') break; // fixed boxes escape the clipping of their ancestors
      }
    }
    // Text running into other text (for example a label wider than its column). Only the middle
    // of each line box counts, so tight line heights and touching glyphs are not reported.
    const runs = [];
    const all = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = all.nextNode(); n; n = all.nextNode()) {
      const text = n.nodeValue.replace(/\s+/g, ' ').trim();
      const el = n.parentElement;
      if (!text || !el || el.closest('script,style,noscript,template')) continue;
      let fixed = false;
      for (let e = el; e && !fixed; e = e.parentElement) fixed = getComputedStyle(e).position === 'fixed';
      if (fixed || getComputedStyle(el).visibility !== 'visible') continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width <= 1 || r.height <= 1) continue;
        runs.push({ text: text.slice(0, 40), node: n, l: r.left, r: r.right, t: r.top + r.height * 0.3, b: r.bottom - r.height * 0.3 });
      }
    }
    runs.sort((a, b) => a.t - b.t);
    const seenPairs = new Set();
    for (let i = 0; i < runs.length; i += 1) {
      for (let j = i + 1; j < runs.length && runs[j].t < runs[i].b; j += 1) {
        const a = runs[i]; const c = runs[j];
        if (a.node === c.node) continue;
        if (Math.min(a.r, c.r) - Math.max(a.l, c.l) > 2 && Math.min(a.b, c.b) > Math.max(a.t, c.t)) {
          const key = `${a.text}|${c.text}`;
          if (!seenPairs.has(key)) { seenPairs.add(key); out.push(`text overlaps other text: "${a.text}" and "${c.text}"`); }
        }
      }
    }
    return out;
  }, MIN_FONT_PX);
  issues.slice(0, 20).forEach((i) => fail(where, i));
}

const labelGapProblem = (i, at = '') => `labels "${i.a}" and "${i.b}" are ${i.gap}px apart${at}, closer than ${i.need}px (${i.inner ? `${LABEL_GAP_FACTOR} times the ${i.inner}px inside one label` : 'the minimum'})`;

async function checkLabelSpacing(page, where) {
  const issues = await page.evaluate(([sel, factor, min]) => window.__labelGaps(sel, factor, min), [LABEL_ROWS, LABEL_GAP_FACTOR, MIN_LABEL_GAP]);
  issues.forEach((i) => fail(where, labelGapProblem(i)));
}

// The label spacing check at every width of SWEEP, so a layout between the five sizes cannot set
// two labels too close either. Reduced motion, so every label is at rest.
async function sweepLabelSpacing(browser, pageDef) {
  const vp = { name: 'width sweep', width: SWEEP.to, height: 900 };
  const { context, page, where } = await openPage(browser, pageDef, vp, 'dark', { reducedMotion: 'reduce' });
  try {
    await page.evaluate(() => document.fonts.ready);
    const found = new Map();
    let widths = 0;
    for (let w = SWEEP.from; w <= SWEEP.to; w += SWEEP.step) {
      await page.setViewportSize({ width: w, height: vp.height });
      widths += 1;
      const issues = await page.evaluate(([sel, factor, min]) => window.__labelGaps(sel, factor, min), [LABEL_ROWS, LABEL_GAP_FACTOR, MIN_LABEL_GAP]);
      for (const i of issues) {
        const key = `${i.a}|${i.b}`;
        const seen = found.get(key);
        if (!seen) { found.set(key, { ...i, ranges: [[w, w]] }); continue; }
        const last = seen.ranges[seen.ranges.length - 1];
        if (w - last[1] === SWEEP.step) last[1] = w; else seen.ranges.push([w, w]);
        if (i.gap < seen.gap) Object.assign(seen, { gap: i.gap, inner: i.inner, need: i.need });
      }
    }
    const span = ([a, b]) => (a === b ? `${a}` : `${a} to ${b}`);
    for (const i of found.values()) fail(where, labelGapProblem(i, ` at widths ${i.ranges.map(span).join(', ')}px`));
    log(`${found.size ? 'FAIL' : 'ok  '} ${where}: ${widths} widths from ${SWEEP.from} to ${SWEEP.to}px`);
  } finally {
    await context.close();
  }
}

async function checkMedia(page, where) {
  const media = await page.evaluate(async () => {
    const imgs = [...document.images].map((img) => ({ src: img.currentSrc || img.src, ok: img.complete && img.naturalWidth > 0 }));
    const films = [];
    for (const v of document.querySelectorAll('video')) {
      const t0 = Date.now();
      while (v.readyState < 2 && !v.error && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
      const poster = v.poster ? await fetch(v.poster).then((r) => r.ok).catch(() => false) : true;
      films.push({ src: v.currentSrc, ready: v.readyState, error: v.error ? v.error.code : 0, poster, w: v.videoWidth });
    }
    return { imgs, films };
  });
  media.imgs.filter((i) => !i.ok).forEach((i) => fail(where, `broken image: ${i.src}`));
  for (const f of media.films) {
    if (f.error || f.ready < 2 || !f.w) fail(where, `broken video: ${f.src || '(no source chosen)'} readyState ${f.ready} error ${f.error}`);
    if (!f.poster) fail(where, 'video poster does not load');
  }
  return media;
}

async function checkFonts(page, where) {
  const missing = await page.evaluate(async () => {
    await document.fonts.ready;
    const want = ['300 20px "IBM Plex Sans"', '400 20px "IBM Plex Sans"', '500 20px "IBM Plex Sans"', '600 20px "IBM Plex Sans"', '500 20px "IBM Plex Mono"'];
    const loaded = new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.weight} ${f.family.replace(/"/g, '')}`));
    return want.filter((w) => { const [wt, , ...fam] = w.split(' '); return !loaded.has(`${wt} ${fam.join(' ').replace(/"/g, '')}`); });
  });
  missing.forEach((m) => fail(where, `font not loaded: ${m}`));
}

async function checkLinks(page, where) {
  const links = await page.evaluate(() => ({
    app: [...document.querySelectorAll('[data-app-link]')].map((a) => a.getAttribute('href')),
    demo: [...document.querySelectorAll('[data-demo-link]')].map((a) => a.getAttribute('href')),
    shown: [...document.querySelectorAll('[data-demo-email]')].map((e) => e.textContent.trim()),
  }));
  if (!links.app.length) fail(where, 'no Sign in link marked data-app-link');
  if (!links.demo.length) fail(where, 'no Request a demo link marked data-demo-link');
  if (!links.shown.length) fail(where, 'the demo address is not shown as text');
  links.app.filter((h) => h !== APP_URL).forEach((h) => fail(where, `Sign in link ${h} is not ${APP_URL}`));
  links.demo.filter((h) => !h.startsWith(`mailto:${DEMO_EMAIL}`)).forEach((h) => fail(where, `demo link ${h} is not mailto:${DEMO_EMAIL}`));
  links.shown.filter((s) => s !== DEMO_EMAIL).forEach((s) => fail(where, `shown address ${s} is not ${DEMO_EMAIL}`));
}

async function measureFullPage(page, where) {
  const texts = await page.evaluate(() => window.__texts());
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await hideText(page, true);
  const full = await page.screenshot({ fullPage: true, animations: 'disabled' });
  const shots = [{ data: full.toString('base64'), x: 0, y: 0, label: 'page' }];
  // Text over the hero film: also measure over several frames of the film.
  const hero = await page.evaluate(() => {
    const h = document.querySelector('[data-hero]');
    const r = h.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  });
  const hasFilm = await page.evaluate(() => {
    const v = document.querySelector('[data-hero] video');
    return !!v && v.readyState >= 1 && getComputedStyle(v).display !== 'none';
  });
  if (hasFilm) {
    for (const t of FILM_TIMES) {
      await page.evaluate(async (time) => {
        const v = document.querySelector('[data-hero] video');
        v.pause();
        await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = time; });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, t);
      // fullPage, so a hero taller than the viewport (narrow phones) is measured to its bottom.
      const clip = await page.screenshot({ fullPage: true, clip: { x: hero.x, y: hero.y, width: hero.w, height: hero.h }, animations: 'disabled' });
      shots.push({ data: clip.toString('base64'), x: hero.x, y: hero.y, label: `film at ${t}s` });
    }
  }
  await hideText(page, false);
  const heroTexts = texts.filter((t) => t.rects.some((r) => r.y < hero.y + hero.h));
  const otherTexts = texts.filter((t) => !heroTexts.includes(t));
  checkContrast(where, await page.evaluate(([tx, sh]) => window.__contrast(tx, sh), [heroTexts, shots]));
  checkContrast(where, await page.evaluate(([tx, sh]) => window.__contrast(tx, sh), [otherTexts, shots.slice(0, 1)]));
  return texts.length;
}

async function measureViewport(page, where, selector, label) {
  await finishAnimations(page);
  const texts = await page.evaluate((sel) => window.__texts(sel), selector);
  await hideText(page, true);
  const shot = await page.screenshot({ animations: 'disabled' });
  await hideText(page, false);
  const pos = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  checkContrast(where, await page.evaluate(([tx, sh]) => window.__contrast(tx, sh), [texts, [{ data: shot.toString('base64'), x: pos.x, y: pos.y, label }]]));
  return texts.length;
}

async function checkPlayback(page, where) {
  const state = async () => page.evaluate(() => { const v = document.querySelector('[data-hero] video'); return v ? { paused: v.paused } : null; });
  const s0 = await state();
  if (!s0) { fail(where, 'hero film missing'); return; }
  if (s0.paused) fail(where, 'hero film is not playing at the top of the page');
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(500);
  if (!(await state()).paused) fail(where, 'hero film keeps playing when off screen');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(500);
  if ((await state()).paused) fail(where, 'hero film does not resume when back on screen');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  if (!(await state()).paused) fail(where, 'hero film keeps playing when the tab is hidden');
  const loops = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().endTime === Infinity).length);
  if (loops) fail(where, `${loops} looping animation(s) keep running when the tab is hidden`);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function runNormal(browser, pageDef, vp, scheme) {
  const { context, page, where } = await openPage(browser, pageDef, vp, scheme);
  try {
    if (vp.name === 'desktop') {
      await page.waitForTimeout(120);
      await page.screenshot({ path: join(OUT, `${pageDef.name}-${vp.name}-${scheme}-early.png`) });
    }
    await basics(page, where, pageDef);
    await checkFonts(page, where);
    await checkLinks(page, where);
    await page.waitForTimeout(2600);
    await page.screenshot({ path: join(OUT, `${pageDef.name}-${vp.name}-${scheme}-first.png`) });
    await scrollThrough(page);
    await checkMedia(page, where);
    if (scheme === 'dark') await checkPlayback(page, where);
    await finishAnimations(page);
    await checkLayout(page, where);
    await checkLabelSpacing(page, where);
    await page.screenshot({ path: join(OUT, `${pageDef.name}-${vp.name}-${scheme}.png`), fullPage: true });
    const n = await measureFullPage(page, where);
    // The navigation over the paper part of the page.
    await page.evaluate(() => window.scrollTo({ top: Math.floor(document.documentElement.scrollHeight * 0.45), behavior: 'instant' }));
    await page.waitForTimeout(450);
    const nNav = await measureViewport(page, where, '[data-nav]', 'navigation over the page');
    await page.screenshot({ path: join(OUT, `${pageDef.name}-${vp.name}-${scheme}-scrolled.png`) });
    // The small-screen menu, open.
    let nMenu = 0;
    const burger = page.locator('[data-burger]');
    if (await burger.isVisible()) {
      for (const y of [0, 0.45]) {
        await page.evaluate((f) => window.scrollTo({ top: Math.floor(document.documentElement.scrollHeight * f), behavior: 'instant' }), y);
        await page.waitForTimeout(400);
        await burger.click();
        await page.waitForTimeout(250);
        if ((await burger.getAttribute('aria-expanded')) !== 'true') fail(where, 'menu button does not open the menu');
        nMenu += await measureViewport(page, where, '[data-menu]', `open menu at ${y * 100}%`);
        await page.screenshot({ path: join(OUT, `${pageDef.name}-${vp.name}-${scheme}-menu-${y * 100}.png`) });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        if ((await burger.getAttribute('aria-expanded')) !== 'false') fail(where, 'Escape does not close the menu');
      }
    }
    log(`ok   ${where}: ${n} text runs, ${nNav} in the navigation${nMenu ? `, ${nMenu} in the menu` : ''}`);
  } finally {
    await context.close();
  }
}

async function runReduced(browser, pageDef, vp) {
  const { context, page, where } = await openPage(browser, pageDef, vp, 'dark', { reducedMotion: 'reduce' });
  try {
    await page.waitForTimeout(1200);
    const before = await page.evaluate(() => window.__raf);
    await page.waitForTimeout(1000);
    const state = await page.evaluate((rafBefore) => {
      const running = document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.animationName || (a.effect && a.effect.target && a.effect.target.className) || 'animation');
      const films = [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, t: v.currentTime }));
      const hidden = window.__texts().filter((t) => t.opacity < 0.99).map((t) => t.text);
      return { running, films, hidden, raf: window.__raf - rafBefore };
    }, before);
    if (state.running.length) fail(where, `animations running with reduced motion: ${[...new Set(state.running)].join(', ')}`);
    state.films.filter((f) => !f.paused || f.t > 0).forEach(() => fail(where, 'video plays with reduced motion'));
    if (state.raf > 0) fail(where, `${state.raf} animation frames requested in one second with reduced motion`);
    state.hidden.slice(0, 10).forEach((t) => fail(where, `text hidden at rest with reduced motion: "${t}"`));
    await page.screenshot({ path: join(OUT, `${pageDef.name}-${vp.name}-reduced.png`), fullPage: true });
    log(`ok   ${where}`);
  } finally {
    await context.close();
  }
}

async function runNoScript(browser, pageDef) {
  const vp = VIEWPORTS[0];
  const { context, page, where } = await openPage(browser, pageDef, vp, 'light', { javaScriptEnabled: false });
  try {
    await page.waitForTimeout(3200);
    const hidden = await page.evaluate(() => {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim() || !n.parentElement) continue;
        let op = 1;
        for (let e = n.parentElement; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
        const cs = getComputedStyle(n.parentElement);
        if (cs.display !== 'none' && op < 0.99) out.push(n.nodeValue.trim().slice(0, 60));
      }
      return out;
    });
    hidden.slice(0, 10).forEach((t) => fail(where, `text hidden without JavaScript: "${t}"`));
    log(`ok   ${where}`);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();
try {
  for (const pageDef of PAGES) {
    for (const vp of VIEWPORTS) {
      for (const scheme of SCHEMES) await runNormal(browser, pageDef, vp, scheme);
      await runReduced(browser, pageDef, vp);
    }
    await sweepLabelSpacing(browser, pageDef);
    await runNoScript(browser, pageDef);
  }
} finally {
  await browser.close();
  server.close();
}

log(`Screenshots: ${OUT}`);
if (failures.length) {
  log(`\n${failures.length} problem(s):`);
  failures.forEach((f) => log(`  ${f}`));
  process.exit(1);
}
log('Site check passed.');
