#!/usr/bin/env node
// Quality check of the landing site (MOT-01). Serves apps/site on a free local port, opens both
// languages at 1440x900 and 390x844 in light and dark, saves screenshots, and fails on:
//   a request to another origin, horizontal overflow, text under 12px, text contrast under 4.5:1
//   (background sampled at the text position, over several frames of the hero film), a missing
//   <title> or meta description, console errors, broken media, links that differ from
//   site.config.mjs, and, with reduced motion, any running animation, loop or playing video.
//
//   node apps/site/check.mjs [--out <folder for screenshots>] [--only en|id]
// The functions passed to page.evaluate run in the browser, so they use its globals.
/* global window, document, NodeFilter, getComputedStyle, requestAnimationFrame, scrollX, scrollY, innerHeight, Image */
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
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
];
const SCHEMES = ['light', 'dark'];

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
    const step = Math.max(200, Math.floor(innerHeight * 0.7));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 90));
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 150));
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 250));
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
    return out;
  }, MIN_FONT_PX);
  issues.slice(0, 20).forEach((i) => fail(where, i));
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
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: Math.min(r.height, innerHeight - r.top) };
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
      const clip = await page.screenshot({ clip: { x: hero.x, y: hero.y, width: hero.w, height: hero.h }, animations: 'disabled' });
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
