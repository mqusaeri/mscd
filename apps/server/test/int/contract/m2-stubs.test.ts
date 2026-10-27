// Milestone 2 route stubs (docs/platform/MILESTONE-2.md D.1, F): M2-02 mounts every new route with a stub behind
// `@ApiRoute` that answers 501 `not-implemented` once the guard admits the caller, and lists the route ids per
// building package in `m2-pending/`. This suite checks the lists against the route table, and that each listed route
// (and each pending path value of an existing route) answers the stub's problem to a caller the guard admits. It also
// checks the D.2 change for the platform operator in multi tenancy: `admin.packs.list` and `admin.packs.import` are
// admitted without a membership.
import { API_ROUTES, WORK_PACKAGE_IDS, type RouteDef } from '@mscd/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { PENDING_PATH_VALUES, PENDING_ROUTES, pendingFiles } from '../m2-pending/pending';
import { expectedAllowed } from '../rbac/expectations';
import {
  NOT_IMPLEMENTED_TYPE, ROLE_KEYS, addFixtureUser, addRoleUsers, callRoute, createFullApp, exampleInput, guardDenials, resetRateLimits,
  sessionFor, type Client, type FullApp, type RoleKey, type RouteInput,
} from './harness';

const BY_ID = new Map(API_ROUTES.map((r) => [r.id, r] as const));

/** The value of the member a `permissionBy` route reads, for this input. */
function memberOf(def: RouteDef, input: RouteInput): unknown {
  if (!def.permissionBy) return undefined;
  const { source, member } = def.permissionBy;
  const holder = (source === 'path' ? input.params : source === 'body' ? input.body : input.query) as Record<string, unknown> | undefined;
  return holder?.[member];
}

/** True when the input names a system where the route reads one (as the RBAC sweep decides it). */
function namesSystem(def: RouteDef, input: RouteInput): boolean {
  const source = def.msSource ?? (/:ms(\/|$)/.test(def.path) ? 'path' : undefined);
  if (!source) return false;
  const holder = (source === 'path' ? input.params : source === 'body' ? input.body : input.query) as { ms?: unknown } | undefined;
  return typeof holder?.ms === 'string' && holder.ms !== '';
}

/** Every pending call: each listed route with its example input, and each pending path value of an existing route. */
function pendingCalls(): { label: string; def: RouteDef; input: RouteInput }[] {
  const out: { label: string; def: RouteDef; input: RouteInput }[] = [];
  for (const id of PENDING_ROUTES.keys()) {
    const def = BY_ID.get(id);
    if (def) out.push({ label: id, def, input: exampleInput(def, { ms: 'isms' }) });
  }
  for (const [id, members] of PENDING_PATH_VALUES) {
    const def = BY_ID.get(id);
    if (!def) continue;
    for (const [member, values] of Object.entries(members)) {
      for (const value of values) out.push({ label: `${id} (${member} ${value})`, def, input: exampleInput(def, { ms: 'isms', override: { params: { [member]: value } } }) });
    }
  }
  return out;
}

