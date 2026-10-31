// Measurement for the M3-02 handoff (Milestone 3 G.2): the build time and the peak use of the worker's temporary folder
// for an organisation with 1 GiB of Managed Vault files and three parts. Skipped unless MSCD_MEASURE_EXPORT=1, because
// it uploads 1 GiB to SeaweedFS; the result is printed and written to MSCD_MEASURE_OUT when that is set.
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { demoSession, type FullApp } from '../contract/harness';
import { startStorageStack, type StorageStack } from '../files/helpers';
import { buildExport, clearExports, createExportApp, putVaultFile } from './helpers';

const MIB = 1024 * 1024;
const FILES = 8;
const FILE_BYTES = 128 * MIB;
const PART_BYTES = 400 * MIB;

/** Bytes in the export working folders of the temporary folder. */
async function workBytes(): Promise<number> {
  let total = 0;
  for (const name of await readdir(os.tmpdir()).catch(() => [] as string[])) {
    if (!name.startsWith('mscd-org-export-')) continue;
    const dir = path.join(os.tmpdir(), name);
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      total += (await stat(path.join(dir, file)).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

describe.skipIf(process.env.MSCD_MEASURE_EXPORT !== '1')('organisation export measurement (1 GiB, three parts)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let full: FullApp;

  beforeAll(async () => {
    stack = await startStorageStack();
    full = await createExportApp(db, stack.gateway.url);
    await clearExports(db, 'tst');
    for (let n = 1; n <= FILES; n += 1) await putVaultFile(full, db, 'tst', `Measure file ${n}.bin`, randomBytes(FILE_BYTES));
  }, 1_800_000);
  afterAll(async () => {
    await full?.close();
    await stack?.close();
  });

  it('builds 1 GiB of files into three parts and reports time and peak temporary disk use', async () => {
    const rina = await demoSession(full, db, 'rina', 'tst');
    const admin = await demoSession(full, db, 'tenant.admin', 'tst');
    const created = await rina.post<{ data: { id: string } }>('/api/v1/admin/organization/exports', {});
    const id = created.body.data.id;
    expect((await admin.post(`/api/v1/admin/organization/exports/${id}/decision`, { approve: true })).status).toBe(200);
    let peak = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        peak = Math.max(peak, await workBytes());
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();
    const started = Date.now();
    const outcome = await buildExport(full, 'tst', id, PART_BYTES);
    const seconds = (Date.now() - started) / 1000;
    sampling = false;
    await sampler;
    expect(outcome.status, outcome.error).toBe('ready');
    expect(outcome.parts).toBe(3);
    const result = {
      vaultBytes: FILES * FILE_BYTES,
      partBytes: PART_BYTES,
      parts: outcome.parts,
      exportBytes: outcome.sizeBytes,
      files: outcome.files,
      buildSeconds: Math.round(seconds * 10) / 10,
      peakTempBytes: peak,
      peakTempMiB: Math.round((peak / MIB) * 10) / 10,
    };
    process.stdout.write(`org-export measurement: ${JSON.stringify(result)}\n`);
    if (process.env.MSCD_MEASURE_OUT) {
      await mkdir(path.dirname(process.env.MSCD_MEASURE_OUT), { recursive: true });
      await writeFile(process.env.MSCD_MEASURE_OUT, `${JSON.stringify(result, null, 2)}\n`);
    }
  }, 1_800_000);
});
