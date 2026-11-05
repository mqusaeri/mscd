// Screenshots for the user acceptance test guide (UAT). Off unless UAT_SHOTS_DIR names a folder: then every screen the
// runs check for readability, every dialog and every toast is saved as a PNG of the viewport, with one line per picture
// in index.jsonl (run, test, kind, label, path of the screen, file). UAT_SHOTS_RUN names the run in the file names.
// A failed screenshot never fails a run.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

const DIR = process.env.UAT_SHOTS_DIR || '';
const RUN = (process.env.UAT_SHOTS_RUN || 'run').replace(/[^a-z0-9-]/gi, '');
let seq = 0;

export async function uatShot(page, label, kind) {
  if (!DIR) return;
  try {
    mkdirSync(DIR, { recursive: true });
    let title = '';
    try {
      title = test.info().title;
    } catch {
      title = '';
    }
    seq += 1;
    const file = `${RUN}-${String(seq).padStart(4, '0')}.png`;
    await page.screenshot({ path: path.join(DIR, file), animations: 'disabled' });
    const url = page.url().replace(/^https?:\/\/[^/]+/, '');
    appendFileSync(path.join(DIR, 'index.jsonl'), `${JSON.stringify({ run: RUN, seq, test: title, kind, label, url, file })}\n`);
  } catch {
    // a screenshot is a by-product of the run
  }
}
