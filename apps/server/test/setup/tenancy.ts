// Tenancy of an integration test run (Milestone 2 plan K.6, M2-S13).
//
// `npm run test:int` runs every suite with the test profile, whose tenancy mode is single (one organisation per
// installation, as on-premise). `npm run test:int:saas` (vitest.int-saas.config.ts) runs the suites that guard the
// boundaries between organisations and roles (security, rbac, contract) again with tenancy mode multi and schema
// isolation, as `profiles/saas.yaml` runs a SaaS server: the setup file `saas-run.ts` sets the two profile overrides
// below in the environment of those test files, and the configuration of every test database (`db.config()` of
// test-db.ts, `createFullApp` of the contract harness) reads them from there. A test that passes its own tenancy
// variables keeps them.

/** The tenancy modes of the profile (`tenancy.mode`). */
export type TestTenancy = 'single' | 'multi';

/** Variable the SaaS run sets for its global setup and workers (vitest.int-saas.config.ts). */
export const SAAS_RUN_VARIABLE = 'MSCD_TEST_TENANCY';

/** Multi tenancy with schema isolation, as saas.yaml runs (MSCD__<SECTION>__<KEY> overrides of the test profile). */
export const MULTI_TENANCY_ENV = { MSCD__TENANCY__MODE: 'multi', MSCD__TENANCY__ISOLATION: 'schema' } as const;

/** The suites (folders of test/int) that the SaaS run runs with tenancy mode multi. */
export const MULTI_TENANCY_SUITES = ['security', 'rbac', 'contract'] as const;

/** The suites of the operator's organisation lifecycle that the SaaS run adds; they set the tenancy of each test. */
export const OPERATOR_SUITES = ['saas-ops', 'entitlements', 'domains'] as const;

/** True in the SaaS run (`npm run test:int:saas`), in the global setup and in every test file of the run. */
export function isSaasRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SAAS_RUN_VARIABLE] === 'multi';
}

/**
 * The tenancy mode the configuration of the current test file reads by default: multi when the profile override is
 * set (the SaaS run sets it for the suites of MULTI_TENANCY_SUITES), else the single tenancy of the test profile.
 */
export function testTenancy(env: NodeJS.ProcessEnv = process.env): TestTenancy {
  return env.MSCD__TENANCY__MODE === 'multi' ? 'multi' : 'single';
}

/** The suite (first folder below test/int) of a test file path, or null for a file outside test/int. */
export function suiteOf(file: string): string | null {
  const match = /[\\/]test[\\/]int[\\/]([^\\/]+)[\\/]/.exec(file);
  return match ? match[1]! : null;
}
