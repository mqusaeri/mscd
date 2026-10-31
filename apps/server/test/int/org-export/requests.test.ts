// Organisation export requests (Milestone 3 D.1, D.4, H.2, J.4, J.8) on the demo template with a storage gateway:
// - a request in an organisation with two Tenant Admins (tst) waits for the other's approval, the requester cannot
//   approve (SOD-SELF-APPROVE), a rejection needs a note, and one export flows at a time (export_in_progress);
// - in an organisation with one Tenant Admin (ndt) the request is queued at once with the warning;
// - every request, decision and download is audited and announced to every active Tenant Admin and every primary
//   Management System Manager (organization_export_requested), the ready export to its requester;
// - an organisation whose stored files exceed lifecycle.export_max_bytes is refused (export_too_large);
// - an offboarding organisation still requests, decides and downloads;
// - the platform operator queues an export and sees its status in multi tenancy (audited ops.export_requested), gets
//   403 on every Tenant Admin route including the download, and 409 single_tenancy in single tenancy.
import {
  API_ROUTES,
  OpsOrganizationExportItem,
  OrganizationExportCreated,
  OrganizationExportDetail,
  OrganizationExportItem,
  type OpsOrganizationExportQueued,
} from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { MULTI } from '../entitlements/helpers';
import { callRoute, demoSession, rowsIn, sessionFor, userIdOf, type Client, type FullApp } from '../contract/harness';
import { inScope } from '../db/helpers';
import { startStorageStack, type StorageStack } from '../files/helpers';
import { buildExport, clearExports, createExportApp, exportRow, ORG_IDS, putVaultFile, sha256, vaultRepository } from './helpers';

const route = (id: string) => API_ROUTES.find((r) => r.id === id)!;
const LIST = route('exports.organization.list');
const CREATE = route('exports.organization.create');
const GET = route('exports.organization.get');
const DECIDE = route('exports.organization.decide');
const MANIFEST = route('exports.organization.manifest');
const DOWNLOAD = route('exports.organization.download');
const OPS_LIST = route('ops.exports.list');
const OPS_CREATE = route('ops.exports.create');
const problem = (slug: string) => `https://mscd.cyberlentera.com/problems/${slug}`;

