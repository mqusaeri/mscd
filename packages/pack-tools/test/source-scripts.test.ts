// The source scripts of packs/scripts (Milestone 2 E.1): the `removed.csv` rules of extract-from-sample.mjs, the
// activity numbering that validate-sources.mjs asks of a removal, and mapping sources in the validator. Every case
// runs the scripts on a temporary copy of the files they read, so the repository is never written.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, SOURCES_DIR, tempDir } from './helpers.js';

type Run = { status: number | null; stdout: string; stderr: string };

/** A temporary tree with the two scripts, the sample module they read, packs/sources and packs/content. */
function scriptTree(): string {
  const root = tempDir('mscd-pack-scripts-');
  cpSync(path.join(REPO_ROOT, 'packs/scripts'), path.join(root, 'packs/scripts'), { recursive: true });
  cpSync(SOURCES_DIR, path.join(root, 'packs/sources'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'packs/content'), path.join(root, 'packs/content'), { recursive: true });
  const data = path.join(root, 'apps/web/src/data');
  mkdirSync(data, { recursive: true });
  for (const file of ['mscd-data.js', 'static.js', 'dates.js']) cpSync(path.join(REPO_ROOT, 'apps/web/src/data', file), path.join(data, file));
  writeFileSync(path.join(root, 'apps/web/package.json'), '{ "type": "module" }\n');
  return root;
}

