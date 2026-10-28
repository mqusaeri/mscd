// Helpers of the entitlement tests (Milestone 2 M2-S10): the multi-tenancy api application with two plan presets, the
// entitlement rows and their audit entries, and a signed licence stored the way an installation before M2-S10 kept it.
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import { licenceDocumentSha256 } from '../../../src/modules/license/licence.service';
import type { TestDatabase } from '../../setup/test-db';
import { devLicence } from '../packs/fixtures';
import { inPlatform } from '../onboarding/helpers';

/** Multi tenancy with schema isolation, as `saas.yaml` runs. */
export const MULTI = { MSCD__TENANCY__MODE: 'multi', MSCD__TENANCY__ISOLATION: 'schema' } as const;

/** Two presets of `license.plans` for the tests (the profile of the tests has none). */
export const PLANS = {
  MSCD__LICENSE__PLANS__TRIAL: '{max_users: 3, max_management_systems: 1, valid_days: 30, grace_days: 7, storage_adapters: [managed_vault], features: [link_health_monitor]}',
  MSCD__LICENSE__PLANS__STANDARD:
    '{max_users: 50, max_management_systems: 3, valid_days: 365, grace_days: 30, storage_adapters: [managed_vault, m365, google_drive], features: [integrated_mode, edition_transition, link_health_monitor, auditor_guest_access]}',
} as const;

/** The `platform.entitlement` row of an organisation (null without one). */
export async function entitlementRow(db: TestDatabase, orgId: string) {
  return inPlatform(db, async (trx) => (await trx.selectFrom('platform.entitlement').selectAll().where('organization_id', '=', orgId).executeTakeFirst()) ?? null);
}

/** The `ops.entitlements_changed` entries of an organisation, oldest first. */
export async function entitlementAudit(db: TestDatabase, orgId: string) {
  return inPlatform(db, (trx) =>
    trx
      .selectFrom('platform.audit_log')
      .select(['actor_kind', 'actor_user_id', 'entity_type', 'entity_id', 'entity_code', 'before_data', 'after_data'])
      .where('action', '=', 'ops.entitlements_changed')
      .where('organization_id', '=', orgId)
      .orderBy('seq')
      .execute(),
  );
}

/**
 * Stores a signed licence for an organisation the way `PUT /admin/license` did before M2-S10: a `platform.licence` row
 * and no entitlement row. Returns the document.
 */
export async function storeOldLicence(
  db: TestDatabase,
  tenant: CreatedTenant,
  overrides: Record<string, unknown> = {},
  document: Record<string, unknown> = devLicence(tenant.id, overrides),
): Promise<Record<string, unknown>> {
  await inPlatform(db, (trx) =>
    trx
      .insertInto('platform.licence')
      .values({
        organization_id: tenant.id,
        license_id: String(document.license_id),
        document: JSON.stringify(document),
        document_sha256: licenceDocumentSha256(document),
        key_id: String(document.key_id),
        installed_by: null,
      })
      .execute(),
  );
  return document;
}
