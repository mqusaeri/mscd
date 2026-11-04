// Erasure receipts and their re-apply after a restore (Milestone 3 D.6.5, M3-13 after ISO M4), on two copies of the
// demo template: the first is the live database, the second stands for a database restored from a backup taken
// before the erasure (the same person, membership and request, as the backup held them). Covers: the receipt names no
// person; the erasure queues an `org.lifecycle` run, which signs the receipt with the anchor key and emails it to every
// platform operator and every active Tenant Admin once, in single tenancy (no hourly schedule of that job there) and in
// multi tenancy (the SaaS run); the daily `privacy.deadlines` run of the organisation sends a receipt whose first send
// failed; `tenant erasure --reapply` refuses a receipt with a changed byte and
// one of another organisation, reports the open items the restored person still holds, erases the person again with
// the receipt's pseudonym (audited `privacy_request.erased` with `reapplied: true`, the receipt kept as sent), skips a
// person already erased, and names the request of a person without an account that the restored copy does not hold;
// `tenant erasure --print-receipts` prints the signed receipt as the email attaches it; two runs that overlap email a
// receipt once. Invented people only (R-19).
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '@mscd/shared';
import { formatPrintedReceipts, tenantErasureReapply, tenantErasureReceipts } from '../../../src/cli/tenant';
import { MscdConfig } from '../../../src/config/mscd-config';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { loadAnchorSigningKey } from '../../../src/modules/jobs/audit-verify-chain.job';
import { DeletionMailer } from '../../../src/modules/ops/deletion/deletion-mailer';
import { ErasureReceiptSender } from '../../../src/modules/ops/deletion/erasure-receipts';
import { OrgLifecycleJob } from '../../../src/modules/ops/deletion/org-lifecycle.job';
import {
  ERASURE_RECEIPT_TYPE, receiptFileText, signReceipt, verifyReceiptText, type ErasureReceipt,
} from '../../../src/modules/privacy/erasure-receipt';
import { PrivacyDeadlinesJob } from '../../../src/modules/privacy/privacy-deadlines.job';
import { testTenancy } from '../../setup/tenancy';
import { useTestDatabase, type TestDatabase } from '../../setup/test-db';
import { startMailpit, type Mailpit } from '../identity/helpers';
import {
  createPrivacyApp, inventedMember, ORG_IDS, platformRows, primaryManagers, rowsOf, signIn, type Client, type DemoOrg, type PrivacyApp,
} from './helpers';

const REQUESTS = '/api/v1/admin/privacy-requests';
const REQUEST = (id: string) => `${REQUESTS}/${id}`;
const CHECKS = (ms: string) => `/api/v1/ms/${ms}/privacy-checks`;
const ORG: DemoOrg = 'ndt';
const PERSON = { handle: 'nadia.kurniawan', displayName: 'Nadia Kurniawan', email: 'nadia.kurniawan@nusantaradigital.co.id', jobTitle: 'Buyer' };