describe('organisation export requests (D.4, H.2)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let full: FullApp;
  let rina: Client;
  let admin: Client;
  let bagus: Client;

  /** Notices of a kind about one export, with one title, per recipient handle. */
  const notices = async (org: 'tst' | 'ndt', kind: string, exportId: string, title?: string) =>
    rowsIn<{ handle: string; title_en: string; body_en: string }>(db, org, sql`
      select u.handle, n.title_en, n.body_en from notification n join platform.app_user u on u.id = n.recipient_user_id
      where n.kind = ${kind} and n.entity_ref ->> 'id' = ${exportId} ${title ? sql`and n.title_en = ${title}` : sql``}
      order by u.handle`);

  /** Active Tenant Admins and primary Management System Managers of an organisation, by handle (H.2). */
  const expectedRecipients = async (org: 'tst' | 'ndt') => {
    const admins = await rowsIn<{ handle: string }>(db, org, sql`select u.handle from platform.org_membership m join platform.app_user u on u.id = m.user_id
      where m.organization_id = ${ORG_IDS[org]} and m.status = 'active' and m.deleted_at is null and 'tenant_admin' = any(m.admin_roles) and u.status = 'active'`);
    const managers = await rowsIn<{ handle: string }>(db, org, sql`select distinct u.handle from user_ms_role r join platform.app_user u on u.id = r.user_id
      where r.role = 'ms_manager' and r.is_primary and r.approval_status = 'active' and r.deleted_at is null`);
    return [...new Set([...admins, ...managers].map((r) => r.handle))].sort();
  };

  beforeAll(async () => {
    stack = await startStorageStack();
    full = await createExportApp(db, stack.gateway.url);
    rina = await demoSession(full, db, 'rina', 'tst');
    admin = await demoSession(full, db, 'tenant.admin', 'tst');
    bagus = await demoSession(full, db, 'bagus', 'tst');
  }, 240_000);
  afterAll(async () => {
    await full?.close();
    await stack?.close();
  });
  beforeEach(async () => {
    await clearExports(db, 'tst');
    await clearExports(db, 'ndt');
  });

  it('waits for a second Tenant Admin, refuses the requester as approver and announces each step', async () => {
    const created = await callRoute<OrganizationExportCreated>(rina, CREATE, { body: { note: 'Copy for the records archive' } });
    expect(created.violations).toEqual([]);
    expect(created.status, created.text).toBe(202);
    expect(OrganizationExportCreated.safeParse(created.body).success).toBe(true);
    expect(created.body.data).toMatchObject({ status: 'requested', approvalNeeded: true });
    const id = created.body.data.id;
    expect((await exportRow(db, id))).toMatchObject({ status: 'requested', requested_via: 'tenant_admin', requested_by: await userIdOf(db, 'rina') });

    // Every active Tenant Admin and primary Management System Manager is told, the requester too.
    const told = await notices('tst', 'organization_export_requested', id, 'Organisation export requested');
    expect(told.map((n) => n.handle).sort()).toEqual(await expectedRecipients('tst'));
    expect(told[0]!.body_en).toContain('Another Tenant Admin must approve it');
    expect(told[0]!.body_en).toContain('Copy for the records archive');

    // A second request while one waits: 409 export_in_progress.
    const again = await callRoute(admin, CREATE, { body: {} });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ type: problem('conflict'), messageKey: 'export_in_progress' });

    // The requester cannot approve; another Tenant Admin can.
    const self = await callRoute(rina, DECIDE, { params: { id }, body: { approve: true } });
    expect(self.violations).toEqual([]);
    expect(self.status).toBe(422);
    expect(self.body).toMatchObject({ type: problem('business-rule'), rule: 'SOD-SELF-APPROVE' });
    // A Domain Owner is no Tenant Admin (guard, F.6).
    expect((await callRoute(bagus, DECIDE, { params: { id }, body: { approve: true } })).status).toBe(403);
    // A rejection needs a note (schema).
    expect((await callRoute(admin, DECIDE, { params: { id }, body: { approve: false } })).status).toBe(400);

    const decided = await callRoute(admin, DECIDE, { params: { id }, body: { approve: true } });
    expect(decided.violations).toEqual([]);
    expect(decided.status, decided.text).toBe(200);
    expect(decided.body).toMatchObject({ ok: true, data: { id, status: 'queued' } });
    const row = await exportRow(db, id);
    expect(row).toMatchObject({ status: 'queued', decided_by: await userIdOf(db, 'tenant.admin') });
    const decidedNotices = await notices('tst', 'organization_export_requested', id, 'Organisation export approved');
    expect(decidedNotices.map((n) => n.handle).sort()).toEqual(await expectedRecipients('tst'));
    expect(decidedNotices[0]!.body_en).toMatch(/approved the full export requested by/);
    // A decided export cannot be decided again.
    expect((await callRoute(admin, DECIDE, { params: { id }, body: { approve: true } })).status).toBe(409);

    // Audit entries of the request and the decision.
    const audit = await rowsIn<{ action: string; actor_user_id: string; after_data: Record<string, unknown> }>(db, 'tst', sql`
      select action, actor_user_id, after_data from audit_trail where entity_id = ${id} order by seq`);
    expect(audit.map((a) => a.action)).toEqual(['organization_export.requested', 'organization_export.decided']);
    expect(audit[0]!.after_data).toMatchObject({ status: 'requested', approvalNeeded: true, note: 'Copy for the records archive' });

    // List and detail.
    const list = await callRoute<OrganizationExportItem[]>(rina, LIST, {});
    expect(list.violations).toEqual([]);
    expect(list.body[0]).toMatchObject({ id, status: 'queued', requestedBy: { handle: 'rina' }, decidedBy: { handle: 'tenant.admin' }, isFinal: false });
    const detail = await callRoute<OrganizationExportDetail>(admin, GET, { params: { id } });
    expect(detail.violations).toEqual([]);
    expect(detail.body).toMatchObject({ id, parts: [], manifestSha256: null });
    // A part of an export that is not ready: 409.
    expect((await callRoute(rina, DOWNLOAD, { params: { id, part: '1' } })).status).toBe(409);
    expect((await callRoute(rina, MANIFEST, { params: { id } })).status).toBe(409);

    // The build ends with the ready notice to the requester only.
    const built = await buildExport(full, 'tst', id, 1024 * 1024);
    expect(built.status, built.error).toBe('ready');
    const ready = await notices('tst', 'organization_export_ready', id);
    expect(ready.map((n) => n.handle)).toEqual(['rina']);
    expect(ready[0]!.body_en).toMatch(/It can be downloaded until \d{4}-\d{2}-\d{2}/);

    // Each download is audited, counted and announced.
    const part = await callRoute(admin, DOWNLOAD, { params: { id, part: '1' } });
    expect(part.violations).toEqual([]);
    expect(part.status).toBe(200);
    expect(part.headers['content-type']).toBe('application/gzip');
    const stored = await exportRow(db, id);
    const parts = stored.parts as { part: number; sha256: string; sizeBytes: number }[];
    expect(part.headers['x-mscd-sha256']).toBe(parts[0]!.sha256);
    expect(sha256(part.raw.rawPayload)).toBe(parts[0]!.sha256);
    expect(Number(part.headers['content-length'])).toBe(parts[0]!.sizeBytes);
    const manifest = await callRoute(rina, MANIFEST, { params: { id } });
    expect(manifest.violations).toEqual([]);
    expect(manifest.headers['content-type']).toBe('application/json');
    expect(sha256(manifest.raw.rawPayload)).toBe(stored.manifest_sha256);
    expect((await exportRow(db, id)).download_count).toBe(2);
    const downloaded = await notices('tst', 'organization_export_requested', id, 'Organisation export downloaded');
    expect(downloaded.map((n) => n.handle).sort()).toEqual(
      [...(await expectedRecipients('tst')), ...(await expectedRecipients('tst'))].sort(),
    );
    const downloads = await rowsIn<{ after_data: Record<string, unknown> }>(db, 'tst', sql`
      select after_data from audit_trail where entity_id = ${id} and action = 'organization_export.downloaded' order by seq`);
    expect(downloads.map((d) => d.after_data)).toEqual([
      expect.objectContaining({ part: 1, sha256: parts[0]!.sha256 }),
      expect.objectContaining({ file: 'manifest', sha256: stored.manifest_sha256 }),
    ]);
    // A part that does not exist: 404.
    expect((await callRoute(rina, DOWNLOAD, { params: { id, part: String(parts.length + 1) } })).status).toBe(404);
    await clearExports(db, 'tst');
  });

  it('rejects with a note and lets the next request through', async () => {
    const created = await callRoute<OrganizationExportCreated>(admin, CREATE, { body: {} });
    expect(created.status).toBe(202);
    const id = created.body.data.id;
    const rejected = await callRoute(rina, DECIDE, { params: { id }, body: { approve: false, note: 'Not agreed with the board' } });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ data: { id, status: 'rejected' } });
    expect(await exportRow(db, id)).toMatchObject({ status: 'rejected', decision_note: 'Not agreed with the board' });
    expect((await callRoute(admin, CREATE, { body: {} })).status).toBe(202);
    await clearExports(db, 'tst');
  });

  it('queues the request of a single Tenant Admin at once with the warning', async () => {
    const ndt = await demoSession(full, db, 'rina', 'ndt');
    const created = await callRoute<OrganizationExportCreated>(ndt, CREATE, { body: {} });
    expect(created.violations).toEqual([]);
    expect(created.status).toBe(202);
    expect(created.body.data).toMatchObject({ status: 'queued', approvalNeeded: false });
    expect(created.body.message?.[0]).toBe('The export was queued. Nobody else approved it, because the organisation has one Tenant Admin.');
    const told = await notices('ndt', 'organization_export_requested', created.body.data.id);
    expect(told.map((n) => n.handle).sort()).toEqual(await expectedRecipients('ndt'));
    expect(told[0]!.body_en).toContain('without a second approval');
    await clearExports(db, 'ndt');
  });

  it('refuses an organisation whose stored files exceed lifecycle.export_max_bytes (export_too_large)', async () => {
    const repo = await vaultRepository(db, 'tst');
    const [big] = await rowsIn<{ id: string }>(db, 'tst', sql`insert into storage_object (storage_repository_id, external_item_id, display_name, size_bytes,
        hash_algorithm, hash_source, link_status) values (${repo.id}, ${`tenants/${ORG_IDS.tst}/huge`}, 'huge.bin', ${String(200 * 1024 ** 3)}, 'none', 'none', 'intact')
      returning id`);
    try {
      const refused = await callRoute(rina, CREATE, { body: {} });
      expect(refused.violations).toEqual([]);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ type: problem('conflict'), messageKey: 'export_too_large' });
    } finally {
      await rowsIn(db, 'tst', sql`update storage_object set deleted_at = now() where id = ${big!.id}`);
    }
  });

  it('lets an offboarding organisation request, decide and download', async () => {
    await putVaultFile(full, db, 'tst', 'Offboarding check.txt', Buffer.from('offboarding'));
    await sql`update platform.organization set status = 'offboarding' where id = ${ORG_IDS.tst}`.execute(db.migrator);
    try {
      const created = await callRoute<OrganizationExportCreated>(rina, CREATE, { body: {} });
      expect(created.status, created.text).toBe(202);
      const id = created.body.data.id;
      const decided = await callRoute(admin, DECIDE, { params: { id }, body: { approve: true } });
      expect(decided.status, decided.text).toBe(200);
      expect((await buildExport(full, 'tst', id, 1024 * 1024)).status).toBe('ready');
      const part = await callRoute(admin, DOWNLOAD, { params: { id, part: '1' } });
      expect(part.status).toBe(200);
      // Writes that are not exports stay closed while offboarding (403 organisation-inactive).
      const write = await rina.post('/api/v1/admin/organization/exports/00000000-0000-4000-8000-000000000000/decision', { approve: true });
      expect(write.status).toBe(404);
    } finally {
      await sql`update platform.organization set status = 'active' where id = ${ORG_IDS.tst}`.execute(db.migrator);
      await clearExports(db, 'tst');
    }
  });

  it('answers 409 single_tenancy to the operator routes in single tenancy', async () => {
    const client = await sessionFor(full, await userIdOf(db, 'ops'), null);
    const list = await callRoute(client, OPS_LIST, { params: { org: 'tst' } });
    expect(list.violations).toEqual([]);
    expect(list.status).toBe(409);
    expect(list.body).toMatchObject({ messageKey: 'single_tenancy' });
    const create = await callRoute(client, OPS_CREATE, { params: { org: 'tst' }, body: { reason: 'Asked by the customer in ticket 4411' } });
    expect(create.status).toBe(409);
    expect(create.body).toMatchObject({ messageKey: 'single_tenancy' });
  });

  describe('in multi tenancy', () => {
    let multi: FullApp;
    let op: Client;

    beforeAll(async () => {
      multi = await createExportApp(db, stack.gateway.url, MULTI);
      op = await sessionFor(multi, await userIdOf(db, 'ops'), null);
    });
    afterAll(async () => {
      await multi?.close();
    });

    it('lets the operator queue an export and see its status, never its content', async () => {
      const queued = await callRoute<OpsOrganizationExportQueued>(op, OPS_CREATE, { params: { org: 'tst' }, body: { reason: 'Asked by the customer in ticket 4411' } });
      expect(queued.violations).toEqual([]);
      expect(queued.status, queued.text).toBe(202);
      const id = queued.body.data.id;
      const opsId = await userIdOf(db, 'ops');
      expect(await exportRow(db, id)).toMatchObject({ status: 'queued', requested_via: 'operator', requested_by: opsId });
      const [entry] = await inScope(db.migrator, { platformScope: true }, (trx) =>
        trx.selectFrom('platform.audit_log').select(['actor_kind', 'actor_user_id', 'organization_id', 'entity_id', 'after_data']).where('action', '=', 'ops.export_requested').where('entity_id', '=', id).execute(),
      );
      expect(entry).toMatchObject({ actor_kind: 'operator', actor_user_id: opsId, organization_id: ORG_IDS.tst, after_data: { reason: 'Asked by the customer in ticket 4411' } });
      const told = await notices('tst', 'organization_export_requested', id);
      expect(told.map((n) => n.handle).sort()).toEqual(await expectedRecipients('tst'));
      expect(told[0]!.body_en).toContain('Your MSCD service provider queued a full export');
      // A second one while it is queued: 409 export_in_progress; an unknown organisation: 404.
      expect((await callRoute(op, OPS_CREATE, { params: { org: 'tst' }, body: { reason: 'Asked again by the customer' } })).body).toMatchObject({ messageKey: 'export_in_progress' });
      expect((await callRoute(op, OPS_LIST, { params: { org: 'nosuchorg' } })).status).toBe(404);

      // The build tells every Tenant Admin, because the provider asked for it.
      expect((await buildExport(multi, 'tst', id, 1024 * 1024)).status).toBe('ready');
      const ready = await notices('tst', 'organization_export_ready', id);
      const admins = await rowsIn<{ handle: string }>(db, 'tst', sql`select u.handle from platform.org_membership m join platform.app_user u on u.id = m.user_id
        where m.organization_id = ${ORG_IDS.tst} and m.status = 'active' and 'tenant_admin' = any(m.admin_roles)`);
      expect(ready.map((n) => n.handle).sort()).toEqual(admins.map((a) => a.handle).sort());

      // The operator sees status, dates and sizes only.
      const list = await callRoute<OpsOrganizationExportItem[]>(op, OPS_LIST, { params: { org: 'tst' } });
      expect(list.violations).toEqual([]);
      expect(list.status).toBe(200);
      const item = list.body.find((e) => e.id === id)!;
      expect(OpsOrganizationExportItem.safeParse(item).success).toBe(true);
      expect(item).toMatchObject({ status: 'ready', requestedVia: 'operator', isFinal: false });
      expect(Object.keys(item).sort()).toEqual(['completedAt', 'downloadCount', 'expiresAt', 'id', 'isFinal', 'partCount', 'requestedAt', 'requestedVia', 'sizeBytes', 'status']);

      // The operator never downloads: 403 on every Tenant Admin route.
      for (const [def, input] of [
        [DOWNLOAD, { params: { id, part: '1' } }],
        [MANIFEST, { params: { id } }],
        [GET, { params: { id } }],
        [LIST, {}],
      ] as const) {
        const answer = await callRoute(op, def, input);
        expect(answer.violations).toEqual([]);
        expect(answer.status, def.id).toBe(403);
      }
      // The Tenant Admins see who asked as "nobody they know".
      const tst = await demoSession(multi, db, 'rina', 'tst');
      const detail = await callRoute<OrganizationExportDetail>(tst, GET, { params: { id } });
      expect(detail.body).toMatchObject({ requestedVia: 'operator', requestedBy: null, status: 'ready' });
      expect(detail.body.parts.length).toBeGreaterThan(0);
      await clearExports(db, 'tst');
    });
  });
});
