// The test routes of D.3 "Test support" (WP-27, J.6): `POST /test/reset` puts the api back to the seed state between
// end-to-end tests, and `POST /test/session` signs a user in without a password or second factor. Both exist only
// when the profile has `demo.enabled` and `test.endpoints_enabled` (the release flavour refuses both keys at start-up,
// and the authorisation guard answers 404 for test routes otherwise); this service checks again.
//
// The reset recreates the database only when the write tracker saw a write since the last reset (M2-21,
// `write-tracker.ts`); otherwise it deletes the sessions `POST /test/session` minted and answers at once. The mock
// providers and the in-memory caches are reset every time, since a test may change the mock providers directly.
import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Me, TestResetResponse, TestSessionRequest } from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Clock } from '../../common/clock';
import { DependencyUnavailableError, NotFoundError } from '../../common/problems';
import { ME_ASSEMBLER, SYSTEM_USER_ID, type MeAssembler, type Principal } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { NO_ORGANISATION } from '../authz/authz-infra';
import { SessionService } from '../identity/session.service';
import { OidcDiscovery } from '../identity/oidc/discovery';
import { sha256 } from '../identity/tokens';
import { LicenceService } from '../license/licence.service';
import { PackInstallerDatabase } from '../packs/pack-installer.service';
import { TenantResolver } from '../tenancy/tenant-resolver';
import { TenantScope } from '../tenancy/tenant-scope';
import { closeKeptConnections, databaseOf, deleteSessions, recreateDatabase } from './database-reset';
import { TestRequestGate } from './request-gate';
import { testEndpointsEnabled } from './test-mode';
import { TestWriteTracker } from './write-tracker';

/** How long the reset waits for running requests before it goes on. */
const DRAIN_TIMEOUT_MS = 15_000;
/** How long the mock providers may take to answer their reset. */
const MOCK_RESET_TIMEOUT_MS = 10_000;
/** Rounds of the pool check after the database was recreated. */
const POOL_CHECK_ROUNDS = 5;

/** Hosts of the real provider APIs: never sent a mock reset. */
const REAL_PROVIDER_HOSTS = new Set(['graph.microsoft.com', 'login.microsoftonline.com', 'www.googleapis.com', 'oauth2.googleapis.com']);

@Injectable()
export class TestSupportService implements OnApplicationShutdown {
  private readonly logger = new Logger('TestSupport');
  /** Resets run one after the other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: MscdConfig,
    private readonly gate: TestRequestGate,
    private readonly scope: TenantScope,
    private readonly tenants: TenantResolver,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
    private readonly tracker: TestWriteTracker,
    @Inject(ME_ASSEMBLER) private readonly me: MeAssembler,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** The kept administrator connection of the resets without a write is closed when the api stops. */
  async onApplicationShutdown(): Promise<void> {
    await closeKeptConnections();
  }

