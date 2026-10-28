// Writes of `platform.entitlement` (Milestone 2 K.6, M2-S10). The table is written in platform scope only (M2-02
// follow-up 9): every write here runs inside `inPlatformScope(trx, ...)`, so it works in a transaction opened with
// `withPlatform` as well as inside an organisation transaction of `withTenant`, where the row is otherwise read only.
// Each write takes the organisation's entitlement lock, bumps `version`, records `ops.entitlements_changed` with the
// old and the new values, sends the change notice `mscd_tenant_changed` and drops this process's cache entry after the
// commit.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { currentRequestContext } from '../../common/request-context';
import { AUDIT_WRITER, SYSTEM_USER_ID, type AuditWriter, type Trx } from '../../common/tokens';
import { acceptsAfterCommit, afterCommit } from '../../common/transaction-hooks';
import type { ActorKind } from '@mscd/shared';
import { inPlatformScope } from '../identity/platform-scope';
import { EntitlementRegistry } from './entitlement-registry';
import {
  ENTITLEMENT_COLUMNS,
  auditValues,
  readEntitlement,
  recordOf,
  sameValues,
  valuesOf,
  type EntitlementRecord,
  type EntitlementValues,
} from './entitlement-row';
import { publishTenantChange } from './tenant-change';

/** Who made a change, and why (the `ops.entitlements_changed` entry). */
export interface EntitlementChange {
  /** Default: the request's user, else the system user. */
  actor?: { userId: string | null; kind: ActorKind };
  /** `preset`, `limits`, `licence_upload` or `backfill` (stored in the audit entry). */
  reason: string;
  /** The organisation's slug, for the audit entry. */
  slug?: string | null;
}

type EntitlementDbRow = Parameters<typeof recordOf>[0];

@Injectable()
export class EntitlementStore {
  constructor(
    @Optional() @Inject(AUDIT_WRITER) private readonly audit?: AuditWriter,
    @Optional() private readonly registry?: EntitlementRegistry,
  ) {}

  /** Serialises the writes of one organisation's entitlement until the transaction ends. */
  async lock(trx: Trx, orgId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`entitlement:${orgId}`}, 0))`.execute(trx);
  }

  /**
   * Writes the row of an organisation (insert or update) unless it already holds these values; returns the row and
   * whether it changed. The caller has checked `If-Match` under `lock` where the route needs it.
   */
  async write(trx: Trx, orgId: string, values: EntitlementValues, change: EntitlementChange): Promise<{ row: EntitlementRecord; changed: boolean }> {
    return inPlatformScope(trx, async () => {
      await this.lock(trx, orgId);
      const before = await readEntitlement(trx, orgId);
      if (before && sameValues(valuesOf(before), values)) return { row: before, changed: false };
      const actor = this.actorOf(change);
      const columns = columnsOf(values);
      const row = await trx
        .insertInto('platform.entitlement')
        .values({ organization_id: orgId, ...columns, updated_by: actor.userId })
        .onConflict((oc) =>
          oc.column('organization_id').doUpdateSet({
            ...columns,
            updated_by: actor.userId,
            version: sql<number>`platform.entitlement.version + 1`,
            updated_at: sql<Date>`now()`,
          }),
        )
        .returning([...ENTITLEMENT_COLUMNS])
        .executeTakeFirstOrThrow();
      const record = recordOf(row as EntitlementDbRow);
      await this.recorded(trx, record, before, change, actor);
      return { row: record, changed: true };
    });
  }

  /**
   * Writes the row only when the organisation has none (the backfill from a signed licence installed before M2-S10).
   * Returns null when another transaction wrote one first.
   */
  async insertIfMissing(trx: Trx, orgId: string, values: EntitlementValues, change: EntitlementChange): Promise<EntitlementRecord | null> {
    return inPlatformScope(trx, async () => {
      const actor = this.actorOf(change);
      const row = await trx
        .insertInto('platform.entitlement')
        .values({ organization_id: orgId, ...columnsOf(values), updated_by: actor.userId })
        .onConflict((oc) => oc.column('organization_id').doNothing())
        .returning([...ENTITLEMENT_COLUMNS])
        .executeTakeFirst();
      if (!row) return null;
      const record = recordOf(row as EntitlementDbRow);
      await this.recorded(trx, record, null, change, actor);
      return record;
    });
  }

  /** The audit entry, the change notice and the drop of this process's cache entry after the commit. */
  private async recorded(
    trx: Trx,
    row: EntitlementRecord,
    before: EntitlementRecord | null,
    change: EntitlementChange,
    actor: { userId: string | null; kind: ActorKind },
  ): Promise<void> {
    await this.audit?.record(trx, {
      action: 'ops.entitlements_changed',
      // A command of the operator has no user (actor kind `operator`, no id); the system acts as the system user.
      actor: { userId: actor.userId ?? (actor.kind === 'system' ? SYSTEM_USER_ID : null), kind: actor.kind },
      organizationId: row.organizationId,
      entityType: 'entitlement',
      entityId: row.organizationId,
      entityCode: change.slug ?? null,
      before: before ? { ...auditValues(valuesOf(before)), version: before.version } : null,
      after: { ...auditValues(valuesOf(row)), version: row.version, reason: change.reason },
    });
    await publishTenantChange(trx, row.organizationId);
    const registry = this.registry;
    if (!registry) return;
    if (acceptsAfterCommit(trx)) afterCommit(trx, () => registry.invalidate(row.organizationId));
    else registry.invalidate(row.organizationId);
  }

  private actorOf(change: EntitlementChange): { userId: string | null; kind: ActorKind } {
    if (change.actor) return change.actor;
    const context = currentRequestContext();
    return context?.userId ? { userId: context.userId, kind: context.actorKind ?? 'user' } : { userId: null, kind: 'system' };
  }
}

/** The table columns of a value set (lists without duplicates, in a stable order). */
function columnsOf(values: EntitlementValues) {
  const unique = <T extends string>(x: readonly T[]) => [...new Set(x)].sort();
  return {
    plan: values.plan,
    source: values.source,
    max_users: values.maxUsers,
    max_management_systems: values.maxManagementSystems,
    frameworks: unique(values.frameworks),
    storage_adapters: unique(values.storageAdapters),
    features: unique(values.features),
    rate_user_per_minute: values.rateUserPerMinute,
    rate_org_per_minute: values.rateOrgPerMinute,
    valid_from: values.validFrom,
    valid_until: values.validUntil,
    grace_days: values.graceDays,
  };
}
