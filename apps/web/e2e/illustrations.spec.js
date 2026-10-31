import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webBuild } from '../../../tools/scripts/e2e-cache.mjs';
import { test, expect, metaById, openScreen, expectReadableText, expectNoHorizontalOverflow, expectToast, framesPass } from './helpers.js';

// The illustration library in a real browser (MILESTONE-2 MOT-03, rules L-1 to L-5), through its gallery: the
// sample-only host screen `?screen=illustrations`. The scenes play one short entrance (every animation ends within
// 1.2 seconds) and then stand still; with reduced motion they show the same final frame at once. They load nothing
// from anywhere and run under the release Content-Security-Policy. @sample-only: the gallery exists in sample builds.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const REPO = path.resolve(WEB, '../..');
const META = metaById('illustrations');
const SCENES = ['getting-started', 'no-systems', 'no-documents', 'no-evidence', 'no-findings', 'all-done', 'error', 'offline'];
const BUDGET_MS = 1200;

/** The policy of deploy/nginx/security-headers.conf without the optional Google Fonts hosts (as MOT-02 does). */
function releaseCsp() {
  const conf = readFileSync(path.join(REPO, 'deploy/nginx/security-headers.conf'), 'utf8');
  const policy = conf.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
  if (!policy) throw new Error('No Content-Security-Policy in deploy/nginx/security-headers.conf');
  return policy.replace(/\$mscd_csp_\w+/g, '');
}

/**
 * Serves the page with the release policy: the document gets the Content-Security-Policy header and loses its
 * Google Fonts lines, as deploy/docker/web.Dockerfile removes them. Records every request and policy violation.
 */
async function underReleasePolicy(page) {
  const csp = releaseCsp();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const res = await route.fetch();
    const body = (await res.text()).split('\n').filter((line) => !/fonts\.(googleapis|gstatic)\.com/.test(line)).join('\n');
    return route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-security-policy': csp } });
  });
  return requests;
}

const scenes = (page) => page.locator('main [data-screen="illustrations"] svg.il');
const gallery = (page) => page.locator('main [data-screen="illustrations"] .ilg-grid svg.il');

/** Waits until every finite animation of the page has ended (the Tera button keeps its own endless glow). */
async function settled(page) {
  await page.waitForFunction(() => document.getAnimations()
    .filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity)
    .every((a) => a.playState === 'finished'));
}

/**
 * Hides the floating Tera button, which glows for ever by design (not part of this package) and is fixed over the
 * bottom right of the page, so it can cover a scene in an element screenshot.
 */
function hideTera(page) {
  return page.addStyleTag({ content: 'button[title="Ask Tera"]{visibility:hidden!important;animation:none!important}' });
}

/** The animations inside the scenes: their state and timing. */
function sceneAnimations(page) {
  return page.evaluate(() => [...document.querySelectorAll('main svg.il')].flatMap((svg) => svg.getAnimations({ subtree: true }).map((a) => {
    const t = a.effect.getComputedTiming();
    return { scene: svg.dataset.scene, name: a.animationName, state: a.playState, end: t.endTime, iterations: t.iterations };
  })));
}

/**
 * Share of pixels that differ between two PNG screenshots (any channel off by more than 16), measured in the page.
 * With `scale` below 1 both are first scaled down: a scene that ends its entrance keeps its animated elements on their
 * own compositing layers, which moves an edge by a fraction of a pixel; half size hides that and still shows a
 * missing node or line.
 */
async function pixelDifference(page, a, b, scale = 1) {
  return page.evaluate(async ([x, y, k]) => {
    const load = async (b64) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return 1;
    const w = Math.max(1, Math.round(ia.width * k));
    const h = Math.max(1, Math.round(ia.height * k));
    const pixels = (img) => {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, w, h);
      return g.getImageData(0, 0, w, h).data;
    };
    const pa = pixels(ia);
    const pb = pixels(ib);
    let off = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (Math.abs(pa[i] - pb[i]) > 16 || Math.abs(pa[i + 1] - pb[i + 1]) > 16 || Math.abs(pa[i + 2] - pb[i + 2]) > 16) off += 1;
    }
    return off / (pa.length / 4);
  }, [a.toString('base64'), b.toString('base64'), scale]);
}

