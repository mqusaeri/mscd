// `mscd-server license entitlements show` and `set` (Milestone 2 M2-S10): a preset, explicit limits over the current
// row, the refusals before anything is written, the audit entry of the operator command, and the help that names
// `--preset`.
import type { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explicitBody, formatEntitlement, licenseEntitlementsSet, licenseEntitlementsShow } from '../../../src/cli/license';
import type { MscdConfig } from '../../../src/config/mscd-config';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { buildProgram } from '../../../src/program';
import { createTenant } from '../../setup/global-db';
import { useTestDatabase } from '../../setup/test-db';
import type { FullApp } from '../contract/harness';
import { addPerson, createOnboardingApp } from '../onboarding/helpers';
import { MULTI, PLANS, entitlementAudit, entitlementRow } from './helpers';

const TODAY = '2026-09-29';

describe('license entitlements commands (Milestone 2 M2-S10)', () => {
  const db = useTestDatabase('empty');
  let full: FullApp;
  let config: MscdConfig;
  let omega: CreatedTenant;

  beforeAll(async () => {
    omega = await createTenant(db, 'omega', { name: 'PT Omega' });
    await addPerson(db, 'omega.admin', [{ org: omega, adminRoles: ['tenant_admin'] }]);
    await addPerson(db, 'omega.member', [{ org: omega }]);
    config = db.config({ ...MULTI, ...PLANS }, 'cli');
    full = await createOnboardingApp(db, { env: { ...MULTI, ...PLANS } });
  });
  afterAll(async () => {
    await full?.close();
  });

  it('names the preset option in the help of license entitlements', () => {
    const license = buildProgram().commands.find((c) => c.name() === 'license')!;
    const entitlements = license.commands.find((c) => c.name() === 'entitlements') as Command;
    expect(entitlements.commands.map((c) => c.name())).toEqual(['show', 'set']);
    expect(entitlements.helpInformation()).toContain('preset');
    const set = entitlements.commands.find((c) => c.name() === 'set')!;
    const flags = set.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--org', '--preset', '--max-users', '--max-systems', '--valid-until', '--valid-from', '--rate-user', '--rate-org']));
  });

  it('shows nothing for an organisation without an entitlement, then sets a preset and shows it', async () => {
    expect(await licenseEntitlementsShow(config, { org: 'omega' }, full.app)).toBeNull();
    await expect(licenseEntitlementsShow(config, { org: 'nosuchorg' }, full.app)).rejects.toThrow(/Unknown organisation nosuchorg/);

    const written = await licenseEntitlementsSet(config, { org: 'omega', preset: 'trial' }, full.app);
    expect(written.changed).toBe(true);
    expect(written.result.data).toMatchObject({ organization: 'omega', plan: 'trial', source: 'preset', maxUsers: 3, validFrom: TODAY, validUntil: '2026-10-28', version: 1 });
    expect(written.result.warnings).toBeUndefined();
    const [entry] = await entitlementAudit(db, omega.id);
    // An operator command: actor kind operator without a user.
    expect(entry).toMatchObject({ actor_kind: 'operator', actor_user_id: null, entity_code: 'omega', after_data: expect.objectContaining({ plan: 'trial', reason: 'preset' }) });

    const shown = await licenseEntitlementsShow(config, { org: 'omega' }, full.app);
    expect(shown?.entitlement).toEqual(written.result.data);
    expect(formatEntitlement(shown!.entitlement)).toEqual([
      'Organisation:        omega',
      'Plan:                the trial plan (preset)',
      'Users:               2 of 3 (active members without guests)',
      'Management systems:  0 of 1 (not archived)',
      `Valid:               ${TODAY} to 2026-10-28, then 7 days of grace`,
      'Frameworks:          every installed framework',
      'Storage adapters:    managed_vault',
      'Features:            link_health_monitor',
      'Requests a minute:   600 (default) per user, 6000 (default) per organisation',
      `Version:             1 (changed ${shown!.entitlement.updatedAt})`,
    ]);
  });

  it('sets explicit limits over the current row; options left out keep their values', async () => {
    const written = await licenseEntitlementsSet(config, { org: 'omega', maxUsers: '1', rateUser: '90', validUntil: 'none' }, full.app);
    expect(written.changed).toBe(true);
    expect(written.result.data).toMatchObject({
      plan: null,
      source: 'manual',
      maxUsers: 1,
      maxManagementSystems: 1,
      storageAdapters: ['managed_vault'],
      features: ['link_health_monitor'],
      rateUserPerMinute: 90,
      rateOrgPerMinute: null,
      graceDays: 7,
      validFrom: TODAY,
      validUntil: null,
      version: 2,
    });
    // Below the current use: accepted with the warning of LIC-USERS.
    expect(written.result.warnings?.map((w) => w.rule)).toEqual(['LIC-USERS']);
    expect(await entitlementRow(db, omega.id)).toMatchObject({ source: 'manual', max_users: 1, rate_user_per_minute: 90, valid_until: null, version: 2 });
    expect(formatEntitlement(written.result.data)).toContain('Valid:               2026-09-29 to no end date');

    // The same values again change nothing.
    const again = await licenseEntitlementsSet(config, { org: 'omega', maxUsers: '1' }, full.app);
    expect(again.changed).toBe(false);
    expect(await entitlementAudit(db, omega.id)).toHaveLength(2);
  });

  it('refuses unclear or invalid options before anything is written', async () => {
    await expect(licenseEntitlementsSet(config, { org: 'omega', preset: 'trial', maxUsers: '5' }, full.app)).rejects.toThrow(/--preset cannot be combined with limits \(--max-users\)/);
    await expect(licenseEntitlementsSet(config, { org: 'omega' }, full.app)).rejects.toThrow(/Give --preset <name>, or limits/);
    await expect(licenseEntitlementsSet(config, { org: 'omega', maxUsers: 'many' }, full.app)).rejects.toThrow(/--max-users must be a whole number/);
    await expect(licenseEntitlementsSet(config, { org: 'omega', features: 'teleport' }, full.app)).rejects.toMatchObject({
      slug: 'validation',
      extras: { errors: [expect.objectContaining({ path: '--features (0)' })] },
    });
    await expect(licenseEntitlementsSet(config, { org: 'omega', preset: 'gold' }, full.app)).rejects.toMatchObject({ extras: { messageKey: 'unknown_preset' } });
    // A new organisation needs the user and system limits and the last valid day.
    const fresh = await createTenant(db, 'omega_two', { name: 'PT Omega Two' });
    await expect(licenseEntitlementsSet(config, { org: 'omega_two', maxUsers: '5' }, full.app)).rejects.toThrow(/--max-systems, --valid-until are needed/);
    expect(await entitlementRow(db, fresh.id)).toBeNull();
    expect((await entitlementRow(db, omega.id))?.version).toBe(2);
  });

  it('builds explicit limits with the defaults of a new row', () => {
    expect(explicitBody({ org: 'x', maxUsers: '5', maxSystems: '2', validUntil: '2027-01-31', frameworks: 'ISO27001, ISO9001', features: 'none' }, null, TODAY)).toEqual({
      plan: null,
      maxUsers: 5,
      maxManagementSystems: 2,
      frameworks: ['ISO27001', 'ISO9001'],
      storageAdapters: ['managed_vault'],
      features: [],
      rateUserPerMinute: null,
      rateOrgPerMinute: null,
      graceDays: 30,
      validFrom: TODAY,
      validUntil: '2027-01-31',
    });
  });
});
