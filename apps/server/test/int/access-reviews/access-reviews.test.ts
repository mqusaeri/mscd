// The periodic access review against the demo data with a real storage gateway on SeaweedFS (Milestone 3 D.9, J.8,
// M3-07). In the Test Organisation (`tst`) tenant.admin and rina are the two Tenant Admins, rina is the only
// Management System Manager of the ISMS (no Programme Owner), and the guest ext.auditor holds an open auditor grant.
// The settings with If-Match; "Start review now" with its snapshot (memberships, admin roles, linked sign-in, business
// roles, the guest grant without its role row), task and notices, one open review at a time; decisions with
// REVIEW-OWN-ACCESS; the guest grant revoked through the system route; the sign-off refused with undecided items and
// accepted with rina's own role left for a second reviewer (REVIEW-SINGLE-ADMIN), proposing the A.5.18 evidence; a
// business role revocation, a linked sign-in removal and a membership change applied by tenant.admin; completion
// refused while something waits, then completed with the report in the vault and the ISMS rows filed as a new file of
// the evidence item; the report CSV; cancel; a system nobody may review (its own message, no "second reviewer" items)
// and the requester and approver of a business role. Every route answers 403 to a person without the permission.
import type { AccessReviewDetail, AccessReviewPartDetail, AccessReviewPartSummary, AccessReviewSettings, AccessReviewSummary, CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { startStorageStack, type StorageStack } from '../files/helpers';
import {
  createReviewApp, insertProvider, linkIdentity, platformRows, rowsOf, signIn, userId, type FilesClient, type ReviewApp,
} from './helpers';

interface Problem {
  rule?: string;
  messageKey?: string;
  messages?: { en: string; id: string };
  errors?: { path: string; message: string }[];
}

const ADMIN = '/api/v1/admin/access-reviews';
const MS = '/api/v1/ms/isms/access-reviews';

describe('periodic access review (Milestone 3 D.9)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: ReviewApp;
  let admin: FilesClient;
  let rina: FilesClient;
  let bagus: FilesClient;
  let reviewId = '';
  let providerId = '';

  const detail = async () => {
    const answer = await admin.get<AccessReviewDetail>(`${ADMIN}/${reviewId}`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body;
  };
  const part = async (client: FilesClient = rina) => {
    const answer = await client.get<AccessReviewPartDetail>(`${MS}/${reviewId}`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body;
  };
  const decideOrg = (client: FilesClient, itemId: string, body: Record<string, unknown>) => client.post<CommandResult & Problem>(`${ADMIN}/${reviewId}/items/${itemId}/decision`, body);
  const decideMs = (client: FilesClient, itemId: string, body: Record<string, unknown>) => client.post<CommandResult & Problem>(`${MS}/${reviewId}/items/${itemId}/decision`, body);
  const applyOrg = (client: FilesClient, itemId: string, body: Record<string, unknown>) => client.post<CommandResult & Problem>(`${ADMIN}/${reviewId}/items/${itemId}/apply`, body);
  const applyMs = (client: FilesClient, itemId: string, body: Record<string, unknown>) => client.post<CommandResult & Problem>(`${MS}/${reviewId}/items/${itemId}/apply`, body);

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createReviewApp(db, stack.gateway.url);
    admin = await signIn(ctx as never, db, 'tenant.admin', 'tst');
    rina = await signIn(ctx as never, db, 'rina', 'tst');
    bagus = await signIn(ctx as never, db, 'bagus', 'tst');
    // A company sign-in provider of tst, with bagus linked through it (the snapshot reviews it).
    providerId = await insertProvider(db, 'tst', 'tst-keycloak');
    await linkIdentity(db, providerId, bagus.userId, 'kc-bagus-0001');
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('reads and changes the settings with If-Match; the next due date is today or later', async () => {
    const first = await admin.get<AccessReviewSettings>(`${ADMIN}/settings`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ frequencyMonths: 3, nextDueOn: null, daysToComplete: 14, etag: 'W/"0"' });
    expect(first.headers.etag).toBe('W/"0"');
    expect((await bagus.get(`${ADMIN}/settings`)).status).toBe(403);

    const stale = await admin.call<Problem>('PUT', `${ADMIN}/settings`, { frequencyMonths: 3, nextDueOn: '2026-12-31', daysToComplete: 14 }, { 'if-match': 'W/"123"' });
    expect(stale.status).toBe(412);
    const past = await admin.call<Problem>('PUT', `${ADMIN}/settings`, { frequencyMonths: 3, nextDueOn: '2026-09-01', daysToComplete: 14 }, { 'if-match': 'W/"0"' });
    expect(past.status).toBe(400);
    expect(past.body.errors?.[0]?.path).toBe('body.nextDueOn');
    const put = await admin.call<AccessReviewSettings>('PUT', `${ADMIN}/settings`, { frequencyMonths: 6, nextDueOn: '2026-12-31', daysToComplete: 21 }, { 'if-match': 'W/"0"' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ frequencyMonths: 6, nextDueOn: '2026-12-31', daysToComplete: 21 });
    expect(put.headers.etag).toBe(put.body.etag);
    const again = await admin.call<AccessReviewSettings>('PUT', `${ADMIN}/settings`, { frequencyMonths: 3, nextDueOn: '2026-12-31', daysToComplete: 14 }, { 'if-match': put.body.etag });
    expect(again.status).toBe(200);
    expect((await admin.call<Problem>('PUT', `${ADMIN}/settings`, { frequencyMonths: 12, nextDueOn: '2026-12-31', daysToComplete: 14 }, { 'if-match': put.body.etag })).status).toBe(412);
    expect((await admin.call<Problem>('PUT', `${ADMIN}/settings`, { frequencyMonths: 2, nextDueOn: '2026-12-31', daysToComplete: 14 })).status).toBe(400);
    const audit = await rowsOf<{ before_data: Record<string, unknown>; after_data: Record<string, unknown> }>(
      db, 'tst', sql`select before_data, after_data from audit_trail where action = 'access_review.settings_changed' order by seq`,
    );
    expect(audit.map((a) => a.after_data.frequencyMonths)).toEqual([6, 3]);
  });

  it('starts a review with a snapshot of every right in force, a task for the ISMS and the notices; one open review at a time', async () => {
    // rina is a Tenant Admin of tst as well: she starts a review, which tenant.admin cancels and starts again.
    expect((await rina.post(ADMIN, {})).status).toBe(201);
    const [opened] = (await admin.get<AccessReviewSummary[]>(ADMIN)).body;
    expect(opened).toMatchObject({ status: 'open', reviewNo: 'AR-2026-01', openedOn: '2026-09-29', dueOn: '2026-10-13', openedBy: { handle: 'rina' } });
    expect((await admin.post(`${ADMIN}/${opened!.id}/cancel`, { reason: 'Started by mistake' })).status).toBe(200);

    const created = await admin.post<CommandResult & { data: { id: string; reviewNo: string; dueOn: string } }>(ADMIN, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    reviewId = created.body.data.id;
    expect(created.body.data).toMatchObject({ reviewNo: 'AR-2026-02', dueOn: '2026-10-13' });
    const conflict = await admin.post<Problem>(ADMIN, {});
    expect(conflict.status).toBe(409);
    expect(conflict.body.messages?.en).toContain('already open');

    const list = await admin.get<AccessReviewSummary[]>(ADMIN);
    expect(list.body.map((r) => [r.reviewNo, r.status])).toEqual([['AR-2026-02', 'open'], ['AR-2026-01', 'cancelled']]);
    expect(list.body[1]!.cancelReason).toBe('Started by mistake');

    const review = await detail();
    expect(review.openedBy?.handle).toBe('tenant.admin');
    const org = review.organisationPart.rows;
    const kinds = (kind: string) => org.filter((r) => r.kind === kind);
    expect(kinds('membership').map((r) => r.subject.handle)).toEqual(expect.arrayContaining(['rina', 'bagus', 'tenant.admin', 'maya']));
    expect(kinds('membership').some((r) => r.subject.handle === 'ext.auditor')).toBe(false);
    expect(kinds('admin_role').map((r) => `${r.subject.handle}:${r.role}`).sort()).toEqual(['rina:storage_admin', 'rina:tenant_admin', 'tenant.admin:tenant_admin']);
    expect(kinds('linked_sign_in')).toEqual([expect.objectContaining({ role: 'tst-keycloak', subject: expect.objectContaining({ handle: 'bagus' }) })]);
    expect(org.find((r) => r.subject.handle === 'tenant.admin' && r.kind === 'membership')).toMatchObject({ ownAccess: true, lastSignInAt: expect.any(String), needsSecondReviewer: false });
    expect(review.parts.map((p) => p.ms)).toEqual(['isms']);
    expect(review.warnings).toEqual([expect.objectContaining({ rule: 'REVIEW-SINGLE-ADMIN' })]);

    const isms = await part();
    const roles = isms.rows.filter((r) => r.kind === 'business_role');
    expect(roles.find((r) => r.subject.handle === 'rina')).toMatchObject({ role: 'ms_manager', ownAccess: true, needsSecondReviewer: true });
    expect(roles.find((r) => r.subject.handle === 'bagus')).toMatchObject({ role: 'domain_owner', ownAccess: false, needsSecondReviewer: false });
    // The guest's External Auditor role is reviewed once, as its grant.
    expect(roles.some((r) => r.subject.handle === 'ext.auditor')).toBe(false);
    expect(isms.rows.filter((r) => r.kind === 'auditor_access')).toEqual([expect.objectContaining({ subject: expect.objectContaining({ handle: 'ext.auditor' }), role: 'external_auditor', validUntil: expect.any(String) })]);
    expect(isms.suggestedEvidence).toMatchObject({ code: expect.any(String) });
    expect((await rina.get<AccessReviewPartSummary[]>(MS)).body.map((p) => [p.reviewNo, p.reviewStatus])).toEqual([['AR-2026-02', 'open'], ['AR-2026-01', 'cancelled']]);

    // One stored task for the ISMS part, owned by its primary manager; the cancelled review's task is cancelled.
    const tasks = await rowsOf<{ status: string; owner_user_id: string | null; entity_code: string; title_en: string }>(
      db, 'tst', sql`select status, owner_user_id, entity_code, title_en from task where source_rule = 'access_review' order by created_at`,
    );
    expect(tasks.map((t) => [t.entity_code, t.status])).toEqual([['AR-2026-01', 'cancelled'], ['AR-2026-02', 'open']]);
    expect(tasks[1]).toMatchObject({ owner_user_id: rina.userId, title_en: 'Review the access in ISMS on Access review of this system (AR-2026-02)' });
    const notices = await rowsOf<{ recipient_user_id: string; kind: string; title_en: string }>(
      db, 'tst', sql`select recipient_user_id, kind, title_en from notification where kind = 'access_review_due' and title_en like '%AR-2026-02%' order by title_en, recipient_user_id`,
    );
    expect(notices.map((n) => n.title_en)).toEqual(expect.arrayContaining(['Access review AR-2026-02 is open', 'Access review AR-2026-02: review the access in ISMS']));
    expect(notices.filter((n) => n.title_en === 'Access review AR-2026-02 is open').map((n) => n.recipient_user_id).sort()).toEqual([admin.userId, rina.userId].sort());
    // The settings moved the next due date on by the frequency from today.
    expect((await admin.get<AccessReviewSettings>(`${ADMIN}/settings`)).body.nextDueOn).toBe('2026-12-29');
    const audit = await rowsOf<{ after_data: Record<string, unknown> }>(db, 'tst', sql`select after_data from audit_trail where action = 'access_review.opened' and entity_id = ${reviewId}`);
    expect(audit[0]!.after_data).toMatchObject({ reviewNo: 'AR-2026-02', openedBy: 'tenant_admin', parts: 2 });
  });

  it('refuses a decision on one\'s own access and records the others; a change needs a note', async () => {
    const org = (await detail()).organisationPart.rows;
    const own = org.find((r) => r.subject.handle === 'tenant.admin' && r.kind === 'membership')!;
    const refused = await decideOrg(admin, own.id, { decision: 'keep' });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ rule: 'REVIEW-OWN-ACCESS', messageKey: 'rule.REVIEW-OWN-ACCESS' });
    // rina, the other Tenant Admin, decides tenant.admin's items.
    expect((await decideOrg(rina, own.id, { decision: 'keep' })).status).toBe(200);
    const rinaAdmin = org.find((r) => r.subject.handle === 'rina' && r.role === 'storage_admin')!;
    expect((await decideOrg(admin, rinaAdmin.id, { decision: 'change' })).status).toBe(400);
    expect((await decideOrg(admin, rinaAdmin.id, { decision: 'change', note: 'Storage Admin moves to yusuf in November' })).status).toBe(200);
    // An item of a system is not an organisation item.
    const isms = await part();
    expect((await decideOrg(admin, isms.rows[0]!.id, { decision: 'keep' })).status).toBe(404);
    expect((await decideMs(bagus, isms.rows[0]!.id, { decision: 'keep' })).status).toBe(403);
    const audit = await rowsOf<{ actor_user_id: string; after_data: Record<string, unknown> }>(
      db, 'tst', sql`select actor_user_id, after_data from audit_trail where action = 'access_review.item_decided' and entity_id = ${rinaAdmin.id}`,
    );
    expect(audit[0]).toMatchObject({ actor_user_id: admin.userId, after_data: { decision: 'change', note: 'Storage Admin moves to yusuf in November', kind: 'admin_role', subject: 'rina' } });
  });

  it('rina decides the ISMS items but not her own role, revokes the guest grant and signs off into the A.5.18 evidence', async () => {
    let isms = await part();
    const own = isms.rows.find((r) => r.ownAccess)!;
    expect((await decideMs(rina, own.id, { decision: 'keep' })).body.rule).toBe('REVIEW-OWN-ACCESS');
    const guest = isms.rows.find((r) => r.kind === 'auditor_access')!;
    const bagusRole = isms.rows.find((r) => r.kind === 'business_role' && r.subject.handle === 'bagus')!;

    // Applying a guest grant before it is decided, or through the organisation route, is refused.
    expect((await applyMs(rina, guest.id, { action: 'apply' })).status).toBe(409);
    expect((await decideMs(rina, guest.id, { decision: 'revoke', note: 'The certification audit ended' })).status).toBe(200);
    expect((await applyOrg(admin, guest.id, { action: 'apply' })).status).toBe(409);
    expect((await applyMs(rina, bagusRole.id, { action: 'apply' })).status).toBe(409);
    const revoked = await applyMs(rina, guest.id, { action: 'apply' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.data).toEqual({ appliedAction: 'auditor_access.revoked' });
    const grants = await rowsOf<{ revoked_at: Date | null }>(db, 'tst', sql`select revoked_at from auditor_access_grant where user_id = (select id from platform.app_user where handle = 'ext.auditor')`);
    expect(grants[0]!.revoked_at).not.toBeNull();
    // A second request finds it applied and changes nothing.
    expect((await applyMs(rina, guest.id, { action: 'apply' })).body.data).toEqual({ appliedAction: null });

    // The sign-off waits for every item but rina's own role, which nobody else in the ISMS can decide.
    const early = await rina.post<Problem>(`${MS}/${reviewId}/sign-off`, {});
    expect(early.status).toBe(409);
    expect((await decideMs(rina, bagusRole.id, { decision: 'revoke', note: 'Moved to the finance team' })).status).toBe(200);
    for (const row of (await part()).rows) {
      if (row.decision === null && !row.ownAccess) expect((await decideMs(rina, row.id, { decision: 'keep' })).status).toBe(200);
    }
    isms = await part();
    expect(isms).toMatchObject({ decided: isms.items - 1, needsSecondReviewer: 1 });
    // An evidence item of another system is refused.
    expect((await rina.post(`${MS}/${reviewId}/sign-off`, { evidenceId: '00000000-0000-4000-8000-000000000999' })).status).toBe(404);
    const signed = await rina.post<CommandResult>(`${MS}/${reviewId}/sign-off`, { evidenceId: isms.suggestedEvidence!.id });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.warnings).toEqual([expect.objectContaining({ rule: 'REVIEW-SINGLE-ADMIN' })]);
    expect(signed.body.warnings![0]!.messages.en).toContain('Rina Kusuma');
    expect((await part())).toMatchObject({ status: 'signed_off', signedOffBy: { handle: 'rina' }, evidenceId: isms.suggestedEvidence!.id, evidenceCode: isms.suggestedEvidence!.code });
    expect((await decideMs(rina, bagusRole.id, { decision: 'keep' })).status).toBe(409);
    expect((await rina.post(`${MS}/${reviewId}/sign-off`, {})).status).toBe(409);
    const tasks = await rowsOf<{ status: string; closed_by: string | null }>(db, 'tst', sql`select status, closed_by from task where source_rule = 'access_review' and entity_code = 'AR-2026-02'`);
    expect(tasks).toEqual([{ status: 'done', closed_by: rina.userId }]);
  });

  it('tenant.admin applies the business role revocation and removes the linked sign-in; a change is marked applied', async () => {
    const review = await detail();
    expect(review.parts[0]).toMatchObject({ status: 'signed_off' });
    const pending = review.pendingApplications;
    const role = pending.find((r) => r.kind === 'business_role' && r.subject.handle === 'bagus')!;
    expect(role).toMatchObject({ decision: 'revoke', decidedBy: { handle: 'rina' }, ms: 'isms' });
    const applied = await applyOrg(admin, role.id, { action: 'apply' });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ changed: ['isms'], data: { appliedAction: 'role.revoked' } });
    const grant = await rowsOf<{ deleted_at: Date | null }>(db, 'tst', sql`select r.deleted_at from user_ms_role r where r.user_id = ${bagus.userId} and r.role = 'domain_owner'`);
    expect(grant.every((g) => g.deleted_at !== null)).toBe(true);
    const roleAudit = await rowsOf<{ action: string }>(db, 'tst', sql`select action from audit_trail where action in ('role.revoked', 'access_review.item_applied') and actor_user_id = ${admin.userId} order by seq`);
    expect(roleAudit.map((a) => a.action)).toEqual(['role.revoked', 'access_review.item_applied']);

    // The linked sign-in of bagus: decided revoke, applied through the identity service.
    const linked = review.organisationPart.rows.find((r) => r.kind === 'linked_sign_in')!;
    expect((await decideOrg(admin, linked.id, { decision: 'revoke', note: 'Signs in with the password only' })).status).toBe(200);
    const unlinked = await applyOrg(admin, linked.id, { action: 'apply' });
    expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
    expect(unlinked.body.data).toEqual({ appliedAction: 'identity.unlinked' });
    expect(await platformRows(db, sql`select subject from platform.user_identity where identity_provider_id = ${providerId}`)).toEqual([]);
    const platformAudit = await platformRows<{ after_data: Record<string, unknown> }>(db, sql`select after_data from platform.audit_log where action = 'identity.unlinked' and entity_id = ${bagus.userId}`);
    expect(platformAudit[0]!.after_data).toMatchObject({ provider: 'tst-keycloak', reason: 'Access review AR-2026-02: Signs in with the password only' });

    // The Storage Admin change: "Mark as applied" with a note.
    const change = (await detail()).pendingApplications.find((r) => r.decision === 'change')!;
    expect((await applyOrg(admin, change.id, { action: 'apply' })).status).toBe(409);
    const marked = await applyOrg(admin, change.id, { action: 'mark_applied', note: 'Handed to yusuf on People and roles' });
    expect(marked.status).toBe(200);
    const after = (await detail()).organisationPart.rows.find((r) => r.id === change.id)!;
    expect(after).toMatchObject({ appliedAction: 'marked_applied', appliedNote: 'Handed to yusuf on People and roles', appliedBy: { handle: 'tenant.admin' } });
    expect((await decideOrg(rina, change.id, { decision: 'keep' })).status).toBe(409);
  });

  it('completes only when nothing waits, stores the report and files the ISMS rows as evidence', async () => {
    const early = await admin.post<Problem>(`${ADMIN}/${reviewId}/complete`, {});
    expect(early.status).toBe(409);
    expect(early.body.messages?.en).toContain('organisation item(s) to decide');

    // Decide the remaining organisation items, each by a Tenant Admin who is not its subject.
    for (const row of (await detail()).organisationPart.rows) {
      if (row.decision !== null) continue;
      const by = row.subject.handle === 'tenant.admin' ? rina : admin;
      expect((await decideOrg(by, row.id, { decision: 'keep' })).status, row.subject.handle).toBe(200);
    }
    const before = await rowsOf<{ storage_object_id: string; file_sequence: number }>(db, 'tst', sql`select storage_object_id, file_sequence from evidence where id = (select evidence_id from access_review_part where access_review_id = ${reviewId} and management_system_id is not null)`);
    const done = await admin.post<CommandResult & { data: { filed: { ms: string; evidenceCode: string }[]; reportStored: boolean } }>(`${ADMIN}/${reviewId}/complete`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.reportStored).toBe(true);
    expect(done.body.data.filed).toEqual([{ ms: 'isms', evidenceCode: expect.any(String) }]);
    expect(done.body.warnings).toEqual([expect.objectContaining({ rule: 'REVIEW-SINGLE-ADMIN' })]);

    const review = await detail();
    expect(review).toMatchObject({ status: 'completed', completedBy: { handle: 'tenant.admin' }, completedAt: expect.any(String) });
    expect(review.organisationPart.status).toBe('signed_off');
    expect(review.parts[0]!.evidenceFiledAt).not.toBeNull();
    expect(review.warnings).toEqual([expect.objectContaining({ rule: 'REVIEW-SINGLE-ADMIN' })]);
    const stored = await rowsOf<{ report_object_id: string | null; summary: Record<string, unknown> }>(db, 'tst', sql`select report_object_id, summary from access_review where id = ${reviewId}`);
    expect(stored[0]!.report_object_id).not.toBeNull();
    expect(stored[0]!.summary).toMatchObject({ completed: { needsSecondReviewer: 1, revoked: 3, reportStored: true } });

    // The evidence item has a new current file, filed by tenant.admin as a generated file.
    const after = await rowsOf<{ storage_object_id: string; file_sequence: number }>(db, 'tst', sql`select storage_object_id, file_sequence from evidence where id = ${review.parts[0]!.evidenceId}`);
    expect(after[0]!.file_sequence).toBe(before[0]!.file_sequence + 1);
    expect(after[0]!.storage_object_id).not.toBe(before[0]!.storage_object_id);
    const filed = await rowsOf<{ after_data: Record<string, unknown> }>(db, 'tst', sql`select after_data from audit_trail where action = 'evidence.file_uploaded' and entity_id = ${review.parts[0]!.evidenceId} order by seq desc limit 1`);
    expect(filed[0]!.after_data).toMatchObject({ source: 'generated', generated: { mimeType: 'text/csv' } });

    // Completed: no more changes.
    expect((await admin.post(`${ADMIN}/${reviewId}/complete`, {})).status).toBe(409);
    expect((await admin.post(`${ADMIN}/${reviewId}/cancel`, { reason: 'Too late' })).status).toBe(409);
    expect((await decideOrg(rina, review.organisationPart.rows[0]!.id, { decision: 'revoke', note: 'x' })).status).toBe(409);
  });

  it('downloads the report as a formula-safe CSV and audits the download', async () => {
    const report = await admin.get(`${ADMIN}/${reviewId}/report`);
    expect(report.status).toBe(200);
    expect(String(report.headers['content-type'])).toContain('text/csv');
    expect(String(report.headers['content-disposition'])).toContain('access-review-AR-2026-02-tst.csv');
    const lines = report.raw.toString('utf8').trim().split(/\r?\n/);
    expect(lines[0]).toBe('review_no,opened_on,due_on,system,item_kind,person,handle,role,pending_approval,granted_by,requested_by,approved_by,granted_at,valid_until,last_sign_in_at,decision,decision_note,decided_by,decided_at,needs_second_reviewer,applied_action,applied_note,applied_by,applied_at,not_applied_reason');
    expect(lines.some((l) => l.includes('auditor_access') && l.includes('auditor_access.revoked'))).toBe(true);
    expect(lines.some((l) => l.includes('business_role') && l.includes('ms_manager') && l.includes(',yes,'))).toBe(true);
    expect((await bagus.get(`${ADMIN}/${reviewId}/report`)).status).toBe(403);
    const audit = await rowsOf<{ after_data: Record<string, unknown> }>(db, 'tst', sql`select after_data from audit_trail where action = 'file.downloaded' and entity_type = 'access_review'`);
    expect(audit[0]!.after_data).toMatchObject({ format: 'csv', fileName: 'access-review-AR-2026-02-tst.csv' });
  });

  it('records a revocation as not applied with its reason, and refuses to disable an invited membership', async () => {
    const created = await admin.post<CommandResult & { data: { id: string } }>(ADMIN, {});
    expect(created.status).toBe(201);
    reviewId = created.body.data.id;
    const maya = (await detail()).organisationPart.rows.find((r) => r.kind === 'membership' && r.subject.handle === 'maya')!;
    expect((await decideOrg(admin, maya.id, { decision: 'revoke', note: 'Internal audit is outsourced' })).status).toBe(200);
    expect((await applyOrg(admin, maya.id, { action: 'not_applied' })).status).toBe(400);
    const kept = await applyOrg(admin, maya.id, { action: 'not_applied', reason: 'Still needed for the open internal audit' });
    expect(kept.status).toBe(200);
    expect((await detail()).organisationPart.rows.find((r) => r.id === maya.id)).toMatchObject({ notAppliedReason: 'Still needed for the open internal audit', appliedAt: null, appliedAction: 'not_applied' });

    // An invited member (no account activity yet) in a new review: disabling waits for the person.
    await platformRows(db, sql`update platform.org_membership set status = 'invited' where organization_id = '00000000-0000-4000-8000-00000000a004'
      and user_id = (select id from platform.app_user where handle = 'mfa.tester') returning user_id`);
    expect((await admin.post(`${ADMIN}/${reviewId}/cancel`, { reason: 'Superseded' })).status).toBe(200);
    reviewId = (await admin.post<CommandResult & { data: { id: string } }>(ADMIN, {})).body.data.id;
    const invited = (await detail()).organisationPart.rows.find((r) => r.kind === 'membership' && r.role === 'invited')!;
    expect(invited.subject.displayName).toBe('mfa.tester@mscd.test');
    expect((await decideOrg(admin, invited.id, { decision: 'revoke', note: 'Never joined' })).status).toBe(200);
    const refused = await applyOrg(admin, invited.id, { action: 'apply' });
    expect(refused.status).toBe(409);
    expect(refused.body.messages?.en).toContain('invited membership');
    expect((await admin.post(`${ADMIN}/${reviewId}/cancel`, { reason: 'Test done' })).status).toBe(200);
    expect((await admin.post(`${ADMIN}/${reviewId}/cancel`, {})).status).toBe(400);
  });

  it('names a system nobody may review on its own, and shows who asked for and approved a business role', async () => {
    // rina is the ISMS's only Management System Manager and it has no Programme Owner: with her role ended, nobody may
    // decide the ISMS items.
    const ended = await rowsOf<{ id: string }>(db, 'tst', sql`update user_ms_role set deleted_at = now()
      where user_id = ${rina.userId} and role = 'ms_manager' and deleted_at is null returning id`);
    expect(ended).toHaveLength(1);
    // Another business role of the ISMS was asked for by tenant.admin and approved by rina under the four-eyes flow.
    const [approved] = await rowsOf<{ id: string; user_id: string; role: string }>(db, 'tst', sql`update user_ms_role set requested_by = ${admin.userId}, approved_by = ${rina.userId}
      where id = (select id from user_ms_role where role not in ('ms_manager', 'external_auditor') and approval_status = 'active' and deleted_at is null order by id limit 1)
      returning id, user_id, role`);
    expect(approved).toBeDefined();
    try {
      const created = await admin.post<CommandResult & { data: { id: string } }>(ADMIN, {});
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      reviewId = created.body.data.id;
      const review = await detail();
      expect(review.parts).toEqual([expect.objectContaining({ ms: 'isms', status: 'open', noReviewer: true, needsSecondReviewer: 0 })]);
      expect(review.organisationPart.noReviewer).toBe(false);
      // No item of the ISMS "needs a second reviewer", so the open review gives no REVIEW-SINGLE-ADMIN warning about it.
      expect(review.warnings).toEqual([]);

      // The requester and the approver of the business role in the report (the view is read below, once rina may again).
      const [holder] = await platformRows<{ handle: string }>(db, sql`select handle from platform.app_user where id = ${approved!.user_id}`);
      const report = await admin.get(`${ADMIN}/${reviewId}/report`);
      const lines = report.raw.toString('utf8').trim().split(/\r?\n/);
      const header = lines[0]!.split(',');
      const line = lines.find((l) => l.includes(',business_role,') && l.includes(`,${holder!.handle},${approved!.role},`))!;
      expect(line).toBeDefined();
      const cells = line.split(',');
      expect(cells[header.indexOf('requested_by')]).toBe('Tenant Admin (tenant.admin)');
      expect(cells[header.indexOf('approved_by')]).toBe('Rina Kusuma (rina)');
      expect(cells[header.indexOf('needs_second_reviewer')]).toBe('no');

      // "Complete" names the system on its own; the Tenant Admin assigns a reviewer or cancels the review.
      const refused = await admin.post<Problem>(`${ADMIN}/${reviewId}/complete`, {});
      expect(refused.status).toBe(409);
      expect(refused.body.messages?.en).toContain('ISMS has no Management System Manager or Programme Owner to review it; assign one on People and roles, or cancel the review');
      expect(refused.body.messages?.en).not.toContain('not signed off yet');
      expect(refused.body.messages?.id).toContain('ISMS tidak memiliki Management System Manager atau Pemilik Program');
    } finally {
      await rowsOf(db, 'tst', sql`update user_ms_role set deleted_at = null where id = ${ended[0]!.id} returning id`);
    }
    // With the reviewer back, the part waits for her sign-off as usual, and her view names the requester and approver.
    expect((await detail()).parts[0]).toMatchObject({ noReviewer: false });
    const [item] = await rowsOf<{ id: string }>(db, 'tst', sql`select id from access_review_item where access_review_id = ${reviewId} and ref->>'roleId' = ${approved!.id}`);
    expect((await part()).rows.find((r) => r.id === item!.id)).toMatchObject({
      kind: 'business_role', requestedBy: { handle: 'tenant.admin' }, approvedBy: { handle: 'rina' }, grantedBy: { handle: 'rina' }, needsSecondReviewer: false,
    });
    expect((await admin.post(`${ADMIN}/${reviewId}/cancel`, { reason: 'Test done' })).status).toBe(200);
    expect((await detail()).parts[0]).toMatchObject({ noReviewer: false });
  });

  it('answers 404 for a review of another id and 403 to people without the permission', async () => {
    const unknown = '00000000-0000-4000-8000-000000000abc';
    expect((await admin.get(`${ADMIN}/${unknown}`)).status).toBe(404);
    expect((await rina.get(`${MS}/${unknown}`)).status).toBe(404);
    expect((await bagus.get(ADMIN)).status).toBe(403);
    expect((await bagus.get(MS)).status).toBe(403);
    expect((await bagus.post(ADMIN, {})).status).toBe(403);
    const hendra = await signIn(ctx as never, db, 'hendra', 'tst');
    expect((await hendra.get(MS)).status).toBe(403);
    expect(await userId(db, 'hendra')).toBe(hendra.userId);
  });
});
