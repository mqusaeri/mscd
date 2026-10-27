// Holdings and handover (Milestone 2 D.1 `records.holdings`, `records.holdings.reassign`, `admin.users.holdings`, H.13,
// M2-07): the open items a person holds in a system for MS Managers, the handover of chosen kinds or everything in one
// transaction with per-record warnings (BR-16, BR-41) and audit, the BR-22 confirmation for records shared with other
// systems, and counts without titles for the Tenant Admin.
import { CommandResult, Holdings, UserHoldings } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { auditByAction, createExtraApp, idOf, inOrg, rowsOf, sessionFor, systemOf, type Client, type CommandsApp } from './helpers';

const HOLDINGS = (ms: string, handle: string) => `/api/v1/ms/${ms}/holdings/${handle}`;

describe('holdings and handover (M2-07)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let hendra: Client;
  let admin: Client;
  let isms: { id: string; version: string };

  const holdings = async (handle: string, client: Client = rina, ms = 'isms') => {
    const response = await client.get<Holdings>(HOLDINGS(ms, handle));
    expect(response.status).toBe(200);
    expect(Holdings.safeParse(response.body).success).toBe(true);
    return response.body;
  };

  beforeAll(async () => {
    ctx = await createExtraApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    bagus = await sessionFor(ctx, db, 'bagus', 'tst');
    maya = await sessionFor(ctx, db, 'maya', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    admin = await sessionFor(ctx, db, 'tenant.admin', 'tst');
    isms = await systemOf(db, 'tst', 'isms');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('lists the open items a person holds in the system with counts per kind', async () => {
    const body = await holdings('bagus');
    expect(body).toMatchObject({ handle: 'bagus', ms: 'isms' });
    expect(body.items.length).toBeGreaterThan(0);
    const counted = Object.values(body.counts).reduce((a, b) => a + (b ?? 0), 0);
    expect(counted).toBe(body.items.length);
    const bagusId = await idOf(db, 'tst', 'bagus');
    const [risks] = await rowsOf<{ n: number }>(db, 'tst', sql`
      select count(*)::int as n from risk r where r.deleted_at is null and r.owner_user_id = ${bagusId}
         and exists (select 1 from entity_ms_link l where l.entity_type = 'risk' and l.entity_id = r.id and l.management_system_id = ${isms.id} and l.deleted_at is null)`);
    expect(body.counts.risk ?? 0).toBe(risks!.n);
    const [entries] = await rowsOf<{ n: number }>(db, 'tst', sql`
      select count(*)::int as n from applicability_entry e where e.management_system_id = ${isms.id} and e.deleted_at is null
         and (e.owner_user_id = ${bagusId} or e.justification_holder_user_id = ${bagusId})`);
    expect(body.counts.applicability_entry ?? 0).toBe(entries!.n);
    const entry = body.items.find((i) => i.kind === 'applicability_entry');
    if (entry) expect(entry.ref).toMatchObject({ module: 'implementation', entityType: 'applicability_entry', code: entry.code });
  });

  it('is for MS Managers and Programme Owners only (record.assign), and answers 404 for someone who is no member', async () => {
    expect((await bagus.get(HOLDINGS('isms', 'bagus'))).status).toBe(403);
    expect((await hendra.get(HOLDINGS('isms', 'bagus'))).status).toBe(403);
    expect((await maya.get(HOLDINGS('isms', 'bagus'))).status).toBe(403);
    expect((await rina.get(HOLDINGS('isms', 'nobody-here'))).status).toBe(404);
    expect((await rina.get(HOLDINGS('isms', 'none'))).status).toBe(400);
    expect((await bagus.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi' })).status).toBe(403);
  });

  it('hands chosen kinds over to a successor in one transaction, with an audit entry per record', async () => {
    const before = await holdings('bagus');
    const moved = before.items.filter((i) => i.kind === 'risk' || i.kind === 'evidence');
    expect(moved.length).toBeGreaterThan(0);
    const dewiBefore = await holdings('dewi');
    const response = await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi', kinds: ['risk', 'evidence'] });
    expect(response.status).toBe(200);
    expect(CommandResult.safeParse(response.body).success).toBe(true);
    expect(response.body).toMatchObject({ ok: true, changed: ['isms'], count: moved.length });
    const after = await holdings('bagus');
    expect(after.counts.risk ?? 0).toBe(0);
    expect(after.counts.evidence ?? 0).toBe(0);
    expect(after.items.length).toBe(before.items.length - moved.length);
    const dewi = await holdings('dewi');
    expect(dewi.counts.risk ?? 0).toBe((dewiBefore.counts.risk ?? 0) + (before.counts.risk ?? 0));
    const audit = (await auditByAction(db, 'tst', 'holdings.reassigned')).filter((a) => moved.some((m) => m.ref.id === a.entity_id));
    expect(audit).toHaveLength(moved.length);
    for (const entry of audit) {
      expect(entry).toMatchObject({ actor: 'rina', before: { holder: 'bagus' }, after: { holder: 'dewi', columns: expect.any(Array), kinds: expect.any(Array) } });
    }
    // Each warning names its record (BR-41: a due date after the next audit stays).
    for (const warning of response.body.warnings ?? []) {
      expect(['BR-41', 'BR-16', 'BR-17']).toContain(warning.rule);
      expect(moved.some((m) => warning.messages.en.startsWith(`${m.code}: `))).toBe(true);
    }
  });

  it('warns per record when the successor wrote the version in review of a document they now approve (BR-16)', async () => {
    const [bagusId, dewiId] = [await idOf(db, 'tst', 'bagus'), await idOf(db, 'tst', 'dewi')];
    const [doc] = await rowsOf<{ id: string; code: string }>(db, 'tst', sql`
      select d.id, d.doc_code as code from document d
        join entity_ms_link l on l.entity_type = 'document' and l.entity_id = d.id and l.management_system_id = ${isms.id} and l.deleted_at is null
       where d.deleted_at is null and not exists (select 1 from document_version v where v.document_id = d.id and v.status = 'in_review' and v.deleted_at is null)
       order by d.doc_code limit 1`);
    await inOrg(db, 'tst', async (trx) => {
      await sql`update document set approver_user_id = ${bagusId} where id = ${doc!.id}`.execute(trx);
      await sql`insert into document_version (document_id, version_label, storage_object_id, status, submitted_by, submitted_at)
                select ${doc!.id}, 'v98.0', storage_object_id, 'in_review', ${dewiId}, now() from document_version where storage_object_id is not null limit 1`.execute(trx);
    });
    const response = await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi', kinds: ['document_approver'] });
    expect(response.status).toBe(200);
    expect(response.body.warnings).toContainEqual({ rule: 'BR-16', messages: { en: expect.stringMatching(new RegExp(`^${doc!.code}: `)), id: expect.stringMatching(new RegExp(`^${doc!.code}: `)) } });
    const [stored] = await rowsOf<{ approver: string }>(db, 'tst', sql`select approver_user_id as approver from document where id = ${doc!.id}`);
    expect(stored!.approver).toBe(dewiId);
  });

  it('refuses a successor who is no member or the same person, and an empty kind list', async () => {
    const stranger = await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'staff01' });
    expect(stranger.status).toBe(422);
    expect(stranger.body.rule).toBe('NOT-A-MEMBER');
    const same = await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'bagus' });
    expect(same.status).toBe(422);
    expect(same.body).toMatchObject({ messageKey: 'holdings.same_person' });
    expect((await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi', kinds: [] })).status).toBe(400);
    expect((await rina.post(`${HOLDINGS('isms', 'nobody-here')}/reassign`, { successor: 'dewi' })).status).toBe(404);
  });

  it('lists the drift results a person holds as tasks and the reviews they own as register rows, and hands them over', async () => {
    const bagusId = await idOf(db, 'tst', 'bagus');
    const ids = await inOrg(db, 'tst', async (trx) => {
      const insertDrift = (code: string, resolved: boolean) => sql<{ id: string }>`
        insert into drift_result (management_system_id, drift_rule_def_id, rule_code, entity_code, title, holder_user_id, due_at, resolved_at)
        select ${isms.id}, d.id, d.code, ${code}, 'Fixture drift item', ${bagusId}, '2026-10-15', ${resolved ? sql`now()` : sql`null`}
          from ref.drift_rule_def d where d.framework_version_id = ${isms.version} order by d.code limit 1
        returning id`.execute(trx);
      const insertReview = async (code: string, status: 'planned' | 'closed') => {
        const { rows } = await sql<{ id: string }>`
          insert into management_review (code, title, owner_user_id, planned_at, status, decisions_recorded, closed_at)
          values (${code}, 'Fixture review', ${bagusId}, '2026-11-20', ${status}, ${status === 'closed'}, ${status === 'closed' ? '2026-09-01' : null})
          returning id`.execute(trx);
        await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary)
                  values ('management_review', ${rows[0]!.id}, ${isms.id}, true)`.execute(trx);
        return rows[0]!.id;
      };
      return {
        drift: (await insertDrift('DR-HX1', false)).rows[0]!.id,
        resolvedDrift: (await insertDrift('DR-HX2', true)).rows[0]!.id,
        review: await insertReview('MR-HX1', 'planned'),
        closedReview: await insertReview('MR-HX2', 'closed'),
      };
    });
    const before = await holdings('bagus');
    expect(before.items.find((i) => i.ref.id === ids.drift)).toMatchObject({
      kind: 'task', code: 'DR-HX1', title: 'Fixture drift item', dueAt: '2026-10-15', ref: { module: 'surveillance', entityType: 'drift_result' },
    });
    expect(before.items.find((i) => i.ref.id === ids.review)).toMatchObject({
      kind: 'register_row', code: 'MR-HX1', title: 'Fixture review', dueAt: '2026-11-20', ref: { module: 'audit', entityType: 'management_review' },
    });
    expect(before.items.some((i) => i.ref.id === ids.resolvedDrift || i.ref.id === ids.closedReview)).toBe(false);
    const counts = (await admin.get<UserHoldings>(`/api/v1/admin/users/${bagusId}/holdings`)).body.systems.find((s) => s.ms === 'isms')!;
    expect(counts.total).toBe(before.items.length);

    const response = await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi', kinds: ['task', 'register_row'] });
    expect(response.status).toBe(200);
    const after = await holdings('bagus');
    expect(after.items.some((i) => i.ref.id === ids.drift || i.ref.id === ids.review)).toBe(false);
    const dewi = await holdings('dewi');
    expect(dewi.items.filter((i) => i.ref.id === ids.drift || i.ref.id === ids.review)).toHaveLength(2);
    const [stored] = await rowsOf<{ holder: string; owner: string; resolved_holder: string; closed_owner: string }>(db, 'tst', sql`
      select (select u.handle from drift_result r join platform.app_user u on u.id = r.holder_user_id where r.id = ${ids.drift}) as holder,
             (select u.handle from management_review r join platform.app_user u on u.id = r.owner_user_id where r.id = ${ids.review}) as owner,
             (select u.handle from drift_result r join platform.app_user u on u.id = r.holder_user_id where r.id = ${ids.resolvedDrift}) as resolved_holder,
             (select u.handle from management_review r join platform.app_user u on u.id = r.owner_user_id where r.id = ${ids.closedReview}) as closed_owner`);
    expect(stored).toEqual({ holder: 'dewi', owner: 'dewi', resolved_holder: 'bagus', closed_owner: 'bagus' });
    const audit = (await auditByAction(db, 'tst', 'holdings.reassigned')).filter((a) => a.entity_id === ids.drift || a.entity_id === ids.review);
    expect(audit.map((a) => [a.entity_type, a.after?.columns])).toEqual(
      expect.arrayContaining([['drift_result', ['holder_user_id']], ['management_review', ['owner_user_id']]]),
    );
  });

  it('lists open self-assessment gaps, planned audit activities and business associates held as relationship owner, and hands them over', async () => {
    const [bagusId, dewiId, rinaId] = [await idOf(db, 'tst', 'bagus'), await idOf(db, 'tst', 'dewi'), await idOf(db, 'tst', 'rina')];
    const ids = await inOrg(db, 'tst', async (trx) => {
      const { rows: conditions } = await sql<{ id: string; code: string; text: string }>`
        select c.id, c.code, c.text from ref.finding_condition c
         where c.framework_version_id = ${isms.version}
           and not exists (select 1 from self_assessment s where s.finding_condition_id = c.id and s.management_system_id = ${isms.id} and s.deleted_at is null)
         order by c.code limit 2`.execute(trx);
      expect(conditions).toHaveLength(2);
      const assess = async (conditionId: string, status: 'gap' | 'conforming', fixAt: string | null) =>
        (await sql<{ id: string }>`
          insert into self_assessment (management_system_id, finding_condition_id, status, owner_user_id, target_fix_at, assessed_at)
          values (${isms.id}, ${conditionId}, ${status}, ${bagusId}, ${fixAt}, '2026-09-20') returning id`.execute(trx)).rows[0]!.id;
      // An applicability entry the successor owns, so that an activity examining it gives AUD-INDEP once she audits it.
      const { rows: targets } = await sql<{ id: string; code: string }>`
        select e.id, ci.item_code as code from applicability_entry e join ref.catalogue_item ci on ci.id = e.catalogue_item_id
         where e.management_system_id = ${isms.id} and e.deleted_at is null
           and e.owner_user_id is distinct from ${bagusId} and e.justification_holder_user_id is distinct from ${bagusId}
         order by ci.item_code limit 1`.execute(trx);
      await sql`update applicability_entry set owner_user_id = ${dewiId} where id = ${targets[0]!.id}`.execute(trx);
      const { rows: events } = await sql<{ id: string }>`
        select id from audit_event where management_system_id = ${isms.id} and deleted_at is null order by scheduled_at, id limit 1`.execute(trx);
      const activity = async (code: string, column: 'auditor_user_id' | 'auditee_user_id', status: 'planned' | 'done', target: string | null) =>
        (await sql<{ id: string }>`
          insert into audit_activity (audit_event_id, management_system_id, template_code, title, ${sql.ref(column)}, scheduled_at, status, target_code)
          values (${events[0]!.id}, ${isms.id}, ${code}, ${`Fixture audit activity ${code}`}, ${bagusId}, '2026-10-20', ${status}, ${target})
          returning id`.execute(trx)).rows[0]!.id;
      const associate = (await sql<{ id: string }>`
        insert into business_associate (management_system_id, code, title, owner_user_id, relationship_owner_user_id)
        values (${isms.id}, 'BA-HX1', 'Fixture business associate', ${rinaId}, ${bagusId}) returning id`.execute(trx)).rows[0]!.id;
      return {
        condition: conditions[0]!,
        gap: await assess(conditions[0]!.id, 'gap', '2026-11-30'),
        conforming: await assess(conditions[1]!.id, 'conforming', null),
        audited: await activity('IA-HX1', 'auditor_user_id', 'planned', targets[0]!.code),
        auditee: await activity('IA-HX2', 'auditee_user_id', 'planned', null),
        done: await activity('IA-HX3', 'auditor_user_id', 'done', null),
        associate,
      };
    });
    const before = await holdings('bagus');
    expect(before.items.find((i) => i.ref.id === ids.gap)).toMatchObject({
      kind: 'finding', code: ids.condition.code, title: ids.condition.text, dueAt: '2026-11-30', ref: { module: 'audit', entityType: 'self_assessment' },
    });
    expect(before.items.find((i) => i.ref.id === ids.audited)).toMatchObject({
      kind: 'prep_task', code: 'IA-HX1', dueAt: '2026-10-20', ref: { module: 'audit', entityType: 'audit_activity' },
    });
    expect(before.items.find((i) => i.ref.id === ids.auditee)).toMatchObject({ kind: 'prep_task', code: 'IA-HX2' });
    expect(before.items.find((i) => i.ref.id === ids.associate)).toMatchObject({
      kind: 'register_row', code: 'BA-HX1', ref: { entityType: 'business_associate' },
    });
    // A conforming row and a finished activity are not open items.
    expect(before.items.some((i) => i.ref.id === ids.conforming || i.ref.id === ids.done)).toBe(false);
    const counts = (await admin.get<UserHoldings>(`/api/v1/admin/users/${bagusId}/holdings`)).body.systems.find((s) => s.ms === 'isms')!;
    expect(counts.total).toBe(before.items.length);

    const response = await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi', kinds: ['finding', 'prep_task', 'register_row'] });
    expect(response.status).toBe(200);
    // The successor owns the entry the activity examines, so she would audit her own work (AUD-INDEP, a warning).
    expect(response.body.warnings).toContainEqual({ rule: 'AUD-INDEP', messages: { en: expect.stringMatching(/^IA-HX1: /), id: expect.stringMatching(/^IA-HX1: /) } });
    const after = await holdings('bagus');
    expect(after.items.some((i) => [ids.gap, ids.audited, ids.auditee, ids.associate].includes(i.ref.id))).toBe(false);
    const dewi = await holdings('dewi');
    expect(dewi.items.filter((i) => [ids.gap, ids.audited, ids.auditee, ids.associate].includes(i.ref.id))).toHaveLength(4);
    const [stored] = await rowsOf<Record<string, string>>(db, 'tst', sql`
      select (select u.handle from self_assessment r join platform.app_user u on u.id = r.owner_user_id where r.id = ${ids.gap}) as gap,
             (select u.handle from self_assessment r join platform.app_user u on u.id = r.owner_user_id where r.id = ${ids.conforming}) as conforming,
             (select u.handle from audit_activity r join platform.app_user u on u.id = r.auditor_user_id where r.id = ${ids.audited}) as auditor,
             (select u.handle from audit_activity r join platform.app_user u on u.id = r.auditee_user_id where r.id = ${ids.auditee}) as auditee,
             (select u.handle from audit_activity r join platform.app_user u on u.id = r.auditor_user_id where r.id = ${ids.done}) as done,
             (select u.handle from business_associate r join platform.app_user u on u.id = r.relationship_owner_user_id where r.id = ${ids.associate}) as relationship,
             (select u.handle from business_associate r join platform.app_user u on u.id = r.owner_user_id where r.id = ${ids.associate}) as associate_owner`);
    expect(stored).toEqual({
      gap: 'dewi', conforming: 'bagus', auditor: 'dewi', auditee: 'dewi', done: 'bagus', relationship: 'dewi', associate_owner: 'rina',
    });
    const audit = (await auditByAction(db, 'tst', 'holdings.reassigned')).filter((a) => [ids.gap, ids.audited, ids.auditee, ids.associate].includes(a.entity_id!));
    expect(audit.map((a) => [a.entity_type, a.after?.columns])).toEqual(expect.arrayContaining([
      ['self_assessment', ['owner_user_id']], ['audit_activity', ['auditor_user_id']], ['audit_activity', ['auditee_user_id']],
      ['business_associate', ['relationship_owner_user_id']],
    ]));
    expect(audit).toHaveLength(4);
  });

  it('hands everything over when no kind is named, after which the person holds nothing in the system', async () => {
    const response = await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi' });
    expect(response.status).toBe(200);
    expect(response.body.count).toBeGreaterThan(0);
    expect(await holdings('bagus')).toMatchObject({ items: [], counts: {} });
    const nothing = await rina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi' });
    expect(nothing.body).toMatchObject({ ok: true, count: 0 });
  });

  it('gives the Tenant Admin counts per system and kind with the primary manager, never a title', async () => {
    const dewiId = await idOf(db, 'tst', 'dewi');
    const response = await admin.get<UserHoldings>(`/api/v1/admin/users/${dewiId}/holdings`);
    expect(response.status).toBe(200);
    expect(UserHoldings.safeParse(response.body).success).toBe(true);
    const [system] = response.body.systems;
    expect(system).toMatchObject({ ms: 'isms', primaryManager: { handle: 'rina', displayName: expect.any(String), email: expect.stringContaining('@') } });
    expect(system!.total).toBe(Object.values(system!.counts).reduce((a, b) => a + (b ?? 0), 0));
    expect(system!.total).toBe((await holdings('dewi')).items.length);
    expect(JSON.stringify(response.body)).not.toMatch(/"title"|"items"|"code"/);
    const bagusId = await idOf(db, 'tst', 'bagus');
    expect((await admin.get<UserHoldings>(`/api/v1/admin/users/${bagusId}/holdings`)).body).toEqual({ systems: [] });
    expect((await admin.get(`/api/v1/admin/users/0b7a4e7c-1d2f-4a3b-9c8d-7e6f5a4b3c2d/holdings`)).status).toBe(404);
    expect((await bagus.get(`/api/v1/admin/users/${dewiId}/holdings`)).status).toBe(403);
  });

  it('asks for the BR-22 confirmation when a record is shared with another system', async () => {
    const ndtRina = await sessionFor(ctx, db, 'rina', 'ndt');
    const [ndtIsms, ndtQms] = [await systemOf(db, 'ndt', 'isms'), await systemOf(db, 'ndt', 'qms')];
    const bagusId = await idOf(db, 'ndt', 'bagus');
    await inOrg(db, 'ndt', async (trx) => {
      const { rows } = await sql<{ id: string }>`
        insert into risk (code, title, owner_user_id, risk_profile_code)
        select 'R-HX1', 'Fixture shared risk', ${bagusId}, risk_profile_code from risk where risk_profile_code is not null limit 1
        returning id`.execute(trx);
      await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary) values
                  ('risk', ${rows[0]!.id}, ${ndtIsms.id}, true), ('risk', ${rows[0]!.id}, ${ndtQms.id}, false)`.execute(trx);
    });
    const refused = await ndtRina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi', kinds: ['risk'] });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ rule: 'BR-22', affected: expect.arrayContaining(['qms']) });
    const confirmed = await ndtRina.post(`${HOLDINGS('isms', 'bagus')}/reassign`, { successor: 'dewi', kinds: ['risk'], confirm: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.changed).toEqual(expect.arrayContaining(['isms', 'qms']));
    const [risk] = await rowsOf<{ owner: string }>(db, 'ndt', sql`select u.handle as owner from risk r join platform.app_user u on u.id = r.owner_user_id where r.code = 'R-HX1'`);
    expect(risk!.owner).toBe('dewi');
  });
});
