// The purge of an organisation (Milestone 3 D.5.2 to D.5.5; M3-03), against the test database, a throwaway SeaweedFS
// bucket and a storage gateway of this file (R-20). Organisation A is purged and organisation B shares a person with it:
// the purge removes A's schema, vault objects, data key and platform rows, anonymises the account that belonged to A
// only, keeps the shared account with its membership of B, redacts A's platform audit entries under one attestation,
// and leaves every row, object and chain entry of B as it was. A forced failure at the vault step is retried from that
// step through `ops.deletion.retry`. The platform chain verifies after the purge, the signed certificate verifies and a
// changed byte fails, the certificate goes to the captured Tenant Admin and the operator, and a redacted row changed by
// the database owner without an attestation breaks the chain.
import { OrganizationDeletionView, type OrganizationDeletionResult, type OpsOrganizationItem, type Page } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_WRITER, type AuditWriter, type GatewayClient } from '../../../src/common/tokens';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { compiledAnchorKeys } from '../../../src/modules/audit/anchors';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { verifyCertificateText, type DeletionCertificate } from '../../../src/modules/ops/deletion/certificate';
import { PURGED_PLATFORM_TABLES } from '../../../src/modules/ops/deletion/deletion-coverage';
import { OrgLifecycleJob } from '../../../src/modules/ops/deletion/org-lifecycle.job';
import { PurgeRunner } from '../../../src/modules/ops/deletion/purge-runner';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import { callRoute, type FullApp } from '../contract/harness';
import { inScope } from '../db/helpers';
import { addProvider } from '../identity/helpers';
import { addPerson, inPlatform, inTenant, platformAudit, sessionIn, type Person } from '../onboarding/helpers';
import {
  DELETION_CERTIFICATE, DELETION_GET, DELETION_RETRY, STATUS, createDeletionApp, createVaultTenant, deletionsOf, makeDue, orgRow, platformEntries,
  putVaultObject, schemaExists, startDeletionStack, vaultVersions, waiting, type DeletionStack,
} from './helpers';

