// The organisation export commands of single tenancy (Milestone 3 D.3, D.4): `export organization --out <dir>` builds
// the parts and the manifest into an empty folder with the builder of the worker job (audited), refuses a folder that
// is not empty and refuses in multi tenancy with the message to use the web app; `export verify --dir <dir>` passes on
// the folder, with the anchor keys of this build, and fails on a changed byte; the build refuses while another export
// is being built in the installation, and refuses a private key as `--anchor-key`. Both commands are registered with
// their options.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportOrganization, exportVerify, MULTI_TENANCY_REFUSAL } from '../../../src/cli/export';
import { BUILD_BUSY_MESSAGE, BUILD_LOCK_CLASS, BUILD_LOCK_KEY } from '../../../src/modules/org-export/build-lock';
import { buildProgram } from '../../../src/program';
import { useTestDatabase } from '../../setup/test-db';
import { MULTI } from '../entitlements/helpers';
import { rowsIn, type FullApp } from '../contract/harness';
import { startStorageStack, type StorageStack } from '../files/helpers';
import { createExportApp, putVaultFile, sha256 } from './helpers';

describe('export organization and export verify (D.4)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let full: FullApp;
  let work: string;
  const fileBody = Buffer.from('Kebijakan keamanan informasi, versi 3\n'.repeat(2000));

  beforeAll(async () => {
    stack = await startStorageStack();
    full = await createExportApp(db, stack.gateway.url);
    await putVaultFile(full, db, 'tst', 'Kebijakan keamanan informasi.txt', fileBody);
    work = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-02-cli-'));
  }, 240_000);
  afterAll(async () => {
    await full?.close();
    await stack?.close();
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('registers both commands with their options', () => {
    const exportCommand = buildProgram().commands.find((c) => c.name() === 'export') as Command;
    const flags = (name: string) => exportCommand.commands.find((c) => c.name() === name)!.options.map((o) => o.long);
    expect(flags('organization')).toEqual(['--out', '--org', '--anchor-key']);
    expect(flags('verify')).toEqual(['--dir', '--anchor-key']);
  });

  it('builds the export into an empty folder, audited, and the folder verifies', async () => {
    const config = db.config({ MSCD__STORAGE__GATEWAY__URL: stack.gateway.url, MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
    const out = path.join(work, 'export');
    const result = await exportOrganization(config, { out, org: 'tst' }, undefined, 512 * 1024);
    expect(result.orgSlug).toBe('tst');
    expect(result.parts.length).toBeGreaterThanOrEqual(2);
    const names = (await readdir(out)).sort();
    expect(names).toEqual([...result.parts.map((p) => p.name), result.manifestFile].sort());
    for (const part of result.parts) expect(sha256(await readFile(path.join(out, part.name)))).toBe(part.sha256);
    const manifest = JSON.parse(await readFile(path.join(out, result.manifestFile), 'utf8')) as { requestedVia: string; entries: { path: string }[] };
    expect(manifest.requestedVia).toBe('cli');
    expect(manifest.entries.some((e) => e.path.endsWith('/Kebijakan keamanan informasi.txt'))).toBe(true);
    const audit = await rowsIn<{ after_data: { requestedVia: string; parts: unknown[] } }>(db, 'tst', sql`
      select after_data from audit_trail where action = 'organization_export.built' and entity_id = ${result.exportId}`);
    expect(audit[0]!.after_data).toMatchObject({ requestedVia: 'cli' });
    expect(audit[0]!.after_data.parts).toHaveLength(result.parts.length);

    const report = await exportVerify(out);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(result.anchorKeyIdsWithoutKey).toEqual([]);

    // A changed byte in the last part is found.
    const last = path.join(out, result.parts.at(-1)!.name);
    const bytes = await readFile(last);
    bytes[Math.floor(bytes.length / 3)] ^= 0x01;
    await writeFile(last, bytes);
    const bad = await exportVerify(out);
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBeGreaterThan(0);
  });

  it('refuses a folder that is not empty, an unknown organisation, and multi tenancy', async () => {
    const config = db.config({ MSCD__STORAGE__GATEWAY__URL: stack.gateway.url, MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
    const busy = path.join(work, 'busy');
    await mkdir(busy, { recursive: true });
    await writeFile(path.join(busy, 'other.txt'), 'x');
    await expect(exportOrganization(config, { out: busy, org: 'tst' })).rejects.toThrow(/is not empty/);
    await expect(exportOrganization(config, { out: path.join(work, 'nobody'), org: 'nosuchorg' })).rejects.toThrow(/Unknown organisation nosuchorg/);
    await expect(exportOrganization(config, { out: path.join(work, 'all') })).rejects.toThrow(/name one with --org/);
    // A private key as --anchor-key is refused before anything is written.
    const privateKey = path.resolve(__dirname, '../../fixtures/secrets/audit-anchor.key');
    await expect(exportOrganization(config, { out: path.join(work, 'private-key'), org: 'tst', anchorKey: privateKey })).rejects.toThrow(/private key/);
    await expect(readdir(path.join(work, 'private-key'))).rejects.toThrow();
    const multi = db.config({ ...MULTI, MSCD__STORAGE__GATEWAY__URL: stack.gateway.url }, 'cli');
    await expect(exportOrganization(multi, { out: path.join(work, 'multi'), org: 'tst' })).rejects.toThrow(MULTI_TENANCY_REFUSAL);
    // Nothing was written for the refused multi-tenancy run.
    await expect(readdir(path.join(work, 'multi'))).rejects.toThrow();
  });

  it('refuses while another organisation export is being built in the installation', async () => {
    const config = db.config({ MSCD__STORAGE__GATEWAY__URL: stack.gateway.url, MSCD__MAIL__SMTP__PORT: '9' }, 'cli');
    const out = path.join(work, 'busy-build');
    await db.migrator.connection().execute(async (conn) => {
      await sql`select pg_advisory_lock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY})`.execute(conn);
      try {
        await expect(exportOrganization(config, { out, org: 'tst' })).rejects.toThrow(BUILD_BUSY_MESSAGE);
      } finally {
        await sql`select pg_advisory_unlock(${BUILD_LOCK_CLASS}, ${BUILD_LOCK_KEY})`.execute(conn);
      }
    });
    // Nothing but the empty folder was written.
    expect(await readdir(out)).toEqual([]);
  });

  it('reports a folder without parts', async () => {
    const empty = path.join(work, 'empty');
    await mkdir(empty, { recursive: true });
    const report = await exportVerify(empty);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatch(/No part/);
  });
});