describe('Milestone 2 pending lists (D.1)', () => {
  const files = pendingFiles();

  it('names building packages of the plan, one file each', () => {
    const packages = [...files.values()].map((f) => f.workPackage);
    expect(packages.filter((p) => !(WORK_PACKAGE_IDS as readonly string[]).includes(p))).toEqual([]);
    expect(new Set(packages).size).toBe(packages.length);
    expect(packages.filter((p) => !p.startsWith('M2-'))).toEqual([]);
  });

  it('lists routes of the route table, each owned by the package whose file lists it, and none twice', () => {
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const [name, file] of files) {
      for (const id of file.routes) {
        const def = BY_ID.get(id);
        if (!def) problems.push(`${name}: ${id} is not a route of the route table`);
        else if (def.owner !== file.workPackage) problems.push(`${name}: ${id} is owned by ${def.owner}`);
        if (seen.has(id)) problems.push(`${name}: ${id} is also listed in ${seen.get(id)}`);
        seen.set(id, name);
      }
    }
    expect(problems).toEqual([]);
  });

  it('lists pending path values that the route accepts, for path members of routes that are not pending as a whole', () => {
    const problems: string[] = [];
    for (const [name, file] of files) {
      for (const [id, members] of Object.entries(file.pathValues ?? {})) {
        const def = BY_ID.get(id);
        if (!def) {
          problems.push(`${name}: ${id} is not a route of the route table`);
          continue;
        }
        if (PENDING_ROUTES.has(id)) problems.push(`${name}: ${id} is pending as a whole and needs no path values`);
        for (const [member, values] of Object.entries(members)) {
          if (!def.path.includes(`/:${member}`)) problems.push(`${name}: ${id} has no path member ${member}`);
          for (const value of values) {
            const params = exampleInput(def, { ms: 'isms', override: { params: { [member]: value } } }).params;
            if (!def.params?.safeParse(params).success) problems.push(`${name}: ${id} does not accept ${member} ${value}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('Milestone 2 stubs answer 501 not-implemented after the guard (D.1)', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  const clients = {} as Record<RoleKey, Client>;

  beforeAll(async () => {
    full = await createFullApp(db);
    const users = await addRoleUsers(db, 'tst', 'isms', 'm2stub');
    for (const role of ROLE_KEYS) clients[role] = await sessionFor(full, users[role].id, 'tst');
  });

  afterAll(async () => {
    await full?.close();
  });

  for (const { label, def, input } of pendingCalls()) {
    it(`${label}: ${def.method} ${def.path}`, async () => {
      await resetRateLimits(db);
      const role = ROLE_KEYS.find((r) => expectedAllowed(def, r, memberOf(def, input), namesSystem(def, input)));
      expect(role, `${label}: some role of F.6 is admitted`).toBeDefined();
      const before = await guardDenials(full, def.id);
      const call = await callRoute(clients[role!], def, input, def.ifMatch ? { 'if-match': '"1"' } : {});
      expect(await guardDenials(full, def.id), `${label}: the guard admits ${role}`).toBe(before);
      expect(call.violations).toEqual([]);
      expect({ status: call.status, body: call.body }).toEqual({
        status: 501,
        body: expect.objectContaining({
          type: NOT_IMPLEMENTED_TYPE,
          status: 501,
          messageKey: 'not_implemented',
          detail: expect.stringContaining(`(${PENDING_ROUTES.get(def.id) ?? [...pendingFiles().values()].find((f) => f.pathValues?.[def.id])!.workPackage})`),
        }),
      });
    });
  }

  it('denies a stubbed route to a role the matrix does not admit before the stub runs', async () => {
    await resetRateLimits(db);
    const def = BY_ID.get('ms.certification')!;
    const before = await guardDenials(full, def.id);
    const call = await callRoute(clients.DO, def, exampleInput(def, { ms: 'isms' }));
    expect(call.status).toBe(403);
    expect(await guardDenials(full, def.id)).toBe(before + 1);
  });
});

describe('the platform operator in multi tenancy without a membership (D.2)', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let operator: Client;
  let admin: Client;

  beforeAll(async () => {
    full = await createFullApp(db, { MSCD__TENANCY__MODE: 'multi' });
    const op = await addFixtureUser(db, 'tst', 'm2multi-op', { platformOperator: true });
    // The operator signs in without an organisation: the membership above is not used by the session.
    operator = await sessionFor(full, op.id, null);
    const ta = await addFixtureUser(db, 'tst', 'm2multi-ta', { org: ['tenant_admin'] });
    admin = await sessionFor(full, ta.id, 'tst');
  });

  afterAll(async () => {
    await full?.close();
  });

  it('lists the installed packs for the operator and still for the Tenant Admin', async () => {
    await resetRateLimits(db);
    const def = BY_ID.get('admin.packs.list')!;
    for (const client of [operator, admin]) {
      const call = await callRoute(client, def, exampleInput(def));
      expect(call.violations).toEqual([]);
      expect(call.status).toBe(200);
    }
  });

  it('admits the operator to the pack import (the bundle is then checked)', async () => {
    await resetRateLimits(db);
    const def = BY_ID.get('admin.packs.import')!;
    const before = await guardDenials(full, def.id);
    const call = await callRoute(operator, def, exampleInput(def));
    expect(call.violations).toEqual([]);
    expect(await guardDenials(full, def.id)).toBe(before);
    expect(call.status).not.toBe(403);
  });

  it('admits the operator to the stubbed operator routes of the SaaS track', async () => {
    const problems: string[] = [];
    for (const def of API_ROUTES.filter((r) => r.scope === 'platform' && PENDING_ROUTES.has(r.id))) {
      await resetRateLimits(db);
      const call = await callRoute(operator, def, exampleInput(def));
      if (call.status !== 501) problems.push(`${def.id} answered ${call.status}: ${call.text.slice(0, 200)}`);
      problems.push(...call.violations);
    }
    expect(problems).toEqual([]);
  });

  it('keeps the operator out of an organisation route the matrix gives the Tenant Admin', async () => {
    await resetRateLimits(db);
    const def = BY_ID.get('admin.onboarding')!;
    const call = await callRoute(operator, def, exampleInput(def));
    expect(call.status).toBe(403);
    expect((await callRoute(admin, def, exampleInput(def))).status).toBe(501);
  });
});
