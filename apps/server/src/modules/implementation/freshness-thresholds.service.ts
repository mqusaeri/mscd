// Freshness limits per evidence frequency of a system (Milestone 2 D.1 `freshness.thresholds.get` and
// `freshness.thresholds.put`, E.3). The limits in force for a frequency are the system's own row of
// `freshness_threshold`, else the organisation-wide row (`management_system_id` null), else the built-in defaults of
// `read-model/derive/freshness.ts`. Organisation-wide rows are not set on screen (Milestone 2 B). Setting a system's
// limits upserts its row on the unique index; resetting soft deletes it. Every change is audited with its before and
// after values and queues `freshness.recompute` for the system, so stored freshness follows the new limits.
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, FreshnessThresholdItem, FreshnessThresholdSet } from '@mscd/shared';
import { sql } from 'kysely';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, RECORD_RESOLVER, type AuditWriter, type MsRef, type Principal, type RecordResolver, type Trx } from '../../common/tokens';
import { DEFAULT_THRESHOLDS } from '../read-model/derive/freshness';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { commandResult, enqueueFreshness, orgOf } from './command-support';

/** Values of one stored threshold row as numbers. */
interface StoredThreshold {
  id: string;
  management_system_id: string | null;
  frequency_code: string;
  fresh_grace_days: string;
  aging_factor: string;
  expired_factor: string;
}

/** The three limits of a frequency (the wire names of `FreshnessThresholdItem`). */
export interface ThresholdValues {
  graceDays: number;
  agingFactor: number;
  expiredFactor: number;
}

function valuesOf(row: Pick<StoredThreshold, 'fresh_grace_days' | 'aging_factor' | 'expired_factor'>): ThresholdValues {
  return { graceDays: Number(row.fresh_grace_days), agingFactor: Number(row.aging_factor), expiredFactor: Number(row.expired_factor) };
}

const DEFAULT_VALUES: ThresholdValues = {
  graceDays: DEFAULT_THRESHOLDS.grace,
  agingFactor: DEFAULT_THRESHOLDS.aging,
  expiredFactor: DEFAULT_THRESHOLDS.expired,
};

