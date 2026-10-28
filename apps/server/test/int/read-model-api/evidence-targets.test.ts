// Evidence targets on the evidence list (MILESTONE-2 M2-11, item 2 of its handoff): a row of `GET /ms/{ms}/evidence`
// carries every live target of the record (`evidence_target`) in every system, with the id that
// `evidence.targets.remove` takes, in target order, when the caller may change the record's targets
// (`evidence.manage`): an MS Manager on every record, a Domain or Risk Owner on own records. Removed targets drop out.
// Internal Auditors, Top Management and external auditors (D-34) get rows without targets.
import { EvidenceItem, pageOf } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { ORG_IDS, createScreenApp, screenClient, userId, type ReadModelApp, type ScreenClient } from './helpers';

const NDT = { orgId: ORG_IDS.ndt, schema: 'org_ndt', platformScope: true } as const;
const TST = { orgId: ORG_IDS.tst, schema: 'org_tst', platformScope: true } as const;

interface TargetRow {
  id: string;
  ms: string;
  targetType: 'catalogue_item' | 'requirement';
  code: string;
}

describe('Per-screen read endpoints: evidence targets (M2-11)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  let rina: ScreenClient;

  /** The live targets of an evidence record as the database holds them, in target order. */
  const liveTargets = (code: string) =>
    inScope(db.migrator, NDT, async (trx) => {
      const { rows } = await sql<TargetRow>`
        select t.id, m.slug as ms, t.target_type as "targetType", coalesce(ci.item_code, r.requirement_code) as code
          from evidence_target t
          join evidence e on e.id = t.evidence_id
          join management_system m on m.id = t.management_system_id
          left join ref.catalogue_item ci on ci.id = t.catalogue_item_id
          left join ref.requirement r on r.id = t.requirement_id
         where e.evidence_code = ${code} and e.deleted_at is null and t.deleted_at is null
         order by t.position, t.created_at`.execute(trx);
      return rows;
    });

  /** Adds a target to an evidence record for the first live entry of a system that the record does not serve yet. */
  const addTarget = (code: string, ms: string, targetType: 'catalogue_item' | 'requirement') =>
    inScope(db.migrator, NDT, async (trx) => {
      const column = targetType === 'catalogue_item' ? sql.ref('e.catalogue_item_id') : sql.ref('e.requirement_id');
      const { rows } = await sql<{ id: string; item: string; ms_id: string; evidence_id: string; code: string }>`
        select e.id, ${column} as item, e.management_system_id as ms_id, ev.id as evidence_id,
               coalesce(ci.item_code, r.requirement_code) as code
          from applicability_entry e
          join management_system m on m.id = e.management_system_id and m.slug = ${ms}
          join evidence ev on ev.evidence_code = ${code} and ev.deleted_at is null
          left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
          left join ref.requirement r on r.id = e.requirement_id
         where e.deleted_at is null and ${column} is not null
           and not exists (select 1 from evidence_target t where t.evidence_id = ev.id and t.applicability_entry_id = e.id and t.deleted_at is null)
         order by coalesce(ci.item_code, r.requirement_code)
         limit 1`.execute(trx);
      const entry = rows[0]!;
      const { rows: next } = await sql<{ position: number }>`
        select coalesce(max(position), -1)::int + 1 as position from evidence_target where evidence_id = ${entry.evidence_id}`.execute(trx);
      const inserted = await trx
        .insertInto('evidence_target')
        .values({
          evidence_id: entry.evidence_id, management_system_id: entry.ms_id, applicability_entry_id: entry.id, target_type: targetType,
          catalogue_item_id: targetType === 'catalogue_item' ? entry.item : null, requirement_id: targetType === 'requirement' ? entry.item : null,
          position: next[0]!.position,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: inserted.id, ms, targetType, code: entry.code } satisfies TargetRow;
    });

  const rowOf = async (client: ScreenClient, code: string, ms = 'isms') => {
    const response = await client.get(`/api/v1/ms/${ms}/evidence?q=${encodeURIComponent(code)}&pageSize=50`);
    expect(response.status).toBe(200);
    return pageOf(EvidenceItem).parse(response.body).items.find((i) => i.code === code);
  };

  beforeAll(async () => {
    ctx = await createScreenApp(db);
    rina = await screenClient(ctx, db, 'rina', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('lists every live target of each evidence record with its id, in target order', async () => {
    const all = await rina.all<EvidenceItem>('/api/v1/ms/isms/evidence');
    expect(all.total).toBeGreaterThan(0);
    for (const item of all.items) {
      expect(item.targets, item.code).toBeDefined();
      // The list holds the evidence that serves the system, so each row has a target in it.
      expect(item.targets!.some((t) => t.ms === 'isms'), item.code).toBe(true);
    }
    const row = await rowOf(rina, 'EV-0313');
    expect(row?.targets).toEqual(await liveTargets('EV-0313'));
    expect(row?.targets?.every((t) => /^[0-9a-f-]{36}$/.test(t.id))).toBe(true);
  });

  it('lists a second target in the same system and a target in another system, and drops a removed one', async () => {
    const before = await liveTargets('EV-0313');
    const same = await addTarget('EV-0313', 'isms', 'catalogue_item');
    const other = await addTarget('EV-0313', 'qms', 'requirement');
    const row = await rowOf(rina, 'EV-0313');
    expect(row?.targets).toEqual([...before, same, other]);
    expect(row?.targets?.filter((t) => t.ms === 'isms')).toHaveLength(before.filter((t) => t.ms === 'isms').length + 1);
    // The record is listed in the other system too, with the same targets.
    expect((await rowOf(rina, 'EV-0313', 'qms'))?.targets).toEqual([...before, same, other]);

    await inScope(db.migrator, NDT, (trx) => sql`update evidence_target set deleted_at = now() where id = ${before[0]!.id}::uuid`.execute(trx));
    expect((await rowOf(rina, 'EV-0313'))?.targets).toEqual([...before.slice(1), same, other]);
  });

  it('gives an owner-scoped reader the targets of own records only', async () => {
    const bagus = await screenClient(ctx, db, 'bagus', 'ndt');
    const evs = await bagus.all<EvidenceItem>('/api/v1/ms/isms/evidence');
    expect(evs.total).toBeGreaterThan(0);
    for (const item of evs.items) {
      expect(item.owner).toBe('bagus');
      expect(item.targets, item.code).toEqual(await liveTargets(item.code));
    }
  });

  it('gives an Internal Auditor rows without targets, and the targets of own records once an own grant is added', async () => {
    const maya = await screenClient(ctx, db, 'maya', 'ndt');
    const read = await maya.all<EvidenceItem>('/api/v1/ms/isms/evidence');
    expect(read.total).toBeGreaterThan(0);
    expect(read.items.every((i) => !('targets' in i))).toBe(true);

    // As Domain Owner too, the auditor reads every record (full read scope) and may change the targets of own records
    // only (evidence.manage as an own grant), so only those rows carry targets.
    const code = read.items.find((i) => i.code !== 'EV-0313')!.code;
    const id = await userId(db, 'maya');
    await inScope(db.migrator, NDT, async (trx) => {
      const isms = await trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow();
      await trx.insertInto('user_ms_role').values({ user_id: id, management_system_id: isms.id, role: 'domain_owner' }).execute();
      await sql`update evidence set owner_user_id = ${id}::uuid where evidence_code = ${code} and deleted_at is null`.execute(trx);
    });
    const owner = await screenClient(ctx, db, 'maya', 'ndt');
    const evs = await owner.all<EvidenceItem>('/api/v1/ms/isms/evidence');
    expect(evs.total).toBe(read.total);
    const own = evs.items.find((i) => i.code === code);
    expect(own?.owner).toBe('maya');
    expect(own?.targets).toEqual(await liveTargets(code));
    expect(evs.items.filter((i) => 'targets' in i).map((i) => i.code)).toEqual([code]);
  });

  it('gives Top Management and external auditors evidence rows without targets', async () => {
    const hendra = await screenClient(ctx, db, 'hendra', 'ndt');
    const top = await hendra.all<EvidenceItem>('/api/v1/ms/isms/evidence');
    expect(top.total).toBeGreaterThan(0);
    expect(top.items.every((i) => !('targets' in i))).toBe(true);

    const packed = await inScope(db.migrator, TST, async (trx) => {
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
    expect(evidence.items[0]).not.toHaveProperty('targets');
  });
});
