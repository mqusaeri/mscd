// The organisation part of an access review as evidence (Milestone 3 D.9, M3-14, ISO review m1) with a real storage
// gateway on SeaweedFS and the mock providers. "Complete" needs an evidence item for the organisation part (422
// `access_reviews.evidence_required` without one) and files its rows (memberships, admin roles, linked company
// sign-in) with the summary and the warnings of the whole review as a new file of that item; each system's rows go to
// the item named at its sign-off as before, only that system's rows. In the Test Organisation (`tst`, with a Managed
// Vault) the two parts name two items; in a third demo organisation (`rmn`) whose Managed Vault is taken away for the
// test and whose evidence goes to the mock SharePoint, the organisation part is still filed and the report is kept only
// there. The decisions
// and sign-offs that the other access review tests drive through the routes are written here directly, so each case
// reaches "Complete" in one step. The evidence items offered at "Complete" show their title only where the Tenant
// Admin reads the system, or for the evidence of access control (A.5.15, A.5.18, A.8.2).
import type { AccessReviewDetail, CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID } from '../../../src/common/tokens';
import { useTestDatabase } from '../../setup/test-db';
import { startStorageStack, type StorageStack } from '../files/helpers';
import { createReviewApp, inOrg, platformRows, rowsOf, signIn, type DemoOrg, type FilesClient, type ReviewApp } from './helpers';

const ADMIN = '/api/v1/admin/access-reviews';

interface Completed extends CommandResult {
  data: { filed: { ms: string; evidenceCode: string }[]; organisation: { ms: string; evidenceCode: string }; reportStored: boolean };
}

