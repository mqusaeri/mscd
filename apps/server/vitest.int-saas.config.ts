import type { UserConfig } from 'vitest/config';
import { MULTI_TENANCY_SUITES, OPERATOR_SUITES, SAAS_RUN_VARIABLE } from './test/setup/tenancy';
import base from './vitest.int.config';

// Integration tests of the SaaS run (Milestone 2 plan K.6, M2-S13): `npm run test:int:saas -w @mscd/server`.
//
// The suites that guard the boundaries between organisations and roles (security, rbac, contract) run with tenancy
// mode multi and schema isolation, as `profiles/saas.yaml` runs a SaaS server: the setup file test/setup/saas-run.ts
// sets the profile overrides for their test files. The suites of the operator's organisation lifecycle (saas-ops,
// entitlements, domains) run as in `test:int`: each of their tests sets tenancy mode multi itself, and their
// single-tenancy tests check the on-premise refusals. The global setup builds the multi-tenancy template (the demo
// template seeded with tenancy multi, at least two organisations) on a PostgreSQL container of its own
// (test/setup/global-db.ts). Everything else is vitest.int.config.ts.
process.env[SAAS_RUN_VARIABLE] = 'multi';

const test = base.test ?? {};
const setupFiles = test.setupFiles === undefined ? [] : Array.isArray(test.setupFiles) ? test.setupFiles : [test.setupFiles];

const config: UserConfig = {
  ...base,
  test: {
    ...test,
    include: [...MULTI_TENANCY_SUITES, ...OPERATOR_SUITES].map((suite) => `test/int/${suite}/**/*.test.ts`),
    setupFiles: [...setupFiles, 'test/setup/saas-run.ts'],
    env: { ...(test.env ?? {}), [SAAS_RUN_VARIABLE]: 'multi' },
  },
};

export default config;
