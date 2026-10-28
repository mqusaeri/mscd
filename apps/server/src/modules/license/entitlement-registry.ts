// The entitlement registry of one process (Milestone 2 K.6, M2-S10): the `platform.entitlement` row of each
// organisation, cached for up to 60 seconds. The licence gate's request-path checks (read-only mode, features,
// adapters through `LicenceService.evaluateOrg`), the operations metrics (`mscd_licence_days_left`) and the rate limits
// per organisation read it here. A change notice (`mscd_tenant_changed`, tenant-change.ts) drops the organisation's
// entry in every process, and the writing process drops its own entry after the commit, so a change counts at once
// and the 60 seconds only bound a lost notice. Checks inside a transaction (the user and system limits under their
// lock) read the row in that transaction instead.
//
// Single tenancy has no entitlements: the registry answers null without reading anything.
import { Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { MscdConfig } from '../../config/mscd-config';
import type { OrgRateLimitSource, OrgRateLimits } from '../tenancy/rate-limit-store';
import { TenantScope } from '../tenancy/tenant-scope';
import { readEntitlement, type EntitlementRecord } from './entitlement-row';
import { TenantChangeListener } from './tenant-change';

/** Longest time an entry is used before the row is read again (the bound of a lost change notice). */
export const ENTITLEMENT_CACHE_TTL_MS = 60_000;

interface Entry {
  row: EntitlementRecord | null;
  expiresAt: number;
}

@Injectable()
export class EntitlementRegistry implements OrgRateLimitSource, OnModuleInit, OnModuleDestroy {
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, { generation: string; promise: Promise<EntitlementRecord | null> }>();
  private readonly generations = new Map<string, number>();
  private everything = 0;
  private unsubscribe: (() => void) | null = null;
  /** The clock of the cache (tests move it). */
  now: () => number = () => Date.now();

  constructor(
    private readonly config: MscdConfig,
    @Optional() private readonly scope?: TenantScope,
    @Optional() private readonly changes?: TenantChangeListener,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.changes?.subscribe((orgId) => this.invalidate(orgId)) ?? null;
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** True when entitlements are the effective licences (tenancy.mode multi). */
  get active(): boolean {
    return this.config.profile.tenancy.mode === 'multi';
  }

  /** The entitlement row of an organisation (null: no row, or single tenancy), from the cache when it is fresh. */
  async get(orgId: string): Promise<EntitlementRecord | null> {
    if (!this.active || !this.scope) return null;
    const cached = this.entries.get(orgId);
    if (cached && cached.expiresAt > this.now()) return cached.row;
    const generation = this.generationOf(orgId);
    const pending = this.loading.get(orgId);
    if (pending && pending.generation === generation) return pending.promise;
    const scope = this.scope;
    const promise = scope
      .withPlatform((trx) => readEntitlement(trx, orgId), { scope: 'auth' })
      .then((row) => {
        // A change notice that arrived during the read makes this value stale: it is returned, not kept.
        if (this.generationOf(orgId) === generation) this.entries.set(orgId, { row, expiresAt: this.now() + ENTITLEMENT_CACHE_TTL_MS });
        return row;
      })
      .finally(() => {
        if (this.loading.get(orgId)?.promise === promise) this.loading.delete(orgId);
      });
    this.loading.set(orgId, { generation, promise });
    return promise;
  }

  /** The cached row without reading (undefined: nothing cached or the entry is too old). */
  peek(orgId: string): EntitlementRecord | null | undefined {
    const cached = this.entries.get(orgId);
    return cached && cached.expiresAt > this.now() ? cached.row : undefined;
  }

  /** Drops the entry of an organisation, or every entry with null. */
  invalidate(orgId: string | null): void {
    if (orgId === null) {
      this.everything += 1;
      this.entries.clear();
      return;
    }
    this.generations.set(orgId, (this.generations.get(orgId) ?? 0) + 1);
    this.entries.delete(orgId);
  }

  /** The rate limits per organisation of its entitlement (`ORG_RATE_LIMITS`, F.3); null keeps the defaults. */
  async limitsFor(orgId: string): Promise<OrgRateLimits | null> {
    const row = await this.get(orgId);
    if (!row) return null;
    return { userPerMinute: row.rateUserPerMinute, orgPerMinute: row.rateOrgPerMinute };
  }

  private generationOf(orgId: string): string {
    return `${this.everything}:${this.generations.get(orgId) ?? 0}`;
  }
}
