// Enumerations against the build plan: every DDL CHECK list of C.4 to C.6, the problem slugs and rule ids of D.1,
// the gateway slugs of D.5, the jobs of E.2, the notification kinds of E.6 and the audit actions of F.11, each with
// the values of Milestone 2 section J (J.3 to J.7) merged in by the helpers.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from '../src/index.js';
import {
  AUDIT_ACTIONS, AUDIT_EVENT_TYPES, BUSINESS_RULE_IDS, CONFIRMATION_RULE_IDS, DemoPersonaRequest, GATEWAY_PROBLEM_SLUGS, JOB_NAMES, LICENCE_FEATURES,
  NOTIFICATION_KINDS, OPS_RUNNABLE_JOBS, PERMISSIONS, PLATFORM_AUDIT_ACTION_PREFIXES, PLATFORM_RULE_IDS, PLATFORM_WARNING_RULE_IDS, PROBLEM_SLUGS,
  PROBLEM_STATUS, PROBLEM_TYPE_BASE, RULE_IDS, UI_ROLES, WARNING_RULE_IDS, isPlatformAuditAction, problemType,
} from '../src/index.js';
import {
  m2CheckLists, m2Section, planAuditActions, planCheckLists, planJobNames, planNotificationKinds, planPlatformRuleIds, planProblemSlugs,
  planSection, planWarningRuleIds, readRepoFile, tableRow,
} from './helpers.js';

const codes = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
const zodEnums: z.ZodEnum[] = [];
for (const value of Object.values(shared as Record<string, unknown>)) if (value instanceof z.ZodEnum) zodEnums.push(value);
const stringArrays = Object.entries(shared as Record<string, unknown>).filter(
  (entry): entry is [string, readonly string[]] => Array.isArray(entry[1]) && entry[1].length > 0 && entry[1].every((x) => typeof x === 'string'),
);

describe('DDL CHECK lists (C.4 to C.6)', () => {
  const lists = planCheckLists();

  it('are read from the plan', () => {
    expect(lists.size).toBeGreaterThan(90);
  });

  it('include the Milestone 2 lists of J.7, which replace the BP list of the same column', () => {
    const m2 = m2CheckLists();
    expect(m2.size).toBe(15);
    for (const [column, values] of m2) expect(lists.get(column), column).toEqual(values);
    expect(lists.get('audit_event.event_type')).toEqual([...AUDIT_EVENT_TYPES]);
    expect(lists.get('audit_activity_template.event_type')).toContain('internal_audit');
  });

  for (const [column, values] of lists) {
    it(`${column} has an exported enumeration with the same values`, () => {
      const wanted = [...values].sort().join('|');
      const matches = stringArrays.filter(([, a]) => [...a].sort().join('|') === wanted).map(([name]) => name);
      expect(matches, `${column}: ${values.join(', ')}`).not.toEqual([]);
      // The array has a zod enum of the same values (the schema the API and the read model validate with).
      expect(zodEnums.some((e) => [...(e.options as string[])].sort().join('|') === wanted), column).toBe(true);
    });
  }
});

describe('exported enumerations', () => {
  it('have unique values', () => {
    for (const [name, values] of stringArrays) expect(new Set(values).size, name).toBe(values.length);
  });
});

