// Organisation resolution (build plan F.7, F.10): slug or id to organisation, schema and status, cached for 60
// seconds. Every status change made through the command line or the operator routes calls `invalidate(orgId)`, so a
// suspended organisation is refused within the request that follows the change in this process.
//
// Other processes (Milestone 2 K.6, M2-S09): a status change, like every change of cached organisation data, sends the
// change notice `mscd_tenant_changed` in its transaction (`publishTenantChange` of modules/license/tenant-change.ts).
// Every api and worker process of multi tenancy listens with `TenantChangeListener`, and this resolver drops its entry
// of the organisation when a notice arrives (every entry when the listener reconnected and notices may be lost), so
// the new status counts in every process within moments instead of up to 60 seconds. Processes without the listener
// (single tenancy, commands, test applications) keep the 60 second expiry.
import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { NotFoundError } from '../../common/problems';
import type { OrgTimeZoneLookup } from '../../common/clock';
import { DEFAULT_TIME_ZONE } from '../../common/clock';
import type { TenantInfo } from '../../common/tokens';
import { DATABASE, type AppDatabase } from '../../db/database.module';
import { TenantChangeListener } from '../license/tenant-change';

export const TENANT_CACHE_TTL_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z][a-z0-9_]{1,39}$/;

interface CacheEntry {
  info: TenantInfo;
  expiresAt: number;
}

@Injectable()
export class TenantResolver implements OrgTimeZoneLookup, OnModuleInit, OnModuleDestroy {
  private readonly byId = new Map<string, CacheEntry>();
  private readonly bySlug = new Map<string, CacheEntry>();
  private unsubscribe?: () => void;
  /**
   * Counts the invalidations. A load that started before one returns what it read but does not cache it: its read may
   * come from before the change that the invalidation reports (a notice that arrives while the row is being read).
   */
  private invalidations = 0;

  constructor(
    @Inject(DATABASE) private readonly db: AppDatabase,
    @Optional() private readonly changes?: TenantChangeListener,
  ) {}

  /** Drops cached organisations on the change notices of other processes (see the top of this file). */
  onModuleInit(): void {
    this.unsubscribe = this.changes?.subscribe((orgId) => (orgId === null ? this.invalidateAll() : this.invalidate(orgId)));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** The organisation with this id or slug (not deleted), or null. */
  async resolve(slugOrId: string): Promise<TenantInfo | null> {
    if (UUID.test(slugOrId)) return this.resolveById(slugOrId.toLowerCase());
    if (SLUG.test(slugOrId)) return this.resolveBySlug(slugOrId);
    return null;
  }

  /** The organisation with this id or slug; 404 `not-found` when there is none. */
  async require(slugOrId: string): Promise<TenantInfo> {
    const info = await this.resolve(slugOrId);
    if (!info) throw new NotFoundError('Unknown organisation');
    return info;
  }

  async resolveById(id: string): Promise<TenantInfo | null> {
    const cached = this.fresh(this.byId.get(id));
    if (cached) return cached;
    return this.load('id', id);
  }

  async resolveBySlug(slug: string): Promise<TenantInfo | null> {
    const cached = this.fresh(this.bySlug.get(slug));
    if (cached) return cached;
    return this.load('slug', slug);
  }

  /** Drops the cache entry of an organisation (call on every status or settings change, F.7). */
  invalidate(orgId: string): void {
    this.invalidations += 1;
    const entry = this.byId.get(orgId);
    this.byId.delete(orgId);
    if (entry) this.bySlug.delete(entry.info.slug);
    for (const [slug, e] of this.bySlug) if (e.info.id === orgId) this.bySlug.delete(slug);
  }

  /** Drops every cache entry (test reset, D.3 Test support). */
  invalidateAll(): void {
    this.invalidations += 1;
    this.byId.clear();
    this.bySlug.clear();
  }

  /** `OrgTimeZoneLookup` for the clock: the organisation's time zone, the C.4 default when it is unknown. */
  async timeZoneOf(orgId: string): Promise<string> {
    return (await this.resolveById(orgId))?.timeZone ?? DEFAULT_TIME_ZONE;
  }

  private fresh(entry: CacheEntry | undefined): TenantInfo | null {
    return entry && entry.expiresAt > Date.now() ? entry.info : null;
  }

  private async load(by: 'id' | 'slug', value: string): Promise<TenantInfo | null> {
    const started = this.invalidations;
    const row = await this.db
      .selectFrom('platform.organization')
      .select(['id', 'slug', 'name', 'schema_name', 'status', 'time_zone', 'local_login', 'demo_deploy_label', 'site_count', 'position'])
      .where(by, '=', value)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    const info: TenantInfo = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      schema: row.schema_name,
      status: row.status,
      timeZone: row.time_zone,
      localLogin: row.local_login,
      demoDeployLabel: row.demo_deploy_label,
      siteCount: row.site_count,
      position: row.position,
    };
    if (this.invalidations !== started) return info;
    const entry: CacheEntry = { info, expiresAt: Date.now() + TENANT_CACHE_TTL_MS };
    this.byId.set(info.id, entry);
    this.bySlug.set(info.slug, entry);
    return info;
  }
}
