// Requests from one person (Milestone 3 D.1, D.2, D.6, J.4, J.5, J.8; M3-04) on a copy of the demo template with the
// storage stack of the file tests (the person export is stored in the Managed Vault). Covers: the due time of a request
// and the deadline notices of `privacy.deadlines`; the moves of J.8 with `If-Match`; the system checks with their tasks
// and notices; the access export with its sections and without secrets or other people's data, for a Tenant Admin and
// for the person; rectify refused for a shared account and the person's own `me.profile`; restriction that stops
// sign-in to this organisation only; erasure refused with open items and for the last Tenant Admin; an erasure of a
// shared account (the pseudonym in the user list, the read model, the audit trail, the document register export and
// the review calendar feed, audit entries without address, browser, email or name, both chains verifying with their
// attestations, the account still working in its other organisation); an erasure that anonymises an account without
// another membership; the mention search (a risk description and an interested party's requirements, nothing from
// another system); the person's own requests; and the retention clean-up of D.6.7. The people are the demo people and
// invented ones (R-19).
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackgroundTask, CalendarFeed, CommandResult, Page, PrivacyCheckItem, PrivacyMentions, PrivacyRequestDetail, PrivacyRequestItem, UserView } from '@mscd/shared';
import { SYSTEM_USER_ID } from '../../../src/common/tokens';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { ExportBuildJob } from '../../../src/modules/exports/export-build.job';
import { ERASED_SUBJECT, PERSONAL_DATA_FORMAT, PERSONAL_DATA_SECTIONS } from '../../../src/modules/exports/personal-data';
import { CleanupExpiredJob } from '../../../src/modules/jobs/cleanup-expired.job';
import { PrivacyDeadlinesService } from '../../../src/modules/privacy/privacy-deadlines.job';
import { pseudonymHandle } from '../../../src/modules/privacy/pseudonym';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { useTestDatabase } from '../../setup/test-db';
import {
  createPrivacyApp, inOrg, inventedMember, ORG_IDS, platformRows, primaryManagers, rowsOf, signIn, startStorageStack, userId,
  type Client, type DemoOrg, type PrivacyApp, type StorageStack,
} from './helpers';

const REQUESTS = '/api/v1/admin/privacy-requests';
const REQUEST = (id: string) => `${REQUESTS}/${id}`;
const CHECKS = (ms: string) => `/api/v1/ms/${ms}/privacy-checks`;
const HOUR = 3_600_000;
const ORG: DemoOrg = 'ndt';

