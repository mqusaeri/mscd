// Readability checks of the journey (MILESTONE-2 M2-18), after apps/web/e2e/helpers.js (contrastProblems,
// expectReadableText, expectOverlayReadable) and e2e/contrast.spec.js. tools/smoke keeps its own copy, as it does for
// the TOTP helper, so the journey depends on nothing outside this folder.
//
// Every visible text of the page (main column, sidebar, top bar, drawer and dialog) is measured against the colour
// actually behind it, with the backgrounds and opacities of every ancestor composited: WCAG 2.1 AA, 4.5:1 for normal
// text and 3:1 for large text (24px, or 18.66px bold). No text may be smaller than 12px (CLAUDE.md). A check whose
// scope finds no visible text fails, so a screen outside the scope is never passed unmeasured.
/* global document, getComputedStyle */
import { expect } from '@playwright/test';

/** The app shell (main column, sidebar, top bar, drawer and dialog); the sign-in pages keep their card in main. */
export const SCOPE = 'main *, aside *, header *, div[style*="z-index: 41"] *, div[style*="z-index: 51"] *';
/** The full-page message of the app (no role yet, a failed start), which has no main column. */
export const PANEL_SCOPE = 'div.mscd[role] *';
const OVERLAY_SCOPE = 'div[style*="z-index: 41"] *, div[style*="z-index: 51"] *';

/** Entry animations jump to their end state, so the checks see the resting colours. */
async function finishAnimations(page) {
  await page.evaluate(() => document.getAnimations().forEach((a) => {
    if (a.effect && a.effect.getComputedTiming().iterations !== Infinity) a.finish();
  }));
}

/** Texts below WCAG AA contrast or under 12px, as readable lines, and the number of texts measured. */
export async function readabilityProblems(page, scope = SCOPE) {
  await finishAnimations(page);
  return page.evaluate((scope) => {
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return { r: 0, g: 0, b: 0, a: 0 }; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const over = (s, d) => ({ r: s.r * s.a + d.r * d.a * (1 - s.a), g: s.g * s.a + d.g * d.a * (1 - s.a), b: s.b * s.a + d.b * d.a * (1 - s.a), a: s.a + d.a * (1 - s.a) });
    const solid = (c) => (c.a ? { r: c.r / c.a, g: c.g / c.a, b: c.b / c.a, a: 1 } : c);
    const fade = (c, o) => ({ ...c, a: c.a * o });
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const out = [];
    let measured = 0;
    for (const el of document.querySelectorAll(scope)) {
      if (el.closest('svg')) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      if (!own || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      measured += 1;
      const size = parseFloat(cs.fontSize);
      if (size < 11.95) out.push(`${cs.fontSize} "${own.slice(0, 40)}" is under 12px`);
      const bg = parse(cs.backgroundColor);
      let text = over(parse(cs.color), bg), back = bg;
      for (let e = el; e; e = e.parentElement) {
        if (e !== el) { const b = parse(getComputedStyle(e).backgroundColor); if (b.a) { text = over(text, b); back = over(back, b); } }
        const o = Number(getComputedStyle(e).opacity); if (o < 1) { text = fade(text, o); back = fade(back, o); }
      }
      const pageBg = parse(getComputedStyle(document.body).backgroundColor);
      const t = solid(over(text, pageBg)), k = solid(over(back, pageBg));
      const [hi, lo] = [lum(t), lum(k)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const bold = Number(cs.fontWeight) >= 700;
      const min = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < min) out.push(`${ratio.toFixed(2)}:1 below ${min}:1 "${own.slice(0, 40)}" ${cs.color} on rgb(${[k.r, k.g, k.b].map(Math.round).join(', ')})`);
    }
    return { problems: out, measured };
  }, scope);
}

async function expectReadable(page, label, scope) {
  const { problems, measured } = await readabilityProblems(page, scope);
  expect(measured, `visible texts of ${label} to measure (scope ${scope})`).toBeGreaterThan(0);
  expect(problems, `texts of ${label} below WCAG AA contrast or under 12px`).toEqual([]);
}

/** Every text of the page meets WCAG AA contrast and is at least 12px (the app shell, or the scope given). */
export async function expectReadableText(page, label = 'the screen', scope = SCOPE) {
  await expectReadable(page, label, scope);
}

/** The open dialog or drawer: every text meets WCAG AA contrast and is at least 12px. */
export async function expectOverlayReadable(page, label = 'the dialog') {
  await expect(page.locator('div[style*="z-index: 41"], div[style*="z-index: 51"]').first()).toBeVisible();
  await expectReadable(page, label, OVERLAY_SCOPE);
}