  /** `POST /test/reset`. */
  reset(): Promise<TestResetResponse> {
    const run = this.queue.then(() => this.resetNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** `POST /test/session`: an active session of `handle` (auth method `test`, no MFA) and its `Me`. */
  async session(request: FastifyRequest, reply: FastifyReply, body: TestSessionRequest): Promise<Me> {
    this.assertEnabled();
    const user = await this.scope.withTenant({ ...NO_ORGANISATION, userId: SYSTEM_USER_ID }, (trx) =>
      trx
        .selectFrom('platform.app_user')
        .select(['id', 'handle', 'email', 'display_name', 'job_title', 'kind'])
        .where('handle', '=', body.handle)
        .where('status', '=', 'active')
        .where('kind', '=', 'person')
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    );
    if (!user) throw new NotFoundError('No active user with this handle');

    const wanted = body.org ? await this.tenants.resolveBySlug(body.org) : null;
    if (body.org && !wanted) throw new NotFoundError('Unknown organisation');
    // Own membership rows are visible to the user without an organisation (C.4 policy `user_id = app.user_id`).
    const membership = await this.scope.withTenant({ ...NO_ORGANISATION, userId: user.id }, (trx) => {
      let query = trx
        .selectFrom('platform.org_membership')
        .select('organization_id')
        .where('user_id', '=', user.id)
        .where('status', '=', 'active')
        .where('deleted_at', 'is', null);
      if (wanted) query = query.where('organization_id', '=', wanted.id);
      return query.orderBy('is_default', 'desc').orderBy('created_at').executeTakeFirst();
    });
    if (!membership) throw new NotFoundError('The user has no active membership in this organisation');
    const org = wanted ?? (await this.tenants.resolveById(membership.organization_id));
    if (!org || org.status !== 'active') throw new NotFoundError('The organisation is not active');

    const presented = this.sessions.readCookie(request);
    const now = this.clock.now();
    const issued = await this.scope.withTenant({ orgId: org.id, schema: org.schema, userId: user.id }, async (trx) => {
      if (presented) await this.sessions.revoke(trx, sha256(presented), 'signed_in_again');
      return this.sessions.create(trx, {
        userId: user.id,
        organizationId: org.id,
        authOrgId: org.id,
        state: 'active',
        authMethod: 'test',
        passwordAt: now,
        mfaAt: now,
      });
    });
    this.tracker.rememberSession(issued.row.id_hash);
    this.sessions.setCookie(reply, issued);
    const principal: Principal = {
      user: { id: user.id, handle: user.handle, email: user.email, displayName: user.display_name, jobTitle: user.job_title, kind: user.kind },
      org,
      session: this.sessions.principalSession(issued.row),
    };
    return this.me.assemble(principal, { csrfToken: issued.csrfToken });
  }

  private assertEnabled(): void {
    if (!testEndpointsEnabled(this.config)) throw new NotFoundError();
  }

  private async resetNow(): Promise<TestResetResponse> {
    this.assertEnabled();
    const test = this.config.profile.test;
    if (!test?.template_database || !test.admin_database_url_file) {
      throw new DependencyUnavailableError('test.template_database and test.admin_database_url_file are required for a reset');
    }
    const started = Date.now();
    await this.gate.closeAndDrain(DRAIN_TIMEOUT_MS);
    try {
      // The mock providers reset while the database is put back (they do not depend on each other); the reset answers
      // when both are done.
      const mock = this.resetMockProviders();
      mock.catch(() => undefined);
      try {
        await this.resetDatabase(test.admin_database_url_file, test.template_database);
      } catch (error) {
        await mock.catch(() => undefined);
        throw error;
      }
      this.tracker.resetDone();
      await mock;
      this.clearCaches();
    } finally {
      this.gate.open();
    }
    return { ok: true, durationMs: Date.now() - started };
  }

  /**
   * Puts the database back to the template state: recreated after a write, else only the sessions this service minted
   * are deleted.
   */
  private async resetDatabase(adminUrlFile: string, template: string): Promise<void> {
    const adminUrl = this.config.readSecretFile(adminUrlFile, 'test.admin_database_url_file');
    const database = databaseOf(this.config.databaseUrl('app'));
    const changedBy = this.tracker.changedBy;
    if (changedBy !== null) {
      this.logger.debug(`Test reset recreates the database (first write since the last reset: ${changedBy})`);
      // The pack installer pool opens again on its next use; the app pool is checked below.
      await this.optional(PackInstallerDatabase)?.onApplicationShutdown();
      try {
        await recreateDatabase({ adminUrl, database, template });
      } catch (error) {
        this.logger.error(`Test reset: the database could not be recreated: ${(error as Error).message}`);
        throw new DependencyUnavailableError('The database could not be recreated from the template', { cause: error });
      }
      await this.checkAppPool();
    } else {
      // Nothing wrote since the last reset: only the sessions this service minted differ from the template.
      try {
        await deleteSessions({ adminUrl, database, idHashes: this.tracker.mintedSessions() });
      } catch (error) {
        this.logger.error(`Test reset: the minted sessions could not be deleted: ${(error as Error).message}`);
        throw new DependencyUnavailableError('The sessions of the last test could not be deleted', { cause: error });
      }
    }
  }

  /**
   * The app pool keeps its object (every module holds the same `Kysely`), so the connections the drop ended are
   * removed instead: idle clients leave the pool on their termination error, and every connection the pool still
   * hands out is checked by the F.10 checkout guard (every checkout in test profiles), which destroys a dead one.
   * Rounds of `pool_max` parallel transactions run until one round passes completely.
   */
  private async checkAppPool(): Promise<void> {
    const width = this.config.profile.database.pool_max;
    let failures = 0;
    for (let round = 1; round <= POOL_CHECK_ROUNDS; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      const results = await Promise.allSettled(
        Array.from({ length: width }, () => this.scope.withTenant({ ...NO_ORGANISATION, userId: SYSTEM_USER_ID }, async () => undefined)),
      );
      failures = results.filter((r) => r.status === 'rejected').length;
      if (failures === 0) return;
    }
    throw new DependencyUnavailableError(`The database pool still fails after the reset (${failures} of ${width} connections)`);
  }

  /** `POST /_admin/reset` of the mock providers: their state goes back to the fixtures they were started with. */
  private async resetMockProviders(): Promise<void> {
    if (!this.config.profile.storage.adapters.enabled.some((a) => a === 'm365' || a === 'google_drive')) return;
    const base = new URL(this.config.profile.gateway.providers.m365.graph_base_url);
    if (REAL_PROVIDER_HOSTS.has(base.hostname)) return;
    let response: Response;
    try {
      response = await fetch(`${base.origin}/_admin/reset`, { method: 'POST', signal: AbortSignal.timeout(MOCK_RESET_TIMEOUT_MS) });
    } catch (error) {
      throw new DependencyUnavailableError(`The mock providers at ${base.origin} did not answer the reset`, { cause: error });
    }
    if (!response.ok) throw new DependencyUnavailableError(`The mock providers answered the reset with ${response.status}`);
    await response.arrayBuffer();
  }

  /** In-memory caches that hold database state: organisations, OIDC discovery and verified licences. */
  private clearCaches(): void {
    this.tenants.invalidateAll();
    this.optional(OidcDiscovery)?.clear();
    const licence = this.optional(LicenceService) as unknown as { verified?: Map<string, unknown>; throttle?: Map<string, unknown> } | undefined;
    licence?.verified?.clear();
    licence?.throttle?.clear();
  }

  private optional<T>(type: abstract new (...args: never[]) => T): T | undefined {
    try {
      return this.moduleRef?.get(type as never, { strict: false }) as T | undefined;
    } catch {
      return undefined;
    }
  }
}