describe('requests from one person (Milestone 3 D.6)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: PrivacyApp;
  let rina: Client;
  const clients = new Map<string, Client>();
  let managers: Map<string, string | null>;

  const as = async (handle: string, org: DemoOrg = ORG): Promise<Client> => {
    const key = `${handle}@${org}`;
    let client = clients.get(key);
    if (!client) {
      client = await signIn(ctx, db, handle, org);
      clients.set(key, client);
    }
    return client;
  };

  /** Records a request as rina and answers its id and number. */
  const record = async (body: Record<string, unknown>): Promise<{ id: string; requestNo: string }> => {
    const answer = await rina.post<CommandResult>(REQUESTS, body);
    expect(answer.status, answer.text).toBe(201);
    const data = answer.body.data as { id: string; requestNo: string };
    return { id: data.id, requestNo: data.requestNo };
  };
  const detail = async (id: string): Promise<PrivacyRequestDetail> => {
    const answer = await rina.get<PrivacyRequestDetail>(REQUEST(id));
    expect(answer.status, answer.text).toBe(200);
    return answer.body;
  };
  const start = async (id: string): Promise<void> => {
    const answer = await rina.patch(REQUEST(id), { action: 'start', identityCheckNote: 'Identity checked by a video call' });
    expect(answer.status, answer.text).toBe(200);
  };
  /** Every system check of a request marked done by the system's primary Management System Manager. */
  const checkAll = async (id: string): Promise<void> => {
    for (const check of (await detail(id)).checks) {
      const handle = managers.get(check.ms);
      expect(handle, `primary manager of ${check.ms}`).toBeTruthy();
      const manager = await as(handle!);
      const done = await manager.post(`${CHECKS(check.ms)}/${check.id}/done`, { note: 'Records checked; nothing to change' });
      expect(done.status, done.text).toBe(200);
    }
  };
  const membership = async (org: DemoOrg, user: string) =>
    (await platformRows<{ status: string; deleted_at: Date | null }>(db, sql`
      select status, deleted_at from platform.org_membership where organization_id = ${ORG_IDS[org]}::uuid and user_id = ${user}::uuid`))[0];

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createPrivacyApp(db, stack.gateway.url);
    rina = await as('rina');
    managers = await primaryManagers(db, ORG);
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  describe('the register and its moves (D.6.2, J.8)', () => {
    it('records an access request due 72 hours after it was received, with a check, a task and a notice per system', async () => {
      const staff = await userId(db, 'staff10');
      const receivedAt = new Date(Date.now() - HOUR);
      const { id, requestNo } = await record({ type: 'access', subject: { userId: staff }, receivedAt: receivedAt.toISOString(), channel: 'email', note: 'Asked by email' });
      expect(requestNo).toMatch(/^PR-2026-\d{3}$/);
      const item = await detail(id);
      expect(item).toMatchObject({
        requestNo, type: 'access', status: 'received', channel: 'email', overdue: false, closedAt: null, note: 'Asked by email',
        subject: { kind: 'member', userId: staff, handle: 'staff10', name: 'Staff 10', email: 'staff10@nusantaradigital.co.id' },
      });
      expect(new Date(item.dueAt).getTime() - receivedAt.getTime()).toBe(72 * HOUR);
      const systems = [...managers.keys()];
      expect(item.checks.map((c) => c.ms)).toEqual(systems);
      expect(item.checks.every((c) => c.status === 'open')).toBe(true);
      const tasks = await rowsOf<{ handle: string; ms: string; title_en: string; entity_code: string }>(db, ORG, sql`
        select u.handle, m.slug as ms, t.title_en, t.entity_code from task t join platform.app_user u on u.id = t.owner_user_id
          join management_system m on m.id = t.management_system_id
         where t.source_rule = 'privacy_check' and t.entity_type = 'privacy_check' and t.status = 'open'
           and t.entity_id in (select c.id from privacy_check c where c.privacy_request_id = ${id})
         order by m.position, m.slug`);
      expect(tasks).toEqual(systems.filter((s) => managers.get(s)).map((s) => ({
        handle: managers.get(s), ms: s, title_en: `Check this system for ${requestNo} (copy of personal data) in Personal data checks`, entity_code: requestNo,
      })));
      const notices = await rowsOf<{ handle: string }>(db, ORG, sql`
        select u.handle from notification n join platform.app_user u on u.id = n.recipient_user_id
         where n.kind = 'privacy_check_requested' and n.entity_ref->>'code' = ${requestNo} order by u.handle`);
      expect(notices.map((n) => n.handle).sort()).toEqual([...new Set([...managers.values()].filter(Boolean))].sort());
      // The audit entry names the request, never the person.
      const [created] = await rowsOf<{ after_data: Record<string, unknown> }>(db, ORG, sql`
        select after_data from audit_trail where action = 'privacy_request.created' and entity_id = ${id}`);
      expect(created!.after_data).toMatchObject({ type: 'access', subject_kind: 'member', channel: 'email', checks: systems.length });
      expect(JSON.stringify(created!.after_data)).not.toMatch(/staff10|Staff 10/);
      const list = await rina.get<Page<PrivacyRequestItem>>(`${REQUESTS}?status=received&type=access`);
      expect(list.body.items.map((r) => r.id)).toContain(id);
      expect((await rina.get<Page<PrivacyRequestItem>>(`${REQUESTS}?q=${requestNo}`)).body.items.map((r) => r.requestNo)).toEqual([requestNo]);
    });

    it('records a correction without checks and a request about a person without an account; refuses a future time and a non-member', async () => {
      const staff = await userId(db, 'staff16');
      const correction = await record({ type: 'rectification', subject: { userId: staff }, receivedAt: new Date().toISOString(), channel: 'letter' });
      expect((await detail(correction.id)).checks).toEqual([]);
      const other = await record({ type: 'erasure', subject: { name: 'Bima Haryanto', email: 'bima.haryanto@supplier.example' }, receivedAt: new Date().toISOString(), channel: 'other' });
      expect((await detail(other.id)).subject).toEqual({ kind: 'other', userId: null, handle: null, name: 'Bima Haryanto', email: 'bima.haryanto@supplier.example' });
      const future = await rina.post(REQUESTS, { type: 'access', subject: { name: 'Bima Haryanto' }, receivedAt: new Date(Date.now() + 2 * HOUR).toISOString(), channel: 'email' });
      expect(future.status).toBe(422);
      expect(future.body.messageKey).toBe('privacy.received_in_future');
      const outsider = await rina.post(REQUESTS, { type: 'access', subject: { userId: await userId(db, 'tenant.admin') }, receivedAt: new Date().toISOString(), channel: 'email' });
      expect(outsider.status).toBe(404);
      const forbidden = await (await as('bagus')).get(REQUESTS);
      expect(forbidden.status).toBe(403);
    });

    it('starts work after the identity check with If-Match, refuses a second start, and refuses a request with its reason', async () => {
      const { id } = await record({ type: 'erasure', subject: { userId: await userId(db, 'staff17') }, receivedAt: new Date().toISOString(), channel: 'email' });
      const stale = await rina.patch(REQUEST(id), { action: 'start', identityCheckNote: 'Checked' }, { 'if-match': 'W/"1"' });
      expect(stale.status).toBe(412);
      const current = await detail(id);
      const started = await rina.patch(REQUEST(id), { action: 'start', identityCheckNote: 'Checked by phone' }, { 'if-match': current.etag });
      expect(started.status, started.text).toBe(200);
      expect(await detail(id)).toMatchObject({ status: 'in_progress', identityCheckNote: 'Checked by phone', identityCheckedBy: { handle: 'rina' }, handledBy: { handle: 'rina' } });
      expect((await rina.patch(REQUEST(id), { action: 'start', identityCheckNote: 'Again' })).status).toBe(409);
      const note = await rina.patch(REQUEST(id), { action: 'note', note: 'Called the person back' });
      expect(note.status).toBe(200);
      expect((await detail(id)).note).toBe('Called the person back');
      const closeEarly = await rina.post(`${REQUEST(id)}/close`, { outcome: 'Done' });
      expect(closeEarly.status).toBe(409);
      expect(closeEarly.body.messageKey).toBe('privacy.checks_open');
      const refused = await rina.patch(REQUEST(id), { action: 'refuse', reason: 'The data is kept under a legal duty' });
      expect(refused.status).toBe(200);
      const after = await detail(id);
      expect(after).toMatchObject({ status: 'refused', outcome: 'The data is kept under a legal duty' });
      expect(after.closedAt).not.toBeNull();
      expect(after.actions.map((a) => a.action)).toEqual(['privacy_request.created', 'privacy_request.updated', 'privacy_request.updated', 'privacy_request.updated']);
      const open = await rowsOf<{ n: number }>(db, ORG, sql`
        select count(*)::int as n from task where source_rule = 'privacy_check' and status = 'open'
           and entity_id in (select c.id from privacy_check c where c.privacy_request_id = ${id})`);
      expect(open[0]!.n).toBe(0);
      expect((await rina.patch(REQUEST(id), { action: 'withdraw', reason: 'Too late' })).status).toBe(409);
    });
  });

  describe('deadline notices (privacy.deadlines, J.3)', () => {
    it('notifies the Tenant Admins of requests due within 24 hours and of overdue ones, and of no other', async () => {
      const now = new Date();
      const soon = await record({ type: 'rectification', subject: { name: 'Citra Lestari' }, receivedAt: new Date(now.getTime() - 60 * HOUR).toISOString(), channel: 'email' });
      const late = await record({ type: 'rectification', subject: { name: 'Dedi Kurniawan' }, receivedAt: new Date(now.getTime() - 80 * HOUR).toISOString(), channel: 'email' });
      const later = await record({ type: 'rectification', subject: { name: 'Eka Saputri' }, receivedAt: now.toISOString(), channel: 'email' });
      expect((await detail(late.id)).overdue).toBe(true);
      expect((await detail(soon.id)).overdue).toBe(false);
      const org = (await ctx.moduleRef.get(TenantResolver).resolveById(ORG_IDS[ORG]))!;
      const result = await ctx.moduleRef.get(TenantScope).withTenant({ orgId: org.id, schema: org.schema, userId: SYSTEM_USER_ID }, (trx) =>
        ctx.moduleRef.get(PrivacyDeadlinesService).run(trx, org, now));
      expect(result.overdue).toBeGreaterThanOrEqual(1);
      const admins = await platformRows<{ handle: string }>(db, sql`
        select u.handle from platform.org_membership m join platform.app_user u on u.id = m.user_id
         where m.organization_id = ${ORG_IDS[ORG]}::uuid and m.status = 'active' and m.deleted_at is null and 'tenant_admin' = any(m.admin_roles)
         order by u.handle`);
      const due = await rowsOf<{ code: string; handle: string; title_en: string }>(db, ORG, sql`
        select n.entity_ref->>'code' as code, u.handle, n.title_en from notification n join platform.app_user u on u.id = n.recipient_user_id
         where n.kind = 'privacy_request_due' order by 1, 2`);
      const of = (code: string) => due.filter((n) => n.code === code);
      expect(of(soon.requestNo).map((n) => n.handle)).toEqual(admins.map((a) => a.handle));
      expect(of(soon.requestNo)[0]!.title_en).toBe(`Personal data request ${soon.requestNo} is due soon`);
      expect(of(late.requestNo).map((n) => n.handle)).toEqual(admins.map((a) => a.handle));
      expect(of(late.requestNo)[0]!.title_en).toBe(`Personal data request ${late.requestNo} is overdue`);
      expect(of(later.requestNo)).toEqual([]);
    });
  });

  describe('the access export (D.6.3)', () => {
    const download = async (client: Client, taskId: string, org: DemoOrg = ORG): Promise<Record<string, unknown>> => {
      const built = await ctx.moduleRef.get(ExportBuildJob).build(ORG_IDS[org], taskId);
      expect(built.status, built.error).toBe('succeeded');
      const task = await client.get<BackgroundTask>(`/api/v1/exports/${taskId}`);
      expect(task.body).toMatchObject({ status: 'succeeded', kind: 'export' });
      const file = await client.get(task.body.downloadUrl!);
      expect(file.status, file.text).toBe(200);
      expect(String(file.headers['content-disposition'])).toMatch(/^attachment; filename="personal-data-staff11-\d{4}-\d{2}-\d{2}\.json"/);
      return JSON.parse(file.raw.toString('utf8')) as Record<string, unknown>;
    };
    const expectClean = async (data: Record<string, unknown>) => {
      expect(data.format).toBe(PERSONAL_DATA_FORMAT);
      expect(Object.keys(data)).toEqual(expect.arrayContaining([...PERSONAL_DATA_SECTIONS]));
      expect(data.account).toMatchObject({ handle: 'staff11', displayName: 'Staff 11', email: 'staff11@nusantaradigital.co.id', kind: 'person' });
      expect(data.membership).toMatchObject({ status: 'active' });
      const text = JSON.stringify(data);
      // No secret of any kind, and no other member's address.
      expect(text).not.toMatch(/password|argon2|secret|token_hash|csrf|recovery/i);
      const others = await platformRows<{ email: string }>(db, sql`
        select u.email from platform.org_membership m join platform.app_user u on u.id = m.user_id
         where m.organization_id = ${ORG_IDS[ORG]}::uuid and u.handle <> 'staff11'`);
      for (const other of others) expect(text.includes(other.email), other.email).toBe(false);
    };

    it('builds the export of an access request for the Tenant Admin, with every section and no secret or other person\'s data', async () => {
      const staff = await as('staff11');
      expect((await staff.patch('/api/v1/me/profile', { jobTitle: 'Records Clerk' })).status).toBe(204);
      const { id, requestNo } = await record({ type: 'access', subject: { userId: staff.userId }, receivedAt: new Date().toISOString(), channel: 'email' });
      const early = await rina.post(`${REQUEST(id)}/export`);
      expect(early.status).toBe(409);
      expect(early.body.messageKey).toBe('privacy.start_first');
      await start(id);
      const queued = await rina.post<CommandResult>(`${REQUEST(id)}/export`);
      expect(queued.status, queued.text).toBe(202);
      const data = await download(rina, queued.body.taskId!);
      await expectClean(data);
      expect((data.account as { jobTitle: string }).jobTitle).toBe('Records Clerk');
      expect((data.sessions as unknown[]).length).toBeGreaterThan(0);
      expect((data.requests as { requestNo: string }[]).map((r) => r.requestNo)).toContain(requestNo);
      const [file] = await rowsOf<{ kind: string; format: string; subject_user_id: string; privacy_request_id: string }>(db, ORG, sql`
        select kind, format, subject_user_id, privacy_request_id from export_file where background_task_id = ${queued.body.taskId}`);
      expect(file).toEqual({ kind: 'personal_data', format: 'json', subject_user_id: staff.userId, privacy_request_id: id });
      expect((await detail(id)).exportTaskId).toBe(queued.body.taskId);
      // The person cannot read the Tenant Admin's task, and the register stays closed to the person.
      expect((await staff.get(`/api/v1/exports/${queued.body.taskId}`)).status).toBe(404);
      expect((await staff.get(REQUEST(id))).status).toBe(403);
      await checkAll(id);
      const closed = await rina.post(`${REQUEST(id)}/close`, { outcome: 'Copy of the data sent by email' });
      expect(closed.status, closed.text).toBe(200);
      expect(await detail(id)).toMatchObject({ status: 'completed', outcome: 'Copy of the data sent by email' });
    });

    it('builds the same export for the person from My account, served to that person only', async () => {
      const staff = await as('staff11');
      const queued = await staff.post<CommandResult>('/api/v1/me/data-export');
      expect(queued.status, queued.text).toBe(202);
      const data = await download(staff, queued.body.taskId!);
      await expectClean(data);
      expect((await rina.get(`/api/v1/exports/${queued.body.taskId}`)).status).toBe(404);
    });
  });

  describe('correction and restriction (D.6.3)', () => {
    it('refuses to correct a shared account, while the person corrects their own name and job title', async () => {
      const staff = await as('staff12');
      const { id } = await record({ type: 'rectification', subject: { userId: staff.userId }, receivedAt: new Date().toISOString(), channel: 'email' });
      await start(id);
      const shared = await rina.post(`${REQUEST(id)}/rectify`, { displayName: 'Staff Twelve' });
      expect(shared.status).toBe(422);
      expect(shared.body.messageKey).toBe('shared_account');
      const own = await staff.patch('/api/v1/me/profile', { displayName: 'Staff Twelve', jobTitle: 'Archive Clerk' });
      expect(own.status, own.text).toBe(204);
      const [user] = await platformRows<{ display_name: string; job_title: string }>(db, sql`select display_name, job_title from platform.app_user where id = ${staff.userId}`);
      expect(user).toEqual({ display_name: 'Staff Twelve', job_title: 'Archive Clerk' });
      const [entry] = await platformRows<{ after_data: Record<string, unknown> }>(db, sql`
        select after_data from platform.audit_log where action = 'user.updated' and entity_id = ${staff.userId} order by seq desc limit 1`);
      expect(entry!.after_data).toMatchObject({ displayName: 'Staff Twelve', jobTitle: 'Archive Clerk', source: 'my_account' });
      expect((await staff.patch('/api/v1/me/profile', {})).status).toBe(400);
      const closed = await rina.post(`${REQUEST(id)}/close`, { outcome: 'The person corrected the shared account in My account' });
      expect(closed.status).toBe(200);
    });

    it('corrects the account of a person who belongs to this organisation only', async () => {
      const user = await inventedMember(db, ORG, { handle: 'wira.santoso', displayName: 'Wira Santosa', email: 'wira.santoso@nusantaradigital.co.id', jobTitle: 'Analyst' });
      const { id } = await record({ type: 'rectification', subject: { userId: user }, receivedAt: new Date().toISOString(), channel: 'email' });
      await start(id);
      const fixed = await rina.post<CommandResult>(`${REQUEST(id)}/rectify`, { displayName: 'Wira Santoso', jobTitle: 'Senior Analyst' });
      expect(fixed.status, fixed.text).toBe(200);
      expect(fixed.body.count).toBe(2);
      const [row] = await platformRows<{ display_name: string; job_title: string }>(db, sql`select display_name, job_title from platform.app_user where id = ${user}`);
      expect(row).toEqual({ display_name: 'Wira Santoso', job_title: 'Senior Analyst' });
      expect((await detail(id)).result).toMatchObject({ rectified: 1, fieldsChanged: 2 });
    });

    it('restricts a person in this organisation only: no sign-in here, sign-in elsewhere keeps working', async () => {
      const ndtSession = await as('staff13', 'ndt');
      const bsdSession = await as('staff13', 'bsd');
      expect((await ndtSession.get('/api/v1/me/privacy-requests')).status).toBe(200);
      const { id } = await record({ type: 'restriction', subject: { userId: ndtSession.userId }, receivedAt: new Date().toISOString(), channel: 'email' });
      expect((await rina.post(`${REQUEST(id)}/restrict`)).status).toBe(409);
      await start(id);
      const restricted = await rina.post(`${REQUEST(id)}/restrict`);
      expect(restricted.status, restricted.text).toBe(200);
      expect(await membership('ndt', ndtSession.userId)).toMatchObject({ status: 'disabled', deleted_at: null });
      expect(await membership('bsd', ndtSession.userId)).toMatchObject({ status: 'active', deleted_at: null });
      expect((await ndtSession.get('/api/v1/me/privacy-requests')).status).toBe(401);
      expect((await signIn(ctx, db, 'staff13', 'ndt').then((c) => c.get('/api/v1/me/privacy-requests'))).status).not.toBe(200);
      expect((await bsdSession.get('/api/v1/me/privacy-requests')).status).toBe(200);
      expect((await rina.post(`${REQUEST(id)}/restrict`)).body.messageKey).toBe('privacy.already_restricted');
      expect((await rina.post(`${REQUEST(id)}/close`, { outcome: 'Processing stopped' })).status).toBe(200);
    });

    it('refuses to restrict or erase one\'s own membership while another Tenant Admin can answer', async () => {
      const rinaTst = await as('rina', 'tst');
      const own = await rinaTst.post<CommandResult>(REQUESTS, { type: 'restriction', subject: { userId: rinaTst.userId }, receivedAt: new Date().toISOString(), channel: 'email' });
      expect(own.status, own.text).toBe(201);
      const id = (own.body.data as { id: string }).id;
      expect((await rinaTst.patch(REQUEST(id), { action: 'start', identityCheckNote: 'Known to the team' })).status).toBe(200);
      const refused = await rinaTst.post(`${REQUEST(id)}/restrict`);
      expect(refused.status).toBe(403);
      expect(await membership('tst', rinaTst.userId)).toMatchObject({ status: 'active', deleted_at: null });
    });

    it('refuses to restrict the last active Tenant Admin', async () => {
      const { id } = await record({ type: 'restriction', subject: { userId: rina.userId }, receivedAt: new Date().toISOString(), channel: 'email' });
      await start(id);
      const refused = await rina.post(`${REQUEST(id)}/restrict`);
      expect(refused.status).toBe(409);
      expect(refused.body.messageKey).toBe('last_tenant_admin');
    });
  });

  describe('erasure (D.6.5)', () => {
    it('refuses an erasure while checks are open and while the person holds open items', async () => {
      const bagus = await userId(db, 'bagus');
      const { id } = await record({ type: 'erasure', subject: { userId: bagus }, receivedAt: new Date().toISOString(), channel: 'email' });
      await start(id);
      const open = await rina.post(`${REQUEST(id)}/erase`, { confirm: true });
      expect(open.status).toBe(409);
      expect(open.body.messageKey).toBe('privacy.checks_open');
      await checkAll(id);
      const held = await rina.post(`${REQUEST(id)}/erase`, { confirm: true });
      expect(held.status, held.text).toBe(422);
      expect(held.body.rule).toBe('ERASE-OPEN-ITEMS');
      expect(held.body.messages.en).toMatch(/still holds \d+ open items/);
      expect((await rina.post(`${REQUEST(id)}/erase`, {})).status).toBe(400);
    });

    it('refuses to erase the last active Tenant Admin', async () => {
      const { id } = await record({ type: 'erasure', subject: { userId: rina.userId }, receivedAt: new Date().toISOString(), channel: 'email' });
      await start(id);
      await checkAll(id);
      const refused = await rina.post(`${REQUEST(id)}/erase`, { confirm: true });
      expect(refused.status).toBe(409);
      expect(refused.body.messageKey).toBe('last_tenant_admin');
    });

    it('erases a shared account in this organisation under a pseudonym, and the account keeps working in its other organisation', async () => {
      const staff = await as('staff14', 'ndt');
      const staffBsd = await as('staff14', 'bsd');
      const email = 'staff14@nusantaradigital.co.id';
      // Traces of the person: own audit entries (a profile change, a request from My account), a completed activity, a
      // notification and a calendar feed.
      expect((await staff.patch('/api/v1/me/profile', { jobTitle: 'Filing Clerk' })).status).toBe(204);
      const own = await staff.post<CommandResult>('/api/v1/me/privacy-requests', { type: 'erasure', note: 'Please erase my data' });
      expect(own.status, own.text).toBe(201);
      const id = (own.body.data as { id: string }).id;
      const [activity] = await rowsOf<{ id: string; code: string }>(db, ORG, sql`
        update implementation_activity_progress set status = 'verified', completed_by_user_id = ${staff.userId}::uuid, completed_at = now(), verified_at = now()
         where id = (select a.id from implementation_activity_progress a join management_system m on m.id = a.management_system_id
                      where m.slug = 'isms' and a.deleted_at is null order by a.phase_no, a.activity_no limit 1)
        returning id, phase_no || '.' || activity_no as code`);
      await rowsOf(db, ORG, sql`
        insert into calendar_feed_token (user_id, management_system_id, token_hash)
        select ${staff.userId}::uuid, m.id, ${randomBytes(32)} from management_system m where m.slug = 'isms' returning id`);
      await rowsOf(db, ORG, sql`
        insert into notification (recipient_user_id, kind, title_en, title_id, body_en, body_id)
        values (${staff.userId}::uuid, 'reminder', 'A reminder for Staff 14', 'Pengingat', 'b', 'b') returning id`);
      // A competence record about the person (clause 7.2), which stays under the pseudonym after the erasure (D.6.5).
      const competence = await rina.post<CommandResult>('/api/v1/ms/isms/registers/competence', {
        title: 'Records clerk', ownerHandle: 'rina', personHandle: 'staff14', competenceRequired: 'Records handling course', proofType: 'certificate',
      });
      expect(competence.status, competence.text).toBe(201);
      expect(competence.body.ref?.code).toMatch(/^CMP-/);
      // Copies of the person's data for an access request: one built (rina can download it and has the notice), one
      // still queued. The erasure withdraws both (D.6.3, D.6.5).
      const access = await record({ type: 'access', subject: { userId: staff.userId }, receivedAt: new Date().toISOString(), channel: 'email' });
      await start(access.id);
      const builtCopy = await rina.post<CommandResult>(`${REQUEST(access.id)}/export`);
      expect(builtCopy.status, builtCopy.text).toBe(202);
      const builtTask = builtCopy.body.taskId!;
      expect((await ctx.moduleRef.get(ExportBuildJob).build(ORG_IDS[ORG], builtTask)).status).toBe('succeeded');
      expect((await rina.get(`/api/v1/exports/${builtTask}/download`)).status).toBe(200);
      const queuedCopy = await rina.post<CommandResult>(`${REQUEST(access.id)}/export`);
      expect(queuedCopy.status, queuedCopy.text).toBe(202);
      const queuedTask = queuedCopy.body.taskId!;
      const copyNotices = async () => (await rowsOf<{ n: number }>(db, ORG, sql`
        select count(*)::int as n from notification where kind = 'export_ready' and entity_ref->>'id' = any(${[builtTask, queuedTask]}::text[])`))[0]!.n;
      expect(await copyNotices()).toBe(1);
      await start(id);
      await checkAll(id);
      const erased = await rina.post<CommandResult>(`${REQUEST(id)}/erase`, { confirm: true });
      expect(erased.status, erased.text).toBe(200);
      const counts = erased.body.data as Record<string, number>;
      expect(counts).toMatchObject({ erased: 1, accountAnonymised: 0 });
      expect(counts.auditEntriesRedacted).toBeGreaterThan(0);
      expect(counts.platformEntriesRedacted).toBeGreaterThan(0);
      expect(counts.notificationsDeleted).toBeGreaterThanOrEqual(2);
      expect(counts.calendarFeedsDeleted).toBe(1);
      expect(counts.exportsWithdrawn).toBe(2);

      const [person] = await rowsOf<{ pseudonym: string; privacy_request_id: string }>(db, ORG, sql`
        select pseudonym, privacy_request_id from erased_person where erased_user_id = ${staff.userId}`);
      expect(person!.pseudonym).toMatch(/^Former user [0-9A-F]{4}$/);
      expect(person!.privacy_request_id).toBe(id);
      const pseudonym = person!.pseudonym;
      const handle = pseudonymHandle(pseudonym);
      expect(handle).toMatch(/^former-user-[0-9a-f]{4}$/);

      // The membership is removed here only; the account is kept, as it still belongs to other organisations.
      expect((await membership('ndt', staff.userId))!.deleted_at).not.toBeNull();
      expect(await membership('bsd', staff.userId)).toMatchObject({ status: 'active', deleted_at: null });
      const [account] = await platformRows<{ handle: string; erased_at: Date | null; status: string }>(db, sql`select handle, erased_at, status from platform.app_user where id = ${staff.userId}`);
      expect(account).toEqual({ handle: 'staff14', erased_at: null, status: 'active' });
      expect((await staff.get('/api/v1/me/privacy-requests')).status).toBe(401);
      expect((await staffBsd.get('/api/v1/me/privacy-requests')).status).toBe(200);
      expect((await rowsOf<{ n: number }>(db, ORG, sql`select count(*)::int as n from notification where recipient_user_id = ${staff.userId}`))[0]!.n).toBe(0);
      expect((await rowsOf<{ n: number }>(db, ORG, sql`select count(*)::int as n from calendar_feed_token where user_id = ${staff.userId}`))[0]!.n).toBe(0);
      expect((await rowsOf<{ n: number }>(db, ORG, sql`select count(*)::int as n from user_ms_role where user_id = ${staff.userId} and deleted_at is null`))[0]!.n).toBe(0);

      // The copies of the data are withdrawn: the built file expired (the next clean-up deletes its vault content) and
      // its name, stored object and task result carry the pseudonym; the queued build failed and a late build fails
      // too; rina's notice is gone, the download answers 404 and a new copy is refused.
      const files = await rowsOf<{ file_name: string; deleted_at: Date | null; expired: boolean; display_name: string | null; result: { fileName?: string } | null }>(db, ORG, sql`
        select f.file_name, f.deleted_at, f.expires_at <= now() as expired, o.display_name, t.result
          from export_file f left join storage_object o on o.id = f.storage_object_id left join background_task t on t.id = f.background_task_id
         where f.background_task_id = ${builtTask}::uuid`);
      expect(files).toHaveLength(1);
      const withdrawnName = files[0]!.file_name;
      expect(withdrawnName).toMatch(new RegExp(`^personal-data-${handle}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
      expect(files[0]).toMatchObject({ expired: true, display_name: withdrawnName, result: { fileName: withdrawnName } });
      expect(files[0]!.deleted_at).not.toBeNull();
      const [stopped] = await rowsOf<{ status: string; error: string | null }>(db, ORG, sql`select status, error from background_task where id = ${queuedTask}::uuid`);
      expect(stopped).toEqual({ status: 'failed', error: ERASED_SUBJECT });
      expect(await ctx.moduleRef.get(ExportBuildJob).build(ORG_IDS[ORG], queuedTask)).toMatchObject({ status: 'failed', error: ERASED_SUBJECT });
      expect((await rina.get(`/api/v1/exports/${builtTask}/download`)).status).toBe(404);
      expect(await copyNotices()).toBe(0);
      const again = await rina.post(`${REQUEST(access.id)}/export`);
      expect(again.status).toBe(409);
      expect(again.body.messageKey).toBe('privacy.already_erased');
      expect(JSON.stringify(await rowsOf(db, ORG, sql`
        select f.file_name, o.display_name, t.result, t.error from background_task t
          left join export_file f on f.background_task_id = t.id left join storage_object o on o.id = f.storage_object_id
         where t.id in (${builtTask}::uuid, ${queuedTask}::uuid)`))).not.toMatch(/staff14|Staff 14/);

      // The user list, the read model and the audit trail of this organisation show the pseudonym only.
      const users = await rina.get<Page<UserView>>('/api/v1/admin/users?pageSize=200');
      expect(JSON.stringify(users.body)).not.toMatch(/staff14|Staff 14/);
      const org = await rina.get<{ PEOPLE: Record<string, [string, string]> }>('/api/v1/ui/org');
      expect(org.status, org.text).toBe(200);
      expect(org.body.PEOPLE[handle]).toEqual([pseudonym, 'Former member']);
      const isms = await rina.get('/api/v1/ui/ms/isms');
      const isms_text = JSON.stringify(isms.body);
      expect(isms_text).not.toMatch(/staff14|Staff 14/);
      expect(isms.status, isms.text).toBe(200);
      expect(isms_text).toContain(`"by":"${handle}"`);
      expect(activity).toBeDefined();
      const trail = await rina.get<Page<{ actor: { handle: string | null; displayName: string | null }; redacted: boolean; sourceIp: string | null; userAgent: string | null }>>(
        `/api/v1/admin/audit-trail?entityId=${staff.userId}&pageSize=200`);
      expect(trail.status, trail.text).toBe(200);
      expect(trail.body.items.length).toBeGreaterThan(0);
      for (const entry of trail.body.items) {
        expect(entry.actor.handle).not.toBe('staff14');
        if (entry.actor.handle && entry.actor.handle !== 'rina') expect(entry.actor).toMatchObject({ handle, displayName: pseudonym });
      }
      expect(JSON.stringify(trail.body)).not.toMatch(/staff14|Staff 14|Filing Clerk/);

      // The exports name the person by the pseudonym, as the screens do: a document that still names the person as owner
      // shows "Former user ..." in the document register. The erasure refuses a person who owns a document, so the row
      // is written here after it, with the member check of the column set aside for this one statement.
      const owned = await inOrg(db, ORG, async (trx) => {
        await sql`alter table document disable trigger assert_member`.execute(trx);
        const { rows } = await sql<{ doc_code: string }>`
          update document set owner_user_id = ${staff.userId}::uuid, next_review_at = current_date
           where id = (select d.id from document d
                        where d.deleted_at is null and exists (select 1 from entity_ms_link l join management_system m on m.id = l.management_system_id
                                                                where l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null and m.slug = 'isms')
                        order by d.doc_code limit 1)
          returning doc_code`.execute(trx);
        await sql`alter table document enable trigger assert_member`.execute(trx);
        return rows[0];
      });
      const register = await rina.get('/api/v1/ms/isms/documents/export?format=csv');
      expect(register.status, register.text).toBe(200);
      const registerText = register.raw.toString('utf8');
      const ownedLine = registerText.split('\r\n').find((line) => line.startsWith(`${owned!.doc_code},`));
      expect(ownedLine, registerText).toContain(`,${pseudonym},`);
      expect(registerText).not.toMatch(/staff14|Staff 14|former-user-/);
      // The review calendar feed names the owner of the document, due for review today, by the pseudonym too.
      const feed = await rina.post<CalendarFeed>('/api/v1/ms/isms/calendar-feed', {});
      expect(feed.status, feed.text).toBe(201);
      const calendar = await ctx.app.inject({ method: 'GET', url: feed.body.downloadUrl });
      expect(calendar.statusCode, calendar.body).toBe(200);
      const calendarText = calendar.body.replace(/\r\n /g, '');
      expect(calendarText).toContain(`${owned!.doc_code} `);
      expect(calendarText).toContain(`(owner ${pseudonym})`);
      expect(calendarText).not.toMatch(/staff14|Staff 14|former-user-/);

      // The registers name the person by the pseudonym: the competence record about the person (registers.list).
      const competences = await rina.get<Page<{ code: string; owner: string; personHandle?: string | null }>>('/api/v1/ms/isms/registers/competence?pageSize=200');
      expect(competences.status, competences.text).toBe(200);
      expect(competences.body.items.find((item) => item.code === competence.body.ref!.code)).toMatchObject({ personHandle: handle, owner: 'rina' });
      expect(JSON.stringify(competences.body)).not.toMatch(/staff14|Staff 14/);

      // The audit rows hold no address, browser, email or name of the person, and both chains verify.
      const tenantRows = await rowsOf<{ entity_code: string | null; before_data: unknown; after_data: unknown; source_ip: string | null; user_agent: string | null; redacted_at: Date | null }>(db, ORG, sql`
        select entity_code, before_data, after_data, host(source_ip) as source_ip, user_agent, redacted_at from audit_trail where actor_user_id = ${staff.userId}`);
      expect(tenantRows.length).toBeGreaterThan(0);
      for (const row of tenantRows) {
        expect(row).toMatchObject({ source_ip: null, user_agent: null });
        expect(row.redacted_at).not.toBeNull();
        expect(JSON.stringify(row)).not.toMatch(new RegExp(`staff14|Staff 14|${email.replace(/\./g, '\\.')}`));
      }
      const platformAbout = await platformRows<{ action: string; entity_code: string | null; before_data: unknown; after_data: unknown; source_ip: string | null; user_agent: string | null }>(db, sql`
        select action, entity_code, before_data, after_data, host(source_ip) as source_ip, user_agent from platform.audit_log
         where organization_id = ${ORG_IDS[ORG]}::uuid and (actor_user_id = ${staff.userId}::uuid or entity_id = ${staff.userId}::uuid)
           and action <> 'user.audit_redacted'`);
      expect(platformAbout.length).toBeGreaterThan(0);
      for (const row of platformAbout) {
        expect(JSON.stringify(row), row.action).not.toMatch(/staff14|Staff 14|nusantaradigital/);
        if (row.action === 'user.updated') expect(row).toMatchObject({ source_ip: null, user_agent: null });
      }
      const attestations = await rowsOf<{ action: string }>(db, ORG, sql`select action from audit_trail where action = 'privacy.audit_redacted' and entity_id = ${id}`);
      expect(attestations).toHaveLength(1);
      const verifier = ctx.moduleRef.get(AuditChainVerifier);
      const tenantChain = await verifier.verifyTenant({ orgId: ORG_IDS[ORG], schema: `org_${ORG}` });
      expect(tenantChain).toMatchObject({ firstBrokenSeq: null });
      expect(tenantChain.redacted).toBeGreaterThan(0);
      expect((await verifier.verifyPlatform()).firstBrokenSeq).toBeNull();

      // The other organisation still shows the person by name.
      const bsdAdmin = await as('rina', 'bsd');
      const bsdUsers = await bsdAdmin.get<Page<UserView>>('/api/v1/admin/users?q=staff14');
      expect(bsdUsers.body.items.map((u) => u.handle)).toEqual(['staff14']);

      // The request keeps the name as entered and records what was done; a second erasure is refused.
      expect(await detail(id)).toMatchObject({ subject: { name: 'Staff 14', email }, result: { erased: 1 } });
      expect((await rina.post(`${REQUEST(id)}/erase`, { confirm: true })).body.messageKey).toBe('privacy.already_erased');
      expect((await rina.post(`${REQUEST(id)}/close`, { outcome: 'Erased in this organisation' })).status).toBe(200);
    });

    it('anonymises the account of a person with no other membership', async () => {
      const user = await inventedMember(db, ORG, { handle: 'arya.nugraha', displayName: 'Arya Nugraha', email: 'arya.nugraha@nusantaradigital.co.id', jobTitle: 'Planner', role: 'domain_owner' });
      const arya = await as('arya.nugraha');
      expect((await arya.patch('/api/v1/me/profile', { jobTitle: 'Senior Planner' })).status).toBe(204);
      const { id } = await record({ type: 'erasure', subject: { userId: user }, receivedAt: new Date().toISOString(), channel: 'email' });
      await start(id);
      await checkAll(id);
      const erased = await rina.post<CommandResult>(`${REQUEST(id)}/erase`, { confirm: true });
      expect(erased.status, erased.text).toBe(200);
      expect(erased.body.data).toMatchObject({ erased: 1, accountAnonymised: 1, rolesRevoked: 1 });
      const [account] = await platformRows<{ handle: string; email: string; display_name: string; job_title: string | null; status: string; erased_at: Date | null }>(db, sql`
        select handle, email, display_name, job_title, status, erased_at from platform.app_user where id = ${user}`);
      expect(account!.handle).toMatch(/^erased-[0-9a-f]{8}$/);
      expect(account).toMatchObject({ email: `${account!.handle}@erased.invalid`, display_name: 'Former user', job_title: null, status: 'disabled' });
      expect(account!.erased_at).not.toBeNull();
      const anonymised = await platformRows<{ entity_code: string }>(db, sql`select entity_code from platform.audit_log where action = 'user.anonymised' and entity_id = ${user}`);
      expect(anonymised.map((a) => a.entity_code)).toEqual([account!.handle]);
      const platformAbout = await platformRows<{ text: string }>(db, sql`
        select coalesce(entity_code, '') || coalesce(before_data::text, '') || coalesce(after_data::text, '') as text from platform.audit_log
         where actor_user_id = ${user}::uuid or entity_id = ${user}::uuid`);
      for (const row of platformAbout) expect(row.text).not.toMatch(/arya\.nugraha|Arya Nugraha/i);
      expect((await ctx.moduleRef.get(AuditChainVerifier).verifyPlatform()).firstBrokenSeq).toBeNull();
    });
  });

  describe('system checks and the mention search (D.6.4)', () => {
    it('finds a name in a risk description and in an interested party\'s requirements, an address in another party\'s, and nothing from another system', async () => {
      // An ISMS risk that the QMS does not share (its QMS link, if any, is removed here).
      const isOnlyIsms = async (table: 'risk'): Promise<{ id: string; code: string }> => {
        const [row] = await rowsOf<{ id: string; code: string }>(db, ORG, sql`
          select t.id, t.code from ${sql.table(table)} t where t.deleted_at is null order by
            (exists (select 1 from entity_ms_link l join management_system m on m.id = l.management_system_id
                      where l.entity_type = ${table} and l.entity_id = t.id and l.deleted_at is null and m.slug = 'isms')) desc, t.code limit 1`);
        await rowsOf(db, ORG, sql`
          insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary)
          select ${table}, ${row!.id}::uuid, m.id, false from management_system m
           where m.slug = 'isms' and not exists (select 1 from entity_ms_link l where l.entity_type = ${table} and l.entity_id = ${row!.id}::uuid
                                                  and l.management_system_id = m.id and l.deleted_at is null)
          returning id`);
        await rowsOf(db, ORG, sql`
          update entity_ms_link set deleted_at = now() where entity_type = ${table} and entity_id = ${row!.id}::uuid and deleted_at is null
             and management_system_id = (select id from management_system where slug = 'qms') returning id`);
        return row!;
      };
      const risk = await isOnlyIsms('risk');
      // The demo organisation keeps no interested parties: two invented ones, linked to the ISMS only. The first names
      // the person by email, the second by name alone.
      const [party] = await rowsOf<{ id: string; code: string }>(db, ORG, sql`
        insert into interested_party (code, title, requirements) values ('IP-PRIV-01', 'Cleaning contractor', 'Keeps the office clean.') returning id, code`);
      const [named] = await rowsOf<{ id: string; code: string }>(db, ORG, sql`
        insert into interested_party (code, title, requirements)
        values ('IP-PRIV-02', 'Building management', 'Site visits are arranged with Larasati Permana a week ahead.') returning id, code`);
      await rowsOf(db, ORG, sql`
        insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary)
        select 'interested_party', p.id, m.id, true from management_system m, interested_party p
         where m.slug = 'isms' and p.id in (${party!.id}::uuid, ${named!.id}::uuid) returning id`);
      await rowsOf(db, ORG, sql`update risk set description = coalesce(description, '') || ' Reported by Larasati Permana of the cleaning contractor.' where id = ${risk.id} returning id`);
      await rowsOf(db, ORG, sql`update interested_party set requirements = coalesce(requirements, '') || ' Contact: larasati.permana@contractor.example' where id = ${party!.id} returning id`);
      const { id, requestNo } = await record({
        type: 'erasure', subject: { name: 'Larasati Permana', email: 'larasati.permana@contractor.example' }, receivedAt: new Date().toISOString(), channel: 'letter',
      });
      const ismsManager = await as(managers.get('isms')!);
      const checks = await ismsManager.get<PrivacyCheckItem[]>(CHECKS('isms'));
      const check = checks.body.find((c) => c.requestNo === requestNo)!;
      expect(check).toMatchObject({ type: 'erasure', status: 'open', subject: { name: 'Larasati Permana', handle: null } });
      const found = await ismsManager.get<PrivacyMentions>(`${CHECKS('isms')}/${check.id}/mentions`);
      expect(found.status, found.text).toBe(200);
      expect(found.body.truncated).toBe(false);
      expect(found.body.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ recordKind: 'risk', recordId: risk.id, code: risk.code, field: 'description', excerpt: expect.stringContaining('Larasati Permana') }),
        expect.objectContaining({ recordKind: 'interested_party', recordId: party!.id, code: party!.code, field: 'requirements', excerpt: expect.stringContaining('larasati.permana@contractor.example') }),
        expect.objectContaining({ recordKind: 'interested_party', recordId: named!.id, code: named!.code, field: 'requirements', excerpt: expect.stringContaining('Larasati Permana') }),
      ]));
      const qmsHandle = managers.get('qms')!;
      const qmsManager = await as(qmsHandle);
      const qmsCheck = (await qmsManager.get<PrivacyCheckItem[]>(CHECKS('qms'))).body.find((c) => c.requestNo === requestNo)!;
      const elsewhere = await qmsManager.get<PrivacyMentions>(`${CHECKS('qms')}/${qmsCheck.id}/mentions`);
      expect(elsewhere.body.items.map((m) => m.recordId)).not.toContain(risk.id);
      expect(elsewhere.body.items.map((m) => m.recordId)).not.toContain(party!.id);
      expect(elsewhere.body.items.map((m) => m.recordId)).not.toContain(named!.id);
      // A check of another system is not found through this system.
      expect((await ismsManager.get(`${CHECKS('isms')}/${qmsCheck.id}/mentions`)).status).toBe(404);
      // Mark done, then the erasure of a person without an account records that every check is done.
      await start(id);
      await checkAll(id);
      expect((await ismsManager.post(`${CHECKS('isms')}/${check.id}/done`, { note: 'Again' })).body.messageKey).toBe('privacy.check_done');
      const doneTasks = await rowsOf<{ status: string }>(db, ORG, sql`
        select distinct status from task where source_rule = 'privacy_check' and entity_id in (select c.id from privacy_check c where c.privacy_request_id = ${id})`);
      expect(doneTasks.map((t) => t.status)).toEqual(['done']);
      const erased = await rina.post<CommandResult>(`${REQUEST(id)}/erase`, { confirm: true });
      expect(erased.status, erased.text).toBe(200);
      expect(erased.body.data).toMatchObject({ erased: 1, systemsChecked: managers.size, auditEntriesRedacted: 0 });
      expect((await rina.post(`${REQUEST(id)}/close`, { outcome: 'Two records edited' })).status).toBe(200);
      expect((await ismsManager.get<PrivacyCheckItem[]>(CHECKS('isms'))).body.find((c) => c.requestNo === requestNo)).toMatchObject({ status: 'done' });
      expect((await (await as('bagus')).get(CHECKS('isms'))).status).toBe(403);
    });
  });

  describe("the person's own requests (D.6.6)", () => {
    it('sends a request from My account, tells the Tenant Admins and lists it for the person', async () => {
      const staff = await as('staff15');
      const sent = await staff.post<CommandResult>('/api/v1/me/privacy-requests', { type: 'restriction', note: 'Please stop sending me tasks' });
      expect(sent.status, sent.text).toBe(201);
      const requestNo = (sent.body.data as { requestNo: string }).requestNo;
      const mine = await staff.get<{ requestNo: string; type: string; status: string }[]>('/api/v1/me/privacy-requests');
      expect(mine.body).toEqual([expect.objectContaining({ requestNo, type: 'restriction', status: 'received' })]);
      const received = await rowsOf<{ handle: string }>(db, ORG, sql`
        select u.handle from notification n join platform.app_user u on u.id = n.recipient_user_id
         where n.kind = 'privacy_request_received' and n.entity_ref->>'code' = ${requestNo}`);
      expect(received.map((r) => r.handle)).toContain('rina');
      const again = await staff.post('/api/v1/me/privacy-requests', { type: 'restriction' });
      expect(again.status).toBe(409);
      expect(again.body.messageKey).toBe('privacy.open_request');
      expect((await staff.post('/api/v1/me/privacy-requests', { type: 'access' })).status).toBe(400);
      expect((await rina.get<Page<PrivacyRequestItem>>(`${REQUESTS}?q=${requestNo}`)).body.items[0]).toMatchObject({ channel: 'self_service', subject: { handle: 'staff15' } });
    });
  });

  describe('read confirmation settings in the snapshot (D.7)', () => {
    it('carries the stored settings of a document that differ from the defaults, and leaves the member out otherwise', async () => {
      const docs = await rowsOf<{ id: string; doc_code: string }>(db, ORG, sql`
        select d.id, d.doc_code from document d join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.deleted_at is null
          join management_system m on m.id = l.management_system_id and m.slug = 'isms'
         where d.deleted_at is null and not d.is_org_wide order by d.doc_code limit 2`);
      const [set, plain] = docs;
      await rowsOf(db, ORG, sql`
        update document set acknowledgement_required = true, acknowledgement_scope = 'roles', acknowledgement_roles = array['ms_manager', 'domain_owner'],
               acknowledgement_due_days = 21
         where id = ${set!.id} returning id`);
      const snapshot = await rina.get<{ bundle: { docs: { id: string; acknowledgement?: unknown }[] } }>('/api/v1/ui/ms/isms');
      expect(snapshot.status, snapshot.text).toBe(200);
      const byCode = new Map(snapshot.body.bundle.docs.map((d) => [d.id, d]));
      expect(byCode.get(set!.doc_code)?.acknowledgement).toEqual({ required: true, scope: 'roles', roles: ['ms_manager', 'domain_owner'], dueDays: 21 });
      expect(byCode.get(plain!.doc_code)).toBeDefined();
      expect(byCode.get(plain!.doc_code)!.acknowledgement).toBeUndefined();
    });
  });

  describe('retention clean-up (D.6.7)', () => {
    it('removes old sessions, tokens and read notifications, and keeps a notification a reminder refers to', async () => {
      const hash = () => randomBytes(32);
      const staff = await userId(db, 'staff18');
      const ago = (days: number) => sql.raw(`now() - interval '${days} days'`);
      const [oldEnded, recentEnded] = [hash(), hash()];
      await platformRows(db, sql`
        insert into platform.session (id_hash, user_id, organization_id, state, auth_method, csrf_token_hash, idle_expires_at, absolute_expires_at, revoked_at, revoke_reason)
        values (${oldEnded}, ${staff}::uuid, ${ORG_IDS[ORG]}::uuid, 'active', 'local', ${hash()}, ${ago(120)}, ${ago(119)}, ${ago(100)}, 'logout'),
               (${recentEnded}, ${staff}::uuid, ${ORG_IDS[ORG]}::uuid, 'active', 'local', ${hash()}, ${ago(20)}, ${ago(19)}, ${ago(10)}, 'logout')
        returning id_hash`);
      const invitations = await platformRows<{ id: string; used: boolean }>(db, sql`
        insert into platform.invitation (token_hash, organization_id, user_id, email, created_by, created_at, expires_at, used_at)
        values (${hash()}, ${ORG_IDS[ORG]}::uuid, ${staff}::uuid, 'staff18@nusantaradigital.co.id', ${rina.userId}::uuid, ${ago(50)}, ${ago(45)}, ${ago(40)}),
               (${hash()}, ${ORG_IDS[ORG]}::uuid, ${staff}::uuid, 'staff18@nusantaradigital.co.id', ${rina.userId}::uuid, ${ago(6)}, ${ago(1)}, ${ago(5)})
        returning id, used_at < now() - interval '30 days' as used`);
      const [oldToken, recentToken] = [hash(), hash()];
      await platformRows(db, sql`
        insert into platform.password_reset_token (token_hash, user_id, created_at, expires_at)
        values (${oldToken}, ${staff}::uuid, ${ago(41)}, ${ago(40)}), (${recentToken}, ${staff}::uuid, ${ago(6)}, ${ago(5)}) returning token_hash`);
      const notes = await rowsOf<{ id: string; title_en: string }>(db, ORG, sql`
        insert into notification (recipient_user_id, kind, title_en, title_id, body_en, body_id, read_at, created_at)
        values (${staff}::uuid, 'reminder', 'old read', 'lama', 'b', 'b', ${ago(400)}, ${ago(401)}),
               (${staff}::uuid, 'reminder', 'old read kept by a reminder', 'lama', 'b', 'b', ${ago(400)}, ${ago(401)}),
               (${staff}::uuid, 'reminder', 'recent read', 'baru', 'b', 'b', ${ago(10)}, ${ago(11)}),
               (${staff}::uuid, 'reminder', 'old unread', 'lama', 'b', 'b', null, ${ago(401)})
        returning id, title_en`);
      const kept = notes.find((n) => n.title_en === 'old read kept by a reminder')!;
      await rowsOf(db, ORG, sql`
        insert into reminder (record_key, entity_type, entity_id, recipient_user_id, sent_by_user_id, notification_id)
        values ('test:cleanup', 'risk', gen_random_uuid(), ${staff}::uuid, ${rina.userId}::uuid, ${kept.id}::uuid) returning id`);

      const result = await ctx.moduleRef.get(CleanupExpiredJob).cleanup();
      expect(result.failedOrganisations).toEqual([]);
      expect(result.sessionsDeleted).toBeGreaterThanOrEqual(1);
      const sessions = await platformRows<{ id_hash: Buffer }>(db, sql`select id_hash from platform.session where user_id = ${staff}::uuid`);
      const left = sessions.map((s) => Buffer.from(s.id_hash).toString('hex'));
      expect(left).toContain(recentEnded.toString('hex'));
      expect(left).not.toContain(oldEnded.toString('hex'));
      const stillInvited = await platformRows<{ id: string }>(db, sql`select id from platform.invitation where user_id = ${staff}::uuid`);
      expect(stillInvited.map((i) => i.id)).toEqual(invitations.filter((i) => !i.used).map((i) => i.id));
      const tokens = await platformRows<{ token_hash: Buffer }>(db, sql`select token_hash from platform.password_reset_token where user_id = ${staff}::uuid`);
      expect(tokens.map((t) => Buffer.from(t.token_hash).toString('hex'))).toEqual([recentToken.toString('hex')]);
      const remaining = await rowsOf<{ title_en: string }>(db, ORG, sql`select title_en from notification where recipient_user_id = ${staff}::uuid order by title_en`);
      expect(remaining.map((n) => n.title_en)).toEqual(['old read kept by a reminder', 'old unread', 'recent read']);
    });
  });
});
