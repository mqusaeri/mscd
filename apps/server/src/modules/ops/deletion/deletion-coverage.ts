// What the purge of an organisation does with each platform table that holds organisation data (Milestone 3 D.5.2,
// D.5.3, R-21). Every platform table with an `organization_id` column, or with a foreign key to a table that has one
// (for example `user_identity` through `identity_provider`), is either purged (step 5, `platform.purge_organization`)
// or kept with a reason. The checks of D.5.3 read these lists, and the coverage test of M3-03
// (test/int/org-deletion/coverage.test.ts) fails on such a table that is in neither, so a new table cannot be
// forgotten. Tables without organisation data (installation, packs, clock, system settings) are not listed.

/** How the rows of one purged table are found: the SQL condition, with `$1` the organisation id. */
export interface PurgedTable {
  table: string;
  /** Condition over the table (alias-free) that selects the organisation's rows; `$1` is the organisation id. */
  where: string;
  why: string;
}

/** Platform tables whose rows of the organisation step 5 deletes (and the checks expect gone). */
export const PURGED_PLATFORM_TABLES: readonly PurgedTable[] = [
  { table: 'org_membership', where: 'organization_id = $1', why: 'memberships of the organisation' },
  { table: 'invitation', where: 'organization_id = $1', why: 'invitations to the organisation (token hashes, emails)' },
  { table: 'identity_provider', where: 'organization_id = $1', why: 'company sign-in providers of the organisation (sealed client secrets)' },
  {
    table: 'user_identity',
    where: 'identity_provider_id IN (SELECT id FROM platform.identity_provider WHERE organization_id = $1)',
    why: 'linked company sign-in through the providers of the organisation',
  },
  {
    table: 'saml_assertion_seen',
    where: 'identity_provider_id IN (SELECT id FROM platform.identity_provider WHERE organization_id = $1)',
    why: 'replay guard of the SAML providers of the organisation',
  },
  {
    table: 'session',
    where: 'organization_id = $1 OR auth_org_id = $1 OR identity_provider_id IN (SELECT id FROM platform.identity_provider WHERE organization_id = $1)',
    why: 'sessions in the organisation or opened through its sign-in policy or providers (network address, browser)',
  },
  {
    table: 'auth_transaction',
    where: 'organization_id = $1 OR identity_provider_id IN (SELECT id FROM platform.identity_provider WHERE organization_id = $1)',
    why: 'sign-in transactions of the organisation',
  },
  { table: 'verified_domain', where: 'organization_id = $1', why: 'email domains of the organisation' },
  { table: 'licence', where: 'organization_id = $1', why: 'licences of the organisation' },
  { table: 'entitlement', where: 'organization_id = $1', why: 'plan and limits of the organisation' },
  { table: 'daily_job_run', where: 'organization_id = $1', why: 'run ledger of the daily jobs of the organisation' },
  { table: 'idempotency_key', where: 'organization_id = $1', why: 'stored answers of repeated requests (may hold record data)' },
  { table: 'tenant_key', where: 'organization_id = $1', why: 'the wrapped data key: without it nothing of the organisation can be unwrapped' },
  { table: 'rate_limit_bucket', where: 'strpos(key, $1::text) > 0', why: 'rate limit counters keyed by the organisation' },
  { table: 'job_outbox', where: "payload -> 'env' ->> 'orgId' = $1::text", why: 'queued jobs that name the organisation' },
];

/** Platform tables whose rows of the organisation stay after the purge, with the reason (D.5.3, D.5.5). */
export const KEPT_PLATFORM_TABLES: Readonly<Record<string, string>> = {
  organization: 'the organisation row with status deleted: slug, name, time zone and region stay, so the slug is never reused and the certificate can name the customer',
  organization_status_event: 'the status history (reasons and operator ids, no personal data of the organisation)',
  organization_deletion: 'this deletion record with the report and the signed certificate (the sealed email list is cleared after the certificate email)',
  organization_export: 'the export records, every one expired, rejected or failed, with no content left in the vault',
  audit_log: 'the platform audit entries of the organisation, redacted: no network addresses, browsers, emails or names (D.5.4)',
};

/** Statuses an export record may have after the purge (its content is gone). */
export const EXPORT_STATUSES_AFTER_PURGE = ['expired', 'rejected', 'failed'] as const;
