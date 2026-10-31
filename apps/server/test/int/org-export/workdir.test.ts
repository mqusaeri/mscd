// The working folders of `org-export.build` (Milestone 3 D.4), without a database. The worker's temporary folder is a
// scratch volume in Compose and an emptyDir in Helm, which keep their content when the worker restarts, so a build
// that died leaves its folder behind. Each build first removes the folders of earlier builds that nobody touched for
// STALE_BUILD_HOURS, and leaves a current build's folder and every other file alone.
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STALE_BUILD_HOURS } from '../../../src/modules/org-export/expiry';
import { removeStaleWorkDirs, WORK_DIR_PREFIX } from '../../../src/modules/org-export/org-export-build.job';

describe('org-export.build removes the working folders of builds that stopped (D.4)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-02-workdir-'));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('removes only old build folders', async () => {
    const old = new Date(Date.now() - (STALE_BUILD_HOURS + 1) * 3_600_000);
    const stale = path.join(root, `${WORK_DIR_PREFIX}aaaaaaaa-stale`);
    const current = path.join(root, `${WORK_DIR_PREFIX}bbbbbbbb-current`);
    const other = path.join(root, 'evidence-pack-old');
    for (const dir of [stale, current, other]) await mkdir(dir);
    await writeFile(path.join(stale, 'mscd-export-tst-part-001.tar.gz'), Buffer.alloc(1024));
    await writeFile(path.join(root, `${WORK_DIR_PREFIX}file`), 'not a folder');
    await utimes(stale, old, old);
    await utimes(other, old, old);
    await utimes(path.join(root, `${WORK_DIR_PREFIX}file`), old, old);

    const removed = await removeStaleWorkDirs(root, new Logger('test'));
    expect(removed).toEqual([stale]);
    expect((await readdir(root)).sort()).toEqual(['evidence-pack-old', `${WORK_DIR_PREFIX}bbbbbbbb-current`, `${WORK_DIR_PREFIX}file`].sort());
    // A second run changes nothing, and a missing folder is no error.
    expect(await removeStaleWorkDirs(root, new Logger('test'))).toEqual([]);
    expect(await removeStaleWorkDirs(path.join(root, 'missing'), new Logger('test'))).toEqual([]);
  });
});
