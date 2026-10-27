import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './helpers.js';

// The living brand panel of the sign-in pages (MILESTONE-2 MOT-02, rules L-1 to L-5) in a real browser.
//
// The sample build that the other specs use has no sign-in pages, so this spec builds the API bundle once
// (`VITE_DATA_SOURCE=api`, into a temporary folder) and serves it on a free port the way the release image does:
// the Google Fonts lines removed from index.html (deploy/docker/web.Dockerfile) and the Content-Security-Policy of
// deploy/nginx/security-headers.conf on every answer. A small fake api answers the three calls of the sign-in page:
// the system profile, `GET /me` (401, no session) and the sign-in methods.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const REPO = path.resolve(WEB, '../..');

const PROFILE = {
  version: '1.0.0', revision: 'abc1234', deploy: 'saas',
  capabilities: {
    licenseValidation: 'online', updatesChannel: 'managed', packsChannel: 'managed', telemetry: false,
    identityProviders: ['local', 'oidc'], storageAdapters: ['managed_vault'], mailTransport: 'smtp', jobsDriver: 'pgboss',
  },
  demo: { enabled: false, personas: false },
  login: { regionLabel: 'Jakarta', mfaEnforced: true },
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** The policy of security-headers.conf without the optional Google Fonts hosts (MSCD_EXTERNAL_FONTS off). */
function releaseCsp() {
  const conf = readFileSync(path.join(REPO, 'deploy/nginx/security-headers.conf'), 'utf8');
  const policy = conf.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
  if (!policy) throw new Error('No Content-Security-Policy in deploy/nginx/security-headers.conf');
  return policy.replace(/\$mscd_csp_\w+/g, '');
}

function buildApiBundle(outDir) {
  const require = createRequire(path.join(WEB, 'package.json'));
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  execFileSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: WEB, env: { ...process.env, VITE_DATA_SOURCE: 'api' }, stdio: 'pipe',
  });
}

function serve(root, csp) {
  const indexHtml = readFileSync(path.join(root, 'index.html'), 'utf8')
    .split('\n').filter((line) => !/fonts\.(googleapis|gstatic)\.com/.test(line)).join('\n');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'content-security-policy': csp, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/api/v1/system/profile') return send(200, 'application/json', JSON.stringify(PROFILE));
    if (url.pathname === '/api/v1/auth/providers') return send(200, 'application/json', JSON.stringify({ local: true, providers: [] }));
    if (url.pathname.startsWith('/api/')) {
      return send(401, 'application/problem+json', JSON.stringify({
        type: 'https://mscd.cyberlentera.com/problems/unauthenticated', title: 'Sign in first', status: 401, requestId: 'req-mot02-0001',
      }));
    }
    const file = path.join(root, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
    let isFile = false;
    try {
      isFile = file.startsWith(root) && statSync(file).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile || file === path.join(root, 'index.html')) return send(200, TYPES['.html'], indexHtml);
    return send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

let site = null;
let outDir = null;

test.describe.configure({ mode: 'default' });
test.use({ apiSession: null, viewport: { width: 1440, height: 900 } });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  outDir = mkdtempSync(path.join(os.tmpdir(), 'mot-02-auth-motion-'));
  buildApiBundle(outDir);
  site = await serve(outDir, releaseCsp());
});

test.afterAll(async () => {
  if (site) await new Promise((resolve) => site.server.close(resolve));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const canvas = (page) => page.locator('canvas.au-threads');

/** Waits until the motion has drawn and the entrance of the page has ended (the text sits at its place). */
async function settled(page) {
  await expect(canvas(page)).toHaveAttribute('data-ready', '');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished'));
}

/** Opens the sign-in page and records requests and policy violations. */
async function openSignIn(page, query = '') {
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    // The work of every animation frame callback (the motion draws in them), in milliseconds.
    window.__frameCosts = [];
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => {
      const start = performance.now();
      cb(t);
      window.__frameCosts.push(performance.now() - start);
    });
  });
  await page.goto(`${site.base}/login${query}`);
  await expect(page.locator('#au-email')).toBeVisible();
  return requests;
}

/** A small fingerprint of the canvas pixels, to tell a moving picture from a still one. */
function canvasPrint(page) {
  return page.evaluate(() => {
    const src = document.querySelector('canvas.au-threads');
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, 96, 96);
    const d = g.getImageData(0, 0, 96, 96).data;
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum = (sum * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13 + d[i + 3] * 17) % 1_000_000_007;
      if (d[i + 3] > 0) lit++;
    }
    return { sum, lit };
  });
}

/** Every line of brand text: box, colour, rendered size and weight. */
function brandTextBoxes(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.au-brand');
    const out = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue.trim()) continue;
      const el = node.parentElement;
      const cs = getComputedStyle(el);
      const svgText = el.closest('svg') ? el.closest('text') : null;
      if (svgText) {
        const svg = svgText.ownerSVGElement;
        const r = svgText.getBoundingClientRect();
        out.push({ text: node.nodeValue.trim(), x: r.x, y: r.y, w: r.width, h: r.height, color: cs.fill, size: parseFloat(cs.fontSize) * svg.getScreenCTM().a, weight: Number(cs.fontWeight) });
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        out.push({ text: node.nodeValue.trim(), x: r.x, y: r.y, w: r.width, h: r.height, color: cs.color, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) });
      }
    }
    return out;
  });
}

