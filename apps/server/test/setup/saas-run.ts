// Setup file of the SaaS integration run (vitest.int-saas.config.ts, Milestone 2 plan K.6, M2-S13). Vitest runs it in
// each test file's worker before the file is imported.
//
// The files of the boundary suites (security, rbac, contract) get the multi-tenancy overrides of saas.yaml in their
// environment, so every application and configuration they build runs with tenancy mode multi and schema isolation.
// The operator suites (saas-ops, entitlements, domains) keep the single tenancy of the test profile as their default:
// each of their tests sets tenancy mode multi itself, and their single-tenancy tests check the on-premise refusals.
// A file of any other suite, or a file whose path cannot be read, stops the run: the SaaS run must never pass while
// testing something else than it says.
import { expect } from 'vitest';
import { MULTI_TENANCY_ENV, MULTI_TENANCY_SUITES, OPERATOR_SUITES, isSaasRun, suiteOf } from './tenancy';

const file = expect.getState().testPath ?? '';
const suite = suiteOf(file);

if (!isSaasRun()) {
  throw new Error('test/setup/saas-run.ts belongs to the SaaS run: start it with npm run test:int:saas -w @mscd/server');
}
if ((MULTI_TENANCY_SUITES as readonly string[]).includes(suite ?? '')) {
  Object.assign(process.env, MULTI_TENANCY_ENV);
} else if ((OPERATOR_SUITES as readonly string[]).includes(suite ?? '')) {
  for (const name of Object.keys(MULTI_TENANCY_ENV)) delete process.env[name];
} else {
  throw new Error(`The SaaS run has no tenancy for the test file ${file || '(unknown)'}: add its suite to test/setup/tenancy.ts`);
}
