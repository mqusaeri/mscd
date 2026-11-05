// Scoping of the per-screen read endpoints (build plan D-04, F.7, D-34, WP-32): an ISMS Domain Owner (`bagus`) sees
// only own records on every endpoint and nothing of other systems; a QMS-only Domain Owner is refused on ISMS; Top
// Management gets pending data only as aggregates; an external auditor gets no holder names, no pending data and
// evidence only through ready packs; unknown systems are 404 and a missing session 401.
import {
  BUSINESS_ROLES, type BusinessRole,
  ActivityItem, ApplicabilityItem, ChainResponse, CycleItem, DocumentItem, DriftPattern, EvidenceItem, GateItemView, ImplementationSummary,
  PendingAggregate, PendingRecord, StageReadiness, SurveillanceEvent, pageOf,
  type UiMsSnapshot, type UiOrgSnapshot,
} from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { ORG_IDS, createScreenApp, screenClient, userId, type ReadModelApp, type ScreenClient } from './helpers';

/** Every RecordRef id found anywhere in a response body. */
function refIds(body: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(body)) for (const v of body) refIds(v, out);
  else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.module === 'string' && typeof o.entityType === 'string' && typeof o.id === 'string') out.add(o.id);
    for (const v of Object.values(o)) refIds(v, out);
  }
  return out;
}