/** Runs a script of packs/scripts (of `root`, or of the repository) with Node. */
function run(root: string, script: string, args: readonly string[] = []): Run {
  const result = spawnSync(process.execPath, [path.join(root, 'packs/scripts', script), ...args], { cwd: root, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Writes a file of packs/content/<packId>/ in the tree. */
function writeContent(root: string, packId: string, file: string, text: string): void {
  const target = path.join(root, 'packs/content', packId, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

const REMOVED_HEADER = 'dataset,code,reason\n';
/** Each case starts several Node processes; a busy build host needs more than the default 5 seconds. */
const SLOW = 60_000;

describe('extract-from-sample.mjs removed.csv (E.1)', () => {
  it('passes --check on an unchanged copy', () => {
    const root = scriptTree();
    const result = run(root, 'extract-from-sample.mjs', ['--check']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^packs\/sources matches the sample: \d+ files in 6 packs$/m);
  }, SLOW);

  it('fails --check on a removed code that is not in the extract, a requirement or catalogue row, an empty reason, and a code a content file adds again', () => {
    const cases: [string, (root: string) => void, string][] = [
      ['not in the extract', (r) => writeContent(r, 'ISO9001-2026', 'removed.csv', `${REMOVED_HEADER}activities.csv,99.1,Not a sample activity\n`),
        'packs/content/ISO9001-2026/removed.csv: activities.csv 99.1 is not in the sample extract'],
      ['requirement', (r) => writeContent(r, 'ISO27001-2022', 'removed.csv', `${REMOVED_HEADER}requirements.csv,10.3,Left the standard\n`),
        'packs/content/ISO27001-2022/removed.csv:2: rows of requirements.csv are never removed; mark the row retired instead'],
      ['catalogue item', (r) => writeContent(r, 'ISO27001-2022', 'removed.csv', `${REMOVED_HEADER}catalogue.csv,A.8.34,Left the standard\n`),
        'packs/content/ISO27001-2022/removed.csv:2: rows of catalogue.csv are never removed; mark the row retired instead'],
      ['empty reason', (r) => writeContent(r, 'ISO27001-2022', 'removed.csv', `${REMOVED_HEADER}prep_tasks.csv,PREP-01, \n`),
        'packs/content/ISO27001-2022/removed.csv:2: reason is empty'],
      ['added again', (r) => {
        writeContent(r, 'ISO27001-2022', 'removed.csv', `${REMOVED_HEADER}prep_tasks.csv,PREP-01,Demo text\n`);
        const [header, first] = readFileSync(path.join(r, 'packs/sources/ISO27001-2022/prep_tasks.csv'), 'utf8').split('\n');
        writeContent(r, 'ISO27001-2022', 'prep_tasks.csv', `${header}\n${first}\n`);
      }, 'packs/content/ISO27001-2022/removed.csv: prep_tasks.csv PREP-01 is removed but still in the output (a content file adds it again)'],
    ];
    for (const [label, change, message] of cases) {
      const root = scriptTree();
      change(root);
      const before = readFileSync(path.join(root, 'packs/sources/ISO27001-2022/prep_tasks.csv'), 'utf8');
      for (const args of [['--check'], []]) {
        const result = run(root, 'extract-from-sample.mjs', args);
        expect(result.status, `${label} ${args.join(' ')}`).toBe(1);
        expect(result.stderr.trim(), label).toBe(`extract-from-sample: ${message}`);
      }
      // The run stops before anything is written.
      expect(readFileSync(path.join(root, 'packs/sources/ISO27001-2022/prep_tasks.csv'), 'utf8'), label).toBe(before);
    }
  }, SLOW);

  it('drops the whole transition phase of ISO 9001:2026, which the validator accepts, and refuses a gap inside a phase', () => {
    const phase = (root: string) => readFileSync(path.join(root, 'packs/sources/ISO9001-2026/activities.csv'), 'utf8')
      .split('\n').filter((line) => line.startsWith('9,')).length;

    const whole = scriptTree();
    expect(phase(whole)).toBe(14);
    const rows = Array.from({ length: 14 }, (_, i) => `activities.csv,9.${i + 1},Demo transition step (E.4)\n`).join('');
    writeContent(whole, 'ISO9001-2026', 'removed.csv', `${REMOVED_HEADER}${rows}`);
    expect(run(whole, 'extract-from-sample.mjs', ['--check']).status).toBe(1);
    const written = run(whole, 'extract-from-sample.mjs');
    expect(written.status, written.stderr).toBe(0);
    expect(phase(whole)).toBe(0);
    expect(run(whole, 'extract-from-sample.mjs', ['--check']).status).toBe(0);
    const valid = run(whole, 'validate-sources.mjs');
    expect(valid.status, valid.stderr).toBe(0);

    const gap = scriptTree();
    writeContent(gap, 'ISO9001-2026', 'removed.csv', `${REMOVED_HEADER}activities.csv,9.1,Demo transition step\n`);
    expect(run(gap, 'extract-from-sample.mjs').status).toBe(0);
    expect(phase(gap)).toBe(13);
    const invalid = run(gap, 'validate-sources.mjs');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('ISO9001-2026/activities.csv: phase 9 activity numbers are not contiguous from 1 (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14)');
  }, SLOW);
});

describe('validate-sources.mjs mapping sources', () => {
  it('refuses a mapping from a retired requirement or catalogue item and keeps one from a row in the standard', () => {
    const sources = (mappings: string): string => {
      const dir = tempDir('mscd-pack-sources-');
      const pack = path.join(dir, 'ISO27001-2022');
      cpSync(path.join(SOURCES_DIR, 'ISO27001-2022'), pack, { recursive: true });
      for (const [file, code] of [['requirements.csv', '10.3'], ['catalogue.csv', 'A.8.34']] as const) {
        const [header = '', ...lines] = readFileSync(path.join(pack, file), 'utf8').trimEnd().split('\n');
        expect(header.endsWith(',retired')).toBe(true);
        const changed = lines.map((line) => (line.startsWith(`${code},`) ? line.replace(/,false$/, ',true') : line));
        expect(changed.filter((line, i) => line !== lines[i])).toHaveLength(1);
        writeFileSync(path.join(pack, file), `${[header, ...changed].join('\n')}\n`);
      }
      mkdirSync(path.join(pack, 'mappings'));
      writeFileSync(path.join(pack, 'mappings/ISO9001-2015.csv'), `source_code,target_pack_id,target_code,mapping_type,evidence_reusable,note\n${mappings}`);
      return dir;
    };

    const live = run(REPO_ROOT, 'validate-sources.mjs', ['--dir', sources('10.2,ISO9001-2015,10.2,equivalent,true,\nA.5.1,ISO9001-2015,5.2,related,false,\n')]);
    expect(live.status, live.stderr).toBe(0);
    const retired = run(REPO_ROOT, 'validate-sources.mjs', ['--dir', sources('10.3,ISO9001-2015,10.3,equivalent,true,\nA.8.34,ISO9001-2015,9.2,related,false,\n')]);
    expect(retired.status).toBe(1);
    expect(retired.stderr).toContain('"10.3" names a retired requirement or catalogue item');
    expect(retired.stderr).toContain('"A.8.34" names a retired requirement or catalogue item');
  }, SLOW);
});
