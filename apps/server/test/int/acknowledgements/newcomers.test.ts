// Newcomers of a read confirmation request (Milestone 3 D.7, M3-14, ISO review M1) on a copy of the demo template, with
// the fixed day of the test profile (`demo.fixed_today` 2026-09-29) as the job's run date: a person who gets an asked
// role while a request is open is added by the daily job `acknowledgement.reminders` with a row, a stored task and
// `acknowledgement_requested`, the request's audience count grows and the job audits `acknowledgement_request.reminded`
// with `after.added` and `after.reason: "newcomers"`; their own due date is the day they were added plus the request's
// period (the person list, "Policies to confirm", the task and the notice); a person excused for a lost role is pending
// again when the role comes back; a closed request gets nobody; and a new request of the same version skips the people
// who confirmed it in an earlier one (`acknowledgements.everyone_confirmed` when nobody is left), while its register
// also lists those earlier confirmations. The request is created by hand, so the tests need no storage stack.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcknowledgementPerson, AcknowledgementRequestDetail, MyAcknowledgementItem } from '@mscd/shared';
import { fmtDay, localDate } from '../../../src/common/dates';
import { SYSTEM_USER_ID } from '../../../src/common/tokens';
import { AcknowledgementRemindersJob } from '../../../src/modules/acknowledgements/acknowledgement-reminders.job';
import { useTestDatabase } from '../../setup/test-db';
import {
  auditOf, createAckApp, expectedAudience, ORG_IDS, rowsOf, signIn, TODAY, verifyChain, type AckApp, type AckClient,
} from './helpers';

const REQUESTS = '/api/v1/ms/isms/acknowledgement-requests';
const TIME_ZONE = 'Asia/Jakarta';
/** The request's period: 14 days to confirm. */
const PERIOD = 14;