@Injectable()
export class FreshnessThresholdsService {
  constructor(
    private readonly tenancy: TenantScope,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/freshness-thresholds
  // -------------------------------------------------------------------------------------------------------------

  /** The limits in force for every frequency of the system's edition, in pack order, marked `set` or `default`. */
  async list(principal: Principal, ms: string): Promise<FreshnessThresholdItem[]> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const frequencies = await this.frequencies(trx, system);
      const rows = await this.storedRows(trx, system.id, false);
      return frequencies.map((code) => {
        const own = rows.find((r) => r.management_system_id === system.id && r.frequency_code === code);
        if (own) return { frequencyCode: code, ...valuesOf(own), source: 'set' as const };
        const org = rows.find((r) => r.management_system_id === null && r.frequency_code === code);
        return { frequencyCode: code, ...(org ? valuesOf(org) : DEFAULT_VALUES), source: 'default' as const };
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // PUT /ms/{ms}/freshness-thresholds/{frequencyCode}
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Sets the system's limits of one frequency (upsert on `freshness_threshold_uq`), or with all values null resets
   * them to the default (soft delete). 404 for a frequency the edition does not define. The schema already checks
   * aging at least 1 and expired at least aging, the CHECK of the table.
   */
  async set(principal: Principal, ms: string, frequencyCode: string, body: FreshnessThresholdSet): Promise<CommandResult> {
    const org = orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      if (!(await this.frequencies(trx, system)).includes(frequencyCode)) {
        throw new NotFoundError(`Frequency ${frequencyCode} is not defined by the edition in use`);
      }
      const rows = await this.storedRows(trx, system.id, true);
      const own = rows.find((r) => r.management_system_id === system.id && r.frequency_code === frequencyCode) ?? null;
      const org_ = rows.find((r) => r.management_system_id === null && r.frequency_code === frequencyCode) ?? null;
      const inForce = own ? valuesOf(own) : org_ ? valuesOf(org_) : DEFAULT_VALUES;
      const before = { frequency_code: frequencyCode, source: own ? 'set' : 'default', ...inForce };

      let after: Record<string, unknown>;
      let changed: boolean;
      let entityId = own?.id ?? null;
      if (body.graceDays === null) {
        changed = own !== null;
        if (own) {
          await sql`update freshness_threshold set deleted_at = now(), updated_at = now(), updated_by = ${actor} where id = ${own.id}`.execute(trx);
        }
        after = { frequency_code: frequencyCode, source: 'default', ...(org_ ? valuesOf(org_) : DEFAULT_VALUES) };
      } else {
        // Stored at the scale of the columns (numeric(6,2) and numeric(6,3)), so a repeated request changes nothing.
        const wanted: ThresholdValues = { graceDays: round(body.graceDays, 2), agingFactor: round(body.agingFactor, 3), expiredFactor: round(body.expiredFactor, 3) };
        changed = !own || !sameValues(valuesOf(own), wanted);
        if (changed) {
          const { rows: upserted } = await sql<{ id: string }>`
            insert into freshness_threshold (management_system_id, frequency_code, fresh_grace_days, aging_factor, expired_factor, created_by, updated_by)
            values (${system.id}, ${frequencyCode}, ${wanted.graceDays}, ${wanted.agingFactor}, ${wanted.expiredFactor}, ${actor}, ${actor})
            on conflict (management_system_id, frequency_code) where deleted_at is null
            do update set fresh_grace_days = excluded.fresh_grace_days, aging_factor = excluded.aging_factor,
                          expired_factor = excluded.expired_factor, updated_at = now(), updated_by = excluded.updated_by
            returning id`.execute(trx);
          entityId = upserted[0]?.id ?? entityId;
        }
        after = { frequency_code: frequencyCode, source: 'set', ...wanted };
      }
      if (!changed) return commandResult([system.slug], { message: ['Nothing to change', 'Tidak ada yang diubah'] });
      await this.audit.record(trx, {
        action: 'freshness_threshold.changed',
        msId: system.id,
        entityType: 'freshness_threshold',
        entityId,
        entityCode: frequencyCode,
        before,
        after,
      });
      // E.3: stored freshness of the system's evidence and entries follows the new limits.
      await enqueueFreshness(this.queue, trx, org, system.id, {}, actor);
      return commandResult([system.slug], { data: { frequencyCode, source: after.source, graceDays: after.graceDays, agingFactor: after.agingFactor, expiredFactor: after.expiredFactor } });
    });
  }

  /** Frequency codes of the system's active edition (`ref.evidence_frequency_rule`), in pack order. */
  private async frequencies(trx: Trx, system: MsRef): Promise<string[]> {
    const { rows } = await sql<{ code: string }>`
      select f.code from ref.evidence_frequency_rule f join management_system m on m.framework_version_id = f.framework_version_id
       where m.id = ${system.id} order by f.sort_order, f.code`.execute(trx);
    return rows.map((r) => r.code);
  }

  /** Live threshold rows of the system and of the organisation; locked for a change. */
  private async storedRows(trx: Trx, msId: string, lock: boolean): Promise<StoredThreshold[]> {
    const { rows } = await sql<StoredThreshold>`
      select id, management_system_id, frequency_code, fresh_grace_days, aging_factor, expired_factor from freshness_threshold
       where deleted_at is null and (management_system_id is null or management_system_id = ${msId})
       ${lock ? sql`for update` : sql``}`.execute(trx);
    return rows;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sameValues(a: ThresholdValues, b: ThresholdValues): boolean {
  return a.graceDays === b.graceDays && a.agingFactor === b.agingFactor && a.expiredFactor === b.expiredFactor;
}
