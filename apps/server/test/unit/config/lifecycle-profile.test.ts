// The lifecycle and privacy profile keys of Milestone 3 D.3 and the lifecycle check of load-profile.ts: values below 7
// for the three lifecycle day counts start a server only on a test stack (`MSCD_SAAS_TEST=1`) or with a test profile
// (the `test` section), so a production server keeps the 7-day minimum before a purge.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ProfileError, lifecycleProfileIssues, loadProfile, validateProfile } from '../../../src/config/load-profile';
import { LIFECYCLE_DEFAULTS, PRIVACY_DEFAULTS } from '../../../src/config/profile.schema';

const PROFILES = path.resolve(__dirname, '../../../profiles');
const profile = (name: string) => path.join(PROFILES, `${name}.yaml`);
const raw = (name: string) => parseYaml(readFileSync(profile(name), 'utf8')) as Record<string, unknown>;

function issuesOf(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProfileError) return error.issues;
    throw error;
  }
  throw new Error('expected a ProfileError');
}

const LOW_KEYS = ['lifecycle.offboarding_days', 'lifecycle.deletion_grace_days', 'lifecycle.deletion_min_grace_days'];

describe('lifecycle and privacy profile keys (Milestone 3 D.3)', () => {
  it.each(['saas', 'onprem', 'demo', 'test'])('%s.yaml holds the defaults', (name) => {
    const loaded = loadProfile({ env: { MSCD_PROFILE_FILE: profile(name) }, flavor: 'dev' }).profile;
    expect(loaded.lifecycle).toEqual(LIFECYCLE_DEFAULTS);
    expect(loaded.privacy).toEqual(PRIVACY_DEFAULTS);
  });

  it('has the defaults of the plan, also when a profile leaves the sections out', () => {
    expect(LIFECYCLE_DEFAULTS).toEqual({
      offboarding_days: 30,
      deletion_grace_days: 30,
      deletion_min_grace_days: 7,
      export_part_bytes: 2147483648,
      export_max_bytes: 107374182400,
      export_link_days: 7,
      backup_copies_end_days: 780,
    });
    expect(PRIVACY_DEFAULTS).toEqual({ request_due_hours: 72, session_retention_days: 90, token_retention_days: 30, notification_retention_days: 365 });
    const input = raw('onprem');
    delete input.lifecycle;
    delete input.privacy;
    const parsed = validateProfile(input, 'release');
    expect(parsed.lifecycle).toEqual(LIFECYCLE_DEFAULTS);
    expect(parsed.privacy).toEqual(PRIVACY_DEFAULTS);
  });

  it('refuses values outside the ranges of D.3', () => {
    const input = raw('onprem');
    input.lifecycle = {
      ...(input.lifecycle as object),
      offboarding_days: 366,
      export_part_bytes: 64 * 1024 * 1024 - 1,
      export_max_bytes: 1024 * 1024 * 1024 - 1,
      export_link_days: 91,
      backup_copies_end_days: 3651,
    };
    input.privacy = { request_due_hours: 23, session_retention_days: 6, token_retention_days: 0, notification_retention_days: 29 };
    const paths = issuesOf(() => validateProfile(input, 'dev')).map((i) => i.path).sort();
    expect(paths).toEqual([
      'lifecycle.backup_copies_end_days',
      'lifecycle.export_link_days',
      'lifecycle.export_max_bytes',
      'lifecycle.export_part_bytes',
      'lifecycle.offboarding_days',
      'privacy.notification_retention_days',
      'privacy.request_due_hours',
      'privacy.session_retention_days',
      'privacy.token_retention_days',
    ]);
    const unknown = raw('onprem');
    unknown.lifecycle = { ...(unknown.lifecycle as object), purge_now: true };
    expect(issuesOf(() => validateProfile(unknown, 'dev'))).toEqual([{ path: 'lifecycle.purge_now', message: 'unknown key' }]);
  });

  it('refuses lifecycle values below 7 on a production profile, in every build flavour', () => {
    const env = {
      MSCD_PROFILE_FILE: profile('saas'),
      MSCD__LIFECYCLE__OFFBOARDING_DAYS: '0',
      MSCD__LIFECYCLE__DELETION_GRACE_DAYS: '1',
      MSCD__LIFECYCLE__DELETION_MIN_GRACE_DAYS: '6',
    };
    for (const flavor of ['dev', 'release'] as const) {
      const issues = issuesOf(() => loadProfile({ env, flavor }));
      expect(issues.map((i) => i.path)).toEqual(LOW_KEYS);
      expect(issues[0]!.message).toMatch(/below 7 are for test stacks only, which run with the environment variable MSCD_SAAS_TEST=1/);
    }
    // 7 is the smallest value a production server takes.
    const seven = { ...env, MSCD__LIFECYCLE__OFFBOARDING_DAYS: '7', MSCD__LIFECYCLE__DELETION_GRACE_DAYS: '7', MSCD__LIFECYCLE__DELETION_MIN_GRACE_DAYS: '7' };
    expect(loadProfile({ env: seven, flavor: 'release' }).profile.lifecycle.deletion_min_grace_days).toBe(7);
    // Other lifecycle keys have no such check.
    const other = { MSCD_PROFILE_FILE: profile('saas'), MSCD__LIFECYCLE__BACKUP_COPIES_END_DAYS: '0' };
    expect(loadProfile({ env: other, flavor: 'release' }).profile.lifecycle.backup_copies_end_days).toBe(0);
  });

  it('takes values below 7 on a test stack (MSCD_SAAS_TEST=1) or with a test profile', () => {
    const low = { MSCD__LIFECYCLE__OFFBOARDING_DAYS: '0', MSCD__LIFECYCLE__DELETION_GRACE_DAYS: '0', MSCD__LIFECYCLE__DELETION_MIN_GRACE_DAYS: '0' };
    const stack = loadProfile({ env: { MSCD_PROFILE_FILE: profile('saas'), MSCD_SAAS_TEST: '1', ...low }, flavor: 'dev' }).profile;
    expect(stack.lifecycle).toMatchObject({ offboarding_days: 0, deletion_grace_days: 0, deletion_min_grace_days: 0 });
    // Only the value 1 counts as set.
    expect(issuesOf(() => loadProfile({ env: { MSCD_PROFILE_FILE: profile('saas'), MSCD_SAAS_TEST: 'true', ...low }, flavor: 'dev' })).map((i) => i.path)).toEqual(LOW_KEYS);
    // The test profile (its `test` section, which release builds refuse) needs no variable.
    const test = loadProfile({ env: { MSCD_PROFILE_FILE: profile('test'), ...low }, flavor: 'dev' }).profile;
    expect(test.lifecycle.offboarding_days).toBe(0);
    // validateProfile without an environment runs the check as without MSCD_SAAS_TEST.
    const input = raw('onprem');
    input.lifecycle = { ...(input.lifecycle as object), deletion_min_grace_days: 3 };
    expect(issuesOf(() => validateProfile(input, 'dev')).map((i) => i.path)).toEqual(['lifecycle.deletion_min_grace_days']);
    expect(validateProfile(input, 'dev', undefined, { MSCD_SAAS_TEST: '1' }).lifecycle.deletion_min_grace_days).toBe(3);
  });

  it('lifecycleProfileIssues reads only the three day counts', () => {
    const parsed = validateProfile(raw('onprem'), 'dev');
    expect(lifecycleProfileIssues(parsed, {})).toEqual([]);
    const low = { ...parsed, lifecycle: { ...parsed.lifecycle, deletion_grace_days: 6 } };
    expect(lifecycleProfileIssues(low, {}).map((i) => i.path)).toEqual(['lifecycle.deletion_grace_days']);
    expect(lifecycleProfileIssues(low, { MSCD_SAAS_TEST: '1' })).toEqual([]);
  });
});
