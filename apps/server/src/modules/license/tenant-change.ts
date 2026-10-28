// Change notices of an organisation across processes (Milestone 2 K.6, M2-S10). A write that changes what other
// processes cache about an organisation (its entitlement here; its status and sessions from M2-S09) calls
// `publishTenantChange(trx, orgId)` in its transaction: `pg_notify('mscd_tenant_changed', orgId)`, which PostgreSQL
// delivers when the transaction commits and drops when it rolls back. Every api and worker process listens on the
// channel with one dedicated connection (`TenantChangeListener`) and hands each notice to its subscribers, which drop
// their cache entry of that organisation. A subscriber gets `null` after the listener (re)connects, because notices
// sent while it was not connected are lost: it then drops every entry.
//
// The writer's own process gets the notice through its listener as well; services that write also drop their own
// entry after the commit, so the writer never reads its old value in the moment before the notice arrives.
import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import pg from 'pg';
import type { Trx } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { TenantScope } from '../tenancy/tenant-scope';

/** The PostgreSQL channel of the change notices; the payload is the organisation id. */
export const TENANT_CHANGED_CHANNEL = 'mscd_tenant_changed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First wait before the listener connects again after a lost connection, doubled up to `MAX_RETRY_MS`. */
const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
/** How long the first connection attempt at start may take before the process starts without it (it keeps trying). */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Sends the change notice of an organisation with the transaction `trx` (delivered on commit). Use it for every write
 * that changes cached organisation data: the entitlement (M2-S10), and the status and sessions (M2-S09).
 */
export async function publishTenantChange(trx: Trx, orgId: string): Promise<void> {
  if (!UUID.test(orgId)) throw new Error(`publishTenantChange: ${JSON.stringify(orgId)} is not an organisation id`);
  await sql`select pg_notify(${TENANT_CHANGED_CHANNEL}, ${orgId.toLowerCase()})`.execute(trx);
}

/** A subscriber: the organisation id of a notice, or null when every organisation may have changed. */
export type TenantChangeHandler = (orgId: string | null) => void;

/**
 * The listener of the change notices of one process. It runs in run modes `api` and `worker` with tenancy.mode multi
 * when the database is loaded; single tenancy (one organisation, no operator changes), commands, the migration and
 * test applications without a database never connect. Losing the connection never stops the process: the listener
 * connects again with a growing wait and tells its subscribers to drop everything once it is back.
 */
@Injectable()
export class TenantChangeListener implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('TenantChanges');
  private readonly subscribers = new Set<TenantChangeHandler>();
  private client: pg.Client | null = null;
  private stopped = false;
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private connectedOnce = false;
  private waiting: (() => void)[] = [];

  constructor(
    private readonly config: MscdConfig,
    @Optional() private readonly scope?: TenantScope,
  ) {}

  /** True when this process listens (api or worker run mode, tenancy.mode multi, with the database). */
  get enabled(): boolean {
    return (
      this.scope !== undefined &&
      this.config.profile.tenancy.mode === 'multi' &&
      (this.config.runMode === 'api' || this.config.runMode === 'worker')
    );
  }

  /** True while the listening connection is up. */
  get connected(): boolean {
    return this.client !== null;
  }

  /** Adds a subscriber; returns the function that removes it. */
  subscribe(handler: TenantChangeHandler): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** Resolves when the listening connection is up (at once when it is, or when this process does not listen). */
  ready(): Promise<void> {
    if (!this.enabled || this.stopped || this.client) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    // Start with the listener when the database answers in time; otherwise go on and keep trying in the background.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CONNECT_TIMEOUT_MS);
      timer.unref();
    });
    await Promise.race([this.connect(), timeout]);
    if (timer) clearTimeout(timer);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    for (const resolve of this.waiting.splice(0)) resolve();
    if (client) await client.end().catch(() => undefined);
  }

  /** Hands a notice to every subscriber; a failing subscriber is logged and does not stop the others. */
  private emit(orgId: string | null): void {
    for (const handler of this.subscribers) {
      try {
        handler(orgId);
      } catch (error) {
        this.logger.error(`A tenant change subscriber failed: ${(error as Error).message}`);
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let connectionString: string;
    try {
      connectionString = this.config.databaseUrl('app');
    } catch (error) {
      // Not reached in api and worker, whose database module needs the same address.
      this.logger.error(`The tenant change listener has no database address: ${(error as Error).message}`);
      return;
    }
    const client = new pg.Client({
      connectionString,
      application_name: `mscd-${this.config.runMode}-tenant-changes`,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // The connection only waits for notices; keep it open through idle firewalls.
      keepAlive: true,
    });
    let lost = false;
    const onLost = (error?: Error) => {
      if (lost) return;
      lost = true;
      if (this.client === client) this.client = null;
      client.removeAllListeners('notification');
      void client.end().catch(() => undefined);
      if (this.stopped) return;
      this.logger.warn(`The tenant change listener lost its database connection${error ? ` (${error.message})` : ''}; it connects again`);
      this.scheduleRetry();
    };
    client.on('error', (error) => onLost(error));
    client.on('end', () => onLost());
    client.on('notification', (message) => {
      if (message.channel !== TENANT_CHANGED_CHANNEL) return;
      const payload = (message.payload ?? '').trim();
      this.emit(UUID.test(payload) ? payload.toLowerCase() : null);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${TENANT_CHANGED_CHANNEL}`);
    } catch (error) {
      onLost(error as Error);
      return;
    }
    if (this.stopped || lost) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.retryMs = FIRST_RETRY_MS;
    // Notices sent while no connection listened are lost: every subscriber drops what it holds.
    if (this.connectedOnce) this.emit(null);
    this.connectedOnce = true;
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
    this.retryTimer.unref();
  }
}
