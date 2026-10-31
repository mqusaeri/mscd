// Helpers of the access review tests (Milestone 3 D.9, M3-07): an api application on the demo template with the
// administration, guest auditor, file, storage, jobs and access review modules against a real storage gateway on
// SeaweedFS (the report and the evidence files go to the test's own bucket), the `access-review.open` job called in
// process, a settable "today" (the clock's fixed date), clients signed in as demo users, and fixture queries.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import type { RawBuilder } from 'kysely';
import { Logger } from 'nestjs-pino';
import { Clock } from '../../../src/common/clock';
import { AccessReviewOpenJob } from '../../../src/modules/access-reviews/access-review-open.job';
import type { DailyResult } from '../../../src/modules/access-reviews/access-review-open.service';
import { AccessReviewsModule } from '../../../src/modules/access-reviews/access-reviews.module';
import { AdminUsersModule } from '../../../src/modules/admin-users/admin-users.module';
import { AuditModule } from '../../../src/modules/audit/audit.module';
import { AuditorAccessModule } from '../../../src/modules/auditor-access/auditor-access.module';
import { AuthzModule } from '../../../src/modules/authz/authz.module';
import { FilesModule } from '../../../src/modules/files/files.module';
import { IdentityModule } from '../../../src/modules/identity/identity.module';
import { SessionService } from '../../../src/modules/identity/session.service';
import { JobsModule } from '../../../src/modules/jobs/jobs.module';
import { KeysModule } from '../../../src/modules/keys/keys.module';
import { LicenseModule } from '../../../src/modules/license/license.module';
import { configureHttpApplication, fastifyAdapterOptions } from '../../../src/modules/platform/http-app';
import { StorageModule } from '../../../src/modules/storage/storage.module';
import { TenancyModule } from '../../../src/modules/tenancy/tenancy.module';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import type { TestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { ORG_IDS, inOrg, signIn, userId, type DemoOrg, type FilesClient } from '../files/helpers';
import { JOB_TEST_ENV } from '../jobs/helpers';

export { ORG_IDS, inOrg, signIn, userId, type DemoOrg, type FilesClient };

export interface ReviewApp {
  app: NestFastifyApplication;
  moduleRef: TestingModule;
  /** Sets the organisation's "today" (`demo.fixed_today`), or back to the profile's date with null. */
  setToday(day: string | null): void;
  /** Runs `access-review.open` for a demo organisation on today's date. */
  daily(org: DemoOrg): Promise<DailyResult>;
  close(): Promise<void>;
}

/** The api modules of the access review routes and job on the test profile (demo mode, `demo.fixed_today` 2026-09-29). */
export async function createReviewApp(db: TestDatabase, gatewayUrl: string): Promise<ReviewApp> {
  const settings = { ...JOB_TEST_ENV, MSCD__MAIL__SMTP__PORT: '9', MSCD__STORAGE__GATEWAY__URL: gatewayUrl };
  const config = db.config(settings);
  const moduleRef = await db
    .createTestingModule(
      {
        imports: [
          TenancyModule, AuditModule, KeysModule, AuthzModule, IdentityModule, LicenseModule, StorageModule, FilesModule, JobsModule, AdminUsersModule,
          AuditorAccessModule, AccessReviewsModule,
        ],
      },
      settings,
    )
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyAdapterOptions(config)), { logger: false });
  app.useLogger(app.get(Logger));
  await configureHttpApplication(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const clock = moduleRef.get(Clock);
  const profileToday = clock.fixedToday;
  let today: string | null = null;
  Object.defineProperty(clock, 'fixedToday', { configurable: true, get: () => today ?? profileToday });
  return {
    app,
    moduleRef,
    setToday: (day) => {
      today = day;
    },
    daily: async (org) => (await moduleRef.get(AccessReviewOpenJob).run(ORG_IDS[org]))!,
    close: () => app.close(),
  };
}

/** Rows of a raw query in a demo organisation. */
export async function rowsOf<T>(db: TestDatabase, org: DemoOrg, query: RawBuilder<T>): Promise<T[]> {
  return inOrg(db, org, async (trx) => (await query.execute(trx)).rows);
}

/** Rows of a raw query with platform scope. */
export async function platformRows<T>(db: TestDatabase, query: RawBuilder<T>): Promise<T[]> {
  return inScope(db.migrator, { platformScope: true }, async (trx) => (await query.execute(trx)).rows);
}

/** An enabled OIDC provider of a demo organisation (no discovery is made: the tests never sign in through it). */
export async function insertProvider(db: TestDatabase, org: DemoOrg, slug: string): Promise<string> {
  return inScope(db.migrator, { platformScope: true }, async (trx) => {
    const row = await trx
      .insertInto('platform.identity_provider')
      .values({
        organization_id: ORG_IDS[org], slug, kind: 'oidc', display_name: `Sign in with ${slug}`, icon: 'generic', enabled: true,
        oidc_issuer: `https://${slug}.idp.test/realms/mscd`, oidc_client_id: 'mscd', require_mfa_claim: true, mfa_fallback: 'local_totp',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/** A linked company sign-in of a user through a provider. */
export async function linkIdentity(db: TestDatabase, providerId: string, user: string, subject: string): Promise<void> {
  await inScope(db.migrator, { platformScope: true }, (trx) =>
    trx.insertInto('platform.user_identity').values({ identity_provider_id: providerId, subject, user_id: user, link_method: 'admin' }).execute(),
  );
}

/** An active session of a user in an organisation signed in through a provider; returns its id hash in hex. */
export async function providerSession(ctx: ReviewApp, org: DemoOrg, user: string, providerId: string): Promise<string> {
  const issued = await ctx.moduleRef.get(TenantScope).withTenant({ orgId: ORG_IDS[org], schema: `org_${org}`, userId: user }, (trx) =>
    ctx.moduleRef.get(SessionService).create(trx, {
      userId: user, organizationId: ORG_IDS[org], authOrgId: ORG_IDS[org], state: 'active', authMethod: 'oidc', identityProviderId: providerId,
      passwordAt: null, mfaAt: new Date(),
    }),
  );
  return issued.row.id_hash.toString('hex');
}
