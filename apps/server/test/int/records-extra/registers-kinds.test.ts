// Register kinds objectives and competence (Milestone 2 D.2, D.3, H.5, M2-07): fields, owner required, own-row rights
// (`register.manage` own), metric and person resolution, the derived competence code, who sees competence records of
// other people, and the renewal reminder of the daily `tasks.overdue` job with its task and notification.
import { CommandResult, RegisterItem, TaskList, type Page } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TasksOverdueJob } from '../../../src/modules/jobs/tasks-overdue.job';
import { COMPETENCE_RENEWAL_ACTION } from '../../../src/modules/risk-registers/competence';
import { useTestDatabase } from '../../setup/test-db';
import {
  ORG_IDS, auditOf, createExtraApp, etagOf, notificationsOf, rowsOf, sessionFor, systemOf, type Client, type CommandsApp,
} from './helpers';

const URL = (register: string) => `/api/v1/ms/isms/registers/${register}`;

describe('register kinds objectives and competence (M2-07)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let hendra: Client;
  let nobody: Client;
  let isms: { id: string; version: string };
  let metricCode: string;

  const listOf = async (client: Client, register: string) => {
    const response = await client.get<Page<RegisterItem>>(`${URL(register)}?pageSize=200`);
    expect(response.status).toBe(200);
    for (const item of response.body.items) expect(RegisterItem.safeParse(item).success, JSON.stringify(item)).toBe(true);
    return response.body;
  };
  const rowOf = async (table: string, id: string) =>
    (await rowsOf<Record<string, unknown> & { updated_at: Date }>(db, 'tst', sql`select * from ${sql.table(table)} where id = ${id}`))[0]!;

  beforeAll(async () => {
    ctx = await createExtraApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    nobody = await sessionFor(ctx, db, 'mfa.tester', 'tst');
    isms = await systemOf(db, 'tst', 'isms');
    const [metric] = await rowsOf<{ code: string }>(db, 'tst', sql`
      select m.code from metric m join entity_ms_link l on l.entity_type = 'metric' and l.entity_id = m.id and l.deleted_at is null
       where m.deleted_at is null and l.management_system_id = ${isms.id} order by m.code limit 1`);
    metricCode = metric!.code;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('objectives (quality_objective)', () => {
    const objective = {
      code: 'QO-01', title: 'Answer customer complaints within two days', ownerHandle: 'bagus', statement: 'Answer 95 percent of complaints within two working days',
      targetText: '95%', dueAt: '2026-12-31', resources: 'Service desk team', evaluationMethod: 'Monthly service report', objectiveStatus: 'planned',
    };

    it('adds an objective of the system with its fields, metric and owner, and lists it (audited)', async () => {
      const created = await rina.post(URL('objectives'), { ...objective, metricCode });
      expect(created.status).toBe(201);
      expect(CommandResult.safeParse(created.body).success).toBe(true);
      expect(created.body.ref).toMatchObject({ entityType: 'quality_objective', code: 'QO-01' });
      const stored = await rowOf('quality_objective', created.body.ref!.id);
      expect(stored).toMatchObject({ management_system_id: isms.id, status: 'planned', target_text: '95%', evaluation_method: 'Monthly service report' });
      const listed = (await listOf(rina, 'objectives')).items.find((i) => i.code === 'QO-01');
      expect(listed).toMatchObject({
        title: objective.title, owner: 'bagus', status: 'ready', ms: ['isms'], shared: false, statement: objective.statement, targetText: '95%',
        metricCode, dueAt: '2026-12-31', resources: 'Service desk team', evaluationMethod: 'Monthly service report', objectiveStatus: 'planned',
        result: null, achievedAt: null,
      });
      const [audit] = await auditOf(db, 'tst', created.body.ref!.id);
      expect(audit).toMatchObject({ action: 'register.created', actor: 'rina', after: expect.objectContaining({ register_code: 'QO-01', metric_id: metricCode, owner: 'bagus' }) });
    });

    it('refuses a duplicate code, system links, an owner of none and an unknown metric', async () => {
      expect((await rina.post(URL('objectives'), objective)).status).toBe(409);
      expect((await rina.post(URL('objectives'), { ...objective, code: 'QO-09', linkedMs: ['isms'] })).status).toBe(400);
      const none = await rina.post(URL('objectives'), { ...objective, code: 'QO-09', ownerHandle: 'none' });
      expect(none.status).toBe(422);
      expect(none.body).toMatchObject({ messageKey: 'register.owner_required' });
      const metric = await rina.post(URL('objectives'), { ...objective, code: 'QO-09', metricCode: 'M-NOPE' });
      expect(metric.status).toBe(422);
      expect(metric.body).toMatchObject({ messageKey: 'register.unknown_metric' });
      expect((await rina.post(URL('objectives'), { ...objective, code: 'QO-09', likelihood: 3 })).status).toBe(400);
      expect((await rina.post(URL('objectives'), { title: 'No code' })).status).toBe(400);
    });

    it('gives own-row rights to a Domain Owner (register.manage own): own rows only, never handed to someone else', async () => {
      const others = await bagus.post(URL('objectives'), { ...objective, code: 'QO-02', ownerHandle: 'rina' });
      expect(others.status).toBe(403);
      const own = await bagus.post(URL('objectives'), { ...objective, code: 'QO-02', ownerHandle: 'bagus' });
      expect(own.status).toBe(201);
      const mine = await rowOf('quality_objective', own.body.ref!.id);
      const patched = await bagus.patch(`${URL('objectives')}/${own.body.ref!.id}`, { objectiveStatus: 'on_track', result: 'On track in October' }, { 'if-match': etagOf(mine.updated_at) });
      expect(patched.status).toBe(200);
      expect(await rowOf('quality_objective', own.body.ref!.id)).toMatchObject({ status: 'on_track', result: 'On track in October' });
      expect((await bagus.patch(`${URL('objectives')}/${own.body.ref!.id}`, { ownerHandle: 'rina' })).status).toBe(403);
      const rinas = await rina.post(URL('objectives'), { ...objective, code: 'QO-03', ownerHandle: 'rina' });
      expect((await bagus.patch(`${URL('objectives')}/${rinas.body.ref!.id}`, { result: 'x' })).status).toBe(403);
      const none = await rina.patch(`${URL('objectives')}/${rinas.body.ref!.id}`, { ownerHandle: 'none' });
      expect(none.status).toBe(422);
      expect((await rina.patch(`${URL('objectives')}/${rinas.body.ref!.id}`, { result: 'x' }, { 'if-match': 'W/"5"' })).status).toBe(412);
      expect((await rina.patch(`${URL('objectives')}/${rinas.body.ref!.id}`, { linkedMs: ['isms'] })).status).toBe(400);
      const achieved = await rina.patch(`${URL('objectives')}/${rinas.body.ref!.id}`, { objectiveStatus: 'achieved', achievedAt: '2026-09-20' });
      expect(achieved.status).toBe(200);
      expect((await auditOf(db, 'tst', rinas.body.ref!.id)).at(-1)).toMatchObject({
        action: 'register.updated', before: { status: 'planned', achieved_at: null }, after: { status: 'achieved', achieved_at: '2026-09-20' },
      });
    });

    it('gives Top Management the rows with the full count but no owner or due date of anyone else (Q-8)', async () => {
      const full = await listOf(rina, 'objectives');
      const top = await listOf(hendra, 'objectives');
      expect(top.total).toBe(full.total);
      for (const item of top.items) expect([item.owner, item.dueAt ?? null]).toEqual(['none', null]);
    });
  });

  describe('competence (competence_record)', () => {
    const record = {
      title: 'Internal auditor', ownerHandle: 'rina', personHandle: 'maya', competenceRequired: 'ISO 19011 auditor training', proofType: 'certificate',
      achievedAt: '2025-03-14', validUntil: '2028-03-14', verifiedByHandle: 'rina',
    };

    it('adds a competence record linked to the system, with a code derived from its id', async () => {
      const created = await rina.post(URL('competence'), record);
      expect(created.status).toBe(201);
      const id = created.body.ref!.id;
      expect(created.body.ref).toMatchObject({ entityType: 'competence_record', code: `CMP-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}` });
      const listed = (await listOf(rina, 'competence')).items.find((i) => i.ref.id === id);
      expect(listed).toMatchObject({
        code: created.body.ref!.code, title: 'Internal auditor', owner: 'rina', status: 'ready', ms: ['isms'], personHandle: 'maya',
        competenceRequired: 'ISO 19011 auditor training', proofType: 'certificate', proofObjectId: null, achievedAt: '2025-03-14', validUntil: '2028-03-14',
        verifiedByHandle: 'rina',
      });
      expect(await rowOf('competence_record', id)).toMatchObject({ role_title: 'Internal auditor', proof_type: 'certificate' });
      const [audit] = await auditOf(db, 'tst', id);
      expect(audit).toMatchObject({ action: 'register.created', after: expect.objectContaining({ register_code: created.body.ref!.code, user_id: 'maya', verified_by: 'rina' }) });
    });

    it('checks the members of a competence record: no code, the required facts, the dates, people and the proof file', async () => {
      expect((await rina.post(URL('competence'), { ...record, code: 'CMP-1' })).status).toBe(400);
      const missing = await rina.post(URL('competence'), { title: 'Internal auditor', ownerHandle: 'rina' });
      expect(missing.status).toBe(400);
      expect(missing.body.errors?.map((e: { path: string }) => e.path).sort()).toEqual(['body.competenceRequired', 'body.personHandle', 'body.proofType']);
      const dates = await rina.post(URL('competence'), { ...record, achievedAt: '2026-01-01', validUntil: '2025-01-01' });
      expect(dates.status).toBe(422);
      expect(dates.body).toMatchObject({ messageKey: 'register.valid_before_achieved' });
      const stranger = await rina.post(URL('competence'), { ...record, personHandle: 'staff01' });
      expect(stranger.status).toBe(422);
      expect(stranger.body.rule).toBe('NOT-A-MEMBER');
      const proof = await rina.post(URL('competence'), { ...record, proofObjectId: '0b7a4e7c-1d2f-4a3b-9c8d-7e6f5a4b3c2d' });
      expect(proof.status).toBe(422);
      expect(proof.body).toMatchObject({ messageKey: 'register.unknown_proof' });
      const [object] = await rowsOf<{ id: string }>(db, 'tst', sql`select id from storage_object limit 1`);
      const analyst = await rina.post(URL('competence'), { ...record, title: 'Security analyst', proofObjectId: object!.id });
      expect(analyst.status).toBe(201);
      // The role is stored in role_title (150 characters), below the 255 the shared title allows.
      const longRole = await rina.post(URL('competence'), { ...record, title: 'R'.repeat(151) });
      expect(longRole.status).toBe(400);
      expect(longRole.body.errors?.map((e: { path: string }) => e.path)).toEqual(['body.title']);
      const analystUrl = `${URL('competence')}/${analyst.body.ref!.id}`;
      expect((await rina.patch(analystUrl, { title: 'R'.repeat(151) })).status).toBe(400);
      expect((await rina.patch(analystUrl, { title: 'R'.repeat(150) })).status).toBe(200);
      expect(await rowOf('competence_record', analyst.body.ref!.id)).toMatchObject({ role_title: 'R'.repeat(150) });
    });

    it('lists competence records of other people only to MS Managers, Programme Owners and Internal Auditors (H.5)', async () => {
      const own = await bagus.post(URL('competence'), { ...record, title: 'Network engineer', ownerHandle: 'bagus', personHandle: 'bagus', verifiedByHandle: null });
      expect(own.status).toBe(201);
      expect((await bagus.post(URL('competence'), { ...record, title: 'Network engineer', ownerHandle: 'rina', personHandle: 'bagus' })).status).toBe(403);
      const forHendra = await rina.post(URL('competence'), { ...record, title: 'Management representative', personHandle: 'hendra' });
      expect(forHendra.status).toBe(201);

      const all = (await listOf(rina, 'competence')).items.map((i) => i.title).sort();
      expect((await listOf(maya, 'competence')).items.map((i) => i.title).sort()).toEqual(all);
      expect((await listOf(bagus, 'competence')).items.map((i) => i.title)).toEqual(['Network engineer']);
      const top = await listOf(hendra, 'competence');
      expect(top.items.map((i) => [i.title, i.personHandle])).toEqual([['Management representative', 'hendra']]);
      expect(top.total).toBe(1);
      expect((await listOf(nobody, 'competence')).total).toBe(0);
      expect((await bagus.patch(`${URL('competence')}/${forHendra.body.ref!.id}`, { validUntil: '2029-01-01' })).status).toBe(403);
      expect((await rina.patch(`${URL('competence')}/${forHendra.body.ref!.id}`, { code: 'CMP-2' })).status).toBe(400);
    });

    it('sets the renewal action 30 days before valid until, shows it in the owner tasks, completes it and notifies once after it lapsed', async () => {
      const job = ctx.moduleRef.get(TasksOverdueJob);
      const soon = await rina.post(URL('competence'), { ...record, title: 'Backup operator', ownerHandle: 'bagus', personHandle: 'bagus', validUntil: '2026-10-09' });
      const lapsed = await rina.post(URL('competence'), { ...record, title: 'Firewall administrator', ownerHandle: 'bagus', personHandle: 'bagus', validUntil: '2026-09-01' });
      const later = await rina.post(URL('competence'), { ...record, title: 'Database administrator', ownerHandle: 'bagus', personHandle: 'bagus', validUntil: '2027-06-01' });
      const result = await job.run(ORG_IDS.tst);
      expect(result.competenceReminders).toBe(2);
      expect(await rowOf('competence_record', soon.body.ref!.id)).toMatchObject({ pending_action: COMPETENCE_RENEWAL_ACTION, action_due_at: '2026-10-09' });
      expect(await rowOf('competence_record', later.body.ref!.id)).toMatchObject({ pending_action: null });
      expect((await notificationsOf(db, 'tst', 'bagus', 'task_overdue')).filter((n) => n.entity_id === lapsed.body.ref!.id)).toHaveLength(1);
      expect((await auditOf(db, 'tst', soon.body.ref!.id)).at(-1)).toMatchObject({ action: 'register.updated', after: { pending_action: COMPETENCE_RENEWAL_ACTION } });

      const tasks = await bagus.get<TaskList>('/api/v1/tasks');
      expect(tasks.status).toBe(200);
      expect(TaskList.safeParse(tasks.body).success).toBe(true);
      const task = tasks.body.items.find((t) => t.id === soon.body.ref!.id);
      expect(task).toMatchObject({ kind: 'task', ms: 'isms', due: '2026-10-09', title: [soon.body.ref!.code, soon.body.ref!.code] });
      expect(task!.act[0]).toContain('Backup operator');
      expect((await listOf(bagus, 'competence')).items.find((i) => i.ref.id === soon.body.ref!.id)!.status).toBe('open');
      // Another person cannot complete it; the owner can, and the job does not set it again for the same date.
      expect((await rina.post(`/api/v1/tasks/${soon.body.ref!.id}/complete`, {})).status).toBe(404);
      const done = await bagus.post(`/api/v1/tasks/${soon.body.ref!.id}/complete`, { note: 'New certificate requested' });
      expect(done.status).toBe(200);
      expect(await rowOf('competence_record', soon.body.ref!.id)).toMatchObject({ pending_action: null, action_due_at: '2026-10-09' });
      const second = await job.run(ORG_IDS.tst);
      expect(second.competenceReminders).toBe(0);
      expect((await notificationsOf(db, 'tst', 'bagus', 'task_overdue')).filter((n) => n.entity_id === lapsed.body.ref!.id)).toHaveLength(1);

      // Renewing the lapsed record (a valid until beyond the reminder window) ends its renewal action.
      const stored = await rowOf('competence_record', lapsed.body.ref!.id);
      expect(stored.pending_action).toBe(COMPETENCE_RENEWAL_ACTION);
      const renewed = await bagus.patch(`${URL('competence')}/${lapsed.body.ref!.id}`, { validUntil: '2029-09-01' }, { 'if-match': etagOf(stored.updated_at) });
      expect(renewed.status).toBe(200);
      expect(await rowOf('competence_record', lapsed.body.ref!.id)).toMatchObject({ pending_action: null, valid_until: '2029-09-01' });
      const third = await job.run(ORG_IDS.tst);
      expect(third.competenceReminders).toBe(0);

      // The renewed record lapses again (the test profile's clock is fixed, so it gets a valid until that has passed):
      // the owner hears about the new lapse once, with its own date.
      const renewedRow = await rowOf('competence_record', lapsed.body.ref!.id);
      const relapsed = await rina.patch(`${URL('competence')}/${lapsed.body.ref!.id}`, { validUntil: '2026-09-15' }, { 'if-match': etagOf(renewedRow.updated_at) });
      expect(relapsed.status).toBe(200);
      const fourth = await job.run(ORG_IDS.tst);
      expect(fourth.competenceReminders).toBe(1);
      expect(await rowOf('competence_record', lapsed.body.ref!.id)).toMatchObject({ pending_action: COMPETENCE_RENEWAL_ACTION, action_due_at: '2026-09-15' });
      const lapses = (await notificationsOf(db, 'tst', 'bagus', 'task_overdue')).filter((n) => n.entity_id === lapsed.body.ref!.id);
      expect(lapses).toHaveLength(2);
      expect(lapses.map((n) => n.body_en)).toEqual(expect.arrayContaining([expect.stringContaining('01 Sep 2026'), expect.stringContaining('15 Sep 2026')]));
      await job.run(ORG_IDS.tst);
      expect((await notificationsOf(db, 'tst', 'bagus', 'task_overdue')).filter((n) => n.entity_id === lapsed.body.ref!.id)).toHaveLength(2);
    });

    it('moves the due date of an open renewal action with a new valid until that is still inside the reminder window', async () => {
      const job = ctx.moduleRef.get(TasksOverdueJob);
      const created = await rina.post(URL('competence'), { ...record, title: 'Network operator', ownerHandle: 'bagus', personHandle: 'bagus', validUntil: '2026-10-09' });
      expect(created.status).toBe(201);
      const id = created.body.ref!.id;
      expect((await job.run(ORG_IDS.tst)).competenceReminders).toBe(1);
      const open = await rowOf('competence_record', id);
      expect(open).toMatchObject({ pending_action: COMPETENCE_RENEWAL_ACTION, action_due_at: '2026-10-09' });
      const moved = await bagus.patch(`${URL('competence')}/${id}`, { validUntil: '2026-10-20' }, { 'if-match': etagOf(open.updated_at) });
      expect(moved.status).toBe(200);
      expect(await rowOf('competence_record', id)).toMatchObject({ pending_action: COMPETENCE_RENEWAL_ACTION, action_due_at: '2026-10-20', valid_until: '2026-10-20' });
      expect((await auditOf(db, 'tst', id)).at(-1)).toMatchObject({
        action: 'register.updated', before: { valid_until: '2026-10-09', action_due_at: '2026-10-09' }, after: { valid_until: '2026-10-20', action_due_at: '2026-10-20' },
      });
      const tasks = await bagus.get<TaskList>('/api/v1/tasks');
      expect(tasks.body.items.find((t) => t.id === id)).toMatchObject({ due: '2026-10-20' });
      // The job leaves the open action as it is.
      expect((await job.run(ORG_IDS.tst)).competenceReminders).toBe(0);
    });
  });
});
