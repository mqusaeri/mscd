// What an erasure removes and where (Milestone 3 D.6.5, M3-13 after security review 1 and ISO M3, m7, m8, m9), on a copy
// of the demo template: the name to remove is the name the request recorded, so an erasure is refused when the
// account's display name changed since (409 `privacy.name_changed`) and `me.profile` refuses a new name while the
// person's own erasure request is open (409 `privacy.erasure_pending`); the audit entries are redacted in two sets (the
// person's own entries, the entries about the account, the membership or the person's business roles, and the entries
// of a record a manager edited for the request lose the email, the handle and the name; every other entry holding the
// email or the handle loses those two), so another record whose code equals the person's name keeps it; the erasure of
// a person without an account runs the same
// attested redaction with the name and email the request recorded; `privacy-requests.get` shows what the erasure
// changes and the legal holds on records about the person; a closed request names no person in the checks list; and the
// personal data copy (format v2) holds the mentions of every system and the entries about the account. Invented people
// only (R-19).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult, PrivacyCheckItem, PrivacyRequestDetail } from '@mscd/shared';
import { AuditChainVerifier } from '../../../src/modules/audit/chain-verifier';
import { PERSONAL_DATA_FORMAT, personalDataOf } from '../../../src/modules/exports/personal-data';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { useTestDatabase } from '../../setup/test-db';
import {
  createPrivacyApp, inventedMember, ORG_IDS, platformRows, primaryManagers, rowsOf, signIn, userId, type Client, type DemoOrg, type PrivacyApp,
} from './helpers';

