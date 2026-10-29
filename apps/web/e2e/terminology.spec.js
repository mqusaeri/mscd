// Terminology of M2-17 (product decision 10 of CLAUDE.md): the screens say "Checkpoint" and "Management System Manager"
// in English and Indonesian. The new words are longer than "gate" and "MS Manager", so every place that shows them is
// checked in both languages and themes at the narrow and wide widths of the layout checks (display.spec.js): the top
// bar, the Viewing as menu, the CHECKPOINT tag, table headers, the Phase board banner, the Portfolio cards and the Tera
// help. Each text with a new word is at least 12px, meets WCAG AA contrast and is not cut off by its box or the page.
import { test, expect, openApp, go, tab, ui, expectNoHorizontalOverflow, expectNoTextOverflow, finishAnimations } from './helpers.js';

const MSM = 'Management System Manager';
const LANGS = {
  en: {
    screens: { overview: 'Overview', controls: 'Controls & requirements', phases: 'Phase board' },
    tab: 'Open checkpoint items, Risk & SoA', heads: ['Checkpoint item', 'Why it blocks the checkpoint'],
    stat: 'Open checkpoint items', next: 'Next checkpoint', banner: 'Critical checkpoint:', tera: 'Ask Tera',
    teraText: 'A checkpoint is a phase that must be fully signed off',
  },
  id: {
    screens: { overview: 'Ikhtisar', controls: 'Kontrol & persyaratan', phases: 'Papan fase' },
    tab: 'Item checkpoint terbuka, Risiko & SoA', heads: ['Item checkpoint', 'Mengapa memblokir checkpoint'],
    stat: 'Item checkpoint terbuka', next: 'Checkpoint berikutnya', banner: 'Checkpoint kritis:', tera: 'Tanya Tera',
    teraText: 'Checkpoint adalah fase yang wajib disahkan penuh',
  },
};

// Every element whose own text holds a new word: its size, its contrast against the backgrounds behind it, and
// whether a box that clips (overflow other than visible) or the page cuts it off. Returns the problems and the count.
async function termProblems(page) {
  await finishAnimations(page);
  return page.evaluate(() => {
    const WORDS = /checkpoint|Management System Manager/i;
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    // The backgrounds behind the text, from the element up to the first opaque one. A soft background image (the
    // page tint) counts as its background colour, or as the page colour when it has none.
    const bgOf = (el) => {
      const layers = [];
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const c = parse(cs.backgroundColor);
        if (cs.backgroundImage !== 'none') { if (c && c.a > 0) layers.push({ ...c, a: 1 }); break; }
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      let out = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      out = { ...out, a: 1 };
      for (const l of layers.reverse()) out = blend(l, out);
      return out;
    };
    const out = [];
    let count = 0;
    const page = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg')) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (!own || !WORDS.test(own) || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      count += 1;
      const what = `"${own.slice(0, 50)}"`;
      const size = parseFloat(cs.fontSize);
      if (size < 11.95) out.push(`${cs.fontSize} under 12px: ${what}`);
      const fg = parse(cs.color);
      const bg = bgOf(el);
      if (fg && bg) {
        const c = blend(fg, bg);
        const ratio = (Math.max(lum(c), lum(bg)) + 0.05) / (Math.min(lum(c), lum(bg)) + 0.05);
        const min = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66) ? 3 : 4.5;
        if (ratio < min) out.push(`contrast ${ratio.toFixed(2)} < ${min}: ${what}`);
      }
      const r = el.getBoundingClientRect();
      if (r.right > page + 1 || r.left < -1) out.push(`outside the page: ${what}`);
      if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) out.push(`cut off (${el.scrollWidth} > ${el.clientWidth}): ${what}`);
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
        if (ps.overflowX === 'auto' || ps.overflowX === 'scroll' || ps.overflowY === 'auto' || ps.overflowY === 'scroll') break;
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.bottom > pr.bottom + 1) out.push(`cut off by its box: ${what}`);
        break;
      }
    }
    return { problems: [...new Set(out)], count };
  });
}

async function expectTermsReadable(page, state) {
  const { problems, count } = await termProblems(page);
  expect(count, `${state}: texts with the new words`).toBeGreaterThan(0);
  expect(problems, `${state}: texts with the new words`).toEqual([]);
  await expectNoTextOverflow(page);
  await expectNoHorizontalOverflow(page);
}

for (const width of [1280, 1920]) {
  for (const [lang, L] of Object.entries(LANGS)) {
    test(`Checkpoint and Management System Manager fit and stay readable, ${lang} at ${width} px`, { tag: '@sample-only' }, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        const at = `${lang} ${theme} ${width}`;
        await openApp(page, `?lang=${lang}&theme=${theme}`);
        // Portfolio cards and the Needs attention list, with the role chip of the top bar.
        await expect(page.locator('main')).toContainText(L.stat);
        await expect(page.locator('header')).toContainText(`${MSM}, ISMS Manager`);
        await expectTermsReadable(page, `${at} Portfolio`);
        // The Viewing as menu.
        await ui.roleButton(page).click();
        const menu = page.locator('header div[style*="width: 300px"]');
        await expect(menu).toContainText(MSM);
        await expectTermsReadable(page, `${at} Viewing as menu`);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        // Overview: the CHECKPOINT tag of the phase list and the next checkpoint.
        await go(page, L.screens.overview);
        await expect(page.locator('main')).toContainText('CHECKPOINT');
        await expect(page.locator('main')).toContainText(L.next);
        await expectTermsReadable(page, `${at} Overview`);
        // Controls & requirements: the tab of open checkpoint items and its table headers.
        await go(page, L.screens.controls);
        await tab(page, L.tab).click();
        for (const head of L.heads) await expect(page.locator('main th', { hasText: head })).toHaveCount(1);
        await expectTermsReadable(page, `${at} Controls & requirements`);
        // Phase board: the CHECKPOINT tag of the current phase, the banner and the Tera help.
        await go(page, L.screens.phases);
        await expect(page.locator('main')).toContainText(L.banner);
        await expectTermsReadable(page, `${at} Phase board`);
        await page.locator(`button[title="${L.tera}"]`).click({ force: true });
        await expect(ui.teraCard(page)).toContainText(L.teraText);
        await expectTermsReadable(page, `${at} Phase board help`);
      }
    });
  }
}