describe('problems and rules (D.1, D.5)', () => {
  const d1 = planSection('### D.1 Conventions', '### D.2');

  it('match the problem slugs and statuses of D.1 and Milestone 2 J.6', () => {
    const row = d1.split('\n').find((l) => l.startsWith('| Problem slugs')) as string;
    expect([...row.matchAll(/`([a-z-]+)` (\d{3})/g)].length).toBe(17);
    const planned = planProblemSlugs();
    expect(planned.length).toBe(18);
    expect(planned.at(-1)).toEqual(['not-implemented', 501]);
    expect([...PROBLEM_SLUGS]).toEqual(planned.map(([slug]) => slug));
    expect(Object.keys(PROBLEM_STATUS).sort()).toEqual([...PROBLEM_SLUGS].sort());
    for (const [slug, status] of planned) expect(PROBLEM_STATUS[slug as keyof typeof PROBLEM_STATUS], slug).toBe(status);
    expect(problemType('not-found')).toBe('https://mscd.cyberlentera.com/problems/not-found');
    expect(d1).toContain(`\`${PROBLEM_TYPE_BASE}<slug>\``);
  });

  it('match the platform rule ids of D.1 and Milestone 2 J.6', () => {
    const row = d1.split('\n').find((l) => l.startsWith('| Errors')) as string;
    const bp = codes(row.slice(row.indexOf('`rule`'))).filter((c) => /^[A-Z]+(-[A-Z]+)+$/.test(c));
    expect(PLATFORM_RULE_IDS.slice(0, bp.length)).toEqual(bp);
    expect([...PLATFORM_RULE_IDS]).toEqual(planPlatformRuleIds());
    expect(PLATFORM_RULE_IDS.slice(bp.length)).toEqual(['APPL-ASSESS', 'PACK-ROW-REMOVED']);
  });

  it('match the warning and confirmation rules of D.1 and Milestone 2 J.6', () => {
    const warnings = d1.split('\n').find((l) => l.startsWith('| Warnings')) as string;
    const bp = [...warnings.matchAll(/BR-\d\d/g)].map((m) => m[0]);
    expect(WARNING_RULE_IDS.slice(0, bp.length)).toEqual(bp);
    expect([...WARNING_RULE_IDS]).toEqual(planWarningRuleIds());
    expect([...PLATFORM_WARNING_RULE_IDS]).toEqual(codes(tableRow(m2Section('### J.6 Problems and rules', '### J.7'), 'Warnings')).filter((c) => /^[A-Z]+(-[A-Z]+)+$/.test(c)));
    for (const id of WARNING_RULE_IDS) expect(RULE_IDS, id).toContain(id);
    const slugs = d1.split('\n').find((l) => l.startsWith('| Problem slugs')) as string;
    expect([...CONFIRMATION_RULE_IDS]).toEqual([...(slugs.match(/confirmation-required` 409 \(([^)]*)\)/)?.[1] ?? '').matchAll(/BR-\d\d/g)].map((m) => m[0]));
  });

  it('number the business rules BR-01 to BR-50', () => {
    expect(BUSINESS_RULE_IDS).toHaveLength(50);
    BUSINESS_RULE_IDS.forEach((id, i) => expect(id).toBe(`BR-${String(i + 1).padStart(2, '0')}`));
    // 57 rule ids of the build plan plus the 3 of Milestone 2 J.6.
    expect(RULE_IDS).toHaveLength(57 + 3);
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    const digest = readRepoFile('docs/platform/spec-digest.md');
    for (const id of BUSINESS_RULE_IDS) expect(digest, id).toContain(`| ${id} |`);
  });

  it('match the gateway problem slugs of D.5', () => {
    const d5 = planSection('### D.5 Storage gateway protocol', '## E. Worker jobs');
    const line = d5.split('\n').find((l) => l.includes('errors use problem details with slugs')) as string;
    expect([...GATEWAY_PROBLEM_SLUGS]).toEqual(codes(line.slice(line.indexOf('slugs'))).filter((c) => /^[a-z-]+$/.test(c)));
  });
});

describe('jobs, notifications and audit actions', () => {
  it('match the jobs of E.2 and Milestone 2 J.3', () => {
    const e2 = planSection('### E.2 Jobs', '### E.3');
    const bp = e2.split('\n').filter((l) => /^\| `[a-z-]+\.[a-z-]+`/.test(l)).map((l) => codes(l)[0] as string);
    expect(JOB_NAMES.slice(0, bp.length)).toEqual(bp);
    expect([...JOB_NAMES]).toEqual(planJobNames());
    expect(JOB_NAMES.length).toBe(bp.length + 6);
  });

  it('match the operator job allow-list of D.3', () => {
    const d3 = planSection('### D.3 Endpoints', '### D.4');
    const row = d3.split('\n').find((l) => l.startsWith('| `POST /ops/jobs/{name}/run`')) as string;
    const list = row.slice(row.indexOf('allow-list'), row.indexOf(';', row.indexOf('allow-list')));
    expect([...OPS_RUNNABLE_JOBS]).toEqual(codes(list));
    for (const job of OPS_RUNNABLE_JOBS) expect(JOB_NAMES).toContain(job);
  });

  it('match the notification kinds of E.6 and Milestone 2 J.4', () => {
    const e6 = planSection('### E.6 Notifications', '### E.7');
    const bp = e6.split('\n').filter((l) => l.startsWith('| `')).flatMap((l) => codes(l.split('|')[1] ?? ''));
    for (const kind of bp) expect(NOTIFICATION_KINDS, kind).toContain(kind);
    expect([...NOTIFICATION_KINDS].sort()).toEqual([...new Set(planNotificationKinds())].sort());
    expect(NOTIFICATION_KINDS.length).toBe(new Set(bp).size + 5);
  });

  it('match the audit actions of F.11 and Milestone 2 J.5', () => {
    const f11 = planSection('### F.11 Keys, secrets and the audit chain', '### F.12');
    const line = f11.split('\n').find((l) => l.startsWith('- Actions:')) as string;
    const all = codes(line);
    const actions = all.filter((c) => /^[a-z_]+(\.[a-z_]+)+$/.test(c) && c !== 'platform.audit_log');
    for (const action of actions) expect(AUDIT_ACTIONS, action).toContain(action);
    expect([...AUDIT_ACTIONS].sort()).toEqual([...new Set(planAuditActions())].sort());
    expect(AUDIT_ACTIONS.length).toBe(new Set(actions).size + 24);
    expect([...PLATFORM_AUDIT_ACTION_PREFIXES]).toEqual(all.filter((c) => c.endsWith('.*')).map((c) => c.slice(0, -1)));
    expect(isPlatformAuditAction('auth.login')).toBe(true);
    expect(isPlatformAuditAction('licence.installed')).toBe(true);
    expect(isPlatformAuditAction('document.transition')).toBe(false);
  });

  it('list the licence features named by the plan', () => {
    const plan = readRepoFile('docs/platform/BUILD-PLAN.md');
    const demo = plan.match(/`features` \[([^\]]+)\]/)?.[1] ?? '';
    expect([...LICENCE_FEATURES]).toEqual(demo.split(',').map((f) => f.trim()));
  });
});

describe('roles and permissions', () => {
  it('have unique permission codes', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('use the four UI roles for demo personas', () => {
    expect([...UI_ROLES].sort()).toEqual(['auditor', 'manager', 'owner', 'top']);
    for (const role of UI_ROLES) expect(DemoPersonaRequest.safeParse({ role }).success).toBe(true);
  });
});
