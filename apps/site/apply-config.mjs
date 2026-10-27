#!/usr/bin/env node
// Writes APP_URL and DEMO_EMAIL from site.config.mjs into the pages of the site.
// Only marked elements change: links with `data-app-link` or `data-demo-link`, and
// elements with `data-demo-email`, whose text is the address.
//
//   node apps/site/apply-config.mjs           rewrite the pages
//   node apps/site/apply-config.mjs --check   exit 1 when a page differs from the config
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, DEMO_EMAIL } from './site.config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PAGES = ['index.html', 'id/index.html'];

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Returns the page with every marked value replaced by the configured one. */
export function applyConfig(html) {
  return html
    .replace(/href="[^"]*"(\s+data-app-link)/g, (_, rest) => `href="${escapeAttr(APP_URL)}"${rest}`)
    .replace(/href="mailto:[^"?]*(\?[^"]*)?"(\s+data-demo-link)/g,
      (_, query = '', rest) => `href="mailto:${escapeAttr(DEMO_EMAIL)}${query}"${rest}`)
    .replace(/(<([a-z]+)[^>]*\sdata-demo-email[^>]*>)[^<]*(<\/\2>)/g,
      (_, open, _tag, close) => `${open}${escapeText(DEMO_EMAIL)}${close}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const page of PAGES) {
    const file = join(here, page);
    const before = readFileSync(file, 'utf8');
    const after = applyConfig(before);
    if (before === after) continue;
    stale += 1;
    if (check) process.stderr.write(`${page}: links differ from site.config.mjs\n`);
    else { writeFileSync(file, after); process.stdout.write(`${page}: updated\n`); }
  }
  if (check && stale) process.exit(1);
  if (!stale) process.stdout.write('Pages match site.config.mjs\n');
}
