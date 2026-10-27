// The change summary of a new document version (Milestone 2 D.2, M2-07): `POST /ms/{ms}/documents/{id}/versions`
// stores what changed with the version in review and audits it; a summary over 500 characters is refused. Runs with
// the real storage gateway and the mock SharePoint of the files tests. The new version queues `readiness.recompute`
// and `cycle.derive` (D.6) for the systems of the document.
import type { CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { createFilesApp, inOrg, signIn, startStorageStack, type FilesApp, type FilesClient, type StorageStack } from '../files/helpers';

describe('change summary of a document version (M2-07)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: FilesApp;
  let rina: FilesClient;

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createFilesApp(db, stack.gateway.url);
    rina = await signIn(ctx, db, 'rina', 'ndt');
  });
  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('stores and audits the change summary of a linked version in review', async () => {
    const document = await inOrg(db, 'ndt', (trx) => trx.selectFrom('document').select(['id']).where('doc_code', '=', 'PRC-08').executeTakeFirstOrThrow());
    const url = `/api/v1/ms/isms/documents/${document.id}/versions`;
    const tooLong = await rina.post(url, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-PRC-08', changeSummary: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);

    // The linked SharePoint file carries version 1.3, which the demo already records: rename that one first.
    await inOrg(db, 'ndt', (trx) => sql`update document_version set version_label = '1.2.9' where document_id = ${document.id} and version_label = '1.3'`.execute(trx));
    const send = vi.spyOn(ctx.jobs, 'send');
    const created = await rina.post<CommandResult>(url, { source: 'link', repository: 'sp', externalItemId: 'demo-sp-PRC-08', changeSummary: 'Approval steps of section 3 shortened' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const systems = await inOrg(db, 'ndt', async (trx) =>
      (await sql<{ id: string }>`
        select m.id from management_system m where m.deleted_at is null and m.status <> 'archived'
           and ((select is_org_wide from document where id = ${document.id})
                or exists (select 1 from entity_ms_link l where l.entity_type = 'document' and l.entity_id = ${document.id}
                             and l.management_system_id = m.id and l.deleted_at is null))`.execute(trx)).rows.map((r) => r.id));
    expect(systems.length).toBeGreaterThan(0);
    const derived = (send.mock.calls as unknown as [string, { payload: { msId?: string } }][])
      .filter(([name]) => name === 'readiness.recompute' || name === 'cycle.derive')
      .map(([name, env]) => `${name} ${env.payload.msId}`)
      .sort();
    expect(derived).toEqual(systems.flatMap((id) => [`cycle.derive ${id}`, `readiness.recompute ${id}`]).sort());
    send.mockRestore();
    const [stored] = await inOrg(db, 'ndt', async (trx) =>
      (await sql<{ id: string; change_summary: string | null }>`
        select id, change_summary from document_version where document_id = ${document.id} and status = 'in_review' and deleted_at is null`.execute(trx)).rows);
    expect(stored).toMatchObject({ change_summary: 'Approval steps of section 3 shortened' });
    const [audit] = await inOrg(db, 'ndt', async (trx) =>
      (await sql<{ after_data: Record<string, unknown> }>`
        select after_data from audit_trail where entity_id = ${document.id} and action = 'document.version_created' order by seq desc limit 1`.execute(trx)).rows);
    expect(audit?.after_data).toMatchObject({ changeSummary: 'Approval steps of section 3 shortened' });
  });
});
