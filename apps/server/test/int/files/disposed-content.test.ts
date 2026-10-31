// Content removed by an approved disposal (Milestone 3 D.2) on the paths outside the file routes: the evidence pack
// download answers 404 `content_disposed`, `integrity.rehash` never re-hashes such an object, and the link check neither
// plans nor checks it. The file routes (open and content) are covered in files.test.ts.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantJobRunner } from '../../../src/modules/jobs/tenant-job';
import { LinkHealthService } from '../../../src/modules/link-health/link-health.service';
import { TenantResolver } from '../../../src/modules/tenancy/tenant-resolver';
import { useTestDatabase } from '../../setup/test-db';
import { createPackApp, type PackApp } from '../evidence-packs/helpers';
import { NOON, createHealthApp, rows, startProviderStack, type HealthApp, type ProviderStack } from '../jobs-health/helpers';
import { ORG_IDS, inOrg, signIn, userId } from './helpers';

const NDT = ORG_IDS.ndt;

/** Marks the content of storage objects of ndt as removed by an approved disposal. */
async function dispose(db: Parameters<typeof inOrg>[0], ids: string[], by: string): Promise<void> {
  await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_object').set({ content_disposed_at: new Date(NOON), content_disposed_by: by }).where('id', 'in', ids).execute());
}

describe('the evidence pack download of disposed content (D.2)', () => {
  const db = useTestDatabase('demo');
  let ctx: PackApp;

  beforeAll(async () => {
    // The answer comes before any call to the storage gateway, so none runs.
    ctx = await createPackApp(db);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('answers 404 content_disposed for a pack file whose content a disposal removed', async () => {
    const rina = await signIn(ctx, db, 'rina', 'ndt');
    const pack = await inOrg(db, 'ndt', async (trx) => {
      const system = await trx.selectFrom('management_system').select('id').where('slug', '=', 'qms').executeTakeFirstOrThrow();
      const object = await trx.selectFrom('storage_object').select('id').where('deleted_at', 'is', null).orderBy('id').executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('evidence_pack')
        .values({ management_system_id: system.id, status: 'ready', pack_folder: '/Compliance/_packs/QMS/2026-09-29/', manifest_csv_object_id: object.id, built_at: new Date(NOON) })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: row.id, objectId: object.id };
    });
    const url = `/api/v1/ms/qms/evidence-packs/${pack.id}/download?file=manifest_csv`;
    await dispose(db, [pack.objectId], rina.userId);

    const answer = await rina.get<{ messageKey?: string; messages?: Record<string, string> }>(url);
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ messageKey: 'content_disposed', messages: { en: expect.stringMatching(/removed/), id: expect.stringMatching(/dihapus/) } });
    // A file the pack does not have keeps its own answer.
    const archive = await rina.get<{ messageKey?: string }>(`/api/v1/ms/qms/evidence-packs/${pack.id}/download?file=archive`);
    expect(archive.status).toBe(404);
    expect(archive.body.messageKey).not.toBe('content_disposed');
  });
});

