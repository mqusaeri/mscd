// Email domains verified by a DNS TXT record (Milestone 2 D.1, J.3, K.6, D-S10; M2-S11) in multi tenancy, against the
// mock DNS responder of tools/mock-providers: add (normalised, IDN to punycode, the token stored only as its hash),
// verify through DNS, the hourly sweep with the expiry after 7 days, the first check after add, the monthly check of
// verified domains with the email to the operators, remove, `domain_taken` and `domain_not_allowed`, a DNS server that
// does not answer, sign-in discovery returning SSO providers only for a verified domain, the same answer for unknown
// slugs and domains, the 429 limit of `GET /auth/providers`, and 409 `single_tenancy` in single tenancy.
import { domainToASCII } from 'node:url';
import { OrgDomain, OrgDomainAdded, OrgDomainCheck, type JobName } from '@mscd/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB_QUEUE } from '../../../src/common/jobs/job-queue';
import type { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { DomainVerifyJob } from '../../../src/modules/ops/domains/domain-verify.job';
import { DomainsService } from '../../../src/modules/ops/domains/domains.service';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { createFullApp, type Client, type FullApp } from '../contract/harness';
import { startMailpit, type Mailpit } from '../identity/helpers';
import { addPerson, createOnboardingApp, inPlatform, resetRateLimits, sessionIn, type Person } from '../onboarding/helpers';
import {
  MULTI, add, addProvider, ageDomain, discover, domainAudit, domainRow, list, problemType, remove, sha256, startMockDns, verify, type MockDns,
} from './helpers';

const TXT_VALUE = /^mscd-verify=([A-Za-z0-9_-]{43})$/;
const DAY = 86_400_000;

describe('email domains verified by DNS (Milestone 2 K.6, M2-S11)', () => {
  const db = useTestDatabase('empty');
  let mail: Mailpit;
  let dns: MockDns;
  let full: FullApp;
  let operator: Person;
  let op: Client;
  let alpha: CreatedTenant;
  let beta: CreatedTenant;
  let gamma: CreatedTenant;
  let service: DomainsService;

  /** Adds a domain and returns the token of its TXT value. */
  async function added(org: string, domain: string): Promise<string> {
    const call = await add(op, org, domain);
    expect(call.violations).toEqual([]);
    expect(call.status, call.text).toBe(201);
    return TXT_VALUE.exec(String(call.body.txtValue))![1]!;
  }

  beforeAll(async () => {
    mail = await startMailpit();
    dns = await startMockDns();
    full = await createOnboardingApp(db, { mail, env: { ...MULTI, MSCD__NETWORK__DNS_RESOLVERS: dns.resolvers } });
    service = full.get<DomainsService>(DomainsService);
    operator = await addPerson(db, 'ops.domains', [], { platformOperator: true, password: true });
    await addPerson(db, 'ops.second', [], { platformOperator: true, password: true });
    op = await sessionIn(full, operator.id, null);
    alpha = await createTenant(db, 'alpha', { name: 'PT Alpha Sejahtera' });
    beta = await createTenant(db, 'beta', { name: 'PT Beta Makmur' });
    gamma = await createTenant(db, 'gamma', { name: 'PT Gamma Raya' });
    await addProvider(db, alpha.id, 'alpha-entra', 'Sign in with Alpha Microsoft');
    await addProvider(db, beta.id, 'beta-entra', 'Sign in with Beta Microsoft');
  });
  afterAll(async () => {
    await full?.close();
    await dns?.close();
    await mail?.stop();
  });
  beforeEach(async () => {
    await resetRateLimits(db);
    dns.zone.fault = { rcode: null, drop: false };
  });

  it('adds a domain: normalised, the record returned once, only the token hash stored, audited, first check queued', async () => {
    const call = await add(op, 'alpha', '  Alpha-Corp.CO.ID. ');
    expect(call.violations).toEqual([]);
    expect(call.status, call.text).toBe(201);
    expect(OrgDomainAdded.safeParse(call.body).success).toBe(true);
    expect(call.body).toEqual({ domain: 'alpha-corp.co.id', txtName: '_mscd-verify.alpha-corp.co.id', txtValue: expect.stringMatching(TXT_VALUE), status: 'pending' });
    const token = TXT_VALUE.exec(String(call.body.txtValue))![1]!;
    // 32 random bytes in base64url.
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const row = await domainRow(db, alpha.id, 'alpha-corp.co.id');
    expect(row).toMatchObject({ status: 'pending', method: 'dns', verified_at: null, verified_by: null, last_checked_at: null });
    expect(row!.txt_token_hash!.equals(sha256(token))).toBe(true);
    // Neither the token nor the TXT value is stored anywhere in the row, the audit trail or the list.
    expect(JSON.stringify(row)).not.toContain(token);
    const audit = await domainAudit(db, 'alpha-corp.co.id');
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'ops.domain_added',
        organization_id: alpha.id,
        actor_kind: 'operator',
        actor_user_id: operator.id,
        entity_type: 'verified_domain',
        after_data: expect.objectContaining({ domain: 'alpha-corp.co.id', status: 'pending', method: 'dns', txtName: '_mscd-verify.alpha-corp.co.id', renewed: false }),
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(token);
    const listed = await list(op, 'alpha');
    expect(listed.violations).toEqual([]);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(OrgDomain.safeParse(listed.body[0]).success).toBe(true);
    const requested = Date.parse(String(listed.body[0]!.requestedAt));
    expect(listed.body[0]).toMatchObject({ domain: 'alpha-corp.co.id', status: 'pending', method: 'dns', verifiedAt: null, lastCheckedAt: null, txtName: '_mscd-verify.alpha-corp.co.id' });
    expect(Date.parse(String(listed.body[0]!.pendingUntil)) - requested).toBe(7 * DAY);
    expect(JSON.stringify(listed.body)).not.toContain(token);

    // The first check is queued a minute later for this domain.
    const queue = full.get<InMemoryJobQueue>(JOB_QUEUE);
    const jobs = queue.waitingJobs('domain.verify' as JobName).filter((j) => (j.env.payload as { domain?: string }).domain === 'alpha-corp.co.id');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.env).toMatchObject({ orgId: null, payload: { organizationId: alpha.id, domain: 'alpha-corp.co.id' } });

    // An international name is stored in punycode.
    const idn = await add(op, 'alpha', 'Bücher-Alpha.example');
    expect(idn.status, idn.text).toBe(201);
    expect(idn.body.domain).toBe(domainToASCII('bücher-alpha.example'));
    expect(idn.body.domain).toMatch(/^xn--bcher-alpha-[a-z0-9]+\.example$/);
    expect(await remove(op, 'alpha', String(idn.body.domain))).toMatchObject({ status: 204 });
  });

  it('refuses free mail domains (422 domain_not_allowed) and names that are not domains (400)', async () => {
    for (const domain of ['gmail.com', 'Yahoo.co.id', 'outlook.com', 'hotmail.com', 'yahoo.com', 'support.gmail.com']) {
      const call = await add(op, 'alpha', domain);
      expect(call.violations).toEqual([]);
      expect(call.status, domain).toBe(422);
      expect(call.body).toMatchObject({ type: problemType('business-rule'), messageKey: 'domain_not_allowed' });
      expect(call.body.messages?.id).toContain('domain email gratis');
    }
    for (const domain of ['localhost', 'not a domain', 'a..b.example', 'x.1234']) {
      const call = await add(op, 'alpha', domain);
      expect(call.status, domain).toBe(400);
      expect(call.body.type).toBe(problemType('validation'));
    }
    expect((await add(op, 'nobody', 'nobody-corp.co.id')).status).toBe(404);
    expect(await domainAudit(db, 'gmail.com')).toEqual([]);
  });

  it('verifies through DNS: a missing record keeps it pending, the record with the token verifies it, discovery then names the organisation', async () => {
    const token = await added('beta', 'beta-group.co.id');
    // Pending: discovery by email does not name the organisation yet.
    expect((await discover(full, { email: 'andi@beta-group.co.id' })).body).toEqual({ local: true, providers: [] });

    const missing = await verify(op, 'beta', 'beta-group.co.id');
    expect(missing.violations).toEqual([]);
    expect(missing.status, missing.text).toBe(200);
    expect(OrgDomainCheck.safeParse(missing.body).success).toBe(true);
    expect(missing.body).toMatchObject({ domain: 'beta-group.co.id', status: 'pending', recordFound: false, verifiedAt: null });
    expect(missing.body.lastCheckedAt).not.toBeNull();

    // A record with another token is not enough.
    dns.zone.set('_mscd-verify.beta-group.co.id', ['mscd-verify=someone-elses-token-0000000000000000000', 'v=spf1 -all']);
    expect((await verify(op, 'beta', 'beta-group.co.id')).body).toMatchObject({ status: 'pending', recordFound: false });

    // The record as the customer adds it (white space around the value is ignored).
    dns.zone.set('_mscd-verify.beta-group.co.id', ['v=spf1 -all', ` mscd-verify=${token} `]);
    const found = await verify(op, 'beta', 'beta-group.co.id');
    expect(found.violations).toEqual([]);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ domain: 'beta-group.co.id', status: 'verified', method: 'dns', recordFound: true, pendingUntil: null });
    expect(found.body.verifiedAt).not.toBeNull();
    expect(await domainRow(db, beta.id, 'beta-group.co.id')).toMatchObject({ status: 'verified', verified_by: 'DNS TXT record (Verify now)' });
    const audit = await domainAudit(db, 'beta-group.co.id');
    expect(audit.map((a) => [a.action, (a.after_data as { status?: string; reason?: string }).status ?? null, (a.after_data as { reason?: string }).reason ?? null])).toEqual([
      ['ops.domain_added', 'pending', null],
      ['ops.domain_verification_failed', 'pending', 'record_missing'],
      ['ops.domain_verification_failed', 'pending', 'record_mismatch'],
      ['ops.domain_verified', 'verified', null],
    ]);
    expect(audit[3]).toMatchObject({ actor_kind: 'operator', actor_user_id: operator.id, before_data: { status: 'pending' } });

    // Verified: the email domain names the organisation and its SSO buttons.
    expect((await discover(full, { email: 'andi@BETA-GROUP.co.id' })).body).toEqual({
      local: true,
      providers: [{ slug: 'beta-entra', kind: 'oidc', label: 'Sign in with Beta Microsoft', icon: 'microsoft' }],
    });
    // Adding it again for the same organisation is refused; the operator list shows it verified.
    const again = await add(op, 'beta', 'beta-group.co.id');
    expect(again.status).toBe(409);
    expect(again.body.messageKey).toBe('domain_already_verified');
    expect((await list(op, 'beta')).body).toEqual([expect.objectContaining({ domain: 'beta-group.co.id', status: 'verified' })]);
  });

  it('gives a verified domain to one organisation only: 409 domain_taken on add and on verify', async () => {
    // beta-group.co.id is verified for beta (test above).
    const taken = await add(op, 'alpha', 'beta-group.co.id');
    expect(taken.violations).toEqual([]);
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ type: problemType('conflict'), messageKey: 'domain_taken' });
    expect(await domainRow(db, alpha.id, 'beta-group.co.id')).toBeUndefined();

    // Two pending claims are allowed; the first to prove the domain wins, the second gets domain_taken.
    const gammaToken = await added('gamma', 'shared-name.co.id');
    const alphaToken = await added('alpha', 'shared-name.co.id');
    dns.zone.set('_mscd-verify.shared-name.co.id', [`mscd-verify=${gammaToken}`, `mscd-verify=${alphaToken}`]);
    expect((await verify(op, 'gamma', 'shared-name.co.id')).body).toMatchObject({ status: 'verified', recordFound: true });
    const second = await verify(op, 'alpha', 'shared-name.co.id');
    expect(second.violations).toEqual([]);
    expect(second.status).toBe(409);
    expect(second.body.messageKey).toBe('domain_taken');
    expect(await domainRow(db, alpha.id, 'shared-name.co.id')).toMatchObject({ status: 'pending' });
    // The hourly sweep ends the losing claim.
    await service.sweep();
    expect(await domainRow(db, alpha.id, 'shared-name.co.id')).toMatchObject({ status: 'failed' });
    expect((await domainAudit(db, 'shared-name.co.id')).filter((a) => a.organization_id === alpha.id).at(-1)).toMatchObject({
      action: 'ops.domain_verification_failed',
      actor_kind: 'system',
      after_data: expect.objectContaining({ status: 'failed', reason: 'domain_taken', via: 'job' }),
    });
  });

  it('checks pending domains every hour for 7 days, then marks them failed; adding again gives a new token and 7 more days', async () => {
    await added('gamma', 'gamma-late.co.id');
    const fresh = await added('gamma', 'gamma-fresh.co.id');
    await ageDomain(db, gamma.id, 'gamma-late.co.id', { requested: 8 });
    await ageDomain(db, gamma.id, 'gamma-fresh.co.id', { requested: 6 });
    const before = (await domainAudit(db, 'gamma-fresh.co.id')).length;

    const result = await service.sweep();
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(await domainRow(db, gamma.id, 'gamma-late.co.id')).toMatchObject({ status: 'failed' });
    const fresher = await domainRow(db, gamma.id, 'gamma-fresh.co.id');
    expect(fresher).toMatchObject({ status: 'pending' });
    expect(fresher!.last_checked_at).not.toBeNull();
    // An hourly miss writes no audit entry; the end of the checks does.
    expect(await domainAudit(db, 'gamma-fresh.co.id')).toHaveLength(before);
    expect((await domainAudit(db, 'gamma-late.co.id')).at(-1)).toMatchObject({
      action: 'ops.domain_verification_failed',
      actor_kind: 'system',
      before_data: { status: 'pending' },
      after_data: expect.objectContaining({ status: 'failed', reason: 'expired', via: 'job' }),
    });
    expect((await list(op, 'gamma')).body.find((d) => d.domain === 'gamma-late.co.id')).toMatchObject({ status: 'failed', pendingUntil: null });

    // A pending record found by the sweep verifies the domain.
    dns.zone.set('_mscd-verify.gamma-fresh.co.id', [`mscd-verify=${fresh}`]);
    await service.sweep();
    expect(await domainRow(db, gamma.id, 'gamma-fresh.co.id')).toMatchObject({ status: 'verified', verified_by: 'DNS TXT record (hourly check)' });

    // A failed domain added again: a new token, pending, 7 days from now.
    const renewedToken = await added('gamma', 'gamma-late.co.id');
    const renewed = await domainRow(db, gamma.id, 'gamma-late.co.id');
    expect(renewed).toMatchObject({ status: 'pending', last_checked_at: null });
    expect(renewed!.txt_token_hash!.equals(sha256(renewedToken))).toBe(true);
    expect((await domainAudit(db, 'gamma-late.co.id')).at(-1)).toMatchObject({
      action: 'ops.domain_added',
      before_data: { status: 'failed' },
      after_data: expect.objectContaining({ status: 'pending', renewed: true }),
    });
    // "Verify now" still works on a failed domain once its record is there.
    await ageDomain(db, gamma.id, 'gamma-late.co.id', { requested: 9 });
    await service.sweep();
    expect(await domainRow(db, gamma.id, 'gamma-late.co.id')).toMatchObject({ status: 'failed' });
    dns.zone.set('_mscd-verify.gamma-late.co.id', [`mscd-verify=${renewedToken}`]);
    expect((await verify(op, 'gamma', 'gamma-late.co.id')).body).toMatchObject({ status: 'verified', recordFound: true });
  });

  it('runs the first check after add through the job handler and skips a domain that is no longer pending', async () => {
    const token = await added('alpha', 'alpha-ready.co.id');
    dns.zone.set('_mscd-verify.alpha-ready.co.id', [`mscd-verify=${token}`]);
    const job = full.get<DomainVerifyJob>(DomainVerifyJob);
    const run = (payload: { organizationId?: string; domain?: string }) =>
      job.handle({ id: `job-${Math.random()}`, name: 'domain.verify', attempt: 1, env: { orgId: null, payload } });
    await run({ organizationId: alpha.id, domain: 'alpha-ready.co.id' });
    expect(await domainRow(db, alpha.id, 'alpha-ready.co.id')).toMatchObject({ status: 'verified' });
    const checks = (await domainAudit(db, 'alpha-ready.co.id')).length;
    // Already verified: nothing to do.
    await run({ organizationId: alpha.id, domain: 'alpha-ready.co.id' });
    expect(await domainAudit(db, 'alpha-ready.co.id')).toHaveLength(checks);
    expect(await service.checkOne(alpha.id, 'no-such-domain.co.id')).toBeNull();
    // Without a payload the handler sweeps.
    await run({});
  });

  it('checks verified domains monthly: a missing record emails the operators and the domain stays verified', async () => {
    const token = await added('alpha', 'alpha-monthly.co.id');
    dns.zone.set('_mscd-verify.alpha-monthly.co.id', [`mscd-verify=${token}`]);
    expect((await verify(op, 'alpha', 'alpha-monthly.co.id')).body).toMatchObject({ status: 'verified' });
    const recent = await added('alpha', 'alpha-recent.co.id');
    dns.zone.set('_mscd-verify.alpha-recent.co.id', [`mscd-verify=${recent}`]);
    expect((await verify(op, 'alpha', 'alpha-recent.co.id')).body).toMatchObject({ status: 'verified' });
    await mail.clear();

    // Checked 31 days ago with the record in place: checked again, nothing sent.
    await ageDomain(db, alpha.id, 'alpha-monthly.co.id', { verified: 40, checked: 31 });
    await ageDomain(db, alpha.id, 'alpha-recent.co.id', { verified: 12, checked: 10 });
    dns.zone.queries.length = 0;
    await service.sweep();
    const asked = dns.zone.queries.map((q) => q.name);
    expect(asked).toContain('_mscd-verify.alpha-monthly.co.id');
    // A domain checked 10 days ago is not due.
    expect(asked).not.toContain('_mscd-verify.alpha-recent.co.id');
    const checked = await domainRow(db, alpha.id, 'alpha-monthly.co.id');
    expect(Date.now() - checked!.last_checked_at!.getTime()).toBeLessThan(60_000);

    // A month later the record is gone: the status stays verified, the operators are emailed, discovery still works.
    await ageDomain(db, alpha.id, 'alpha-monthly.co.id', { checked: 31 });
    dns.zone.set('_mscd-verify.alpha-monthly.co.id', []);
    const result = await service.sweep();
    expect(result.recordMissing).toBe(1);
    expect(result.operatorsEmailed).toBe(2);
    expect(await domainRow(db, alpha.id, 'alpha-monthly.co.id')).toMatchObject({ status: 'verified' });
    expect((await domainAudit(db, 'alpha-monthly.co.id')).at(-1)).toMatchObject({
      action: 'ops.domain_verification_failed',
      actor_kind: 'system',
      after_data: expect.objectContaining({ reason: 'record_missing', statusKept: true, via: 'job' }),
    });
    const message = await mail.waitFor(operator.email, (m) => m.mailKind === 'account:domain_record_missing');
    expect(message.subject).toBe('[MSCD] PT Alpha Sejahtera: the DNS record of alpha-monthly.co.id is gone');
    expect(message.text).toContain('_mscd-verify.alpha-monthly.co.id');
    expect(message.text).toContain('The domain stays verified');
    await mail.waitFor('ops.second@onboarding.test', (m) => m.mailKind === 'account:domain_record_missing');
    expect((await discover(full, { email: 'x@alpha-monthly.co.id' })).body.providers).toHaveLength(1);
    // "Verify now" on a verified domain whose record is gone answers recordFound false and keeps it verified.
    const now = await verify(op, 'alpha', 'alpha-monthly.co.id');
    expect(now.body).toMatchObject({ status: 'verified', recordFound: false });
  });

  it('answers 503 when no DNS server answers and changes nothing', async () => {
    await added('alpha', 'alpha-dark.co.id');
    const before = await domainRow(db, alpha.id, 'alpha-dark.co.id');
    dns.zone.fault = { rcode: 'servfail', drop: false };
    const call = await verify(op, 'alpha', 'alpha-dark.co.id');
    expect(call.violations).toEqual([]);
    expect(call.status).toBe(503);
    expect(call.body.type).toBe(problemType('dependency-unavailable'));
    expect(await domainRow(db, alpha.id, 'alpha-dark.co.id')).toEqual(before);
    // The sweep leaves it alone too while its 7 days run.
    await service.sweep();
    expect(await domainRow(db, alpha.id, 'alpha-dark.co.id')).toMatchObject({ status: 'pending', last_checked_at: null });
  });

  it('removes a domain: discovery stops naming the organisation; 404 for an unknown domain or organisation', async () => {
    const token = await added('beta', 'beta-old.co.id');
    dns.zone.set('_mscd-verify.beta-old.co.id', [`mscd-verify=${token}`]);
    await verify(op, 'beta', 'beta-old.co.id');
    expect((await discover(full, { email: 'x@beta-old.co.id' })).body.providers).toHaveLength(1);
    const call = await remove(op, 'beta', 'beta-old.co.id');
    expect(call.violations).toEqual([]);
    expect(call.status).toBe(204);
    expect(await domainRow(db, beta.id, 'beta-old.co.id')).toBeUndefined();
    expect((await discover(full, { email: 'x@beta-old.co.id' })).body).toEqual({ local: true, providers: [] });
    expect((await domainAudit(db, 'beta-old.co.id')).at(-1)).toMatchObject({
      action: 'ops.domain_removed',
      actor_kind: 'operator',
      before_data: { domain: 'beta-old.co.id', status: 'verified', method: 'dns' },
    });
    for (const call of [await remove(op, 'beta', 'beta-old.co.id'), await verify(op, 'beta', 'never-added.co.id'), await list(op, 'nobody')]) {
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(404);
    }
  });

  it('gives strangers the same answer for an unknown slug, an unknown, pending or failed domain and an organisation without SSO (D-S10)', async () => {
    await added('alpha', 'alpha-pending.co.id');
    const gammaToken = await added('gamma', 'gamma-only.co.id');
    dns.zone.set('_mscd-verify.gamma-only.co.id', [`mscd-verify=${gammaToken}`]);
    await verify(op, 'gamma', 'gamma-only.co.id');
    const queries: Record<string, string>[] = [
      { org: 'nosuchorg' },
      { email: 'someone@unknown-company.co.id' },
      { email: 'someone@alpha-pending.co.id' },
      { email: 'someone@shared-name.co.id' }, // failed for alpha, verified for gamma (no SSO)
      { email: 'someone@gamma-only.co.id' },
      { org: 'gamma' },
      {},
    ];
    const answers = [];
    for (const query of queries) answers.push(await discover(full, query));
    for (const [index, answer] of answers.entries()) {
      expect(answer.status, JSON.stringify(queries[index])).toBe(200);
      expect(answer.body, JSON.stringify(queries[index])).toEqual({ local: true, providers: [] });
      expect(answer.headers['content-type']).toBe(answers[0]!.headers['content-type']);
      expect(Object.keys(answer.headers).filter((h) => !/^(date|x-request-id|x-ratelimit-.*|content-length)$/.test(h)).sort()).toEqual(
        Object.keys(answers[0]!.headers).filter((h) => !/^(date|x-request-id|x-ratelimit-.*|content-length)$/.test(h)).sort(),
      );
    }
    // A known organisation with SSO is named by its slug, as before.
    expect((await discover(full, { org: 'alpha' })).body.providers).toHaveLength(1);
    // An organisation without SSO keeps its local sign-in policy to itself: the stranger's answer.
    await inPlatform(db, (trx) => trx.updateTable('platform.organization').set({ local_login: 'disabled' }).where('id', '=', gamma.id).execute());
    try {
      expect(await discover(full, { org: 'gamma' })).toMatchObject({ status: 200, body: { local: true, providers: [] } });
      expect((await discover(full, { email: 'someone@gamma-only.co.id' })).body).toEqual({ local: true, providers: [] });
      // With SSO, the policy shows with the buttons (the password field hides on the sign-in page).
      await inPlatform(db, (trx) => trx.updateTable('platform.organization').set({ local_login: 'disabled' }).where('id', '=', alpha.id).execute());
      expect((await discover(full, { org: 'alpha' })).body).toMatchObject({ local: false, providers: [{ slug: 'alpha-entra' }] });
    } finally {
      await inPlatform(db, (trx) => trx.updateTable('platform.organization').set({ local_login: 'allowed' }).where('id', 'in', [alpha.id, gamma.id]).execute());
    }
  });

  it('limits GET /auth/providers to 20 calls per minute per address (429 with Retry-After)', async () => {
    for (let i = 0; i < 20; i += 1) expect((await discover(full, { email: `p${i}@probe-${i}.co.id` }, '198.51.100.7')).status).toBe(200);
    const limited = await discover(full, { org: 'alpha' }, '198.51.100.7');
    expect(limited.status).toBe(429);
    expect(limited.body.type).toBe(problemType('rate-limited'));
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another address is not limited by the first one's calls.
    expect((await discover(full, { org: 'alpha' }, '198.51.100.8')).status).toBe(200);
  });

  it('refuses "Verify now" for a domain verified by hand, and changes to an archived organisation', async () => {
    await inPlatform(db, (trx) =>
      trx.insertInto('platform.verified_domain').values({ organization_id: beta.id, domain: 'beta-manual.co.id', verified_by: 'ops ticket 7' }).execute(),
    );
    const manual = await verify(op, 'beta', 'beta-manual.co.id');
    expect(manual.status).toBe(409);
    expect(manual.body.messageKey).toBe('domain_not_dns');
    const archived = await createTenant(db, 'omega', { name: 'PT Omega' });
    await inPlatform(db, (trx) => trx.updateTable('platform.organization').set({ status: 'archived' }).where('id', '=', archived.id).execute());
    const call = await add(op, 'omega', 'omega-corp.co.id');
    expect(call.status).toBe(409);
    expect(call.body.messageKey).toBe('organization_archived');
  });
});

describe('email domain routes in single tenancy (Milestone 2 J.6)', () => {
  const db = useTestDatabase('empty');
  let full: FullApp;
  let op: Client;

  beforeAll(async () => {
    full = await createFullApp(db);
    const operator = await addPerson(db, 'ops.single', [], { platformOperator: true, password: true });
    op = await sessionIn(full, operator.id, null);
    await createTenant(db, 'solo', { name: 'PT Solo' });
  });
  afterAll(async () => {
    await full?.close();
  });

  it('answers 409 single_tenancy on every route, and has no domain.verify handler', async () => {
    await resetRateLimits(db);
    for (const call of [await list(op, 'solo'), await add(op, 'solo', 'solo-corp.co.id'), await verify(op, 'solo', 'solo-corp.co.id'), await remove(op, 'solo', 'solo-corp.co.id')]) {
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(409);
      expect(call.body).toMatchObject({ type: problemType('conflict'), messageKey: 'single_tenancy' });
    }
    expect(full.get<DomainVerifyJob | null>(DomainVerifyJob)).toBeNull();
  });
});