/**
 * The brightest background pixel under each box in a screenshot of the page (text hidden by the caller). With `clip`,
 * only that part of the page is captured, which keeps the frames of a large window quick.
 */
async function brightestUnder(page, boxes, clip = null) {
  const png = await page.screenshot({ type: 'png', animations: 'allow', ...(clip ? { clip } : {}) });
  const dx = clip ? clip.x : 0;
  const dy = clip ? clip.y : 0;
  const shifted = boxes.map((b) => ({ x: b.x - dx, y: b.y - dy, w: b.w, h: b.h }));
  return page.evaluate(async ({ b64, boxes: list }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return list.map((b) => {
      const x = Math.max(0, Math.floor(b.x));
      const y = Math.max(0, Math.floor(b.y));
      const d = g.getImageData(x, y, Math.max(1, Math.ceil(b.w)), Math.max(1, Math.ceil(b.h))).data;
      let best = 0;
      for (let i = 0; i < d.length; i += 4) best = Math.max(best, 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
      return best;
    });
  }, { b64: png.toString('base64'), boxes: shifted });
}

function luminanceOf(rgb) {
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

test('the brand panel moves behind the sign-in form without touching the form', async ({ page }) => {
  const requests = await openSignIn(page, '?theme=light');
  // The form paints and takes the focus first; the motion starts once the page is idle.
  await expect(page.locator('#au-email')).toBeFocused();
  await expect(canvas(page)).toHaveAttribute('data-motion', 'running');
  await expect(canvas(page)).toHaveAttribute('data-ready', '');
  await expect(canvas(page)).toHaveAttribute('aria-hidden', 'true');

  // The canvas fills the panel, stays inside it and takes no clicks.
  const panel = await page.locator('.au-brand').boundingBox();
  const box = await canvas(page).boundingBox();
  expect(box).toEqual(panel);
  const main = await page.locator('main.au-main').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(main.x + 0.5);
  expect(main.width).toBeCloseTo(1440 / 2.1, 0);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: panel.x + panel.width - 40, y: panel.y + 160 });
  expect(hit).toBe('au-brand');
  const h1 = await page.locator('.au-hero h1').boundingBox();
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x: h1.x + 20, y: h1.y + h1.height / 2 })).toBe('H1');

  // The picture moves: two fingerprints a moment apart differ.
  const first = await canvasPrint(page);
  expect(first.lit).toBeGreaterThan(500);
  await page.waitForTimeout(700);
  expect((await canvasPrint(page)).sum).not.toBe(first.sum);

  // The form works as before while the panel moves, and a frame of the motion takes a small part of the frame budget.
  await page.evaluate(() => {
    window.__frameCosts.length = 0;
  });
  await page.locator('#au-email').fill('rina.kusuma@nusantaradigital.co.id');
  await page.locator('#au-password').fill('correct horse battery staple');
  await page.locator('input[name="remember"]').check();
  await expect(page.locator('#au-email')).toHaveValue('rina.kusuma@nusantaradigital.co.id');
  await page.waitForTimeout(1500);
  const costs = await page.evaluate(() => window.__frameCosts.slice().sort((a, b) => a - b));
  expect(costs.length).toBeGreaterThan(10);
  expect(costs[Math.floor(costs.length / 2)]).toBeLessThan(4);
  expect(costs[Math.floor(costs.length * 0.95)]).toBeLessThan(16);

  // L-1 and the Content-Security-Policy: same origin only, no violation, no inline script in the page.
  const origin = new URL(site.base).origin;
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:'))).toEqual([]);
  expect(await page.evaluate(() => window.__violations)).toEqual([]);
  expect(await page.evaluate(() => [...document.scripts].filter((s) => !s.src).length)).toBe(0);
});

/**
 * Measures every line of brand text over the brightest frame of the motion: WCAG AA against the brightest pixel in
 * its box, and a rendered size of at least 12px. Returns the failures. The page must be settled.
 */
async function brandTextFailures(page) {
  const boxes = await brandTextBoxes(page);
  expect(boxes.length).toBeGreaterThanOrEqual(15);
  // Text, its shadows and the halo of the chain labels hidden: what is left under each box is the background alone.
  await page.addStyleTag({
    content: '.au-brand,.au-brand *{color:transparent!important;text-shadow:none!important}.au-chain text{fill:transparent!important;stroke:none!important}',
  });
  const panel = await page.locator('.au-brand').boundingBox();
  const clip = { x: Math.floor(panel.x), y: Math.floor(panel.y), width: Math.ceil(panel.width), height: Math.ceil(panel.height) };
  // Sample frames across the first run of the signal (it starts 1.2 s after the motion) and the motes.
  const brightest = boxes.map(() => 0);
  const start = Date.now();
  while (Date.now() - start < 6500) {
    (await brightestUnder(page, boxes, clip)).forEach((l, i) => {
      brightest[i] = Math.max(brightest[i], l);
    });
    await page.waitForTimeout(250);
  }
  const failures = [];
  boxes.forEach((b, i) => {
    const large = b.size >= 24 || (b.weight >= 700 && b.size >= 18.66);
    const min = large ? 3 : 4.5;
    const fg = luminanceOf(b.color);
    const ratio = (Math.max(fg, brightest[i]) + 0.05) / (Math.min(fg, brightest[i]) + 0.05);
    if (ratio < min) failures.push(`${ratio.toFixed(2)} < ${min}: "${b.text.slice(0, 40)}"`);
    if (b.size < 11.95) failures.push(`${b.size.toFixed(2)}px < 12px: "${b.text.slice(0, 40)}"`);
  });
  return failures;
}