/** An ISO date `days` after `iso`. */
const plusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe('newcomers of an open read confirmation request (M3-14)', () => {
  const db = useTestDatabase('demo');
  let ctx: AckApp;
  let rina: AckClient;
  let job: AcknowledgementRemindersJob;
  let documentId: string;
  let documentCode: string;
  let requestId: string;
  let newcomer: { handle: string; id: string };
  let second: { handle: string; id: string };
  let isms: string;

  /** Members of the organisation with an active account and membership who hold no Risk Owner role in any system. */
  async function withoutRiskOwner(): Promise<{ handle: string; id: string }[]> {
    return rowsOf<{ handle: string; id: string }>(db, 'ndt', sql`
      select u.handle, u.id from platform.app_user u
        join platform.org_membership om on om.user_id = u.id and om.organization_id = ${ORG_IDS.ndt}::uuid and om.status = 'active' and om.deleted_at is null
       where u.kind = 'person' and u.status = 'active' and u.deleted_at is null
         and exists (select 1 from user_ms_role r where r.user_id = u.id and r.deleted_at is null and r.approval_status = 'active')
         and not exists (select 1 from user_ms_role r where r.user_id = u.id and r.role = 'risk_owner' and r.deleted_at is null)
       order by u.handle`);
  }

  const grantRiskOwner = (user: string) =>
    rowsOf(db, 'ndt', sql`insert into user_ms_role (user_id, management_system_id, role, created_by, updated_by)
                          values (${user}, ${isms}, 'risk_owner', ${user}, ${user}) returning id`);
  const endRiskOwner = (user: string) =>
    rowsOf(db, 'ndt', sql`update user_ms_role set deleted_at = now() where user_id = ${user} and role = 'risk_owner' and deleted_at is null returning id`);
  const rowOf = async (request: string, user: string) =>
    (await rowsOf<{ id: string; status: string; excused_reason: string | null; reminder_count: number; created_by: string; created_at: Date }>(db, 'ndt', sql`
      select id, status, excused_reason, reminder_count, created_by, created_at from acknowledgement
       where acknowledgement_request_id = ${request} and user_id = ${user} and deleted_at is null`))[0];
  const detail = async (request: string) => (await rina.get<AcknowledgementRequestDetail>(`${REQUESTS}/${request}`)).body;
  const personIn = async (request: string, handle: string): Promise<AcknowledgementPerson | undefined> =>
    (await detail(request)).people?.find((p) => p.person.handle === handle);

  beforeAll(async () => {
    // No storage call is made: a request by hand, the job and closing without an evidence item.
    ctx = await createAckApp(db, 'http://127.0.0.1:9');
    rina = await signIn(ctx, db, 'rina', 'ndt');
    job = ctx.moduleRef.get(AcknowledgementRemindersJob);
    const [system] = await rowsOf<{ id: string }>(db, 'ndt', sql`select id from management_system where slug = 'isms'`);
    isms = system!.id;
    // An approved ISMS document, not restricted, with no open request.
    const [doc] = await rowsOf<{ id: string; doc_code: string }>(db, 'ndt', sql`
      select d.id, d.doc_code from document d join document_version v on v.id = d.current_version_id and v.status = 'approved'
        join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.is_primary and l.deleted_at is null and l.management_system_id = ${isms}
       where d.deleted_at is null and d.status = 'approved' and d.classification <> 'restricted' and not d.is_org_wide
         and not exists (select 1 from entity_ms_link o where o.entity_type = 'document' and o.entity_id = d.id and o.deleted_at is null
                           and o.management_system_id <> ${isms})
         and not exists (select 1 from acknowledgement_request r where r.document_id = d.id and r.status = 'open' and r.deleted_at is null)
       order by d.doc_code limit 1`);
    documentId = doc!.id;
    documentCode = doc!.doc_code;
    const candidates = await withoutRiskOwner();
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    newcomer = candidates[0]!;
    second = candidates[1]!;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('adds a person who gets an asked role after the start at the next run: a row, a task, a notice and their own due date', async () => {
    const created = await rina.post(REQUESTS, { documentId, audience: { scope: 'roles', roles: ['risk_owner'] }, dueDays: PERIOD });
    expect(created.status, created.text).toBe(201);
    requestId = created.body.data.id;
    const audience = await expectedAudience(db, 'ndt', ['isms'], ['risk_owner']);
    expect(created.body.data.audience).toBe(audience.length);
    expect(audience).not.toContain(newcomer.handle);
    // The request started three days before the job's run date (rows and request as the approval writes them).
    const startedAt = '2026-09-26T03:00:00Z';
    await rowsOf(db, 'ndt', sql`update acknowledgement_request set created_at = ${startedAt}, due_on = ${plusDays('2026-09-26', PERIOD)} where id = ${requestId} returning id`);
    await rowsOf(db, 'ndt', sql`update acknowledgement set created_at = ${startedAt} where acknowledgement_request_id = ${requestId} returning id`);

    // The role is granted after the start; nothing changes until the job runs.
    await grantRiskOwner(newcomer.id);
    expect(await rowOf(requestId, newcomer.id)).toBeUndefined();
    const result = await job.run(ORG_IDS.ndt, undefined, TODAY);
    expect(result!.added).toBeGreaterThanOrEqual(1);

    const row = (await rowOf(requestId, newcomer.id))!;
    expect(row).toMatchObject({ status: 'pending', reminder_count: 0, created_by: SYSTEM_USER_ID });
    const addedOn = localDate(new Date(row.created_at), TIME_ZONE);
    const dueOn = plusDays(addedOn, PERIOD);
    expect(dueOn > plusDays('2026-09-26', PERIOD)).toBe(true);

    // The person list and the register's totals: the day they were added and their own due date.
    const person = await personIn(requestId, newcomer.handle);
    expect(person).toMatchObject({ status: 'pending', addedOn, dueOn, overdue: false });
    const start = await personIn(requestId, audience[0]!);
    expect(start).toMatchObject({ addedOn: '2026-09-26', dueOn: plusDays('2026-09-26', PERIOD) });
    const item = await detail(requestId);
    expect(item.totals.audience).toBe(audience.length + 1);
    const [count] = await rowsOf<{ audience_count: number }>(db, 'ndt', sql`select audience_count from acknowledgement_request where id = ${requestId}`);
    expect(Number(count!.audience_count)).toBe(audience.length + 1);

    // The stored task and the notice name the person's own due date.
    const tasks = await rowsOf<{ status: string; due_at: string; title_en: string }>(db, 'ndt', sql`
      select status, due_at::text as due_at, title_en from task where source_rule = 'acknowledgement' and entity_type = 'acknowledgement' and entity_id = ${row.id}`);
    expect(tasks).toEqual([{ status: 'open', due_at: dueOn, title_en: expect.stringContaining(documentCode) }]);
    const notices = await rowsOf<{ title_en: string; body_en: string }>(db, 'ndt', sql`
      select title_en, body_en from notification where recipient_user_id = ${newcomer.id} and kind = 'acknowledgement_requested' order by created_at`);
    expect(notices.at(-1)).toMatchObject({ title_en: `Please read and confirm ${documentCode}`, body_en: expect.stringContaining(`by ${fmtDay(dueOn)}`) });

    // "Policies to confirm" of the newcomer shows the same due date.
    const client = await signIn(ctx, db, newcomer.handle, 'ndt');
    const mine = (await client.get<MyAcknowledgementItem[]>('/api/v1/me/acknowledgements')).body.find((m) => m.requestId === requestId);
    expect(mine).toMatchObject({ status: 'pending', dueOn });

    // Audited as a reminder run of the request, with what was added (no new audit action, R-14).
    const audit = (await auditOf(db, 'ndt', requestId)).filter((a) => a.action === 'acknowledgement_request.reminded' && a.after?.reason === 'newcomers');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ added: 1, reason: 'newcomers', newcomers: 1, returned: 0, date: TODAY });

    // The same day again: nobody is added twice.
    await job.run(ORG_IDS.ndt, undefined, TODAY);
    expect((await detail(requestId)).totals.audience).toBe(audience.length + 1);
  });

  it('asks again a person who lost the role and has it back', async () => {
    await endRiskOwner(newcomer.id);
    await job.run(ORG_IDS.ndt, undefined, TODAY);
    expect(await rowOf(requestId, newcomer.id)).toMatchObject({ status: 'excused', excused_reason: 'No longer holds a role that is asked to confirm' });
    const audience = (await detail(requestId)).totals.audience;

    await grantRiskOwner(newcomer.id);
    await job.run(ORG_IDS.ndt, undefined, TODAY);
    const row = (await rowOf(requestId, newcomer.id))!;
    expect(row).toMatchObject({ status: 'pending', excused_reason: null, reminder_count: 0 });
    // The same row came back: the audience count stays, and an open task is waiting again.
    expect((await detail(requestId)).totals.audience).toBe(audience);
    const tasks = await rowsOf<{ status: string }>(db, 'ndt', sql`
      select status from task where source_rule = 'acknowledgement' and entity_type = 'acknowledgement' and entity_id = ${row.id} order by created_at`);
    expect(tasks.map((t) => t.status)).toEqual(['cancelled', 'open']);
    const audit = (await auditOf(db, 'ndt', requestId)).filter((a) => a.action === 'acknowledgement_request.reminded' && a.after?.reason === 'newcomers');
    expect(audit.at(-1)!.after).toMatchObject({ added: 1, newcomers: 0, returned: 1 });
  });

  it('adds nobody to a closed request', async () => {
    const closed = await rina.post(`${REQUESTS}/${requestId}/close`, {});
    expect(closed.status, closed.text).toBe(200);
    await grantRiskOwner(second.id);
    await job.run(ORG_IDS.ndt, undefined, TODAY);
    expect(await rowOf(requestId, second.id)).toBeUndefined();
  });

  it('asks in a new request of the same version only the people who have not confirmed it', async () => {
    // Everyone of the closed request but the newcomer confirmed; the second person never was in it.
    await rowsOf(db, 'ndt', sql`update acknowledgement set status = 'confirmed', confirmed_at = now(), opened_at = now()
                                 where acknowledgement_request_id = ${requestId} and user_id <> ${newcomer.id} returning id`);
    const again = await rina.post(REQUESTS, { documentId, audience: { scope: 'roles', roles: ['risk_owner'] }, dueDays: PERIOD });
    expect(again.status, again.text).toBe(201);
    const asked = (await detail(again.body.data.id)).people!.map((p) => p.person.handle).sort();
    expect(asked).toEqual([newcomer.handle, second.handle].sort());
    expect(again.body.data.audience).toBe(2);

    // Both confirm; a further request has nobody left to ask.
    await rowsOf(db, 'ndt', sql`update acknowledgement set status = 'confirmed', confirmed_at = now(), opened_at = now()
                                 where acknowledgement_request_id = ${again.body.data.id} returning id`);
    expect((await rina.post(`${REQUESTS}/${again.body.data.id}/close`, {})).status).toBe(200);

    // The register of the new request (its CSV, and the file a close files as evidence) also lists the people who
    // confirmed the version in the first request, with the day that request opened, so it holds every confirmation of
    // the version; the register of the first request keeps its own people only.
    const firstPeople = (await detail(requestId)).people!;
    const firstConfirmed = firstPeople.filter((p) => p.status === 'confirmed').map((p) => p.person.handle);
    expect(firstConfirmed.length).toBeGreaterThan(0);
    const register = (await rina.get(`${REQUESTS}/${again.body.data.id}/export`)).text.trim().split(/\r\n/).slice(1);
    expect(register).toHaveLength(2 + firstConfirmed.length);
    for (const handle of firstConfirmed) {
      expect(register.filter((l) => l.includes(`,${handle},`))).toHaveLength(1);
      expect(register.find((l) => l.includes(`,${handle},`))).toContain(`,2026-09-26,2026-09-26,${plusDays('2026-09-26', PERIOD)},confirmed,`);
    }
    for (const handle of [newcomer.handle, second.handle]) expect(register.find((l) => l.includes(`,${handle},`))).toContain(',confirmed,');
    expect((await rina.get(`${REQUESTS}/${requestId}/export`)).text.trim().split(/\r\n/)).toHaveLength(1 + firstPeople.length);
    const none = await rina.post(REQUESTS, { documentId, audience: { scope: 'roles', roles: ['risk_owner'] }, dueDays: PERIOD });
    expect(none.status).toBe(422);
    expect(none.body.messageKey).toBe('acknowledgements.everyone_confirmed');
    expect(none.body.messages.id).toContain('sudah mengonfirmasi versi ini');
  });

  it('leaves a verifiable audit chain', async () => {
    expect((await verifyChain(db, 'ndt')).firstBroken).toBeNull();
  });
});
