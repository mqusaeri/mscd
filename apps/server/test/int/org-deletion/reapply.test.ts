// Re-applying a verified deletion after a restore (Milestone 3 D.5.6; M3-03). Organisation A (acme) is purged in a first
// test database and its signed certificate kept. Two more test databases stand for copies restored from before the
// purge: in one, A is archived with its deletion scheduled (the state of the night before the purge); in the other, A is
// active and has no deletion row (a copy from before the end of the contract). `tenant purge --reapply` with the
// certificate moves A to archived with a running deletion and queues `org.purge`; the purge deletes A again with a new
// certificate and leaves B intact; a copy taken while an earlier purge had failed part way runs every step again. A
// certificate with a changed byte, a certificate of another organisation id, and a
// slug that names another organisation are refused and change nothing. All three databases, the bucket and the gateway
// belong to this file (R-20).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatPurgeOutcome, tenantPurgeReapply } from '../../../src/cli/tenant';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { compiledAnchorKeys } from '../../../src/modules/audit/anchors';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { verifyCertificateText } from '../../../src/modules/ops/deletion/certificate';
import { DeletionService } from '../../../src/modules/ops/deletion/deletion.service';
import { PurgeRunner } from '../../../src/modules/ops/deletion/purge-runner';
import { createTestDatabase, type TestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { addPerson, inPlatform, sessionIn } from '../onboarding/helpers';
import {
  MULTI, STATUS, createDeletionApp, createVaultTenant, deletionsOf, makeDue, orgRow, putVaultObject, schemaExists, startDeletionStack, vaultVersions,
  waiting, type DeletionStack,
} from './helpers';

const ACME_ID = '0a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

/** A test database with the api application of this file, for one copy of the installation. */
interface Copy {
  db: TestDatabase;
  full: FullApp;
  acme: CreatedTenant;
  bumi: CreatedTenant;
  close(): Promise<void>;
}

describe('tenant purge --reapply after a restore (Milestone 3 D.5.6; M3-03)', () => {
  let stack: DeletionStack;
  let dir: string;
  let original: Copy;
  let certificateFile: string;
  let certificateText: string;

  const copy = async (acmeStatus: 'active' | 'archived'): Promise<Copy> => {
    const db = await createTestDatabase('empty');
    const full = await createDeletionApp(db, stack);
    const acme = await createVaultTenant(db, stack, 'acme', { id: ACME_ID, name: 'PT Acme Lestari' });
    const bumi = await createVaultTenant(db, stack, 'bumi', { name: 'PT Bumi Raya' });
    await addPerson(db, 'acme.admin', [{ org: acme, adminRoles: ['tenant_admin'] }], { password: true });
    await addPerson(db, 'bumi.admin', [{ org: bumi, adminRoles: ['tenant_admin'] }], { password: true });
    await putVaultObject(db, stack, acme, 'Acme register.csv');
    await putVaultObject(db, stack, bumi, 'Bumi register.csv');
    if (acmeStatus === 'archived') {
      const operator = await addPerson(db, 'ops.copy', [], { platformOperator: true, password: true });
      for (const [status, reason] of [['offboarding', 'Contract ended on 31 Oct 2026'], ['archived', 'Read-only period over']] as const) {
        const call = await callRoute(await sessionIn(full, operator.id, null), STATUS, { params: { org: 'acme' }, body: { status, reason, confirmSlug: 'acme' } });
        expect(call.status, call.text).toBe(200);
      }
    }
    return {
      db,
      full,
      acme,
      bumi,
      close: async () => {
        await full.close().catch(() => undefined);
        await db.drop().catch(() => undefined);
      },
    };
  };
  const reapply = (target: Copy, file: string, confirm: string) =>
    tenantPurgeReapply(target.db.config({ ...MULTI, MSCD__STORAGE__GATEWAY__URL: stack.gateway.url }), { reapply: file, confirm, wait: false }, target.full.app, compiledAnchorKeys());

  /** Runs the queued purge of the copy (the worker's part) and checks the outcome. */
  const purgeQueued = async (target: Copy, deletionId: string) => {
    expect(waiting(target.full, 'org.purge')).toContainEqual({ deletionId });
    return target.full.get<PurgeRunner>(PurgeRunner).run(deletionId);
  };

  /** A is deleted again in the copy, B is intact, the platform chain verifies and a new certificate verifies. */
  const expectDeletedAgain = async (target: Copy) => {
    expect(await orgRow(target.db, ACME_ID)).toMatchObject({ status: 'deleted' });
    expect(await schemaExists(target.db, target.acme.schemaName)).toBe(false);
    expect(await vaultVersions(stack, `tenants/${ACME_ID}/`)).toEqual([]);
    const keys = await inPlatform(target.db, (trx) => trx.selectFrom('platform.tenant_key').select('organization_id').where('organization_id', 'in', [ACME_ID, target.bumi.id]).execute());
    expect(keys.map((k) => k.organization_id)).toEqual([target.bumi.id]);
    expect(await orgRow(target.db, target.bumi.id)).toMatchObject({ status: 'active' });
    expect(await schemaExists(target.db, target.bumi.schemaName)).toBe(true);
    expect((await vaultVersions(stack, `tenants/${target.bumi.id}/`)).length).toBeGreaterThan(0);
    expect((await target.full.get<AuditChainVerifier>(AuditChainVerifier).verifyPlatform()).firstBrokenSeq).toBeNull();
    const file = await target.full.get<DeletionService>(DeletionService).certificate('acme');
    const check = verifyCertificateText(file.text, compiledAnchorKeys());
    expect(check.ok).toBe(true);
    expect(check.certificate!.organization.id).toBe(ACME_ID);
    expect(check.certificate!.checks.every((c) => c.passed)).toBe(true);
    return check.certificate!;
  };

  beforeAll(async () => {
    stack = await startDeletionStack();
    dir = await mkdtemp(path.join(os.tmpdir(), 'm3-03-reapply-'));
    // The original installation: acme is purged and its certificate kept.
    original = await copy('archived');
    const [scheduled] = await deletionsOf(original.db, ACME_ID);
    await makeDue(original.db, ACME_ID);
    await original.full.get<DeletionService>(DeletionService).runDue('acme');
    expect(await original.full.get<PurgeRunner>(PurgeRunner).run(scheduled!.id)).toMatchObject({ status: 'completed' });
    const file = await original.full.get<DeletionService>(DeletionService).certificate('acme');
    certificateText = file.text;
    certificateFile = path.join(dir, file.fileName);
    await writeFile(certificateFile, certificateText);
  });
  afterAll(async () => {
    await original?.close();
    await stack?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('does nothing in the installation where the organisation is deleted already', async () => {
    const outcome = await reapply(original, certificateFile, 'acme');
    expect(outcome).toMatchObject({ status: 'completed', error: 'already deleted' });
    expect(formatPurgeOutcome('tenant purge', 'acme', outcome)).toEqual(['tenant purge: organisation acme is deleted already; nothing to do']);
  });

  it('deletes A again in a copy from before the purge, where A is archived with its deletion scheduled', async () => {
    const restored = await copy('archived');
    try {
      const [before] = await deletionsOf(restored.db, ACME_ID);
      expect(before).toMatchObject({ status: 'scheduled' });
      expect(before!.scheduled_for.getTime()).toBeGreaterThan(Date.now());
      const outcome = await reapply(restored, certificateFile, 'acme');
      expect(outcome).toMatchObject({ status: 'queued', deletionId: before!.id });
      const [running] = await deletionsOf(restored.db, ACME_ID);
      expect(running).toMatchObject({ status: 'running' });
      expect(running!.scheduled_for.getTime()).toBeLessThanOrEqual(Date.now());
      expect(running!.report).toMatchObject({ reapplied: { certificateId: verifyCertificateText(certificateText, compiledAnchorKeys()).certificate!.certificateId } });
      expect(await purgeQueued(restored, before!.id)).toMatchObject({ status: 'completed' });
      const issued = await expectDeletedAgain(restored);
      expect(issued.deletionId).toBe(before!.id);
    } finally {
      await restored.close();
    }
  });

  it('runs every step again in a copy where a purge of A had failed part way, so the restored vault is purged again', async () => {
    const restored = await copy('archived');
    try {
      const [before] = await deletionsOf(restored.db, ACME_ID);
      // The copy was taken while an earlier purge had failed at step 5: its report marks steps 1 to 4 done, although
      // the restored vault holds A's objects again.
      const done = ['check', 'access', 'accounts', 'vault'];
      const steps = ['check', 'access', 'accounts', 'vault', 'database', 'audit', 'organization', 'checks', 'certificate', 'emails'].map((step) => ({
        step, status: done.includes(step) ? 'done' : step === 'database' ? 'failed' : 'pending', at: done.includes(step) ? new Date().toISOString() : null, detail: null,
      }));
      await inPlatform(restored.db, (trx) =>
        trx
          .updateTable('platform.organization_deletion')
          .set({ status: 'failed', failed_step: 'database', error: 'Earlier failure', started_at: new Date(), vault_objects_deleted: '7', report: JSON.stringify({ steps, checks: [] }) })
          .where('id', '=', before!.id)
          .execute(),
      );
      expect((await vaultVersions(stack, `tenants/${ACME_ID}/`)).length).toBeGreaterThan(0);

      const outcome = await reapply(restored, certificateFile, 'acme');
      expect(outcome).toMatchObject({ status: 'queued', deletionId: before!.id });
      const [running] = await deletionsOf(restored.db, ACME_ID);
      expect(running).toMatchObject({ status: 'running', failed_step: null, error: null, started_at: null, vault_objects_deleted: null });
      const report = running!.report as { steps: { step: string; status: string }[]; reapplied?: unknown };
      expect(report.steps.every((s) => s.status === 'pending')).toBe(true);
      expect(report.reapplied).toBeDefined();

      expect(await purgeQueued(restored, before!.id)).toMatchObject({ status: 'completed' });
      await expectDeletedAgain(restored);
    } finally {
      await restored.close();
    }
  });

  it('deletes A again in a copy where A is active and has no deletion row, and refuses a changed certificate, another organisation id and another slug', async () => {
    const restored = await copy('active');
    try {
      expect(await deletionsOf(restored.db, ACME_ID)).toEqual([]);
      const cempaka = await createVaultTenant(restored.db, stack, 'cempaka', { name: 'PT Cempaka' });

      // A changed byte in the signed part.
      const changed = path.join(dir, 'changed.json');
      await writeFile(changed, certificateText.replace('PT Acme Lestari', 'PT Acme Lestary'));
      await expect(reapply(restored, changed, 'acme')).rejects.toThrow(/does not verify: .*signature/i);
      // A file that is no certificate.
      const notCertificate = path.join(dir, 'not-a-certificate.json');
      await writeFile(notCertificate, '{"hello":"world"}\n');
      await expect(reapply(restored, notCertificate, 'acme')).rejects.toThrow(/does not verify/);
      // The slug names an organisation with another id than the certificate.
      await expect(reapply(restored, certificateFile, 'cempaka')).rejects.toThrow(/names organisation 0a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d \(acme\), and --confirm names cempaka/);
      // An unknown slug.
      await expect(reapply(restored, certificateFile, 'nowhere')).rejects.toThrow(/No organisation with slug nowhere/);
      // Nothing changed.
      expect(await orgRow(restored.db, ACME_ID)).toMatchObject({ status: 'active' });
      expect(await orgRow(restored.db, cempaka.id)).toMatchObject({ status: 'active' });
      expect(await deletionsOf(restored.db, ACME_ID)).toEqual([]);
      expect(await deletionsOf(restored.db, cempaka.id)).toEqual([]);
      expect(waiting(restored.full, 'org.purge')).toEqual([]);

      const outcome = await reapply(restored, certificateFile, 'acme');
      expect(outcome).toMatchObject({ status: 'queued' });
      const [running] = await deletionsOf(restored.db, ACME_ID);
      expect(running).toMatchObject({ id: outcome.deletionId, status: 'running', scheduled_by: null });
      expect(await orgRow(restored.db, ACME_ID)).toMatchObject({ status: 'archived', offboarding_ends_at: null });
      const events = await inPlatform(restored.db, (trx) =>
        trx.selectFrom('platform.organization_status_event').select(['from_status', 'to_status', 'reason']).where('organization_id', '=', ACME_ID).orderBy('created_at').execute(),
      );
      expect(events.at(-1)).toMatchObject({ from_status: 'active', to_status: 'archived', reason: expect.stringContaining('Deletion re-applied after a restore') });

      expect(await purgeQueued(restored, outcome.deletionId)).toMatchObject({ status: 'completed' });
      await expectDeletedAgain(restored);
      expect(await orgRow(restored.db, cempaka.id)).toMatchObject({ status: 'active' });
      expect(await schemaExists(restored.db, cempaka.schemaName)).toBe(true);
    } finally {
      await restored.close();
    }
  });
});
