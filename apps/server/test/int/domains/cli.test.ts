// `tenant verify-domain` (Milestone 2 K.6, M2-S11): in multi tenancy it verifies a domain by hand through the service
// of the operator routes, needs `--manual-reason` and is audited `ops.domain_verified` with method `manual`; in single
// tenancy (on-premise) it works as before, and a domain another organisation holds verified is refused with a clear
// message instead of the database's unique violation.
import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpsCliContext, describeError, tenantVerifyDomain } from '../../../src/cli/tenant';
import type { MscdConfig } from '../../../src/config/mscd-config';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { buildProgram } from '../../../src/program';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import { inPlatform } from '../onboarding/helpers';
import { MULTI, domainAudit, domainRow, sha256 } from './helpers';

describe('tenant verify-domain in multi tenancy (Milestone 2 M2-S11)', () => {
  const db = useTestDatabase('empty');
  let config: MscdConfig;
  let context: INestApplicationContext;
  let kappa: CreatedTenant;
  let lambda: CreatedTenant;

  beforeAll(async () => {
    config = db.config({ ...MULTI }, 'cli');
    context = await createOpsCliContext(config);
    kappa = await createTenant(db, 'kappa', { name: 'PT Kappa' });
    lambda = await createTenant(db, 'lambda', { name: 'PT Lambda' });
  });
  afterAll(async () => {
    await context?.close();
  });

  it('has the option --manual-reason', () => {
    const tenant = buildProgram().commands.find((c) => c.name() === 'tenant') as Command;
    const verify = tenant.commands.find((c) => c.name() === 'verify-domain')!;
    expect(verify.options.map((o) => o.long)).toEqual(['--org', '--domain', '--by', '--manual-reason']);
  });

  it('needs a reason, then records the domain as verified by hand with method manual', async () => {
    await expect(tenantVerifyDomain(config, { org: 'kappa', domain: 'kappa-corp.co.id', by: 'ops ticket 42' }, context)).rejects.toThrow(/--manual-reason/);
    expect(await domainRow(db, kappa.id, 'kappa-corp.co.id')).toBeUndefined();

    const first = await tenantVerifyDomain(config, { org: 'kappa', domain: ' Kappa-Corp.CO.ID. ', by: 'ops ticket 42', manualReason: 'Customer proved the domain by email from postmaster' }, context);
    expect(first).toEqual({ organizationId: kappa.id, domain: 'kappa-corp.co.id', created: true, method: 'manual' });
    expect(await domainRow(db, kappa.id, 'kappa-corp.co.id')).toMatchObject({ status: 'verified', method: 'manual', verified_by: 'ops ticket 42', txt_token_hash: null });
    expect(await domainAudit(db, 'kappa-corp.co.id')).toEqual([
      expect.objectContaining({
        action: 'ops.domain_verified',
        organization_id: kappa.id,
        actor_kind: 'operator',
        actor_user_id: null,
        after_data: {
          domain: 'kappa-corp.co.id',
          status: 'verified',
          method: 'manual',
          verifiedBy: 'ops ticket 42',
          reason: 'Customer proved the domain by email from postmaster',
          via: 'cli',
        },
      }),
    ]);

    const again = await tenantVerifyDomain(config, { org: 'kappa', domain: 'kappa-corp.co.id', by: 'someone else', manualReason: 'Second time' }, context);
    expect(again.created).toBe(false);
    expect(await domainAudit(db, 'kappa-corp.co.id')).toHaveLength(1);
  });

  it('turns a pending DNS claim of the organisation into the manual verification', async () => {
    await inPlatform(db, (trx) =>
      trx
        .insertInto('platform.verified_domain')
        .values({ organization_id: kappa.id, domain: 'kappa-pending.co.id', status: 'pending', method: 'dns', txt_token_hash: sha256('token'), requested_at: new Date(), verified_at: null, verified_by: null })
        .execute(),
    );
    const result = await tenantVerifyDomain(config, { org: 'kappa', domain: 'kappa-pending.co.id', by: 'ops', manualReason: 'DNS hosting cannot hold TXT records' }, context);
    expect(result.created).toBe(true);
    expect(await domainRow(db, kappa.id, 'kappa-pending.co.id')).toMatchObject({ status: 'verified', method: 'manual', txt_token_hash: null });
    expect((await domainAudit(db, 'kappa-pending.co.id')).at(-1)).toMatchObject({ before_data: { status: 'pending', method: 'dns' } });
  });

  it('refuses a domain another organisation holds verified, free mail domains and unknown organisations', async () => {
    const taken = tenantVerifyDomain(config, { org: 'lambda', domain: 'kappa-corp.co.id', by: 'ops', manualReason: 'Wrong organisation' }, context);
    await expect(taken).rejects.toMatchObject({ extras: { messageKey: 'domain_taken' } });
    const error = await taken.catch((e: unknown) => e);
    expect(describeError(error)).toBe(
      'The domain kappa-corp.co.id is already verified for another organisation. A verified domain belongs to one organisation only; remove it there first.',
    );
    expect(await domainRow(db, lambda.id, 'kappa-corp.co.id')).toBeUndefined();
    await expect(tenantVerifyDomain(config, { org: 'lambda', domain: 'gmail.com', by: 'ops', manualReason: 'Free mail' }, context)).rejects.toMatchObject({
      extras: { messageKey: 'domain_not_allowed' },
    });
    await expect(tenantVerifyDomain(config, { org: 'nobody', domain: 'nobody.co.id', by: 'ops', manualReason: 'Unknown' }, context)).rejects.toThrow(/Unknown organisation nobody/);
    await expect(tenantVerifyDomain(config, { org: 'lambda', domain: 'lambda.co.id', by: 'ops', manualReason: 'no' }, context)).rejects.toMatchObject({
      extras: { errors: [{ path: '--manual-reason', message: 'must have 3 to 500 characters' }] },
    });
  });
});

describe('tenant verify-domain in single tenancy (on-premise)', () => {
  const db = useTestDatabase('empty');
  let config: MscdConfig;
  let mu: CreatedTenant;

  beforeAll(async () => {
    config = db.config({}, 'cli');
    mu = await createTenant(db, 'mu', { name: 'PT Mu' });
    await createTenant(db, 'nu', { name: 'PT Nu' });
  });

  it('works as before and refuses a domain another organisation holds verified with a clear message', async () => {
    const first = await tenantVerifyDomain(config, { org: 'mu', domain: 'mu-corp.co.id', by: 'ops ticket 1' });
    expect(first).toEqual({ organizationId: mu.id, domain: 'mu-corp.co.id', created: true });
    expect(await domainAudit(db, 'mu-corp.co.id')).toEqual([expect.objectContaining({ action: 'tenant.domain_verified', after_data: { domain: 'mu-corp.co.id', verifiedBy: 'ops ticket 1' } })]);
    await expect(tenantVerifyDomain(config, { org: 'nu', domain: 'mu-corp.co.id', by: 'ops ticket 2' })).rejects.toThrow(
      'The domain mu-corp.co.id is already verified for another organisation (domain_taken); a verified domain belongs to one organisation only, so remove it there first',
    );
  });
});