describe('the organisation part of an access review as evidence (M3-14)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: ReviewApp;

  /** An active Tenant Admin of a demo organisation, signed in, with their handle. */
  async function tenantAdmin(org: DemoOrg): Promise<FilesClient & { handle: string }> {
    const [admin] = await platformRows<{ handle: string }>(db, sql`
      select u.handle from platform.org_membership m join platform.app_user u on u.id = m.user_id
       where m.organization_id = (select id from platform.organization where slug = ${org}) and m.status = 'active' and m.deleted_at is null
         and 'tenant_admin' = any(m.admin_roles) and u.status = 'active' and u.kind = 'person'
       order by u.handle limit 1`);
    expect(admin, `a Tenant Admin of ${org}`).toBeTruthy();
    return Object.assign(await signIn(ctx as never, db, admin!.handle, org), { handle: admin!.handle });
  }

  /**
   * The open review of the organisation (the demo data may hold one), or a new one, with every decision ("keep") and
   * every system sign-off written, optionally into an evidence item.
   */
  async function readyReview(org: DemoOrg, admin: FilesClient, systemEvidence: Record<string, string> = {}): Promise<string> {
    const open = (await admin.get<{ id: string; status: string }[]>(ADMIN)).body.find((r) => r.status === 'open');
    let id = open?.id;
    if (!id) {
      const started = await admin.post<CommandResult & { data: { id: string } }>(ADMIN, {});
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      id = started.body.data.id;
    }
    // Nobody decides on their own access: the admin's own items are decided by the system account here.
    await rowsOf(db, org, sql`update access_review_item
                                 set decision = 'keep', decided_at = now(),
                                     decided_by = case when subject_user_id = ${admin.userId}::uuid then ${SYSTEM_USER_ID}::uuid else ${admin.userId}::uuid end
                               where access_review_id = ${id} and decision is null returning id`);
    await rowsOf(db, org, sql`
      update access_review_part p set status = 'signed_off', signed_off_by = ${admin.userId}, signed_off_at = now(),
             evidence_id = (${JSON.stringify(systemEvidence)}::jsonb ->> m.slug)::uuid
        from management_system m
       where p.access_review_id = ${id} and m.id = p.management_system_id returning p.id`);
    return id;
  }

  /** The current file of an evidence item and its file count. */
  const evidenceFile = async (org: DemoOrg, id: string) =>
    (await rowsOf<{ storage_object_id: string | null; file_sequence: number; evidence_code: string; repository: string | null }>(db, org, sql`
      select e.storage_object_id, e.file_sequence, e.evidence_code, r.slug as repository from evidence e
        left join storage_object o on o.id = e.storage_object_id left join storage_repository r on r.id = o.storage_repository_id
       where e.id = ${id}`))[0]!;

  /** Evidence items of a system that are not restricted, by code. */
  const evidenceOf = (org: DemoOrg, ms: string) =>
    rowsOf<{ id: string; evidence_code: string }>(db, org, sql`
      select e.id, e.evidence_code from evidence e
        join entity_ms_link l on l.entity_type = 'evidence' and l.entity_id = e.id and l.deleted_at is null
        join management_system m on m.id = l.management_system_id and m.slug = ${ms}
       where e.deleted_at is null and e.classification <> 'restricted' order by e.evidence_code`);

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createReviewApp(db, stack.gateway.url);
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('refuses "Complete" without an evidence item, and files the organisation part and the system rows in their own items', async () => {
    const admin = await tenantAdmin('tst');
    const items = await evidenceOf('tst', 'isms');
    expect(items.length).toBeGreaterThanOrEqual(2);
    const [systemItem, orgItem] = [items[0]!, items[1]!];
    const id = await readyReview('tst', admin, { isms: systemItem.id });

    const open = (await admin.get<AccessReviewDetail>(`${ADMIN}/${id}`)).body;
    expect(open.evidenceOptions!.map((o) => o.id)).toEqual(expect.arrayContaining([systemItem.id, orgItem.id]));
    // This Tenant Admin also manages the ISMS, so every item of it shows its title.
    expect(open.evidenceOptions!.every((o) => typeof o.title === 'string' && o.ms.length > 0)).toBe(true);
    for (const body of [{}, { ms: 'isms' }, { evidenceId: orgItem.id }]) {
      const refused = await admin.post<{ messageKey?: string; messages?: { en: string; id: string } }>(`${ADMIN}/${id}/complete`, body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect(refused.body.messageKey).toBe('access_reviews.evidence_required');
      expect(refused.body.messages?.id).toContain('Pilih item bukti untuk bagian organisasi');
    }
    // An item of another system named through this one is not found.
    expect((await admin.post(`${ADMIN}/${id}/complete`, { ms: 'qms', evidenceId: orgItem.id })).status).toBe(404);
    expect((await admin.get<AccessReviewDetail>(`${ADMIN}/${id}`)).body.status).toBe('open');

    const systemBefore = await evidenceFile('tst', systemItem.id);
    const orgBefore = await evidenceFile('tst', orgItem.id);
    const done = await admin.post<Completed>(`${ADMIN}/${id}/complete`, { ms: 'isms', evidenceId: orgItem.id });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({
      filed: [{ ms: 'isms', evidenceCode: systemItem.evidence_code }], organisation: { ms: 'isms', evidenceCode: orgItem.evidence_code }, reportStored: true,
    });

    // Two new files: the organisation part with the summary, and the ISMS rows only.
    const orgAfter = await evidenceFile('tst', orgItem.id);
    const systemAfter = await evidenceFile('tst', systemItem.id);
    expect(orgAfter.file_sequence).toBe(orgBefore.file_sequence + 1);
    expect(systemAfter.file_sequence).toBe(systemBefore.file_sequence + 1);
    const orgText = (await admin.get(`/api/v1/storage/objects/${orgAfter.storage_object_id}/content?ms=isms`)).raw.toString('utf8');
    expect(orgText).toContain(',membership,');
    expect(orgText).toContain(',admin_role,');
    expect(orgText).not.toContain(',business_role,');
    expect(orgText).toContain('summary,value');
    expect(orgText).toMatch(/\r\nitems,\d+\r\n/);
    expect(orgText).toContain(`part_isms,signed off `);
    expect(orgText).toContain(`evidence ${systemItem.evidence_code}`);
    expect(orgText).toContain('report_in_managed_vault,yes');
    const systemText = (await admin.get(`/api/v1/storage/objects/${systemAfter.storage_object_id}/content?ms=isms`)).raw.toString('utf8');
    expect(systemText).toContain(',business_role,');
    expect(systemText).not.toContain(',membership,');
    expect(systemText).not.toContain('summary,value');

    // The organisation part names its item and when it was filed; the completion is audited with it.
    const review = (await admin.get<AccessReviewDetail>(`${ADMIN}/${id}`)).body;
    expect(review.organisationPart).toMatchObject({ status: 'signed_off', evidenceId: orgItem.id, evidenceCode: orgItem.evidence_code, signedOffBy: { handle: admin.handle } });
    expect(review.organisationPart.evidenceFiledAt).not.toBeNull();
    const [audit] = await rowsOf<{ after_data: Record<string, unknown> }>(db, 'tst', sql`
      select after_data from audit_trail where action = 'access_review.completed' and entity_id = ${id}`);
    expect(audit!.after_data).toMatchObject({ organisation: { ms: 'isms', evidenceCode: orgItem.evidence_code }, reportStored: true });
  });

  it('files the organisation part also where the only file repository is the mock SharePoint (no Managed Vault)', async () => {
    // The organisation keeps its files in SharePoint only: its Managed Vault is removed for this case.
    await rowsOf(db, 'rmn', sql`update storage_repository set deleted_at = now() where adapter = 'managed_vault' and deleted_at is null returning id`);
    const vaults = await rowsOf<{ id: string }>(db, 'rmn', sql`select id from storage_repository where adapter = 'managed_vault' and deleted_at is null`);
    expect(vaults).toEqual([]);
    const [system] = await rowsOf<{ slug: string }>(db, 'rmn', sql`select slug from management_system where deleted_at is null order by position, slug limit 1`);
    const ms = system!.slug;
    // Evidence of the system goes to the SharePoint library through the server (pass-through), as the routing allows.
    await inOrg(db, 'rmn', async (trx) => {
      const msId = (await trx.selectFrom('management_system').select('id').where('slug', '=', ms).executeTakeFirstOrThrow()).id;
      const sp = (await trx.selectFrom('storage_repository').select('id').where('slug', '=', 'sp').where('deleted_at', 'is', null).executeTakeFirstOrThrow()).id;
      await trx.updateTable('storage_routing_rule').set({ deleted_at: new Date() })
        .where('management_system_id', '=', msId).where('object_kind', '=', 'evidence').where('classification', 'is', null).where('deleted_at', 'is', null).execute();
      await trx.insertInto('storage_routing_rule').values({ management_system_id: msId, object_kind: 'evidence', storage_repository_id: sp, mode: 'pass_through', priority: 1 }).execute();
    });
    const admin = await tenantAdmin('rmn');
    const id = await readyReview('rmn', admin);
    const [item] = await evidenceOf('rmn', ms);
    expect(item, `an evidence item of ${ms} in rmn`).toBeTruthy();
    const before = await evidenceFile('rmn', item!.id);

    const done = await admin.post<Completed>(`${ADMIN}/${id}/complete`, { ms, evidenceId: item!.id });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({ filed: [], organisation: { ms, evidenceCode: item!.evidence_code }, reportStored: false });
    const after = await evidenceFile('rmn', item!.id);
    expect(after.file_sequence).toBe(before.file_sequence + 1);
    expect(after.repository).toBe('sp');
    const [uploaded] = await rowsOf<{ after_data: Record<string, unknown> }>(db, 'rmn', sql`
      select after_data from audit_trail where action = 'evidence.file_uploaded' and entity_id = ${item!.id} order by seq desc limit 1`);
    expect(uploaded!.after_data).toMatchObject({ source: 'generated', generated: { mimeType: 'text/csv', uploadMode: 'pass_through' } });
    const [stored] = await rowsOf<{ report_object_id: string | null }>(db, 'rmn', sql`select report_object_id from access_review where id = ${id}`);
    expect(stored!.report_object_id).toBeNull();
  });

  it('shows a Tenant Admin without a business role the titles of the access control evidence only, every other item by code', async () => {
    // `tenant.admin` holds no role in the ISMS of tst, so it does not read the ISMS (`ms.read`): record titles are
    // business data. The evidence of A.5.15, A.5.18 and A.8.2 keeps its title, since the access review is its evidence.
    const admin = await signIn(ctx as never, db, 'tenant.admin', 'tst');
    const [roles] = await rowsOf<{ n: number }>(db, 'tst', sql`select count(*)::int as n from user_ms_role where user_id = ${admin.userId} and deleted_at is null`);
    expect(roles!.n).toBe(0);
    const open = (await admin.get<{ id: string; status: string }[]>(ADMIN)).body.find((r) => r.status === 'open');
    let id = open?.id;
    if (!id) {
      const started = await admin.post<CommandResult & { data: { id: string } }>(ADMIN, {});
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      id = started.body.data.id;
    }
    const detail = (await admin.get<AccessReviewDetail>(`${ADMIN}/${id}`)).body;
    const accessControl = new Set((await rowsOf<{ id: string }>(db, 'tst', sql`
      select distinct t.evidence_id as id from evidence_target t
        join management_system m on m.id = t.management_system_id
        join ref.framework_version fv on fv.id = m.framework_version_id
        left join ref.catalogue_item ci on ci.id = t.catalogue_item_id
        left join ref.requirement rq on rq.id = t.requirement_id
       where t.deleted_at is null and fv.pack_id like 'ISO27001%'
         and (ci.item_code in ('A.5.15', 'A.5.18', 'A.8.2') or rq.requirement_code in ('A.5.15', 'A.5.18', 'A.8.2'))`)).map((r) => r.id));
    const options = detail.evidenceOptions!;
    expect(options.some((o) => o.title === null)).toBe(true);
    for (const o of options) expect(o.title === null, `${o.code} title shown`).toBe(!accessControl.has(o.id));
    const proposed = options.find((o) => o.id === detail.organisationPart.suggestedEvidence!.id)!;
    expect(proposed.title).toEqual(expect.any(String));
    // A Tenant Admin who manages the ISMS reads every title of the same review.
    const manager = await tenantAdmin('tst');
    expect(manager.handle).not.toBe('tenant.admin');
    const full = (await manager.get<AccessReviewDetail>(`${ADMIN}/${id}`)).body.evidenceOptions!;
    expect(full.map((o) => o.id)).toEqual(options.map((o) => o.id));
    expect(full.every((o) => typeof o.title === 'string')).toBe(true);
  });
});