describe('erasure receipts and their re-apply after a restore (D.6.5, M3-13)', () => {
  const db = useTestDatabase('demo');
  const restored = useTestDatabase('demo');
  let mail: Mailpit;
  let ctx: PrivacyApp;
  let later: PrivacyApp;
  let rina: Client;
  let folder: string;
  let trusted: { keyId: string; publicKeyPem: string }[];
  let member: string;
  let request: { id: string; requestNo: string };
  let receiptFile: string;
  let pseudonym: string;

  const mailEnv = () => ({ MSCD__MAIL__SMTP__HOST: mail.host, MSCD__MAIL__SMTP__PORT: String(mail.smtpPort) });
  const reapply = (file: string, confirm = ORG) =>
    tenantErasureReapply(restored.config(), { reapply: file, confirm }, later.moduleRef as unknown as INestApplicationContext, trusted);

  beforeAll(async () => {
    mail = await startMailpit();
    ctx = await createPrivacyApp(db, undefined, mailEnv());
    later = await createPrivacyApp(restored, undefined, mailEnv());
    rina = await signIn(ctx, db, 'rina', ORG);
    folder = await mkdtemp(path.join(os.tmpdir(), 'mscd-m3-13-receipts-'));
    const key = loadAnchorSigningKey(ctx.moduleRef.get(MscdConfig))!;
    trusted = [{ keyId: key.keyId, publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
    await later?.close();
    await mail?.stop();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  /** The person, the membership and the erasure request in progress, in a database (the restored copy holds the same). */
  async function seedPerson(target: TestDatabase, ids?: { member: string; request: { id: string; requestNo: string } }): Promise<string> {
    if (!ids) return inventedMember(target, ORG, PERSON);
    await platformRows(target, sql`
      insert into platform.app_user (id, handle, email, display_name, job_title, kind, status)
      values (${ids.member}::uuid, ${PERSON.handle}, ${PERSON.email}, ${PERSON.displayName}, ${PERSON.jobTitle}, 'person', 'active') returning id`);
    await platformRows(target, sql`
      insert into platform.org_membership (organization_id, user_id, status, admin_roles) values (${ORG_IDS[ORG]}::uuid, ${ids.member}::uuid, 'active', '{}') returning user_id`);
    await rowsOf(target, ORG, sql`
      insert into privacy_request (id, request_no, request_type, status, subject_kind, subject_user_id, subject_name, subject_email, channel, received_at, due_at)
      values (${ids.request.id}::uuid, ${ids.request.requestNo}, 'erasure', 'in_progress', 'member', ${ids.member}::uuid, ${PERSON.displayName}, ${PERSON.email},
              'email', now() - interval '1 hour', now() + interval '71 hours') returning id`);
    // An audit entry where the person acted, as the backup holds it.
    await rowsOf(target, ORG, sql`
      insert into audit_trail (organization_id, actor_user_id, actor_kind, action, entity_type, entity_id, entity_code, after_data, source_ip)
      values (${ORG_IDS[ORG]}::uuid, ${ids.member}::uuid, 'user', 'user.updated', 'user', ${ids.member}::uuid, ${PERSON.handle},
              ${JSON.stringify({ email: PERSON.email, displayName: PERSON.displayName })}::jsonb, '192.0.2.20'::inet) returning seq`);
    return ids.member;
  }

  it('queues a run that signs the receipt with the anchor key and emails it once to the platform operators and the Tenant Admins', async () => {
    member = await seedPerson(db);
    const recorded = await rina.post<CommandResult>(REQUESTS, { type: 'erasure', subject: { userId: member }, receivedAt: new Date(Date.now() - 3_600_000).toISOString(), channel: 'email' });
    expect(recorded.status, recorded.text).toBe(201);
    request = recorded.body.data as { id: string; requestNo: string };
    expect((await rina.patch(REQUEST(request.id), { action: 'start', identityCheckNote: 'Identity checked by a video call' })).status).toBe(200);
    const managers = await primaryManagers(db, ORG);
    const detail = await rina.get<{ checks: { id: string; ms: string }[] }>(REQUEST(request.id));
    for (const check of detail.body.checks) {
      const manager = await signIn(ctx, db, managers.get(check.ms)!, ORG);
      expect((await manager.post(`${CHECKS(check.ms)}/${check.id}/done`, { note: 'Nothing to change' })).status).toBe(200);
    }
    const erased = await rina.post<CommandResult>(`${REQUEST(request.id)}/erase`, { confirm: true });
    expect(erased.status, erased.text).toBe(200);
    pseudonym = (await rowsOf<{ pseudonym: string }>(db, ORG, sql`select pseudonym from erased_person where erased_user_id = ${member}::uuid`))[0]!.pseudonym;

    // The erasure queued an `org.lifecycle` run when it committed; the worker's handler of that job sends the receipt
    // first, in single tenancy too, where the worker has no hourly schedule of it (worker-runtime.ts).
    const queued = ctx.queue.waitingJobs('org.lifecycle');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.env).toMatchObject({ orgId: null, payload: {} });
    const lifecycle = ctx.moduleRef.get(OrgLifecycleJob);
    await ctx.queue.work('org.lifecycle', { concurrency: 1 }, (job) => lifecycle.handle(job));
    await ctx.queue.drain();
    expect(ctx.queue.completed('org.lifecycle')).toHaveLength(1);
    expect(ctx.queue.failed('org.lifecycle')).toHaveLength(0);
    const [stored] = await rowsOf<{ receipt: ErasureReceipt; signature: string; key_id: string; sent: boolean }>(db, ORG, sql`
      select erasure_receipt as receipt, erasure_receipt_signature as signature, erasure_receipt_key_id as key_id, erasure_receipt_sent_at is not null as sent
        from privacy_request where id = ${request.id}::uuid`);
    expect(stored).toMatchObject({ sent: true, key_id: trusted[0]!.keyId });
    expect(stored!.receipt).toMatchObject({
      type: ERASURE_RECEIPT_TYPE, version: 1, organization: { id: ORG_IDS[ORG], slug: ORG }, request: { id: request.id, number: request.requestNo },
      subjectKind: 'member', erasedUserId: member, pseudonym,
    });
    expect(stored!.receipt.redactionIds.length).toBeGreaterThanOrEqual(2);
    const text = receiptFileText(stored!.receipt, stored!.signature, stored!.key_id);
    expect(text).not.toMatch(/nadia|Nadia|Kurniawan/);
    expect(verifyReceiptText(text, trusted)).toMatchObject({ ok: true });
    receiptFile = path.join(folder, `erasure-receipt-${ORG}-${request.requestNo}.json`);
    await writeFile(receiptFile, text);

    // Every active Tenant Admin of the organisation and every platform operator gets it.
    const recipients = [
      ...(await platformRows<{ email: string }>(db, sql`
        select u.email from platform.org_membership m join platform.app_user u on u.id = m.user_id
         where m.organization_id = ${ORG_IDS[ORG]}::uuid and m.status = 'active' and m.deleted_at is null and 'tenant_admin' = any(m.admin_roles)
           and u.kind = 'person' and u.status = 'active' and u.deleted_at is null`)),
      ...(await platformRows<{ email: string }>(db, sql`
        select u.email from platform.platform_role r join platform.app_user u on u.id = r.user_id
         where r.role = 'platform_operator' and r.revoked_at is null and u.status = 'active' and u.deleted_at is null`)),
    ].map((r) => r.email);
    expect(recipients.length).toBeGreaterThan(0);
    for (const to of recipients) {
      const message = await mail.waitFor(to, (m) => m.mailKind === 'account:erasure_receipt');
      expect(message.subject).toContain(`erasure receipt for request ${request.requestNo}`);
      expect(message.text).toContain('names no person');
      expect(message.text).not.toMatch(/Nadia|Kurniawan/);
    }
    // Sent once: a second run sends nothing.
    expect(await ctx.moduleRef.get(ErasureReceiptSender).run()).toMatchObject({ signed: 0, sent: 0, failed: 0, unsigned: 0 });
    expect(['single', 'multi']).toContain(testTenancy());
  });

  it('refuses a receipt with a changed byte and a receipt of another organisation', async () => {
    const text = await readFile(receiptFile, 'utf8');
    const changed = path.join(folder, 'changed.json');
    await writeFile(changed, text.replace(pseudonym, pseudonym.replace(/.$/, (c) => (c === '0' ? '1' : '0'))));
    await expect(reapply(changed)).rejects.toThrow(/does not verify: the signature does not match the content/);
    // A genuine signature over a receipt that names another organisation.
    const key = loadAnchorSigningKey(ctx.moduleRef.get(MscdConfig))!;
    const other = { ...(JSON.parse(text) as ErasureReceipt), organization: { id: ORG_IDS.bsd, slug: 'bsd' } };
    delete (other as Partial<{ keyId: string; signature: string }>).keyId;
    delete (other as Partial<{ keyId: string; signature: string }>).signature;
    const signed = signReceipt(other, key);
    const foreign = path.join(folder, 'foreign.json');
    await writeFile(foreign, receiptFileText(other, signed.signature, signed.keyId));
    await expect(reapply(foreign)).rejects.toThrow(/names organisation .* and --confirm names ndt/);
  });

  it('erases the person again in a database restored from before the erasure, with the pseudonym of the receipt', async () => {
    await seedPerson(restored, { member, request });
    // The restored person still owns a risk: the re-apply stops with the list.
    const [risk] = await rowsOf<{ id: string; owner: string | null }>(restored, ORG, sql`
      select r.id, r.owner_user_id as owner from risk r where r.deleted_at is null order by r.code limit 1`);
    await rowsOf(restored, ORG, sql`update risk set owner_user_id = ${member}::uuid where id = ${risk!.id}::uuid returning id`);
    const held = await reapply(receiptFile);
    expect(held.status).toBe('open_items');
    expect(held.status === 'open_items' && held.systems.length).toBeGreaterThan(0);
    expect((await rowsOf<{ n: number }>(restored, ORG, sql`select count(*)::int as n from erased_person`))[0]!.n).toBe(0);
    await rowsOf(restored, ORG, sql`update risk set owner_user_id = ${risk!.owner}::uuid where id = ${risk!.id}::uuid returning id`);

    const done = await reapply(receiptFile);
    expect(done).toMatchObject({ status: 'erased', pseudonym, requestNo: request.requestNo });
    expect(await rowsOf(restored, ORG, sql`select pseudonym, privacy_request_id::text as request from erased_person where erased_user_id = ${member}::uuid`))
      .toEqual([{ pseudonym, request: request.id }]);
    const [membership] = await platformRows<{ deleted: boolean }>(restored, sql`
      select deleted_at is not null as deleted from platform.org_membership where organization_id = ${ORG_IDS[ORG]}::uuid and user_id = ${member}::uuid`);
    expect(membership).toEqual({ deleted: true });
    const holding = await rowsOf<{ n: number }>(restored, ORG, sql`
      select count(*)::int as n from audit_trail
       where position(${PERSON.email} in coalesce(entity_code, '') || coalesce(before_data::text, '') || coalesce(after_data::text, '')) > 0
          or position(${PERSON.handle} in coalesce(entity_code, '') || coalesce(before_data::text, '') || coalesce(after_data::text, '')) > 0`);
    expect(holding[0]!.n).toBe(0);
    const [entry] = await rowsOf<{ actor_kind: string; after: Record<string, unknown> }>(restored, ORG, sql`
      select actor_kind, after_data as after from audit_trail where action = 'privacy_request.erased' and entity_id = ${request.id}::uuid`);
    expect(entry).toMatchObject({ actor_kind: 'system', after: { reapplied: true, erased: 1 } });
    // The request records the erasure with the receipt as it was sent, so the worker does not send it again.
    const [stored] = await rowsOf<{ pseudonym: string; sent: boolean; signature: string | null }>(restored, ORG, sql`
      select result->>'pseudonym' as pseudonym, erasure_receipt_sent_at is not null as sent, erasure_receipt_signature as signature
        from privacy_request where id = ${request.id}::uuid`);
    expect(stored).toMatchObject({ pseudonym, sent: true });
    expect(stored!.signature).toMatch(/^ed25519:/);
    expect((await later.moduleRef.get(AuditChainVerifier).verifyTenant({ orgId: ORG_IDS[ORG], schema: `org_${ORG}` })).firstBrokenSeq).toBeNull();

    // The person is erased already: a second run skips them.
    expect(await reapply(receiptFile)).toEqual({ status: 'skipped', reason: 'already_erased', pseudonym });
  });

  it('names the request of a person without an account that the restored copy does not hold', async () => {
    const key = loadAnchorSigningKey(ctx.moduleRef.get(MscdConfig))!;
    const receipt: ErasureReceipt = {
      type: ERASURE_RECEIPT_TYPE, version: 1, receiptId: randomUUID(), organization: { id: ORG_IDS[ORG], slug: ORG },
      request: { id: randomUUID(), number: 'PR-2026-777' }, subjectKind: 'other', erasedUserId: null, pseudonym: 'Former user 9C4E',
      erasedAt: new Date().toISOString(), redactionIds: [randomUUID()],
    };
    const signed = signReceipt(receipt, key);
    const file = path.join(folder, 'other.json');
    await writeFile(file, receiptFileText(receipt, signed.signature, signed.keyId));
    expect(await reapply(file)).toEqual({ status: 'request_missing', requestNo: 'PR-2026-777' });
  });

  it('sends a receipt whose first send failed in the daily privacy.deadlines run of the organisation', async () => {
    // As after a first send that failed before the signature was stored: unsigned and not sent.
    await rowsOf(db, ORG, sql`
      update privacy_request set erasure_receipt_signature = null, erasure_receipt_key_id = null, erasure_receipt_sent_at = null
       where id = ${request.id}::uuid returning id`);
    await mail.clear();
    const deadlines = ctx.moduleRef.get(PrivacyDeadlinesJob);
    const run = await deadlines.run(ORG_IDS[ORG]);
    expect(run?.receipts).toEqual({ signed: 1, sent: 1, failed: 0, unsigned: 0, busy: 0 });
    const [stored] = await rowsOf<{ signature: string | null; key_id: string | null; sent: boolean }>(db, ORG, sql`
      select erasure_receipt_signature as signature, erasure_receipt_key_id as key_id, erasure_receipt_sent_at is not null as sent
        from privacy_request where id = ${request.id}::uuid`);
    expect(stored).toMatchObject({ sent: true, key_id: trusted[0]!.keyId });
    expect(stored!.signature).toMatch(/^ed25519:/);
    const [admin] = await platformRows<{ email: string }>(db, sql`
      select u.email from platform.org_membership m join platform.app_user u on u.id = m.user_id
       where m.organization_id = ${ORG_IDS[ORG]}::uuid and m.status = 'active' and m.deleted_at is null and 'tenant_admin' = any(m.admin_roles)
         and u.kind = 'person' and u.status = 'active' and u.deleted_at is null
       order by u.handle limit 1`);
    const message = await mail.waitFor(admin!.email, (m) => m.mailKind === 'account:erasure_receipt');
    expect(message.subject).toContain(`erasure receipt for request ${request.requestNo}`);
    // Sent once: the next daily run sends nothing.
    expect((await deadlines.run(ORG_IDS[ORG]))?.receipts).toEqual({ signed: 0, sent: 0, failed: 0, unsigned: 0, busy: 0 });
  });

  it('prints the signed receipts of an organisation for an installation without email', async () => {
    const app = ctx.moduleRef as unknown as INestApplicationContext;
    const printed = await tenantErasureReceipts(db.config(), ORG, app);
    expect(printed.unsigned).toEqual([]);
    expect(printed.receipts).toHaveLength(1);
    const [one] = printed.receipts;
    // The same file as the email attaches (Ed25519 signatures are deterministic, so the receipt signed again is equal).
    expect(one).toMatchObject({ requestNo: request.requestNo, fileName: `erasure-receipt-${ORG}-${request.requestNo}.json`, sent: true });
    expect(one!.text).toBe(await readFile(receiptFile, 'utf8'));
    expect(one!.text.split('\n')).toEqual([expect.any(String), '']);
    expect(verifyReceiptText(one!.text, trusted)).toMatchObject({ ok: true, receipt: { pseudonym } });
    expect(formatPrintedReceipts(ORG, printed)).toEqual([
      `tenant erasure --print-receipts: 1 signed erasure receipt(s) of ${ORG}`,
      `  ${request.requestNo}: erasure-receipt-${ORG}-${request.requestNo}.json`,
    ]);
    // A receipt the worker has not signed yet (so not sent either) is named and not printed.
    const [kept] = await rowsOf<{ signature: string; key_id: string; sent_at: Date }>(db, ORG, sql`
      select erasure_receipt_signature as signature, erasure_receipt_key_id as key_id, erasure_receipt_sent_at as sent_at
        from privacy_request where id = ${request.id}::uuid`);
    await rowsOf(db, ORG, sql`
      update privacy_request set erasure_receipt_signature = null, erasure_receipt_key_id = null, erasure_receipt_sent_at = null
       where id = ${request.id}::uuid returning id`);
    const waiting = await tenantErasureReceipts(db.config(), ORG, app);
    expect(waiting).toEqual({ receipts: [], unsigned: [request.requestNo] });
    expect(formatPrintedReceipts(ORG, waiting)[1]).toContain(`1 receipt(s) wait for the signature of the worker (${request.requestNo})`);
    await rowsOf(db, ORG, sql`
      update privacy_request set erasure_receipt_signature = ${kept!.signature}, erasure_receipt_key_id = ${kept!.key_id},
             erasure_receipt_sent_at = ${kept!.sent_at}
       where id = ${request.id}::uuid returning id`);
    await expect(tenantErasureReceipts(db.config(), 'nosuchorg', app)).rejects.toThrow('No organisation with slug nosuchorg');
  });

  it('emails a receipt once when two runs overlap', async () => {
    // A signed receipt that is not sent yet, and a first run whose first email waits until the second run has ended.
    await rowsOf(db, ORG, sql`update privacy_request set erasure_receipt_sent_at = null where id = ${request.id}::uuid returning id`);
    await mail.clear();
    const mailer = ctx.moduleRef.get(DeletionMailer, { strict: false });
    const send = mailer.send.bind(mailer);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const spy = vi.spyOn(mailer, 'send').mockImplementation(async (message) => {
      calls += 1;
      if (calls === 1) await gate;
      return send(message);
    });
    const sender = ctx.moduleRef.get(ErasureReceiptSender);
    try {
      const first = sender.run(undefined, ORG_IDS[ORG]);
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: 10_000 });
      // The second run finds the organisation's receipt lock held and sends nothing.
      expect(await sender.run(undefined, ORG_IDS[ORG])).toEqual({ signed: 0, sent: 0, failed: 0, unsigned: 0, busy: 1 });
      release();
      expect(await first).toEqual({ signed: 0, sent: 1, failed: 0, unsigned: 0, busy: 0 });
    } finally {
      release();
      spy.mockRestore();
    }
    const [admin] = await platformRows<{ email: string }>(db, sql`
      select u.email from platform.org_membership m join platform.app_user u on u.id = m.user_id
       where m.organization_id = ${ORG_IDS[ORG]}::uuid and m.status = 'active' and m.deleted_at is null and 'tenant_admin' = any(m.admin_roles)
         and u.kind = 'person' and u.status = 'active' and u.deleted_at is null
       order by u.handle limit 1`);
    await mail.waitFor(admin!.email, (m) => m.mailKind === 'account:erasure_receipt');
    expect((await mail.messages(admin!.email)).filter((m) => m.mailKind === 'account:erasure_receipt')).toHaveLength(1);
    // And a later run finds nothing to send.
    expect(await sender.run(undefined, ORG_IDS[ORG])).toEqual({ signed: 0, sent: 0, failed: 0, unsigned: 0, busy: 0 });
  });
});