const REQUESTS = '/api/v1/admin/privacy-requests';
const REQUEST = (id: string) => `${REQUESTS}/${id}`;
const CHECKS = (ms: string) => `/api/v1/ms/${ms}/privacy-checks`;
const ORG: DemoOrg = 'ndt';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('erasure scope (Milestone 3 D.6.5, M3-13)', () => {
  const db = useTestDatabase('demo');
  let ctx: PrivacyApp;
  let rina: Client;
  let managers: Map<string, string | null>;
  const clients = new Map<string, Client>();

  const as = async (handle: string): Promise<Client> => {
    let client = clients.get(handle);
    if (!client) {
      client = await signIn(ctx, db, handle, ORG);
      clients.set(handle, client);
    }
    return client;
  };
  const record = async (body: Record<string, unknown>): Promise<{ id: string; requestNo: string }> => {
    const answer = await rina.post<CommandResult>(REQUESTS, body);
    expect(answer.status, answer.text).toBe(201);
    return answer.body.data as { id: string; requestNo: string };
  };
  const detail = async (id: string): Promise<PrivacyRequestDetail> => {
    const answer = await rina.get<PrivacyRequestDetail>(REQUEST(id));
    expect(answer.status, answer.text).toBe(200);
    return answer.body;
  };
  const start = async (id: string): Promise<void> => {
    const answer = await rina.patch(REQUEST(id), { action: 'start', identityCheckNote: 'Identity checked by a video call' });
    expect(answer.status, answer.text).toBe(200);
  };
  const checkAll = async (id: string): Promise<void> => {
    for (const check of (await detail(id)).checks) {
      const manager = await as(managers.get(check.ms)!);
      const done = await manager.post(`${CHECKS(check.ms)}/${check.id}/done`, { note: 'Records checked and edited' });
      expect(done.status, done.text).toBe(200);
    }
  };
  /** Writes an audit entry of the organisation as the migrator (the chain trigger links and hashes it). */
  const entry = async (e: { actor: string; action: string; type: string; id: string; code: string; before?: unknown; after?: unknown }): Promise<string> => {
    const [row] = await rowsOf<{ seq: string }>(db, ORG, sql`
      insert into audit_trail (organization_id, actor_user_id, actor_kind, action, entity_type, entity_id, entity_code, before_data, after_data, source_ip, user_agent)
      values (${ORG_IDS[ORG]}::uuid, ${e.actor}::uuid, 'user', ${e.action}, ${e.type}, ${e.id}::uuid, ${e.code},
              ${e.before === undefined ? null : JSON.stringify(e.before)}::jsonb, ${e.after === undefined ? null : JSON.stringify(e.after)}::jsonb,
              '192.0.2.10'::inet, 'Test browser')
      returning seq::text as seq`);
    return row!.seq;
  };
  const auditRow = async (seq: string) =>
    (await rowsOf<{ entity_code: string | null; text: string; redacted: boolean; source_ip: string | null }>(db, ORG, sql`
      select entity_code, coalesce(entity_code, '') || ' ' || coalesce(before_data::text, '') || ' ' || coalesce(after_data::text, '') as text,
             redaction_id is not null as redacted, host(source_ip) as source_ip
        from audit_trail where seq = ${seq}::bigint`))[0]!;
  const trailHolding = async (value: string) =>
    (await rowsOf<{ n: number }>(db, ORG, sql`
      select count(*)::int as n from audit_trail
       where position(lower(${value}) in lower(coalesce(entity_code, '') || coalesce(before_data::text, '') || coalesce(after_data::text, ''))) > 0`))[0]!.n;
  const platformHolding = async (value: string) =>
    (await platformRows<{ n: number }>(db, sql`
      select count(*)::int as n from platform.audit_log
       where organization_id = ${ORG_IDS[ORG]}::uuid
         and position(lower(${value}) in lower(coalesce(entity_code, '') || coalesce(before_data::text, '') || coalesce(after_data::text, ''))) > 0`))[0]!.n;
  const isms = async () => (await rowsOf<{ id: string }>(db, ORG, sql`select id from management_system where slug = 'isms'`))[0]!.id;

  beforeAll(async () => {
    ctx = await createPrivacyApp(db);
    rina = await as('rina');
    managers = await primaryManagers(db, ORG);
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses to erase a member renamed after the request, and shows the legal holds on records about the person', async () => {
    const member = await inventedMember(db, ORG, { handle: 'yoga.adinata', displayName: 'Yoga Adinata', email: 'yoga.adinata@nusantaradigital.co.id', jobTitle: 'Clerk' });
    const { id } = await record({ type: 'erasure', subject: { userId: member }, receivedAt: new Date().toISOString(), channel: 'email' });
    await start(id);
    await checkAll(id);
    // A lapsed competence record about the person, under a legal hold.
    const [competence] = await rowsOf<{ id: string }>(db, ORG, sql`
      insert into competence_record (user_id, role_title, competence_required, proof_type, valid_until)
      values (${member}::uuid, 'Clerk', 'Filing course', 'training', current_date - 10) returning id`);
    await rowsOf(db, ORG, sql`
      insert into retention_hold (management_system_id, record_class, item_id, reason)
      values (${await isms()}::uuid, 'competence_record', ${competence!.id}::uuid, 'Dispute about the training records') returning id`);
    const shown = await detail(id);
    expect(shown.erasureImpact).toMatchObject({ legalHolds: 1 });
    expect(shown.erasureImpact!.tenantEntries).toBeGreaterThanOrEqual(0);
    // The account is renamed to an ordinary word after the request was recorded.
    await platformRows(db, sql`update platform.app_user set display_name = 'approved' where id = ${member}::uuid returning id`);
    const refused = await rina.post(`${REQUEST(id)}/erase`, { confirm: true });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.messageKey).toBe('privacy.name_changed');
    expect(refused.body.messages.en).toBe('The person\'s name changed after the request was recorded. Check the request with the person, then record a new one.');
    expect((await rowsOf<{ n: number }>(db, ORG, sql`select count(*)::int as n from erased_person where erased_user_id = ${member}::uuid`))[0]!.n).toBe(0);
    // A request that is no erasure in progress has no impact.
    const access = await record({ type: 'access', subject: { userId: await userId(db, 'bagus') }, receivedAt: new Date().toISOString(), channel: 'email' });
    expect((await detail(access.id)).erasureImpact).toBeNull();
  });

  it('refuses a new display name in My account while the person\'s own erasure request is open', async () => {
    await inventedMember(db, ORG, { handle: 'tari.wulandari', displayName: 'Tari Wulandari', email: 'tari.wulandari@nusantaradigital.co.id', jobTitle: 'Analyst' });
    const tari = await as('tari.wulandari');
    expect((await tari.patch('/api/v1/me/profile', { displayName: 'Tari W.' })).status).toBe(204);
    const asked = await tari.post<CommandResult>('/api/v1/me/privacy-requests', { type: 'erasure' });
    expect(asked.status, asked.text).toBe(201);
    const renamed = await tari.patch('/api/v1/me/profile', { displayName: 'Tari Wulan' });
    expect(renamed.status, renamed.text).toBe(409);
    expect(renamed.body.messageKey).toBe('privacy.erasure_pending');
    expect(renamed.body.messages).toEqual({
      en: 'Your name cannot change while your erasure request is open.',
      id: 'Nama Anda tidak dapat diubah selama permintaan penghapusan Anda masih terbuka.',
    });
    // The job title is no name: it still changes.
    expect((await tari.patch('/api/v1/me/profile', { jobTitle: 'Senior Analyst' })).status).toBe(204);
    // Once the request is closed the name changes again.
    const requestId = (asked.body.data as { id: string }).id;
    expect((await rina.patch(REQUEST(requestId), { action: 'withdraw', reason: 'The person withdrew it' })).status).toBe(200);
    expect((await tari.patch('/api/v1/me/profile', { displayName: 'Tari Wulan' })).status).toBe(204);
  });

  it('removes the email and handle from every entry and the name from the person\'s own entries and from a record the manager edited, and keeps another record\'s code', async () => {
    const email = 'pol.member@nusantaradigital.co.id';
    const member = await inventedMember(db, ORG, { handle: 'pol.member', displayName: 'POL-001', email, jobTitle: 'Archivist', role: 'domain_owner' });
    const manager = await as(managers.get('isms')!);
    const documentId = '0f1e2d3c-4b5a-4968-8778-6a5b4c3d2e1f';
    const otherRecord = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    // Another member's entry about the document POL-001: the name of the request is its code, and it stays.
    const docEntry = await entry({ actor: rina.userId, action: 'document.updated', type: 'document', id: documentId, code: 'POL-001', after: { title: 'POL-001 Information security policy' } });
    // The person's own entry, and an entry of another record that holds the email (set b).
    const own = await entry({ actor: member, action: 'test.note', type: 'task', id: otherRecord, code: 'T-1', after: { note: 'POL-001 checked the door log' } });
    const mail = await entry({ actor: rina.userId, action: 'test.contact', type: 'interested_party', id: otherRecord, code: 'IP-9', after: { contact: email, handle: 'pol.member' } });
    // An entry about the person's business role, written by a Tenant Admin (set a, as the personal data copy lists it).
    const [grant] = await rowsOf<{ id: string }>(db, ORG, sql`select id from user_ms_role where user_id = ${member}::uuid`);
    const roleEntry = await entry({ actor: rina.userId, action: 'role.granted', type: 'user_ms_role', id: grant!.id, code: 'pol.member', after: { user: 'pol.member', displayName: 'POL-001', role: 'domain_owner' } });
    // A risk that names the person, which the manager edits for the request (registers.update).
    const [risk] = await rowsOf<{ id: string; code: string }>(db, ORG, sql`
      update risk set description = 'Access reviews are signed by POL-001 each quarter.'
       where id = (select r.id from risk r join entity_ms_link l on l.entity_type = 'risk' and l.entity_id = r.id and l.deleted_at is null
                    join management_system m on m.id = l.management_system_id and m.slug = 'isms'
                    where r.deleted_at is null order by r.code limit 1)
      returning id, code`);
    const riskCreated = await entry({ actor: rina.userId, action: 'risk.updated', type: 'risk', id: risk!.id, code: risk!.code, after: { description: 'Access reviews are signed by POL-001 each quarter.' } });
    const { id, requestNo } = await record({ type: 'erasure', subject: { userId: member }, receivedAt: new Date(Date.now() - 60_000).toISOString(), channel: 'email' });
    const [stored] = await rowsOf<{ updated_at: Date }>(db, ORG, sql`select updated_at from risk where id = ${risk!.id}::uuid`);
    const edited = await manager.patch(`/api/v1/ms/isms/registers/risks/${risk!.id}`, { description: 'Access reviews are signed by the access owner each quarter.' },
      { 'if-match': `W/"${new Date(stored!.updated_at).getTime()}"` });
    expect(edited.status, edited.text).toBe(200);
    await start(id);
    await checkAll(id);
    const impact = (await detail(id)).erasureImpact!;
    expect(impact.tenantEntries).toBeGreaterThanOrEqual(4);
    expect(impact.legalHolds).toBe(0);

    const erased = await rina.post<CommandResult>(`${REQUEST(id)}/erase`, { confirm: true });
    expect(erased.status, erased.text).toBe(200);
    expect(erased.body.message).toEqual([
      `The personal data of the person in ${requestNo} is erased in this organisation`,
      `Data pribadi orang dalam ${requestNo} telah dihapus di organisasi ini`,
    ]);
    const [person] = await rowsOf<{ pseudonym: string }>(db, ORG, sql`select pseudonym from erased_person where erased_user_id = ${member}::uuid`);
    const pseudonym = person!.pseudonym;
    expect(erased.body.data).toMatchObject({ erased: 1 });
    expect((erased.body.data as Record<string, number>).auditEntriesRedacted).toBeGreaterThanOrEqual(4);

    // Another record's code that equals the name is untouched.
    expect(await auditRow(docEntry)).toMatchObject({ entity_code: 'POL-001', redacted: false, source_ip: '192.0.2.10' });
    expect((await auditRow(docEntry)).text).toContain('POL-001 Information security policy');
    // The email and the handle leave every entry of both chains.
    expect(await trailHolding(email)).toBe(0);
    expect(await trailHolding('pol.member')).toBe(0);
    expect(await platformHolding('pol.member')).toBe(0);
    expect((await auditRow(mail)).text).toContain(pseudonym);
    // The name leaves the person's own entry, the entry about the person's business role and the entries of the risk
    // the manager edited.
    for (const seq of [own, roleEntry, riskCreated]) {
      const row = await auditRow(seq);
      expect(row.text).not.toMatch(/POL-001/);
      expect(row.text).toContain(pseudonym);
      expect(row).toMatchObject({ redacted: true, source_ip: null });
    }
    const riskEntries = await rowsOf<{ text: string }>(db, ORG, sql`
      select coalesce(before_data::text, '') || coalesce(after_data::text, '') as text from audit_trail where entity_type = 'risk' and entity_id = ${risk!.id}::uuid`);
    for (const row of riskEntries) expect(row.text).not.toMatch(/POL-001/);
    // Two sets, each under its own attestation; both chains verify.
    const attestations = await rowsOf<{ count: number }>(db, ORG, sql`
      select (after_data->>'count')::int as count from audit_trail where action = 'privacy.audit_redacted' and entity_id = ${id}::uuid order by seq`);
    expect(attestations).toHaveLength(2);
    const verifier = ctx.moduleRef.get(AuditChainVerifier);
    expect((await verifier.verifyTenant({ orgId: ORG_IDS[ORG], schema: `org_${ORG}` })).firstBrokenSeq).toBeNull();
    expect((await verifier.verifyPlatform()).firstBrokenSeq).toBeNull();
    // The receipt names no person and the request keeps the name as entered.
    const [receipt] = await rowsOf<{ receipt: Record<string, unknown> }>(db, ORG, sql`select erasure_receipt as receipt from privacy_request where id = ${id}::uuid`);
    expect(receipt!.receipt).toMatchObject({ type: 'mscd.erasure-receipt', version: 1, subjectKind: 'member', erasedUserId: member, pseudonym, request: { id, number: requestNo } });
    expect(JSON.stringify(receipt!.receipt)).not.toMatch(/POL-001|pol\.member/);
    expect(await detail(id)).toMatchObject({ subject: { name: 'POL-001', email }, result: { erased: 1 }, erasureImpact: null });
  });

  it('erases a person without an account: the email from every entry, the name from the record the manager edited, under the pseudonym of the request', async () => {
    const name = 'Sekar Pratiwi';
    const email = 'sekar.pratiwi@supplier.example';
    const [party] = await rowsOf<{ id: string; code: string; updated_at: Date }>(db, ORG, sql`
      insert into interested_party (code, title, requirements) values ('IP-ERASE-01', 'Packaging supplier', ${`Audit visits are agreed with ${name} (${email}).`})
      returning id, code, updated_at`);
    await rowsOf(db, ORG, sql`
      insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary)
      select 'interested_party', ${party!.id}::uuid, m.id, true from management_system m where m.slug = 'isms' returning id`);
    const partyCreated = await entry({ actor: rina.userId, action: 'interested_party.created', type: 'interested_party', id: party!.id, code: party!.code,
      after: { requirements: `Audit visits are agreed with ${name} (${email}).` } });
    // Another record holds the same words (no edit for the request): it keeps the name; another holds the email.
    const otherId = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901';
    const sameWord = await entry({ actor: rina.userId, action: 'risk.updated', type: 'risk', id: otherId, code: 'R-ERASE', after: { description: `${name} Road warehouse floods in March` } });
    const emailOnly = await entry({ actor: rina.userId, action: 'test.contact', type: 'business_associate', id: otherId, code: 'BA-9', after: { email } });
    const { id, requestNo } = await record({ type: 'erasure', subject: { name, email }, receivedAt: new Date(Date.now() - 60_000).toISOString(), channel: 'letter' });
    const manager = await as(managers.get('isms')!);
    const edited = await manager.patch(`/api/v1/ms/isms/registers/interested-parties/${party!.id}`, { requirements: 'Audit visits are agreed with the supplier quality desk.' },
      { 'if-match': `W/"${new Date(party!.updated_at).getTime()}"` });
    expect(edited.status, edited.text).toBe(200);
    await start(id);
    await checkAll(id);
    expect((await detail(id)).erasureImpact!.tenantEntries).toBeGreaterThanOrEqual(3);
    const erased = await rina.post<CommandResult>(`${REQUEST(id)}/erase`, { confirm: true });
    expect(erased.status, erased.text).toBe(200);
    const [stored] = await rowsOf<{ pseudonym: string | null; receipt: Record<string, unknown> | null }>(db, ORG, sql`
      select result->>'pseudonym' as pseudonym, erasure_receipt as receipt from privacy_request where id = ${id}::uuid`);
    const pseudonym = stored!.pseudonym!;
    expect(pseudonym).toMatch(/^Former user [0-9A-F]{4,8}$/);
    expect(stored!.receipt).toMatchObject({ subjectKind: 'other', erasedUserId: null, pseudonym, request: { id, number: requestNo } });
    // The entries of the edited record show the pseudonym; the email is in no entry.
    const partyEntries = await rowsOf<{ text: string }>(db, ORG, sql`
      select coalesce(entity_code, '') || coalesce(before_data::text, '') || coalesce(after_data::text, '') as text
        from audit_trail where entity_type = 'interested_party' and entity_id = ${party!.id}::uuid`);
    expect(partyEntries.length).toBeGreaterThanOrEqual(2);
    for (const row of partyEntries) expect(row.text).not.toMatch(new RegExp(escape(name)));
    expect((await auditRow(partyCreated)).text).toContain(pseudonym);
    expect(await trailHolding(email)).toBe(0);
    expect((await auditRow(emailOnly)).text).toContain(pseudonym);
    // The entry of another record holding the same words is unchanged.
    expect(await auditRow(sameWord)).toMatchObject({ redacted: false });
    expect((await auditRow(sameWord)).text).toContain(`${name} Road`);
    expect((await ctx.moduleRef.get(AuditChainVerifier).verifyTenant({ orgId: ORG_IDS[ORG], schema: `org_${ORG}` })).firstBrokenSeq).toBeNull();
    expect(await detail(id)).toMatchObject({ result: { erased: 1 }, subject: { name, email } });

    // Closed, the request names no person in the checks list, and the mention search finds nothing.
    expect((await rina.post(`${REQUEST(id)}/close`, { outcome: 'Records edited and audit entries redacted' })).status).toBe(200);
    const list = await manager.get<PrivacyCheckItem[]>(CHECKS('isms'));
    const closed = list.body.find((c) => c.requestNo === requestNo)!;
    expect(closed).toMatchObject({ subject: null, requestClosed: true, status: 'done' });
    expect(JSON.stringify(list.body.filter((c) => c.requestNo === requestNo))).not.toMatch(new RegExp(escape(name)));
    expect((await manager.get(`${CHECKS('isms')}/${closed.id}/mentions`)).body).toEqual({ items: [], truncated: false });
    // A pseudonym of a person without an account is never given again (freePseudonym reads result.pseudonym).
    const taken = await rowsOf<{ n: number }>(db, ORG, sql`select count(*)::int as n from privacy_request where result->>'pseudonym' = ${pseudonym}`);
    expect(taken[0]!.n).toBe(1);
  });

  it('gives the personal data copy in format v2 with the mentions of every system and the entries about the account, without a disposed competence record', async () => {
    const member = await inventedMember(db, ORG, { handle: 'raka.firmansyah', displayName: 'Raka Firmansyah', email: 'raka.firmansyah@nusantaradigital.co.id', jobTitle: 'Engineer', role: 'domain_owner' });
    await rowsOf(db, ORG, sql`
      update risk set description = coalesce(description, '') || ' Escalations go to Raka Firmansyah.'
       where id = (select r.id from risk r where r.deleted_at is null order by r.code limit 1) returning id`);
    const [kept] = await rowsOf<{ id: string }>(db, ORG, sql`
      insert into competence_record (user_id, role_title, competence_required, proof_type) values (${member}::uuid, 'Engineer', 'Network course', 'training') returning id`);
    await rowsOf(db, ORG, sql`
      insert into competence_record (user_id, role_title, competence_required, proof_type, deleted_at, disposed_at)
      values (${member}::uuid, 'Disposed of', 'Disposed of', 'training', now(), now()) returning id`);
    await entry({ actor: rina.userId, action: 'membership.updated', type: 'org_membership', id: member, code: 'raka.firmansyah', after: { adminRoles: [] } });
    const scope = ctx.moduleRef.get(TenantScope);
    const copy = await scope.withTenant({ orgId: ORG_IDS[ORG], schema: `org_${ORG}`, userId: rina.userId }, (trx) =>
      personalDataOf(trx, { id: ORG_IDS[ORG], name: 'Nusantara Digital', slug: ORG }, member, new Date()));
    expect(PERSONAL_DATA_FORMAT).toBe('mscd-personal-data-v2');
    expect(copy.format).toBe('mscd-personal-data-v2');
    expect(copy.mentions).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: 'risk', field: 'description', excerpt: expect.stringContaining('Raka Firmansyah') })]));
    expect(copy.auditEntriesAbout).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'membership.updated', recordType: 'org_membership' })]));
    for (const e of copy.auditEntriesAbout) expect(Object.keys(e).sort()).toEqual(['action', 'at', 'ms', 'recordType', 'seq']);
    expect(copy.competenceRecords).toHaveLength(1);
    expect(copy.competenceRecords[0]).toMatchObject({ roleTitle: 'Engineer' });
    expect(JSON.stringify(copy.competenceRecords)).not.toContain('Disposed of');
    expect(kept).toBeDefined();
  });
});