test.describe('Illustration library @sample-only', () => {
  test('the gallery shows every scene with its text alternative in English and Indonesian, under the release policy', async ({ page }) => {
    const requests = await underReleasePolicy(page);
    const labels = {};
    for (const [lang, query] of [[0, ''], [1, 'lang=id']]) {
      await openScreen(page, META, query);
      await expect(gallery(page)).toHaveCount(SCENES.length);
      for (const [i, scene] of SCENES.entries()) {
        const svg = gallery(page).nth(i);
        await expect(svg).toHaveAttribute('data-scene', scene);
        await expect(svg).toHaveAttribute('role', 'img');
        const label = await svg.getAttribute('aria-label');
        // The text alternative the gallery prints under the scene is the one assistive technology reads.
        await expect(page.locator('.ilg-card').nth(i).locator('dd').nth(1)).toHaveText(label);
        labels[scene] = [...(labels[scene] ?? []), label];
      }
      // The empty state of the UI kit holds the scene above its title.
      const empty = page.locator('main .mx-empty');
      await expect(empty.locator('.mx-empty-art svg.il[data-scene="no-documents"]')).toBeVisible();
      const art = await empty.locator('.mx-empty-art').boundingBox();
      const title = await empty.locator('.mx-empty-title').boundingBox();
      expect(art.y + art.height).toBeLessThanOrEqual(title.y);
      await expectNoHorizontalOverflow(page);
    }
    for (const scene of SCENES) {
      expect(labels[scene][0].length, scene).toBeGreaterThan(20);
      expect(labels[scene][1], `${scene}: Indonesian`).not.toBe(labels[scene][0]);
    }
    // L-1: nothing from another origin; the release policy needs no change.
    const origin = new URL(page.url()).origin;
    expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:')), 'requests to another origin').toEqual([]);
    expect(await page.evaluate(() => window.__violations), 'Content-Security-Policy violations').toEqual([]);
    // The example action of the empty state answers with a toast.
    await page.locator('main .mx-empty button', { hasText: 'Dokumen baru' }).click();
    await expectToast(page, 'Hanya contoh: tidak ada yang dibuat.');
  });

  test('the entrance ends within 1.2 seconds, never loops, and then the scenes stand still', async ({ page }) => {
    await openScreen(page, META);
    await settled(page);
    await page.locator('main button', { hasText: 'Replay entrance' }).click();
    const startedAt = await page.evaluate(() => document.timeline.currentTime);
    const started = await sceneAnimations(page);
    // Every scene moves, every movement plays once and ends within the budget.
    expect(new Set(started.map((a) => a.scene))).toEqual(new Set(SCENES));
    expect(started.filter((a) => a.state === 'running').length).toBeGreaterThan(SCENES.length * 3);
    for (const a of started) {
      expect(a.iterations, `${a.scene} ${a.name}`).toBe(1);
      expect(a.end, `${a.scene} ${a.name}`).toBeLessThanOrEqual(BUDGET_MS);
    }
    // 1.2 seconds on the clock of the animations (a busy machine may draw fewer frames, not change their timing).
    await page.waitForFunction((t) => document.timeline.currentTime >= t, startedAt + BUDGET_MS + 100);
    expect((await sceneAnimations(page)).filter((a) => a.state !== 'finished'), 'animations still running after 1.2 s').toEqual([]);
    await settled(page);
    await hideTera(page);
    const first = [];
    for (let i = 0; i < SCENES.length; i++) first.push(await gallery(page).nth(i).screenshot());
    // 42 frames later (0.7 s at 60 frames a second) the picture is still the same.
    await framesPass(page, 42);
    for (let i = 0; i < SCENES.length; i++) {
      expect(await pixelDifference(page, first[i], await gallery(page).nth(i).screenshot()), `${SCENES[i]}: pixels that changed after the entrance`).toBe(0);
    }
  });

  test('the scenes reserve their place: nothing moves around them while they enter', async ({ page }) => {
    await openScreen(page, META);
    await settled(page);
    const boxes = () => page.evaluate(() => [...document.querySelectorAll('main .ilg-stage svg.il, main .mx-empty-title, main .ilg-meta')]
      .map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','); }));
    const atRest = await boxes();
    await page.locator('main button', { hasText: 'Replay entrance' }).click();
    // Early in the entrance (60 ms after the replay on the page's animation clock), then half a second into it.
    const replayAt = await page.evaluate(() => document.timeline.currentTime);
    const into = (ms) => page.waitForFunction((t) => document.timeline.currentTime >= t, replayAt + ms);
    await into(60);
    expect(await boxes()).toEqual(atRest);
    await into(500);
    expect(await boxes()).toEqual(atRest);
  });

  test('reduced motion shows the final frame at once: no animation, the same picture as the end of the entrance', async ({ page, browser }) => {
    await openScreen(page, META);
    await settled(page);
    await hideTera(page);
    const ended = [];
    for (let i = 0; i < SCENES.length; i++) ended.push(await gallery(page).nth(i).screenshot());

    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const still = await context.newPage();
    try {
      await still.goto(`/?screen=illustrations&persona=${META.sampleRole}`);
      await expect(gallery(still)).toHaveCount(SCENES.length);
      expect(await sceneAnimations(still), 'animations under reduced motion').toEqual([]);
      await settled(still);
      await hideTera(still);
      for (let i = 0; i < SCENES.length; i++) {
        const diff = await pixelDifference(page, ended[i], await gallery(still).nth(i).screenshot(), 0.5);
        expect(diff, `${SCENES[i]}: still frame against the end of the entrance`).toBeLessThan(0.001);
      }
    } finally {
      await context.close();
    }
    // "Show still frames" in the gallery does the same on request.
    await page.locator('main label', { hasText: 'Show still frames' }).click();
    await page.locator('main button', { hasText: 'Replay entrance' }).click();
    await expect(scenes(page).first()).toHaveClass(/il-still/);
    expect(await sceneAnimations(page)).toEqual([]);
  });

  for (const theme of ['light', 'dark']) {
    test(`L-3 in the ${theme} theme: no text over a scene, readable text, and lines with meaning at 3:1 on the card`, async ({ page }) => {
      await openScreen(page, META, `theme=${theme}`);
      await settled(page);
      await expectReadableText(page, 4.5);
      const report = await page.evaluate(() => {
        const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const lum = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
        const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
        const low = [];
        const covered = [];
        const svgs = [...document.querySelectorAll('main svg.il')];
        for (const svg of svgs) {
          let card = svg.parentElement;
          while (card && getComputedStyle(card).backgroundColor.match(/rgba\([^)]*,\s*0\)|transparent/)) card = card.parentElement;
          const bg = rgb(getComputedStyle(card).backgroundColor);
          for (const el of svg.querySelectorAll('.il-ink,.il-field,.il-slot,.il-thread,.il-acc,.il-ok,.il-bad,.il-warn')) {
            const r = ratio(rgb(getComputedStyle(el).stroke), bg);
            if (r < 3) low.push(`${svg.dataset.scene} ${el.getAttribute('class')} ${r.toFixed(2)}`);
          }
          const box = svg.getBoundingClientRect();
          const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.nodeValue.trim() || !node.parentElement || node.parentElement.closest('svg')) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const t of range.getClientRects()) {
              if (t.right > box.left + 1 && t.left < box.right - 1 && t.bottom > box.top + 1 && t.top < box.bottom - 1) covered.push(`${svg.dataset.scene}: "${node.nodeValue.trim().slice(0, 30)}"`);
            }
          }
        }
        return { scenes: svgs.length, low, covered, text: svgs.reduce((n, s) => n + s.querySelectorAll('text').length, 0) };
      });
      expect(report.scenes).toBeGreaterThan(SCENES.length);
      expect(report.text, 'text elements inside the scenes').toBe(0);
      expect(report.low, 'lines with meaning under 3:1').toEqual([]);
      expect(report.covered, 'text drawn over a scene').toEqual([]);
    });
  }

  test('the API build holds no code of the gallery', async () => {
    test.setTimeout(180_000);
    // The API build of the current sources (VITE_DATA_SOURCE=api), built once and kept while they stay the same (M2-21).
    const outDir = await webBuild('api');
    const assets = readdirSync(path.join(outDir, 'assets')).filter((f) => /\.(js|css)$/.test(f));
    const text = assets.map((f) => readFileSync(path.join(outDir, 'assets', f), 'utf8')).join('\n');
    // The inert definition is there (the registry needs it), with its permission that no session holds.
    expect(text).toContain('sample-build-only');
    // The gallery page, its styles and the library stay out until a screen of the API build uses a scene.
    for (const marker of ['Illustration library', 'Pustaka ilustrasi', 'ilg-grid', 'Name in code']) expect(text, marker).not.toContain(marker);
  });
});
