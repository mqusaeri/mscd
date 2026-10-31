// Removing a member's linked company sign-in (Milestone 3 D.1 `admin.users.identities.remove`, D.9, M3-07): a Tenant
// Admin removes the link of a member for one of this organisation's providers; the sessions signed in through it end
// at once and the other sessions stay; the platform log of the organisation gets `identity.unlinked` with the reason;
// 404 for a non-member, a provider of another organisation and a member without a link through the provider; 403 for a
// person without `user.manage`; the body needs the provider slug and a reason.
import type { CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { startStorageStack, type StorageStack } from '../files/helpers';
import { createReviewApp, insertProvider, linkIdentity, platformRows, providerSession, signIn, userId, type FilesClient, type ReviewApp } from './helpers';

interface Problem {
  errors?: { path: string; message: string }[];
}

describe('admin.users.identities.remove (Milestone 3 D.9)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: ReviewApp;
  let admin: FilesClient;
  let bagus: FilesClient;
  let providerId = '';
  let otherProvider = '';

  const remove = (client: FilesClient, user: string, body: Record<string, unknown>) =>
    client.post<CommandResult & Problem>(`/api/v1/admin/users/${user}/identities/remove`, body);
  const openSession = async (idHash: string) =>
    (await platformRows<{ revoked_at: Date | null; revoke_reason: string | null }>(db, sql`select revoked_at, revoke_reason from platform.session where id_hash = decode(${idHash}, 'hex')`))[0]!;

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createReviewApp(db, stack.gateway.url);
    admin = await signIn(ctx as never, db, 'tenant.admin', 'tst');
    bagus = await signIn(ctx as never, db, 'bagus', 'tst');
    providerId = await insertProvider(db, 'tst', 'tst-entra');
    otherProvider = await insertProvider(db, 'ndt', 'ndt-entra');
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('removes the link, ends the sessions signed in through it and logs identity.unlinked', async () => {
    await linkIdentity(db, providerId, bagus.userId, 'entra-bagus-1');
    await linkIdentity(db, providerId, bagus.userId, 'entra-bagus-2');
    const viaProvider = await providerSession(ctx, 'tst', bagus.userId, providerId);
    const answer = await remove(admin, bagus.userId, { provider: 'tst-entra', reason: 'Left the project team' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, count: 1, data: { provider: 'tst-entra', subjects: 2, sessionsEnded: 1 } });
    expect(answer.body.message?.[0]).toBe('Linked sign-in through Sign in with tst-entra removed; 1 session(s) signed in through it ended');
    expect(await platformRows(db, sql`select subject from platform.user_identity where identity_provider_id = ${providerId}`)).toEqual([]);
    expect(await openSession(viaProvider)).toMatchObject({ revoked_at: expect.any(Date), revoke_reason: 'identity_unlinked' });
    // bagus's password session stays open.
    expect((await bagus.get('/api/v1/me')).status).toBe(200);
    const log = await platformRows<{ organization_id: string; actor_user_id: string; entity_code: string; after_data: Record<string, unknown> }>(
      db, sql`select organization_id, actor_user_id, entity_code, after_data from platform.audit_log where action = 'identity.unlinked' order by seq`,
    );
    expect(log).toEqual([expect.objectContaining({
      organization_id: '00000000-0000-4000-8000-00000000a004', actor_user_id: admin.userId, entity_code: 'bagus',
      after_data: expect.objectContaining({ provider: 'tst-entra', subjects: ['entra-bagus-1', 'entra-bagus-2'], reason: 'Left the project team', sessionsRevoked: 1 }),
    })]);
  });

  it('answers 404 without a link, for a provider of another organisation and for a non-member; 400 and 403 as the contract says', async () => {
    expect((await remove(admin, bagus.userId, { provider: 'tst-entra', reason: 'Left the project team' })).status).toBe(404);
    await linkIdentity(db, otherProvider, bagus.userId, 'ndt-bagus');
    expect((await remove(admin, bagus.userId, { provider: 'ndt-entra', reason: 'Left the project team' })).status).toBe(404);
    expect(await platformRows(db, sql`select subject from platform.user_identity where identity_provider_id = ${otherProvider}`)).toEqual([{ subject: 'ndt-bagus' }]);
    const sari = await userId(db, 'sari');
    await linkIdentity(db, providerId, sari, 'entra-sari');
    expect((await remove(admin, sari, { provider: 'tst-entra', reason: 'Not a member here' })).status).toBe(404);
    expect((await remove(admin, bagus.userId, { provider: 'tst-entra' })).status).toBe(400);
    expect((await remove(admin, bagus.userId, { provider: 'Tst-Entra', reason: 'Left the project team' })).status).toBe(400);
    expect((await remove(bagus, admin.userId, { provider: 'tst-entra', reason: 'Not allowed' })).status).toBe(403);
  });
});
