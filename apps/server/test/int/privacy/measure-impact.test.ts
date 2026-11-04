// Measurement for the M3-13 handoff (Milestone 3 D.6.5, security review 1): the time of the count of "What will change"
// (`erasureImpact` of `privacy-requests.get`) for an organisation whose audit trail holds 100 000 entries. Skipped unless
// MSCD_MEASURE_ERASURE=1, because it writes 100 000 entries through the chain trigger; the result is printed and written
// to MSCD_MEASURE_OUT when that is set. Invented people only (R-19).
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erasureImpact } from '../../../src/modules/privacy/erasure-scope';
import { TenantScope } from '../../../src/modules/tenancy/tenant-scope';
import { useTestDatabase } from '../../setup/test-db';
import { createPrivacyApp, inventedMember, ORG_IDS, rowsOf, userId, type DemoOrg, type PrivacyApp } from './helpers';

const ORG: DemoOrg = 'ndt';
const ENTRIES = 100_000;
const RUNS = 3;

describe.runIf(process.env.MSCD_MEASURE_ERASURE === '1')('the erasure impact count for 100 000 audit entries (M3-13)', () => {
  const db = useTestDatabase('demo');
  let ctx: PrivacyApp;

  beforeAll(async () => {
    ctx = await createPrivacyApp(db);
  }, 240_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('counts the entries that change and prints the time', async () => {
    const person = await inventedMember(db, ORG, {
      handle: 'dimas.saputra', displayName: 'Dimas Saputra', email: 'dimas.saputra@nusantaradigital.co.id', jobTitle: 'Analyst', role: 'domain_owner',
    });
    const other = await userId(db, 'rina');
    const [before] = await rowsOf<{ n: number }>(db, ORG, sql`select count(*)::int as n from audit_trail`);
    const fill = Math.max(0, ENTRIES - before!.n);
    // One entry in 50 by the person, one in 200 holding the email in a text, one in 500 holding the name in a record a
    // manager edits later, the rest by another member; every entry has a before and an after value and a network address.
    const started = performance.now();
    await rowsOf(db, ORG, sql`
      with added as (
      insert into audit_trail (organization_id, actor_user_id, actor_kind, action, entity_type, entity_id, entity_code, before_data, after_data, source_ip, user_agent)
      select ${ORG_IDS[ORG]}::uuid,
             case when g % 50 = 0 then ${person}::uuid else ${other}::uuid end,
             'user', 'risk.updated', 'risk', gen_random_uuid(), 'R-' || lpad(g::text, 6, '0'),
             jsonb_build_object('description', 'Risk text ' || g ||
               case when g % 200 = 0 then ' Contact dimas.saputra@nusantaradigital.co.id.' when g % 500 = 1 then ' Owner Dimas Saputra.' else '' end,
               'status', 'open', 'likelihood', g % 5),
             jsonb_build_object('description', 'Risk text ' || g || ' reviewed', 'status', 'open', 'likelihood', (g + 1) % 5),
             '192.0.2.10'::inet, 'Test browser'
        from generate_series(1, ${fill}::int) g
      returning seq)
      select count(*)::int as n from added`);
    const filled = performance.now() - started;
    const [after] = await rowsOf<{ n: number }>(db, ORG, sql`select count(*)::int as n from audit_trail`);
    expect(after!.n).toBeGreaterThanOrEqual(ENTRIES);

    const scope = ctx.moduleRef.get(TenantScope);
    const row = {
      subject_kind: 'member' as const, subject_user_id: person, subject_name: 'Dimas Saputra', subject_email: null,
      received_at: new Date(Date.now() - 86_400_000),
    };
    const times: number[] = [];
    let impact = { tenantEntries: 0, platformEntries: 0, legalHolds: 0 };
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = performance.now();
      impact = await scope.withTenant({ orgId: ORG_IDS[ORG], schema: `org_${ORG}`, userId: other }, (trx) =>
        erasureImpact(trx, { id: ORG_IDS[ORG], timeZone: 'Asia/Jakarta' }, row, new Date().toISOString().slice(0, 10)));
      times.push(Math.round(performance.now() - t0));
    }
    // The person's own entries (1 in 50) and the entries holding the email (1 in 200, some of them the person's own).
    expect(impact.tenantEntries).toBeGreaterThanOrEqual(Math.floor(fill / 50));
    const result = { auditEntries: after!.n, fillMs: Math.round(filled), countMs: times, impact };
    console.log(`erasure impact measurement: ${JSON.stringify(result)}`);
    if (process.env.MSCD_MEASURE_OUT) await writeFile(process.env.MSCD_MEASURE_OUT, `${JSON.stringify(result, null, 2)}\n`);
  }, 900_000);
});