describe('purge of an organisation (Milestone 3 D.5.2 to D.5.5; M3-03)', () => {
  const db = useTestDatabase('empty');
  let stack: DeletionStack;
  let full: FullApp;
  let operator: Person;
  let acme: CreatedTenant;
  let bumi: CreatedTenant;
  let acmeAdmin: Person;
  let shared: Person;
  let bumiAdmin: Person;
  let deletionId: string;
  let acmeSeqs: string[];
  let bumiSeq: string;
  let bumiBefore: Awaited<ReturnType<typeof stateOf>>;

  const op = () => sessionIn(full, operator.id, null);

  /**
   * Everything of an organisation the purge of another must leave as it was: the row count of every table of its
   * schema, its tenant audit chain (seq and hash of every row), its rows in the platform tables the purge cleans, and
   * its vault object versions.
   */
  const stateOf = async (tenant: CreatedTenant) => {
    const tables = await inTenant(db, tenant, async (trx) => {
      const { rows } = await sql<{ table_name: string }>`
        select table_name from information_schema.tables where table_schema = ${tenant.schemaName} and table_type = 'BASE TABLE' order by table_name`.execute(trx);
      const counts: Record<string, number> = {};
      for (const { table_name } of rows) {
        counts[table_name] = Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(`${tenant.schemaName}.${table_name}`)}`.execute(trx)).rows[0]!.n);
      }
      return counts;
    });
    const chain = await inTenant(db, tenant, async (trx) =>
      (await trx.selectFrom('audit_trail').select(['seq', 'row_hash']).orderBy('seq').execute()).map((r) => `${r.seq}:${r.row_hash.toString('hex')}`),
    );
    const platformRows = await inPlatform(db, async (trx) => {
      const counts: Record<string, number> = {};
      for (const table of PURGED_PLATFORM_TABLES) {
        const where = sql.raw(table.where.replaceAll('$1', `'${tenant.id}'::uuid`));
        counts[table.table] = Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(`platform.${table.table}`)} where ${where}`.execute(trx)).rows[0]!.n);
      }
      return counts;
    });
    return { tables, chain, platformRows, vault: await vaultVersions(stack, `tenants/${tenant.id}/`) };
  };

  beforeAll(async () => {
    stack = await startDeletionStack();
    full = await createDeletionApp(db, stack);
    operator = await addPerson(db, 'ops.purge', [], { platformOperator: true, password: true });
    acme = await createVaultTenant(db, stack, 'acme', { name: 'PT Acme Lestari' });
    bumi = await createVaultTenant(db, stack, 'bumi', { name: 'PT Bumi Raya' });
    acmeAdmin = await addPerson(db, 'acme.admin', [{ org: acme, adminRoles: ['tenant_admin'] }], { password: true });
    shared = await addPerson(db, 'shared.person', [{ org: acme }, { org: bumi }], { password: true });
    bumiAdmin = await addPerson(db, 'bumi.admin', [{ org: bumi, adminRoles: ['tenant_admin'] }], { password: true });

    // Secrets and links of the account that belongs to acme only, and a company sign-in provider of acme.
    const provider = await addProvider(db, acme.id, 'acme-entra', 'Acme Entra ID');
    await inPlatform(db, async (trx) => {
      await trx.insertInto('platform.mfa_factor').values({ user_id: acmeAdmin.id, secret_sealed: 'v1.test.sealed', confirmed_at: new Date() }).execute();
      await trx.insertInto('platform.mfa_recovery_code').values({ user_id: acmeAdmin.id, code_hash: 'test-hash' }).execute();
      await trx.insertInto('platform.user_preference').values({ user_id: acmeAdmin.id, key: 'lang', value: JSON.stringify('id') }).execute();
      await trx.insertInto('platform.user_identity').values({ identity_provider_id: provider, subject: 'acme-subject-1', user_id: acmeAdmin.id, link_method: 'admin' }).execute();
    });

    // Vault objects of both organisations.
    await putVaultObject(db, stack, acme, 'Acme risk register.csv');
    await putVaultObject(db, stack, acme, 'Acme policy.csv');
    await putVaultObject(db, stack, bumi, 'Bumi register.csv');

    // Platform audit entries of both organisations with network addresses, browsers and personal values.
    const writer = full.get<AuditWriter>(AUDIT_WRITER);
    await writer.recordDetached({
      action: 'membership.updated',
      organizationId: acme.id,
      actor: { userId: acmeAdmin.id, kind: 'user' },
      entityType: 'user',
      entityId: shared.id,
      entityCode: shared.handle,
      after: { email: shared.email, role: 'member', note: `Changed by ${acmeAdmin.displayName}` },
      sourceIp: '203.0.113.7',
      userAgent: 'Acme browser 1.0',
    });
    await writer.recordDetached({
      action: 'membership.updated',
      organizationId: bumi.id,
      actor: { userId: bumiAdmin.id, kind: 'user' },
      entityType: 'user',
      entityId: shared.id,
      entityCode: shared.handle,
      after: { email: shared.email, note: `Changed by ${bumiAdmin.displayName}` },
      sourceIp: '198.51.100.9',
      userAgent: 'Bumi browser 2.0',
    });
    acmeSeqs = (await platformEntries(db, acme.id)).map((e) => String(e.seq));
    bumiSeq = String((await platformEntries(db, bumi.id)).at(-1)!.seq);
    // Entries of bumi's own audit chain, with the shared person in them, written as the application writes them.
    for (const holder of [shared.displayName, bumiAdmin.displayName]) {
      await inScope(db.app, { orgId: bumi.id, schema: bumi.schemaName }, (trx) =>
        trx
          .insertInto('audit_trail')
          .values({ actor_kind: 'user', action: 'register.updated', entity_type: 'risk', entity_code: 'R-001', after_data: JSON.stringify({ holder }), source_ip: '198.51.100.10', user_agent: 'Bumi browser 2.0' })
          .execute(),
      );
    }
    bumiBefore = await stateOf(bumi);
    expect(bumiBefore.chain.length).toBeGreaterThan(0);
    expect(bumiBefore.platformRows.org_membership).toBe(2);
  });
  afterAll(async () => {
    await full?.close();
    await stack?.close();
  });

  it('moves acme to archived, makes the deletion due and lets org.lifecycle start it', async () => {
    for (const [status, reason] of [['offboarding', 'Contract ended on 31 Oct 2026'], ['archived', 'Read-only period over']] as const) {
      const call = await callRoute(await op(), STATUS, { params: { org: 'acme' }, body: { status, reason, confirmSlug: 'acme' } });
      expect(call.status, call.text).toBe(200);
    }
    const [scheduled] = await deletionsOf(db, acme.id);
    expect(scheduled).toMatchObject({ status: 'scheduled' });
    expect(scheduled!.notify_emails_sealed).toMatch(/^v1\./);
    deletionId = scheduled!.id;
    await makeDue(db, acme.id);
    expect(await full.get<OrgLifecycleJob>(OrgLifecycleJob).run()).toMatchObject({ purgesQueued: 1 });
    expect(waiting(full, 'org.purge')).toContainEqual({ deletionId });
  });

  it('fails at the vault step when the gateway refuses, alerts the operators, and retries from that step', async () => {
    const runner = full.get<PurgeRunner>(PurgeRunner);
    const holder = runner as unknown as { gateway: GatewayClient };
    const gateway = holder.gateway;
    holder.gateway = {
      post: () => Promise.reject(new Error('The test gateway refuses the purge')),
      putObject: () => Promise.reject(new Error('not used')),
      stream: () => Promise.reject(new Error('not used')),
    } as GatewayClient;
    try {
      expect(await runner.run(deletionId)).toMatchObject({ status: 'failed', failedStep: 'vault' });
    } finally {
      holder.gateway = gateway;
    }
    const [failed] = await deletionsOf(db, acme.id);
    expect(failed).toMatchObject({ status: 'failed', failed_step: 'vault' });
    expect(failed!.error).toContain('The test gateway refuses the purge');
    const report = failed!.report as { steps: { step: string; status: string; at: string | null }[] };
    expect(report.steps.map((s) => `${s.step}:${s.status}`).slice(0, 5)).toEqual(['check:done', 'access:done', 'accounts:done', 'vault:failed', 'database:pending']);
    // Steps 1 to 3 are done: the account of acme only is anonymised, the schema still exists.
    expect(await schemaExists(db, acme.schemaName)).toBe(true);
    expect((await platformAudit(db, 'tenant.purge_failed')).map((e) => e.organization_id)).toEqual([acme.id]);
    await stack.mail.waitFor(operator.email, (m) => m.mailKind === 'account:organization_deletion_failed');

    const accountsAt = report.steps.find((s) => s.step === 'accounts')!.at;
    const retried = await callRoute<OrganizationDeletionResult>(await op(), DELETION_RETRY, { params: { org: 'acme' }, body: { reason: 'The gateway works again' } });
    expect(retried.violations).toEqual([]);
    expect(retried.status, retried.text).toBe(200);
    expect(retried.body.data.status).toBe('running');
    expect(waiting(full, 'org.purge')).toContainEqual({ deletionId });

    expect(await runner.run(deletionId)).toEqual({ deletionId, status: 'completed' });
    const [completed] = await deletionsOf(db, acme.id);
    expect(completed).toMatchObject({ status: 'completed', failed_step: null, error: null, notify_emails_sealed: null });
    const finalReport = completed!.report as { steps: { step: string; status: string; at: string | null }[]; checks: { check: string; passed: boolean }[]; replacementsSealed: unknown };
    expect(finalReport.steps.every((s) => s.status === 'done')).toBe(true);
    // The retry continued from the vault step: the accounts step kept its time.
    expect(finalReport.steps.find((s) => s.step === 'accounts')!.at).toBe(accountsAt);
    expect(finalReport.checks.map((c) => `${c.check}:${c.passed}`)).toEqual([
      'schema:true', 'platform rows:true', 'vault:true', 'data key:true', 'accounts:true', 'audit chain:true',
    ]);
    expect(finalReport.replacementsSealed).toBeNull();
    expect(Number(completed!.vault_objects_deleted)).toBe(2);
  });

  it('removed the schema, vault objects, data key and platform rows of acme, and nothing of bumi', async () => {
    expect(await schemaExists(db, acme.schemaName)).toBe(false);
    expect(await schemaExists(db, bumi.schemaName)).toBe(true);
    expect(await vaultVersions(stack, `tenants/${acme.id}/`)).toEqual([]);
    expect(await vaultVersions(stack, `tenants/${bumi.id}/`)).toHaveLength(1);
    const keys = await inPlatform(db, (trx) => trx.selectFrom('platform.tenant_key').select('organization_id').execute());
    expect(keys.map((k) => k.organization_id)).not.toContain(acme.id);
    expect(keys.map((k) => k.organization_id)).toContain(bumi.id);
    const memberships = await inPlatform(db, (trx) => trx.selectFrom('platform.org_membership').select(['organization_id', 'user_id']).execute());
    expect(memberships.filter((m) => m.organization_id === acme.id)).toEqual([]);
    expect(memberships).toContainEqual({ organization_id: bumi.id, user_id: shared.id });
    expect(memberships).toContainEqual({ organization_id: bumi.id, user_id: bumiAdmin.id });
    const providers = await inPlatform(db, (trx) => trx.selectFrom('platform.identity_provider').select('organization_id').execute());
    expect(providers.filter((p) => p.organization_id === acme.id)).toEqual([]);
    expect(await inPlatform(db, (trx) => trx.selectFrom('platform.user_identity').selectAll().execute())).toEqual([]);

    // The organisation row stays with status deleted, and its history ends with the purge.
    expect(await orgRow(db, acme.id)).toMatchObject({ status: 'deleted', slug: 'acme', name: 'PT Acme Lestari', offboarding_ends_at: null });
    expect((await orgRow(db, bumi.id)).status).toBe('active');
    full.get<TenantResolver>(TenantResolver).invalidateAll();
    expect((await full.get<TenantResolver>(TenantResolver).resolveBySlug('acme'))?.status).toBe('deleted');
    const deleted = await (await op()).request<Page<OpsOrganizationItem>>('GET', '/api/v1/ops/organizations?status=deleted');
    expect(deleted.status, deleted.text).toBe(200);
    expect(deleted.body.items).toEqual([expect.objectContaining({ slug: 'acme', status: 'deleted', systemCount: 0, licence: null, deletion: expect.objectContaining({ status: 'completed' }) })]);
    // Every row, object and chain entry of bumi is as it was before the purge, and its tenant chain verifies.
    expect(await stateOf(bumi)).toEqual(bumiBefore);
    expect(await full.get<AuditChainVerifier>(AuditChainVerifier).verifyTenant({ orgId: bumi.id, schema: bumi.schemaName })).toMatchObject({
      firstBrokenSeq: null, anchorOk: true, checked: bumiBefore.chain.length,
    });
  });

  it('anonymised the account of acme only and kept the shared account with its membership of bumi', async () => {
    const users = await inPlatform(db, (trx) =>
      trx.selectFrom('platform.app_user').select(['id', 'handle', 'email', 'display_name', 'job_title', 'password_hash', 'status', 'erased_at']).where('id', 'in', [acmeAdmin.id, shared.id, bumiAdmin.id]).execute(),
    );
    const byId = new Map(users.map((u) => [u.id, u]));
    const erased = byId.get(acmeAdmin.id)!;
    expect(erased.email).toMatch(/^erased-[0-9a-f]{8}@erased\.invalid$/);
    expect(erased.handle).toMatch(/^erased-[0-9a-f]{8}$/);
    expect(erased).toMatchObject({ display_name: 'Former user', job_title: null, password_hash: null, status: 'disabled' });
    expect(erased.erased_at).not.toBeNull();
    for (const table of ['platform.mfa_factor', 'platform.mfa_recovery_code', 'platform.user_preference', 'platform.session'] as const) {
      const rows = await inPlatform(db, (trx) => trx.selectFrom(table).select('user_id').where('user_id', '=', acmeAdmin.id).execute());
      expect(rows, table).toEqual([]);
    }
    expect(byId.get(shared.id)).toMatchObject({ email: shared.email, handle: shared.handle, display_name: shared.displayName, status: 'active', erased_at: null });
    expect(byId.get(bumiAdmin.id)).toMatchObject({ email: bumiAdmin.email, erased_at: null });
    const anonymised = await platformAudit(db, 'user.anonymised');
    expect(anonymised).toEqual([expect.objectContaining({ organization_id: acme.id, entity_id: acmeAdmin.id, entity_code: erased.handle })]);
    expect(JSON.stringify(anonymised)).not.toContain(acmeAdmin.email);
  });

  it('redacted the platform audit entries of acme under one attestation and left those of bumi', async () => {
    const entries = await inPlatform(db, (trx) =>
      trx.selectFrom('platform.audit_log').selectAll().where('seq', 'in', [...acmeSeqs, bumiSeq]).orderBy('seq').execute(),
    );
    const updated = entries.find((e) => e.action === 'membership.updated' && e.organization_id === acme.id)!;
    expect(updated).toMatchObject({ source_ip: null, user_agent: null });
    expect(updated.redacted_at).not.toBeNull();
    const text = JSON.stringify([updated.entity_code, updated.before_data, updated.after_data]);
    for (const value of [shared.email, shared.handle, acmeAdmin.displayName, acmeAdmin.email]) expect(text).not.toContain(value);
    expect(text).toContain('erased-');
    const theirs = entries.find((e) => String(e.seq) === bumiSeq)!;
    expect(theirs).toMatchObject({ source_ip: '198.51.100.9', user_agent: 'Bumi browser 2.0', redacted_at: null, redaction_id: null });

    const attestations = await inPlatform(db, (trx) =>
      trx.selectFrom('platform.audit_log').select(['seq', 'organization_id', 'after_data']).where('action', '=', 'tenant.audit_redacted').execute(),
    );
    expect(attestations).toHaveLength(1);
    expect(attestations[0]!.organization_id).toBe(acme.id);
    const listed = (attestations[0]!.after_data as { redactionId: string; rows: { seq: number; rowHash: string }[] });
    expect(listed.redactionId).toBe(updated.redaction_id);
    expect(listed.rows.map((r) => String(r.seq))).toContain(String(updated.seq));
    expect(listed.rows.find((r) => String(r.seq) === String(updated.seq))!.rowHash).toBe(updated.row_hash.toString('hex'));

    // The platform chain verifies with the attestation, and an anchor covers the attestation (D.5.4).
    const verified = await full.get<AuditChainVerifier>(AuditChainVerifier).verifyPlatform();
    expect(verified).toMatchObject({ firstBrokenSeq: null, anchorOk: true, redactedUnanchored: 0, redactionHeadSeq: Number(attestations[0]!.seq) });
    expect(verified.redacted).toBeGreaterThanOrEqual(1);
  });

  it('issues a signed certificate that verifies, and a changed byte fails', async () => {
    const view = await callRoute<OrganizationDeletionView>(await op(), DELETION_GET, { params: { org: 'acme' } });
    expect(view.violations).toEqual([]);
    expect(OrganizationDeletionView.safeParse(view.body).success).toBe(true);
    expect(view.body).toMatchObject({ id: deletionId, status: 'completed', failedStep: null, vaultObjectsDeleted: 2 });
    expect(view.body.steps.map((s) => s.step)).toEqual(expect.arrayContaining(['check', 'vault', 'audit', 'certificate', 'check: audit chain']));

    const file = await callRoute(await op(), DELETION_CERTIFICATE, { params: { org: 'acme' } });
    expect(file.violations).toEqual([]);
    expect(file.status).toBe(200);
    expect(String(file.headers['content-type'])).toContain('application/json');
    expect(String(file.headers['content-disposition'])).toContain('deletion-certificate-acme-');
    const check = verifyCertificateText(file.text, compiledAnchorKeys());
    expect(check).toMatchObject({ ok: true, problem: null });
    const certificate = check.certificate as DeletionCertificate;
    expect(view.body.certificateId).toBe(certificate.certificateId);
    expect(certificate).toMatchObject({
      type: 'mscd-deletion-certificate-v1',
      deletionId,
      organization: { id: acme.id, slug: 'acme', name: 'PT Acme Lestari' },
      finalExport: null,
      dates: { deletionScheduledBy: 'system' },
    });
    expect(certificate.finalExportText).toContain('No export taken');
    expect(certificate.checks.every((c) => c.passed)).toBe(true);
    expect(certificate.backups.copiesEndBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const value of [acmeAdmin.email, shared.email, acmeAdmin.displayName, operator.email]) expect(file.text).not.toContain(value);

    const changed = file.text.replace('"PT Acme Lestari"', '"PT Acme Lestary"');
    expect(changed).not.toBe(file.text);
    expect(verifyCertificateText(changed, compiledAnchorKeys())).toMatchObject({ ok: false, problem: 'bad-signature' });
    expect(verifyCertificateText(file.text, [])).toMatchObject({ ok: false, problem: 'unknown-key' });

    // The certificate went to the Tenant Admin captured at scheduling (by the address of that time) and to the operator.
    for (const to of [acmeAdmin.email, operator.email]) {
      const mail = await stack.mail.waitFor(to, (m) => m.mailKind === 'account:organization_deletion_certificate');
      expect(mail.subject).toBe('[MSCD] PT Acme Lestari was deleted from MSCD: deletion certificate');
    }
    expect((await platformAudit(db, 'tenant.purged')).map((e) => e.organization_id)).toEqual([acme.id]);
  });

  it('a redacted row changed by the database owner without an attestation breaks the platform chain', async () => {
    const [row] = await inPlatform(db, (trx) =>
      trx.selectFrom('platform.audit_log').select(['seq', 'redaction_id']).where('organization_id', '=', acme.id).where('redaction_id', 'is not', null).orderBy('seq').limit(1).execute(),
    );
    // The owner passes the append-only trigger with the marker of the redaction and changes the redacted content.
    await db.migrator.transaction().execute(async (trx) => {
      await sql`select set_config('app.platform_scope', 'on', true), set_config('mscd.audit_redaction', ${row!.redaction_id}, true)`.execute(trx);
      await sql`update platform.audit_log set after_data = '{"note":"rewritten"}'::jsonb where seq = ${row!.seq}`.execute(trx);
    });
    const verified = await full.get<AuditChainVerifier>(AuditChainVerifier).verifyPlatform();
    expect(verified.firstBrokenSeq).toBe(Number(row!.seq));
  });
});