describe('integrity.rehash and the link check skip disposed content (D.2)', () => {
  const db = useTestDatabase('demo');
  let stack: ProviderStack;
  let ctx: HealthApp;
  let disposer: string;

  const org = async () => (await ctx.moduleRef.get(TenantResolver).resolveById(NDT))!;

  beforeAll(async () => {
    stack = await startProviderStack();
    ctx = await createHealthApp(db, stack);
    disposer = await userId(db, 'rina');
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('never re-hashes a vault object whose content a disposal removed', async () => {
    // Two vault objects the re-hash would pick first: stored with a computed hash, intact and never re-hashed.
    const candidates = await rows<{ id: string; external_item_id: string }>(
      db,
      'ndt',
      sql`SELECT o.id, o.external_item_id FROM storage_object o JOIN storage_repository r ON r.id = o.storage_repository_id
          WHERE r.adapter = 'managed_vault' AND r.deleted_at IS NULL AND o.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM link_health_result h WHERE h.storage_object_id = o.id AND h.detail->>'check' = 'rehash')
          ORDER BY o.id LIMIT 2`,
    );
    expect(candidates).toHaveLength(2);
    const [gone, kept] = candidates as [(typeof candidates)[0], (typeof candidates)[0]];
    await inOrg(db, 'ndt', (trx) =>
      trx
        .updateTable('storage_object')
        .set({ hash_source: 'computed', hash_algorithm: 'sha256', hash_value: 'a'.repeat(64), link_status: 'intact', link_status_reason: null })
        .where('id', 'in', [gone.id, kept.id])
        .execute(),
    );
    await dispose(db, [gone.id], disposer);

    ctx.gateway.script = (pathName, body) =>
      pathName === '/v1/rehash' ? { matches: true, hashValue: (body as { object: { hashValue: string | null } }).object.hashValue ?? 'a'.repeat(64) } : undefined;
    const before = ctx.gateway.calls.length;
    try {
      await ctx.run('integrity.rehash', { orgId: NDT, payload: {} });
    } finally {
      ctx.gateway.script = null;
    }
    const rehashed = ctx.gateway.calls
      .slice(before)
      .filter((c) => c.path === '/v1/rehash')
      .map((c) => (c.body as { object: { externalItemId: string } }).object.externalItemId);
    expect(rehashed).toContain(kept.external_item_id);
    expect(rehashed).not.toContain(gone.external_item_id);
    const recorded = await rows<{ storage_object_id: string }>(
      db,
      'ndt',
      sql`SELECT storage_object_id FROM link_health_result WHERE detail->>'check' = 'rehash' AND storage_object_id IN (${gone.id}::uuid, ${kept.id}::uuid)`,
    );
    expect(recorded.map((r) => r.storage_object_id)).toEqual([kept.id]);
  });

  it('neither plans nor checks an object whose content a disposal removed', async () => {
    const service = ctx.moduleRef.get(LinkHealthService);
    const due = async () => (await ctx.moduleRef.get(TenantJobRunner).run(await org(), (trx) => service.dueObjects(trx, new Date(NOON)))).map((d) => d.id);
    // Two SharePoint evidence files never checked, so both are due.
    const pair = await rows<{ id: string; external_item_id: string; storage_repository_id: string }>(
      db,
      'ndt',
      sql`SELECT o.id, o.external_item_id, o.storage_repository_id FROM evidence e JOIN storage_object o ON o.id = e.storage_object_id
          JOIN storage_repository r ON r.id = o.storage_repository_id
          WHERE r.slug = 'sp' AND o.link_status = 'intact' AND e.deleted_at IS NULL AND o.deleted_at IS NULL
          ORDER BY o.id LIMIT 2`,
    );
    expect(pair).toHaveLength(2);
    const [gone, kept] = pair as [(typeof pair)[0], (typeof pair)[0]];
    await inOrg(db, 'ndt', (trx) => trx.updateTable('storage_object').set({ last_verified_at: null }).where('id', 'in', [gone.id, kept.id]).execute());
    expect(await due()).toEqual(expect.arrayContaining([gone.id, kept.id]));

    await dispose(db, [gone.id], disposer);
    const after = await due();
    expect(after).toContain(kept.id);
    expect(after).not.toContain(gone.id);

    // A batch planned before the disposal: the check skips the disposed object and asks the provider about the other.
    const before = ctx.gateway.calls.length;
    await ctx.run('link-health.check', { orgId: NDT, payload: { repositoryId: kept.storage_repository_id, storageObjectIds: [gone.id, kept.id] } });
    const asked = ctx.gateway.calls
      .slice(before)
      .filter((c) => c.path === '/v1/stat')
      .map((c) => (c.body as { object: { externalItemId: string } }).object.externalItemId);
    expect(asked).toEqual([kept.external_item_id]);
    // The checked file records its check time; the disposed one is left as it was.
    const checked = await rows<{ id: string; last_verified_at: Date | null }>(
      db,
      'ndt',
      sql`SELECT id, last_verified_at FROM storage_object WHERE id IN (${gone.id}::uuid, ${kept.id}::uuid)`,
    );
    expect(Object.fromEntries(checked.map((r) => [r.id, r.last_verified_at?.toISOString() ?? null]))).toEqual({ [gone.id]: null, [kept.id]: new Date(NOON).toISOString() });
    expect(ctx.queue.failed('link-health.check')).toEqual([]);
  });
});