for (const theme of ['light', 'dark']) {
  test(`brand text keeps WCAG AA contrast over the brightest frame of the motion and is at least 12px, ${theme} theme`, async ({ page }) => {
    test.setTimeout(90_000);
    await openSignIn(page, `?theme=${theme}`);
    await settled(page);
    expect(await brandTextFailures(page)).toEqual([]);
  });
}

// The chain labels grow in viewBox units as the hero narrows, and the Indonesian labels are longer, so the same check
// runs at the narrowest hero (a 901px window), at common laptop and desktop windows and on a tall portrait screen.
const LAYOUTS = [
  { width: 901, height: 800, lang: 'id' },
  { width: 960, height: 1200, lang: 'en' },
  { width: 1000, height: 800, lang: 'id' },
  { width: 1280, height: 720, lang: 'id' },
  { width: 2560, height: 1440, lang: 'id' },
];
for (const { width, height, lang } of LAYOUTS) {
  test(`brand text keeps WCAG AA contrast and 12px at ${width} x ${height}, ${lang === 'id' ? 'Indonesian' : 'English'}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height });
    await openSignIn(page, `?lang=${lang}`);
    await expect(page.locator('.au-root')).toHaveAttribute('lang', lang);
    await expect(canvas(page)).toHaveAttribute('data-motion', 'running');
    await settled(page);
    expect(await brandTextFailures(page)).toEqual([]);
  });
}

test('the motion pauses while the tab is hidden and stands still where the panel collapses (L-4)', async ({ page }) => {
  await openSignIn(page);
  await expect(canvas(page)).toHaveAttribute('data-motion', 'running');
  await settled(page);

  const setHidden = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  await expect(canvas(page)).toHaveAttribute('data-motion', 'paused');
  const paused = await canvasPrint(page);
  await page.waitForTimeout(600);
  expect((await canvasPrint(page)).sum).toBe(paused.sum);
  await setHidden(false);
  await expect(canvas(page)).toHaveAttribute('data-motion', 'running');

  // At 900px and below the panel is the logo bar of the design: the hero is hidden and the threads stand still.
  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(canvas(page)).toHaveAttribute('data-motion', 'still');
    await expect(page.locator('.au-hero')).toBeHidden();
    await expect(page.locator('.au-logo')).toBeVisible();
    await expect(page.locator('#au-email')).toBeVisible();
    const bar = await page.locator('.au-brand').boundingBox();
    expect(await canvas(page).boundingBox()).toEqual(bar);
    expect(bar.height).toBeLessThan(240);
    const still = await canvasPrint(page);
    expect(still.lit).toBeGreaterThan(200);
    await page.waitForTimeout(500);
    expect((await canvasPrint(page)).sum).toBe(still.sum);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // the product name in the bar keeps its contrast over the threads
    const boxes = (await brandTextBoxes(page)).filter((b) => b.w > 0 && b.h > 0);
    expect(boxes.map((b) => b.text)).toEqual(['MSCD']);
    await page.addStyleTag({ content: '.au-logo span{color:transparent!important}' });
    const [bg] = await brightestUnder(page, boxes);
    const fg = luminanceOf(boxes[0].color);
    expect((fg + 0.05) / (bg + 0.05)).toBeGreaterThanOrEqual(4.5);
    await page.addStyleTag({ content: '.au-logo span{color:#f2eee7!important}' });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(canvas(page)).toHaveAttribute('data-motion', 'running');
});

test('reduced motion shows a complete still frame and runs no animation (L-2)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSignIn(page);
  await expect(canvas(page)).toHaveAttribute('data-motion', 'still');
  await settled(page);
  // everything is there at once: the canvas, the hero text at full opacity and the six nodes of the chain
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('canvas.au-threads')).opacity)).toBe('1');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.au-hero')).opacity)).toBe('1');
  await expect(page.locator('svg.au-chain circle')).toHaveCount(6);
  expect(await page.evaluate(() => [...document.querySelectorAll('.au-chain-signal')].map((p) => getComputedStyle(p).opacity))).toEqual(['0', '0']);
  const still = await canvasPrint(page);
  expect(still.lit).toBeGreaterThan(500);
  await page.waitForTimeout(800);
  expect((await canvasPrint(page)).sum).toBe(still.sum);
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);

  // The motion follows the setting when it changes.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(canvas(page)).toHaveAttribute('data-motion', 'running');
});
