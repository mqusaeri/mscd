// The demo persona menu (D-20, Milestone 3 E, M3-15): `Me.personas` lists only the persona users who hold a role in the
// current organisation, a business role in one of its systems (an active grant: approved and not ended, in a system that
// is not deleted) or an organisation role of their membership. On the demo data: in Nusantara Digital Teknologi (`ndt`)
// the menu offers all seven personas, the three of Milestone 3 among them; in PT Bank Sentosa Digital (`bsd`) and RS
// Medika Nusantara (`rmn`), which run no ABMS, Gilang Saputra (Compliance Investigator) is a member without a role, so
// the menu leaves him out, until he holds an organisation role there. The people are the invented demo personas (R-19).
import { DEMO_PERSONAS, UI_ROLES, type Me, type UiRole } from '@mscd/shared';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedTenant } from '../../../src/db/tenant-provisioner';
import type { DB } from '../../../src/db/types';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { tenantInfo } from '../ops/helpers';
import { ORG_IDS, type DemoOrg } from '../read-model/helpers';
import { createAuthzApp, sessionFor, type AuthzApp, type Org, type User } from './helpers';

describe('demo persona menu: personas with a role in the organisation only (M3-15)', () => {
  const db = useTestDatabase('demo');
  let ctx: AuthzApp;
  let rina: User;
  let gilangId: string;

  const orgOf = async (slug: DemoOrg): Promise<Org> => ({
    tenant: { id: ORG_IDS[slug], schemaName: `org_${slug}` } as CreatedTenant,
    info: await tenantInfo(db.migrator, slug),
    systems: {},
  });

  const userOf = async (handle: string): Promise<User> => {
    const row = await db.migrator.selectFrom('platform.app_user').select(['id', 'handle', 'email', 'display_name', 'kind']).where('handle', '=', handle).executeTakeFirstOrThrow();
    return { id: row.id, handle: row.handle, email: row.email, displayName: row.display_name, kind: row.kind as User['kind'] };
  };

  /** The persona menu of rina (a demo user) in an organisation: UI role to handle. */
  const menuIn = async (slug: DemoOrg): Promise<Partial<Record<UiRole, string>>> => {
    const client = await sessionFor(ctx, rina, { org: await orgOf(slug) });
    const me = (await client.get('/api/v1/me')).json() as Me;
    expect(me.personas, slug).toBeDefined();
    return Object.fromEntries(Object.entries(me.personas!).map(([role, p]) => [role, p.who]));
  };

  const inOrg = <T,>(slug: DemoOrg, fn: (trx: Transaction<DB>) => Promise<T>) => inScope(db.migrator, { orgId: ORG_IDS[slug], schema: `org_${slug}`, platformScope: true }, fn);

  beforeAll(async () => {
    ctx = await createAuthzApp(db);
    rina = await userOf('rina');
    gilangId = (await userOf('gilang')).id;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('offers all seven personas in Nusantara Digital Teknologi, the three new ones among them', async () => {
    const menu = await menuIn('ndt');
    expect(Object.keys(menu).sort()).toEqual([...UI_ROLES].sort());
    for (const role of UI_ROLES) expect(menu[role], role).toBe(DEMO_PERSONAS[role]);
    expect(menu).toMatchObject({ sponsor: 'wulan', riskowner: 'ratna', investigator: 'gilang' });
  });

  it('leaves Gilang Saputra out where he is a member without a role (bsd, rmn)', async () => {
    for (const slug of ['bsd', 'rmn'] as const) {
      // He is an active member there: only the role is missing.
      const [membership] = await inScope(db.migrator, { platformScope: true }, (trx) => sql<{ status: string; admin_roles: string[] }>`
        select status, admin_roles from platform.org_membership where user_id = ${gilangId}::uuid and organization_id = ${ORG_IDS[slug]}::uuid`
        .execute(trx).then((r) => r.rows));
      expect(membership, slug).toEqual({ status: 'active', admin_roles: [] });
      const menu = await menuIn(slug);
      expect(menu.investigator, slug).toBeUndefined();
      expect(Object.keys(menu).sort(), slug).toEqual(UI_ROLES.filter((r) => r !== 'investigator').sort());
      expect(menu).toMatchObject({ manager: 'rina', sponsor: 'wulan', riskowner: 'ratna' });
    }
  });

  it('counts only an active grant in a system that is not deleted, and an organisation role', async () => {
    const bsdIsms = await inOrg('bsd', async (trx) => (await trx.selectFrom('management_system').select('id').where('slug', '=', 'isms').executeTakeFirstOrThrow()).id);
    const grant = (values: { approval_status: 'active' | 'pending_approval'; valid_until: Date | null }) =>
      inOrg('bsd', async (trx) =>
        (await trx.insertInto('user_ms_role').values({ user_id: gilangId, management_system_id: bsdIsms, role: 'compliance_investigator', is_primary: false, ...values })
          .returning('id').executeTakeFirstOrThrow()).id);
    const drop = (id: string) => inOrg('bsd', (trx) => trx.updateTable('user_ms_role').set({ deleted_at: new Date() }).where('id', '=', id).execute());

    // A grant waiting for approval, or one that ended, is no role.
    const pending = await grant({ approval_status: 'pending_approval', valid_until: null });
    expect((await menuIn('bsd')).investigator).toBeUndefined();
    await drop(pending);
    // Ended by the clock of the application (the demo's fixed day), as the role resolver reads it.
    const ended = await grant({ approval_status: 'active', valid_until: new Date(ctx.clock.now().getTime() - 86_400_000) });
    expect((await menuIn('bsd')).investigator).toBeUndefined();
    await drop(ended);

    // An active grant is.
    const active = await grant({ approval_status: 'active', valid_until: null });
    expect((await menuIn('bsd')).investigator).toBe('gilang');
    await drop(active);
    expect((await menuIn('bsd')).investigator).toBeUndefined();

    // An organisation role of the membership is, without any business role.
    const setAdminRoles = (roles: string[]) =>
      inScope(db.migrator, { platformScope: true }, (trx) =>
        sql`update platform.org_membership set admin_roles = ${roles}::text[] where user_id = ${gilangId}::uuid and organization_id = ${ORG_IDS.bsd}::uuid`.execute(trx));
    await setAdminRoles(['storage_admin']);
    try {
      expect((await menuIn('bsd')).investigator).toBe('gilang');
    } finally {
      await setAdminRoles([]);
    }
    expect((await menuIn('bsd')).investigator).toBeUndefined();
  });
});