describe('Per-screen read endpoints: scoping (D-04, F.7, D-34)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let rina: ScreenClient;
  let bagus: ScreenClient;
  let full: UiMsSnapshot;
  let org: UiOrgSnapshot;

  beforeAll(async () => {
    ctx = await createScreenApp(db);
    rina = await screenClient(ctx, db, 'rina', 'ndt');
    bagus = await screenClient(ctx, db, 'bagus', 'ndt');
    full = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
    org = (await rina.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('gives an ISMS Domain Owner only own records on every endpoint', async () => {
    const isms = new Set(Object.values(full.refs).map((r) => r.id));
    const seen = new Set<string>();
    const collect = (body: unknown) => refIds(body, seen);

    const reqs = await bagus.all<ApplicabilityItem>('/api/v1/ms/isms/applicability');
    expect(reqs.total).toBeGreaterThan(0);
    expect(reqs.items.every((r) => r.owner === 'bagus')).toBe(true);
    expect(reqs.items.map((r) => r.id)).toEqual(full.bundle.reqs.filter((r) => r.owner === 'bagus').map((r) => r.id));
    collect(reqs.items);

    const docs = await bagus.all<DocumentItem>('/api/v1/ms/isms/documents');
    expect(docs.total).toBeGreaterThan(0);
    expect(docs.items.every((d) => d.owner === 'bagus')).toBe(true);
    const ownReqIds = new Set(reqs.items.map((r) => r.id));
    for (const d of docs.items) for (const code of d.requirements) expect(ownReqIds.has(code)).toBe(true);
    collect(docs.items);

    const evs = await bagus.all<EvidenceItem>('/api/v1/ms/isms/evidence');
    expect(evs.total).toBeGreaterThan(0);
    expect(evs.items.every((e) => e.owner === 'bagus')).toBe(true);
    expect(evs.items.map((e) => e.code)).toEqual(full.bundle.evs.filter((e) => e.owner === 'bagus').map((e) => e.code));
    collect(evs.items);

    const gates = (await bagus.get<GateItemView[]>('/api/v1/ms/isms/gates')).body;
    expect(gates.map((g) => g.id)).toEqual(full.bundle.gates.filter((g) => g.h === 'bagus').map((g) => g.id));
    collect(gates);

    for (const phase of full.bundle.phases) {
      const acts = (await bagus.get<ActivityItem[]>(`/api/v1/ms/isms/phases/${phase.no}/activities`)).body;
      expect(acts.map((a) => a.no)).toEqual(phase.acts.filter((a) => a.owner === 'bagus').map((a) => a.no));
      collect(acts);
    }

    const stages = (await bagus.get<StageReadiness[]>('/api/v1/ms/isms/audit/stages')).body;
    for (const stage of stages) {
      const records = await bagus.all<PendingRecord>(`/api/v1/ms/isms/audit/stages/${stage.key}/records`);
      for (const r of records.items) expect({ stage: stage.key, code: r.ref.code, holder: r.holder?.handle }).toEqual({ stage: stage.key, code: r.ref.code, holder: 'bagus' });
      expect(records.items.filter((r) => r.status !== 'ready')).toHaveLength(full.bundle.chain.items.filter((i) => i.stage === stage.key && i.h === 'bagus').length);
      collect(records.items);
    }

    const own = await bagus.all<PendingRecord>('/api/v1/ms/isms/audit/pending?owner=bagus');
    const asManager = await rina.all<PendingRecord>('/api/v1/ms/isms/audit/pending?owner=bagus');
    expect(own.total).toBe(full.bundle.chain.items.filter((i) => i.h === 'bagus').length);
    expect(own.items).toEqual(asManager.items);
    collect(own.items);

    // Chains: every node outside the owner's records is hidden; chains without an own record are 404.
    let shown = 0;
    for (const chain of org.CHAINS.isms ?? []) {
      const response = await bagus.get<ChainResponse>(`/api/v1/ms/isms/audit/chain?anchor_id=${encodeURIComponent(chain.id)}`);
      if (response.status === 404) continue;
      expect(response.status).toBe(200);
      shown += 1;
      for (const node of response.body.nodes) {
        if ('hidden' in node || node.id === null) continue;
        expect({ id: node.id, holder: node.holder }).toEqual({ id: node.id, holder: 'bagus' });
      }
      collect(response.body);
    }
    expect(shown).toBeGreaterThan(0);

    const cycle = (await bagus.get<CycleItem[]>('/api/v1/ms/isms/surveillance/cycle')).body;
    expect(cycle.every((c) => c.owner === 'bagus')).toBe(true);
    expect(cycle).toHaveLength(full.CYCLE_ITEMS.filter((row) => row[2] === 'bagus').length);
    collect(cycle);

    const drift = (await bagus.get<DriftPattern[]>('/api/v1/ms/isms/surveillance/drift')).body;
    expect(drift.length).toBeGreaterThan(0);
    for (const pattern of drift) for (const row of pattern.rows) expect(row.holder).toBe('bagus');
    collect(drift);

    const nextId = (await bagus.get<{ id: string }>('/api/v1/ms/isms/audit/event/next')).body.id;
    const event = (await bagus.get<SurveillanceEvent>(`/api/v1/ms/isms/surveillance/events/${nextId}`)).body;
    expect(event.prep.every((p) => p.owner === 'bagus')).toBe(true);
    expect(event.prep).toHaveLength(full.PREP.filter((row) => row[1] === 'bagus').length);
    collect(event);

    // Nothing of another system: every record ref belongs to the ISMS snapshot, or is a row of the ISMS system.
    const ismsRows = await inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, async (trx) => {
      const { rows } = await sql<{ id: string }>`
        select f.id from finding f join management_system m on m.id = f.management_system_id where m.slug = 'isms'
        union all select p.id from audit_prep_task p join management_system m on m.id = p.management_system_id where m.slug = 'isms'
        union all select c.id from cycle_requirement_status c join management_system m on m.id = c.management_system_id where m.slug = 'isms'
        union all select r.id from drift_result r join management_system m on m.id = r.management_system_id where m.slug = 'isms'
        union all select l.entity_id from entity_ms_link l join management_system m on m.id = l.management_system_id
          where m.slug = 'isms' and l.deleted_at is null
        union all select t.id from risk_treatment t join management_system m on m.id = t.management_system_id where m.slug = 'isms'
        union all select c.id from chain_record c join management_system m on m.id = c.management_system_id where m.slug = 'isms'`.execute(trx);
      return new Set(rows.map((r) => r.id));
    });
    expect(seen.size).toBeGreaterThan(0);
    for (const id of seen) expect(isms.has(id) || ismsRows.has(id), id).toBe(true);

    // Summary cards count the owner's records; phase counts stay those of the full data (D-04).
    const summary = (await bagus.get<ImplementationSummary>('/api/v1/ms/isms/implementation/summary')).body;
    expect(summary.cards.find((c) => c.key === 'implemented')!.total).toBe(reqs.total);
    expect(summary.phases.map((p) => p.counts)).toEqual(full.bundle.phases.map((p) => p.c));
  });

  it('refuses everyone\'s pending list, the aggregate and other people\'s records to a Domain Owner', async () => {
    expect((await bagus.get('/api/v1/ms/isms/audit/pending')).status).toBe(403);
    expect((await bagus.get('/api/v1/ms/isms/audit/pending?aggregate=unit')).status).toBe(403);
    expect((await bagus.get('/api/v1/ms/isms/audit/pending?owner=rina')).status).toBe(403);
  });

  it('refuses every ISMS endpoint to a QMS-only Domain Owner and shows only own QMS records', async () => {
    const staff = await userId(db, 'staff02');
    await inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, async (trx) => {
      const qms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'qms').executeTakeFirstOrThrow();
      await trx.insertInto('user_ms_role').values({ user_id: staff, management_system_id: qms.id, role: 'domain_owner' }).execute();
    });
    const client = await screenClient(ctx, db, 'staff02', 'ndt');
    const paths = [
      'implementation/summary', 'applicability', 'documents', 'gates', 'phases/1/activities', 'audit/event/next', 'audit/stages',
      'audit/stages/risk/records', 'audit/chain?anchor_id=R-014', 'audit/pending?owner=staff02', 'surveillance/cycle', 'surveillance/drift', 'evidence',
    ];
    for (const path of paths) expect({ path, status: (await client.get(`/api/v1/ms/isms/${path}`)).status }).toEqual({ path, status: 403 });
    for (const path of ['applicability', 'documents', 'evidence']) {
      const page = (await client.get<{ total: number }>(`/api/v1/ms/qms/${path}`)).body;
      expect({ path, total: page.total }).toEqual({ path, total: 0 });
    }
    expect((await client.get<unknown[]>('/api/v1/ms/qms/gates')).body).toEqual([]);
  });

  it('gives Top Management pending data only as counts per stage and role', async () => {
    const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
    expect((await hendra.get('/api/v1/ms/isms/audit/pending')).status).toBe(403);
    expect((await hendra.get('/api/v1/ms/isms/audit/pending?owner=bagus')).status).toBe(403);
    const aggregate = await hendra.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit');
    expect(aggregate.status).toBe(200);
    expect(z.array(z.object({
      stage: z.string(), role: z.string().nullable(), open: z.number(), overdue: z.number(), holders: z.number().optional(), group: z.literal('other_roles').optional(),
    }).strict()).parse(aggregate.body)).toBeTruthy();
    expect(aggregate.body.reduce((n, r) => n + r.open, 0)).toBe(full.bundle.chain.items.length);
    expect(aggregate.body.reduce((n, r) => n + r.overdue, 0)).toBe(full.bundle.chain.items.filter((i) => i.st !== 'pending').length);
    expect(JSON.stringify(aggregate.body)).not.toContain('bagus');
    // No row stands for one person (decision 21, M3-15): a named role has two or more holders besides the reader, and
    // the merged row of the other roles ("Other roles") stands for two or more people besides the reader too, so
    // hendra cannot get one person's numbers by taking away his own open items (he is one of the people of the group).
    for (const row of aggregate.body) {
      if (row.role !== null) expect(row.holders, JSON.stringify(row)).toBeGreaterThanOrEqual(row.role === 'top_management' ? 3 : 2);
      else if (row.group) expect(row.holders, JSON.stringify(row)).toBeGreaterThanOrEqual(3);
      else expect(row.holders).toBeUndefined();
    }
    // In the demo ISMS only the Domain Owners are more than one; the Management System Manager, the Programme Owner,
    // the Risk Owner, the Internal Auditor and Top Management are one each, so they are counted together.
    expect([...new Set(aggregate.body.filter((r) => r.role !== null).map((r) => r.role))]).toEqual(['domain_owner']);
    const groups = aggregate.body.filter((r) => r.group === 'other_roles');
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((r) => r.role === null && r.holders === 5)).toBe(true);
    const own = await hendra.all<PendingRecord>('/api/v1/ms/isms/audit/pending?owner=hendra');
    expect(own.total).toBe(full.bundle.chain.items.filter((i) => i.h === 'hendra').length);
  });

  /**
   * The people of the ISMS of `ndt` under the first of their active business roles (BUSINESS_ROLES order), as the
   * aggregate counts them: every grant holder (`firstRole`, which places the open work of a person; a guest keeps only
   * `external_auditor`), and the holders with an active membership in the organisation and an active account
   * (`active`, the people a row may count, M3-14). `counts` leaves out the external auditors, who hold no chain work.
   */
  const ismsRoles = async (): Promise<{ firstRole: Map<string, BusinessRole>; active: Set<string>; counts: Map<BusinessRole, number> }> => {
    const { rows } = await inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, (trx) => sql<{ handle: string; roles: BusinessRole[]; active: boolean }>`
      select u.handle, array_agg(distinct r.role) as roles,
             bool_or(u.status = 'active' and om.user_id is not null) as active
        from user_ms_role r join management_system m on m.id = r.management_system_id
        join platform.app_user u on u.id = r.user_id and u.deleted_at is null
        left join platform.org_membership om on om.user_id = r.user_id and om.organization_id = ${ORG_IDS.ndt}::uuid
         and om.status = 'active' and om.deleted_at is null
       where m.slug = 'isms' and r.deleted_at is null and r.approval_status = 'active' and (r.valid_until is null or r.valid_until > now())
         and (u.kind <> 'guest' or r.role = 'external_auditor')
       group by u.handle`.execute(trx));
    const firstRole = new Map<string, BusinessRole>();
    const active = new Set<string>();
    const counts = new Map<BusinessRole, number>();
    for (const row of rows) {
      const first = BUSINESS_ROLES.find((r) => row.roles.includes(r))!;
      firstRole.set(row.handle, first);
      if (!row.active) continue;
      active.add(row.handle);
      if (first !== 'external_auditor') counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    return { firstRole, active, counts };
  };

  type Row = PendingAggregate;
  const keyOf = (r: Row) => `${r.stage}|${r.role ?? (r.group ? '~group' : '~none')}`;
  const sorted = (rows: readonly Row[]) => [...rows].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

  /**
   * The answer decision 21 asks for when `reader` reads it, computed here from the chain items of the snapshot and the
   * grants in the database: a role with two or more holders besides the reader keeps its row; the other roles merge
   * into one `other_roles` row per stage when they have two or more holders besides the reader together (`holders`
   * counts the reader too), else their counts join the unassigned row of the stage.
   */
  const expectedAggregate = async (reader: string): Promise<Row[]> => {
    const { firstRole, active, counts } = await ismsRoles();
    const readerRole = active.has(reader) ? firstRole.get(reader) : undefined;
    const others = (role: BusinessRole) => (counts.get(role) ?? 0) - (role === readerRole && counts.has(role) ? 1 : 0);
    const small = (role: BusinessRole) => others(role) < 2;
    const smallRoles = [...counts.keys()].filter(small);
    const groupHolders = smallRoles.reduce((n, role) => n + counts.get(role)!, 0);
    const groupOthers = smallRoles.reduce((n, role) => n + others(role), 0);
    const out = new Map<string, Row>();
    for (const item of full.bundle.chain.items) {
      const role = item.h === 'none' ? null : (firstRole.get(item.h) ?? null);
      let base: Row;
      if (role !== null && !small(role)) base = { stage: item.stage, role, open: 0, overdue: 0, holders: counts.get(role)! };
      else if (role !== null && groupOthers >= 2) base = { stage: item.stage, role: null, open: 0, overdue: 0, holders: groupHolders, group: 'other_roles' };
      else base = { stage: item.stage, role: null, open: 0, overdue: 0 };
      const row = out.get(keyOf(base)) ?? base;
      row.open += 1;
      if (item.st !== 'pending') row.overdue += 1;
      out.set(keyOf(row), row);
    }
    return sorted([...out.values()]);
  };

  /** The open work of some holders per stage, counted from the chain items of the snapshot. */
  const workOf = (handles: readonly string[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const item of full.bundle.chain.items) if (handles.includes(item.h)) out.set(item.stage, (out.get(item.stage) ?? 0) + 1);
    return out;
  };

  /** Ends the ISMS grants of `ends` (soft delete) and adds `adds`, runs `fn`, then puts every grant back. */
  const withIsmsGrants = async (change: { ends?: string[]; adds?: [string, BusinessRole][] }, fn: () => Promise<void>): Promise<void> => {
    const scope = { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true };
    const ended = await inScope(db.migrator, scope, (trx) => sql<{ id: string }>`
      update user_ms_role r set deleted_at = now()
        from management_system m, platform.app_user u
       where m.id = r.management_system_id and m.slug = 'isms' and u.id = r.user_id and u.handle = any(${change.ends ?? []}::text[])
         and r.deleted_at is null
      returning r.id`.execute(trx));
    const added: string[] = [];
    try {
      for (const [handle, role] of change.adds ?? []) {
        const id = await userId(db, handle);
        const row = await inScope(db.migrator, scope, (trx) => sql<{ id: string }>`
          insert into user_ms_role (user_id, management_system_id, role, approval_status, is_primary)
          select ${id}::uuid, m.id, ${role}, 'active', false from management_system m where m.slug = 'isms'
          returning id`.execute(trx));
        added.push(row.rows[0]!.id);
      }
      await fn();
    } finally {
      await inScope(db.migrator, scope, (trx) => sql`update user_ms_role set deleted_at = null where id = any(${ended.rows.map((r) => r.id)}::uuid[])`.execute(trx));
      await inScope(db.migrator, scope, (trx) => sql`update user_ms_role set deleted_at = now() where id = any(${added}::uuid[])`.execute(trx));
    }
  };

  it('names only roles with two or more holders and merges the others into one row per stage (decision 21, M3-15)', async () => {
    const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
    const aggregate = (await hendra.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
    expect(sorted(aggregate)).toEqual(await expectedAggregate('hendra'));
    const { counts } = await ismsRoles();
    for (const row of aggregate.filter((r) => r.role !== null)) expect({ role: row.role, holders: row.holders }).toEqual({ role: row.role, holders: counts.get(row.role!) });
    // The rows come in stage blocks, each with its named roles in BUSINESS_ROLES order, then "Other roles", then the
    // unassigned row.
    const rank = (r: Row) => (r.role !== null ? BUSINESS_ROLES.indexOf(r.role) : r.group ? BUSINESS_ROLES.length : BUSINESS_ROLES.length + 1);
    const stages = aggregate.map((r) => r.stage).filter((stage, n, all) => n === 0 || all[n - 1] !== stage);
    expect(new Set(stages).size).toBe(stages.length);
    for (const stage of stages) {
      const ranks = aggregate.filter((r) => r.stage === stage).map(rank);
      expect(ranks, stage).toEqual([...ranks].sort((a, b) => a - b));
    }
    // A Management System Manager reads the same answer here (audit.pending.aggregate): the five one-holder roles stand
    // for four people besides either reader.
    const forRina = (await rina.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
    expect(sorted(forRina)).toEqual(await expectedAggregate('rina'));
    expect(sorted(forRina)).toEqual(sorted(aggregate));
  });

  it('a lone one-holder role: its counts join the unassigned row, and no row names it (decision 21)', async () => {
    // Only Top Management (hendra, the reader) is left with one holder: the group would stand for one person.
    await withIsmsGrants({ ends: ['rina', 'wulan', 'ratna', 'maya'] }, async () => {
      const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
      const aggregate = (await hendra.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
      expect(sorted(aggregate)).toEqual(await expectedAggregate('hendra'));
      expect(aggregate.some((r) => r.group)).toBe(false);
      expect(aggregate.some((r) => r.role === 'top_management')).toBe(false);
      expect([...new Set(aggregate.filter((r) => r.role !== null).map((r) => r.role))]).toEqual(['domain_owner']);
      // Hendra's open work is in the unassigned row of its stage, with unassigned items and the work of the people
      // without a role (the Domain Owners keep theirs).
      const { firstRole } = await ismsRoles();
      expect(firstRole.get('hendra')).toBe('top_management');
      const elsewhere = [...new Set(full.bundle.chain.items.map((i) => i.h))].filter((h) => firstRole.get(h) !== 'domain_owner');
      expect(elsewhere).toContain('hendra');
      const unassigned = workOf(elsewhere);
      for (const stage of new Set(full.bundle.chain.items.map((i) => i.stage))) {
        expect(aggregate.find((r) => r.stage === stage && r.role === null)?.open ?? 0, stage).toBe(unassigned.get(stage) ?? 0);
      }
    });
  });

  it('Top Management and one other one-holder role: no group, since it would be the other person\'s work once the reader takes away their own (decision 21)', async () => {
    // The Management System Manager (rina) and Top Management (hendra) are left with one holder each. A group of the two
    // minus hendra's own open items (which he reads with ?owner=hendra) would be rina's numbers per stage, so for either
    // of them the two roles stand for one person besides the reader and their counts join the unassigned row.
    await withIsmsGrants({ ends: ['wulan', 'ratna', 'maya'] }, async () => {
      const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
      const elsewhere = async () => {
        const { firstRole } = await ismsRoles();
        return workOf([...new Set(full.bundle.chain.items.map((i) => i.h))].filter((h) => firstRole.get(h) !== 'domain_owner'));
      };
      for (const [reader, client] of [['hendra', hendra], ['rina', rina]] as const) {
        const aggregate = (await client.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
        expect(sorted(aggregate), reader).toEqual(await expectedAggregate(reader));
        expect(aggregate.some((r) => r.group || r.role === 'ms_manager' || r.role === 'top_management'), reader).toBe(false);
        expect([...new Set(aggregate.filter((r) => r.role !== null).map((r) => r.role))], reader).toEqual(['domain_owner']);
        // Both people's open work is in the unassigned row, with the unassigned items.
        const both = workOf(['rina', 'hendra']);
        expect([...both.values()].reduce((n, v) => n + v, 0)).toBeGreaterThan(0);
        for (const [stage, open] of await elsewhere()) expect(aggregate.find((r) => r.stage === stage && r.role === null && !r.group)?.open, `${reader} ${stage}`).toBe(open);
      }
      // The rows of hendra's own work, which he may read.
      const own = await hendra.all<PendingRecord>('/api/v1/ms/isms/audit/pending?owner=hendra');
      expect(own.total).toBe(full.bundle.chain.items.filter((i) => i.h === 'hendra').length);
    });
  });

  it('three one-holder roles with the reader among them: one "Other roles" row per stage for three people, two besides the reader (decision 21)', async () => {
    // The Management System Manager (rina), the Internal Auditor (maya) and Top Management (hendra) are left with one
    // holder each.
    await withIsmsGrants({ ends: ['wulan', 'ratna'] }, async () => {
      const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
      const aggregate = (await hendra.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
      expect(sorted(aggregate)).toEqual(await expectedAggregate('hendra'));
      const groups = aggregate.filter((r) => r.group === 'other_roles');
      expect(groups.length).toBeGreaterThan(0);
      for (const row of groups) expect(row).toMatchObject({ role: null, holders: 3 });
      expect(aggregate.some((r) => r.role === 'ms_manager' || r.role === 'internal_auditor' || r.role === 'top_management')).toBe(false);
      const three = workOf(['rina', 'maya', 'hendra']);
      for (const [stage, open] of three) expect(groups.find((r) => r.stage === stage)?.open, stage).toBe(open);
      expect(groups.reduce((n, r) => n + r.open, 0)).toBe([...three.values()].reduce((n, v) => n + v, 0));
    });
  });

  it('a role the reader shares with one other person is merged for that reader and named for another reader (decision 21)', async () => {
    // Top Management gets a second holder (staff01, a member without another ISMS role); the Programme Owner, the Risk
    // Owner and the Internal Auditor end, so the Management System Manager (rina) is the only one-holder role.
    await withIsmsGrants({ ends: ['wulan', 'ratna', 'maya'], adds: [['staff01', 'top_management']] }, async () => {
      // rina: Top Management stands for two people besides her and keeps its row; her own role stands for nobody
      // besides her, so her open work joins the unassigned row.
      const forRina = (await rina.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
      expect(sorted(forRina)).toEqual(await expectedAggregate('rina'));
      expect(forRina.some((r) => r.group || r.role === 'ms_manager')).toBe(false);
      const top = workOf(['hendra', 'staff01']);
      for (const [stage, open] of top) expect(forRina.find((r) => r.stage === stage && r.role === 'top_management'), stage).toMatchObject({ open, holders: 2 });
      // hendra: Top Management stands for one person besides him (staff01), so it merges with the Management System
      // Manager into "Other roles", which stands for rina and staff01 besides him (three people with hendra).
      const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
      const forHendra = (await hendra.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
      expect(sorted(forHendra)).toEqual(await expectedAggregate('hendra'));
      expect(forHendra.some((r) => r.role === 'top_management' || r.role === 'ms_manager')).toBe(false);
      const groups = forHendra.filter((r) => r.group === 'other_roles');
      for (const row of groups) expect(row.holders).toBe(3);
      const merged = workOf(['rina', 'hendra', 'staff01']);
      for (const [stage, open] of merged) expect(groups.find((r) => r.stage === stage)?.open, stage).toBe(open);
      // The totals are the same for both readers; only their rows differ.
      const total = (rows: PendingAggregate[]) => rows.reduce((n, r) => ({ open: n.open + r.open, overdue: n.overdue + r.overdue }), { open: 0, overdue: 0 });
      expect(total(forHendra)).toEqual(total(forRina));
    });
  });

  it('a system with only multi-holder roles besides the reader: every role keeps its row and no row merges (decision 21)', async () => {
    // Top Management gets two more holders (staff members without another ISMS role); the other one-holder roles end.
    await withIsmsGrants({ ends: ['rina', 'wulan', 'ratna', 'maya'], adds: [['staff01', 'top_management'], ['staff02', 'top_management']] }, async () => {
      const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
      const aggregate = (await hendra.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
      expect(sorted(aggregate)).toEqual(await expectedAggregate('hendra'));
      expect(aggregate.some((r) => r.group)).toBe(false);
      const { counts } = await ismsRoles();
      expect([...counts.values()].every((n) => n >= 2)).toBe(true);
      expect(counts.get('top_management')).toBe(3);
      for (const row of aggregate.filter((r) => r.role !== null)) expect(row.holders).toBe(counts.get(row.role!));
      const top = workOf(['hendra']);
      for (const [stage, open] of top) expect(aggregate.find((r) => r.stage === stage && r.role === 'top_management')).toMatchObject({ open, holders: 3 });
    });
  });

  it('a guest external auditor counts as nobody: one manager and one guest auditor are no group (decision 21)', async () => {
    // Top Management has three holders (hendra and two staff members), so it keeps its row for hendra; the Management
    // System Manager (rina) is the only other one-holder role. A guest external auditor (an active member of the
    // organisation with an active account) holds no chain work: counted as a person, the group would be exactly rina's
    // work. The auditor counts as nobody, so rina's open work joins the unassigned row.
    const scope = { platformScope: true };
    const guestId = await userId(db, 'ext.auditor');
    const kind = await inScope(db.migrator, scope, (trx) => trx.selectFrom('platform.app_user').select(['kind', 'status']).where('id', '=', guestId).executeTakeFirstOrThrow());
    expect(kind).toEqual({ kind: 'guest', status: 'active' });
    const tenant = { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true };
    await inScope(db.migrator, scope, (trx) =>
      sql`insert into platform.org_membership (organization_id, user_id, status) values (${ORG_IDS.ndt}::uuid, ${guestId}::uuid, 'active')`.execute(trx));
    // An external auditor's grant always ends (valid_until), as an auditor access grant gives it.
    const grant = await inScope(db.migrator, tenant, (trx) => sql<{ id: string }>`
      insert into user_ms_role (user_id, management_system_id, role, approval_status, is_primary, valid_until)
      select ${guestId}::uuid, m.id, 'external_auditor', 'active', false, now() + interval '30 days' from management_system m where m.slug = 'isms'
      returning id`.execute(trx));
    try {
      await withIsmsGrants({
        ends: ['wulan', 'ratna', 'maya'],
        adds: [['staff01', 'top_management'], ['staff02', 'top_management'], ['ext.auditor', 'domain_owner']],
      }, async () => {
        const { firstRole, active, counts } = await ismsRoles();
        // The guest is an active holder of the system, under the external auditor role only (a guest's other grants
        // give nothing, as the role resolver decides).
        expect(active.has('ext.auditor')).toBe(true);
        expect(firstRole.get('ext.auditor')).toBe('external_auditor');
        expect(counts.has('external_auditor')).toBe(false);
        expect(counts.get('domain_owner')).toBeGreaterThanOrEqual(2);
        const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
        const aggregate = (await hendra.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
        expect(sorted(aggregate)).toEqual(await expectedAggregate('hendra'));
        expect(aggregate.some((r) => r.group || r.role === 'ms_manager' || r.role === 'external_auditor')).toBe(false);
        const top = workOf(['hendra']);
        for (const [stage, open] of top) expect(aggregate.find((r) => r.stage === stage && r.role === 'top_management'), stage).toMatchObject({ open, holders: 3 });
        // The Domain Owners' holders do not count the guest either.
        for (const row of aggregate.filter((r) => r.role === 'domain_owner')) expect(row.holders).toBe(counts.get('domain_owner'));
        const rinaWork = workOf(['rina']);
        expect([...rinaWork.values()].reduce((n, v) => n + v, 0)).toBeGreaterThan(0);
        const unassigned = workOf([...new Set(full.bundle.chain.items.map((i) => i.h))].filter((h) => !['domain_owner', 'top_management'].includes(firstRole.get(h) ?? '')));
        for (const [stage, open] of unassigned) expect(aggregate.find((r) => r.stage === stage && r.role === null)?.open, stage).toBe(open);
      });
    } finally {
      await inScope(db.migrator, tenant, (trx) => sql`update user_ms_role set deleted_at = now() where id = ${grant.rows[0]!.id}::uuid`.execute(trx));
      await inScope(db.migrator, scope, (trx) =>
        sql`delete from platform.org_membership where organization_id = ${ORG_IDS.ndt}::uuid and user_id = ${guestId}::uuid`.execute(trx));
    }
  });

  it('counts no holder whose membership is disabled, although the business roles stay (M3-14)', async () => {
    // The Management System Manager reads the totals (audit.pending.aggregate). A Domain Owner leaves: the role keeps
    // its row with one holder less, and the leaver's open work stays under the role.
    const before = (await rina.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
    const holdersOf = (rows: PendingAggregate[]) => rows.find((r) => r.role === 'domain_owner')!.holders;
    const leaverId = await userId(db, 'dewi');
    await inScope(db.migrator, { platformScope: true }, (trx) =>
      sql`update platform.org_membership set status = 'disabled' where user_id = ${leaverId}::uuid and organization_id = ${ORG_IDS.ndt}::uuid`.execute(trx));
    try {
      const after = (await rina.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
      expect(holdersOf(after)).toBe(holdersOf(before)! - 1);
      expect(sorted(after)).toEqual(await expectedAggregate('rina'));
      // The open work stays where it was: the same rows and counts, only the holder count changes.
      const counted = (rows: PendingAggregate[]) => sorted(rows).map((r) => ({ ...r, holders: undefined }));
      expect(counted(after)).toEqual(counted(before));
      const roleRow = await inScope(db.migrator, { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true }, (trx) => sql<{ n: number }>`
        select count(*)::int as n from user_ms_role where user_id = ${leaverId}::uuid and deleted_at is null`.execute(trx));
      expect(roleRow.rows[0]!.n).toBeGreaterThan(0);
    } finally {
      await inScope(db.migrator, { platformScope: true }, (trx) =>
        sql`update platform.org_membership set status = 'active' where user_id = ${leaverId}::uuid and organization_id = ${ORG_IDS.ndt}::uuid`.execute(trx));
    }
  });

  it('a leaver who was the only holder of a role: the role merges, and a group of fewer than two people joins the unassigned row (M3-14, decision 21)', async () => {
    // With Top Management alone in "Other roles" (the other one-holder roles ended), hendra leaving makes the group
    // empty: his open work joins the unassigned row, and no row names his role.
    await withIsmsGrants({ ends: ['wulan', 'ratna', 'maya'] }, async () => {
      const leaverId = await userId(db, 'hendra');
      await inScope(db.migrator, { platformScope: true }, (trx) =>
        sql`update platform.org_membership set status = 'disabled' where user_id = ${leaverId}::uuid and organization_id = ${ORG_IDS.ndt}::uuid`.execute(trx));
      try {
        const aggregate = (await rina.get<PendingAggregate[]>('/api/v1/ms/isms/audit/pending?aggregate=unit')).body;
        expect(sorted(aggregate)).toEqual(await expectedAggregate('rina'));
        expect(aggregate.some((r) => r.group || r.role === 'top_management' || r.role === 'ms_manager')).toBe(false);
      } finally {
        await inScope(db.migrator, { platformScope: true }, (trx) =>
          sql`update platform.org_membership set status = 'active' where user_id = ${leaverId}::uuid and organization_id = ${ORG_IDS.ndt}::uuid`.execute(trx));
      }
    });
  });

  it('gives Top Management no holder names or due dates of other people on stage records, gates, chain and drift (F.7, Q-8)', async () => {
    const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
    const people = (await rina.get<{ holder: string; displayName: string }[]>('/api/v1/ms/isms/audit/pending')).body;
    const others = people.filter((p) => p.holder !== 'hendra' && p.holder !== 'none');
    expect(others.length).toBeGreaterThan(0);
    const leaks = (body: unknown): string[] => {
      const text = JSON.stringify(body);
      return others.flatMap((p) => [`"${p.holder}"`, p.displayName].filter((needle) => text.includes(needle)));
    };
    const stages = (await hendra.get<StageReadiness[]>('/api/v1/ms/isms/audit/stages')).body;
    expect(stages.length).toBeGreaterThan(0);
    let records = 0;
    for (const stage of stages) {
      const page = await hendra.all<PendingRecord>(`/api/v1/ms/isms/audit/stages/${stage.key}/records`);
      records += page.total;
      expect({ stage: stage.key, leaks: leaks(page.items) }).toEqual({ stage: stage.key, leaks: [] });
      for (const r of page.items) if (r.holder?.handle !== 'hendra') expect({ dueAt: r.dueAt, daysToDue: r.daysToDue }).toEqual({ dueAt: null, daysToDue: null });
      const named = await hendra.get<{ total: number }>(`/api/v1/ms/isms/audit/stages/${stage.key}/records?owner=${others[0]!.holder}`);
      expect({ stage: stage.key, total: named.body.total }).toEqual({ stage: stage.key, total: 0 });
    }
    expect(records).toBeGreaterThan(0);
    const gates = (await hendra.get<GateItemView[]>('/api/v1/ms/isms/gates')).body;
    expect(gates.length).toBeGreaterThan(0);
    expect(leaks(gates)).toEqual([]);
    for (const chain of org.CHAINS.isms ?? []) {
      const response = await hendra.get<ChainResponse>(`/api/v1/ms/isms/audit/chain?anchor_id=${encodeURIComponent(chain.id)}`);
      if (response.status !== 200) continue;
      expect({ chain: chain.id, leaks: leaks(response.body) }).toEqual({ chain: chain.id, leaks: [] });
    }
    const r014 = (await hendra.get<ChainResponse>('/api/v1/ms/isms/audit/chain?anchor_id=R-014')).body;
    expect(r014.nodes.some((n) => !('hidden' in n) && n.id !== null)).toBe(true);
    expect(leaks(r014)).toEqual([]);
    const drift = (await hendra.get<DriftPattern[]>('/api/v1/ms/isms/surveillance/drift')).body;
    expect(drift.some((p) => p.rows.length > 0)).toBe(true);
    expect(leaks(drift)).toEqual([]);
    expect(leaks((await hendra.get('/api/v1/ms/isms/surveillance/cycle')).body)).toEqual([]);
    const nextId = (await hendra.get<{ id: string }>('/api/v1/ms/isms/audit/event/next')).body.id;
    expect(leaks((await hendra.get(`/api/v1/ms/isms/surveillance/events/${nextId}`)).body)).toEqual([]);
  });

  it('gives an external auditor no holders, no pending data and evidence only through ready packs (D-34)', async () => {
    const packed = await inScope(db.migrator, { orgId: ORG_IDS.tst, schema: 'org_tst', platformScope: true }, async (trx) => {
      const ms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow();
      const ev = await sql<{ id: string; evidence_code: string }>`
        select e.id, e.evidence_code from evidence e join evidence_target t on t.evidence_id = e.id
        where t.management_system_id = ${ms.id} order by e.position limit 1`.execute(trx);
      const evidence = ev.rows[0]!;
      const pack = await trx.insertInto('evidence_pack').values({ management_system_id: ms.id, status: 'ready', item_count: 1 }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('evidence_pack_item').values({ evidence_pack_id: pack.id, evidence_id: evidence.id, evidence_code: evidence.evidence_code, requirement_codes: ['A.5.1'] }).execute();
      return evidence.evidence_code;
    });
    const auditor = await screenClient(ctx, db, 'ext.auditor', 'tst');
    const evidence = pageOf(EvidenceItem).parse((await auditor.get('/api/v1/ms/isms/evidence')).body);
    expect(evidence.items.map((e) => e.code)).toEqual([packed]);
    expect(evidence.items[0]).not.toHaveProperty('owner');
    const reqs = await auditor.all<ApplicabilityItem>('/api/v1/ms/isms/applicability');
    expect(reqs.total).toBe(93);
    expect(reqs.items.every((r) => !('owner' in r))).toBe(true);
    expect((await auditor.get('/api/v1/ms/isms/gates')).body).toEqual([]);
    expect((await auditor.get('/api/v1/ms/isms/phases/4/activities')).body).toEqual([]);
    expect((await auditor.get('/api/v1/ms/isms/surveillance/cycle')).body).toEqual([]);
    expect((await auditor.get('/api/v1/ms/isms/surveillance/drift')).body).toEqual([]);
    expect((await auditor.get<{ total: number }>('/api/v1/ms/isms/audit/stages/risk/records')).body.total).toBe(0);
    expect((await auditor.get('/api/v1/ms/isms/audit/pending')).status).toBe(403);
    const chain = (await auditor.get<ChainResponse>('/api/v1/ms/isms/audit/chain?anchor_id=A.8.13')).body;
    for (const node of chain.nodes) if (!('hidden' in node)) expect({ holder: node.holder, due: node.due }).toEqual({ holder: null, due: null });
    expect(chain.nodes.some((n) => 'hidden' in n)).toBe(true);
    const nextId = (await auditor.get<{ id: string }>('/api/v1/ms/isms/audit/event/next')).body.id;
    const event = (await auditor.get<SurveillanceEvent>(`/api/v1/ms/isms/surveillance/events/${nextId}`)).body;
    expect(event.prep).toEqual([]);
    const documents = await auditor.all<DocumentItem>('/api/v1/ms/isms/documents');
    expect(documents.items.every((d) => !('owner' in d) && !('path' in d))).toBe(true);
  });

  it('answers 404 for unknown systems and systems of another organisation, 401 without a session', async () => {
    const rmn = await screenClient(ctx, db, 'rina', 'rmn');
    expect((await rmn.get('/api/v1/ms/qms/implementation/summary')).status).toBe(404);
    expect((await rina.get('/api/v1/ms/nope/evidence')).status).toBe(404);
    expect((await rina.get('/api/v1/ms/isms/phases/99/activities')).status).toBe(404);
    expect((await rina.get('/api/v1/ms/isms/audit/stages/nope/records')).status).toBe(404);
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/ms/isms/implementation/summary' });
    expect(response.statusCode).toBe(401);
  });
});
