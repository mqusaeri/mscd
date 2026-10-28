// PostgreSQL store of the rate limits (build plan F.3): `platform.rate_limit_bucket`, one fixed window per key,
// incremented with `INSERT ... ON CONFLICT DO UPDATE SET hits = hits + 1`. A key whose window has passed starts a
// new window at its next hit; `cleanup.expired` (WP-22) deletes expired rows. Milestone 2 (M2-S10): the limits per
// organisation and per user of every api request may come from the organisation's entitlement (`ORG_RATE_LIMITS`).
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DATABASE, type AppDatabase } from '../../db/database.module';

export interface RateLimitHit {
  /** Hits in the current window, this one included. */
  current: number;
  /** Milliseconds until the window ends. */
  ttlMs: number;
}

/** Backend of the rate limit plugin's store (`src/modules/platform/rate-limit.ts`). */
export interface RateLimitBackend {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

/** Injection token of the rate limit backend. */
export const RATE_LIMIT_BACKEND = Symbol.for('mscd.rateLimitBackend');

/**
 * Limits per organisation of the requests of every authenticated api request (F.3 `DEFAULT_RATE_LIMITS`, Milestone 2
 * M2-S10): requests per minute of one user and of the whole organisation. Null keeps the default of
 * `DEFAULT_RATE_LIMITS` for that key.
 */
export interface OrgRateLimits {
  userPerMinute: number | null;
  orgPerMinute: number | null;
}

/**
 * Source of the limits per organisation. In multi tenancy the license module answers from the organisation's
 * `platform.entitlement` row (`rate_user_per_minute`, `rate_org_per_minute`) through its cache of up to 60 seconds;
 * null (single tenancy, or no row) keeps every default.
 */
export interface OrgRateLimitSource {
  limitsFor(orgId: string): Promise<OrgRateLimits | null>;
}

/** Injection token of the `OrgRateLimitSource` (provided and exported by the global license module). */
export const ORG_RATE_LIMITS = Symbol.for('mscd.orgRateLimits');

@Injectable()
export class RateLimitBucketStore implements RateLimitBackend {
  constructor(@Inject(DATABASE) private readonly db: AppDatabase) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    if (key.length > 200) throw new Error('Rate limit key longer than 200 characters');
    const window = Math.max(1, Math.trunc(windowMs));
    const { rows } = await sql<{ hits: number; ttl_ms: string }>`
      insert into platform.rate_limit_bucket as b (key, window_start, hits, expires_at)
      values (${key}, clock_timestamp(), 1, clock_timestamp() + ${window} * interval '1 millisecond')
      on conflict (key) do update set
        window_start = case when b.expires_at <= clock_timestamp() then clock_timestamp() else b.window_start end,
        hits = case when b.expires_at <= clock_timestamp() then 1 else b.hits + 1 end,
        expires_at = case when b.expires_at <= clock_timestamp()
                          then clock_timestamp() + ${window} * interval '1 millisecond' else b.expires_at end
      returning hits, greatest(0, ceil(extract(epoch from (expires_at - clock_timestamp())) * 1000))::bigint as ttl_ms`.execute(this.db);
    const row = rows[0]!;
    return { current: Number(row.hits), ttlMs: Number(row.ttl_ms) };
  }

  /** Deletes buckets whose window ended; returns the number of rows removed. */
  async purgeExpired(): Promise<number> {
    const result = await this.db.deleteFrom('platform.rate_limit_bucket').where('expires_at', '<=', sql<Date>`now()`).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
