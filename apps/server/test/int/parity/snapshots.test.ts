// Snapshot parity (build plan J.4, G.9): `GET /ui/org` and `GET /ui/ms/{ms}` for ndt, bsd and rmn as `rina`
// (persona `manager`) equal the exported sample snapshots under the J.4 normalisation. The known differences are
// listed below with the decision that causes them, and their API values are asserted instead.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UiMsSnapshot, UiOrgSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSampleSnapshot } from '../../../src/seed/snapshot';
import { useTestDatabase } from '../../setup/test-db';
import { inScope } from '../db/helpers';
import { createReadModelApp, ORG_IDS, sessionFor, type DemoOrg, type ReadModelApp, type UiClient } from '../read-model/helpers';
import { differences, normaliseMs, normaliseOrg, sampleMsSnapshot, sampleOrgSnapshot } from './compare';

const sample = loadSampleSnapshot();
const ORGS: readonly Exclude<DemoOrg, 'tst'>[] = ['ndt', 'bsd', 'rmn'];
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/** The released version of a development pack: `packs/sources/<pack_id>/manifest.json` (the content step of M2-04). */
function releasedVersion(packId: string): string {
  return (JSON.parse(readFileSync(path.join(REPO_ROOT, 'packs', 'sources', packId, 'manifest.json'), 'utf8')) as { pack_version: string }).pack_version;
}

/** The pack of each version a demo pack card names, by the edition year the card gives (none for one edition). */
const CARD_PACKS: Record<string, Record<string, string>> = {
  isms: { '': 'ISO27001-2022' },
  qms: { '2026': 'ISO9001-2026', '2015': 'ISO9001-2015' },
  bcms: { '': 'ISO22301-2019' },
  abms: { '': 'ISO37001-2025' },
};

/** Pack content the known differences are checked against, read from `ref` of the demo database. */
interface PackContent {
  /**
   * The evidence examples of each installed edition by the key of its row (D2-09): `5.23` for Annex A 5.23, `cl-4.1`
   * for a clause row of an edition with a catalogue, the clause code for a requirement of the other editions. G.5
   * `EXAMPLES` lists them under the system and that key (`isms:5.23`, `qms:7.2`).
   */
  examplesByEdition: Map<string, Map<string, { control: boolean; example: string }>>;
  /** The systems of each organisation in position order. */
  systems: Map<DemoOrg, { slug: string; editionId: string }[]>;
  /** The stages of the ISO 37001:2025 chain with their English auditor questions, in stage order. */
  abmsStages: { key: string; q: string }[];
}

describe('UI snapshot parity with the sample (J.4)', () => {
  const db = useTestDatabase('demo');
  let ctx: ReadModelApp;
  const clients = new Map<DemoOrg, UiClient>();
  const content: PackContent = { examplesByEdition: new Map(), systems: new Map(), abmsStages: [] };

  beforeAll(async () => {
    ctx = await createReadModelApp(db);
    for (const org of ORGS) clients.set(org, await sessionFor(ctx, db, 'rina', org));
    const examples = await sql<{ edition: string; code: string; row: 'control' | 'clause'; catalogue: boolean; example: string }>`
      select framework_version_id as edition, item_code as code, 'control' as row, true as catalogue, evidence_example as example
        from ref.catalogue_item where coalesce(evidence_example, '') <> ''
      union all
      select r.framework_version_id, r.requirement_code, 'clause', v.applicability_target = 'catalogue_item', r.evidence_example
        from ref.requirement r join ref.framework_version v on v.id = r.framework_version_id
       where coalesce(r.evidence_example, '') <> ''`.execute(db.migrator);
    for (const r of examples.rows) {
      const key = r.row === 'control' ? r.code.replace(/^A\./, '') : r.catalogue ? `cl-${r.code}` : r.code;
      const edition = content.examplesByEdition.get(r.edition) ?? new Map<string, { control: boolean; example: string }>();
      expect(edition.has(key), `${r.edition} ${key}`).toBe(false);
      edition.set(key, { control: r.row === 'control', example: r.example });
      content.examplesByEdition.set(r.edition, edition);
    }
    for (const org of ORGS) {
      const systems = await inScope(db.migrator, { orgId: ORG_IDS[org], schema: `org_${org}` }, (trx) =>
        sql<{ slug: string; editionId: string }>`
          select slug, framework_version_id as "editionId" from management_system where deleted_at is null order by position, slug`.execute(trx),
      );
      content.systems.set(org, systems.rows);
    }
    const stages = await sql<{ key: string; q: string }>`
      select c.stage_key as key, c.auditor_question_en as q from ref.traceability_chain_def c join ref.framework_version v on v.id = c.framework_version_id
       where v.pack_id = 'ISO37001-2025' order by c.position`.execute(db.migrator);
    content.abmsStages = stages.rows;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('the comparison is not vacuous: a changed title, holder, count or status is reported', async () => {
    const response = await clients.get('ndt')!.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    const changes: ((s: UiMsSnapshot) => void)[] = [
      (s) => (s.bundle.reqs[0]!.title += ' (changed)'),
      (s) => (s.bundle.chain.items[0]!.h = 'maya'),
      (s) => (s.bundle.chain.recs.risk = 1),
      (s) => (s.bundle.evs[0]!.fresh = 'critical'),
      (s) => (s.bundle.phases[0]!.acts[0]!.st = 'ns'),
      (s) => s.bundle.gates.pop(),
      (s) => (s.bundle.chain.items[0]!.refKey = 'isms:req:A.5.1'),
    ];
    for (const change of changes) {
      const api = structuredClone(response.body);
      change(api);
      const { api: a, sample: e, wireMismatches } = normaliseMs(api, sampleMsSnapshot(sample.snapshots.ndt!, 'isms'));
      expect(differences(a, e).length + wireMismatches.length).toBeGreaterThan(0);
    }
    // The ABMS questions the sample leaves empty are aligned only while each stage asks one question (M2-04).
    const abms = await clients.get('ndt')!.get<UiMsSnapshot>('/api/v1/ui/ms/abms');
    const aligned = normaliseMs(abms.body, sampleMsSnapshot(sample.snapshots.ndt!, 'abms'));
    expect(aligned.wireMismatches).toEqual([]);
    expect(differences(aligned.api, aligned.sample)).toEqual([]);
    const changed = structuredClone(abms.body);
    const items = changed.bundle.chain.items;
    const shared = items.find((item, i) => items.some((other, j) => j !== i && other.stage === item.stage))!;
    shared.q += ' (changed)';
    const { api: a, sample: e, wireMismatches } = normaliseMs(changed, sampleMsSnapshot(sample.snapshots.ndt!, 'abms'));
    expect(differences(a, e).length + wireMismatches.length).toBeGreaterThan(0);
    // Evidence examples are checked per system and key: the examples of Annex A 7.2 (ISMS) and clause 7.2 Competence
    // (QMS) are reported when they swap.
    const org = await clients.get('bsd')!.get<UiOrgSnapshot>('/api/v1/ui/org');
    const sampleOrg = sampleOrgSnapshot(sample.snapshots.bsd!);
    const swapped = structuredClone(org.body) as unknown as Record<string, unknown>;
    const examples = swapped.EXAMPLES as Record<string, string>;
    const [isms, qms] = [examples['isms:7.2'], examples['qms:7.2']];
    expect(isms).toBeTruthy();
    expect(qms).toBeTruthy();
    expect(isms).not.toBe(qms);
    [examples['isms:7.2'], examples['qms:7.2']] = [qms!, isms!];
    const checks = knownOrgDifferences('bsd', swapped, sampleOrg, content);
    expect(() => checks.forEach((check) => check())).toThrow();
    const unchanged = knownOrgDifferences('bsd', structuredClone(org.body) as unknown as Record<string, unknown>, sampleOrgSnapshot(sample.snapshots.bsd!), content);
    expect(() => unchanged.forEach((check) => check())).not.toThrow();
    // Clauses at risk are compared per system and stage: the ABMS control stage (8.1) is reported when it shows the
    // clause of the ISMS control stage (6.1.3 d)).
    const ndtOrg = (await clients.get('ndt')!.get<UiOrgSnapshot>('/api/v1/ui/org')).body;
    const orgDifferences = (body: UiOrgSnapshot) => {
      const api = structuredClone(body) as unknown as Record<string, unknown>;
      const expected = sampleOrgSnapshot(sample.snapshots.ndt!);
      knownOrgDifferences('ndt', api, expected, content);
      const normalised = normaliseOrg(api, expected);
      return differences(normalised.api, normalised.sample);
    };
    expect([ndtOrg.CLAUSE_AT_RISK['isms:control'], ndtOrg.CLAUSE_AT_RISK['abms:control']]).toEqual(['6.1.3 d)', '8.1']);
    expect(orgDifferences(ndtOrg)).toEqual([]);
    const firstWins = structuredClone(ndtOrg);
    firstWins.CLAUSE_AT_RISK['abms:control'] = firstWins.CLAUSE_AT_RISK['isms:control']!;
    expect(orgDifferences(firstWins).length).toBeGreaterThan(0);
  });

  for (const org of ORGS) {
    describe(org, () => {
      it('GET /ui/org equals the sample organisation snapshot', async () => {
        const response = await clients.get(org)!.get<UiOrgSnapshot>('/api/v1/ui/org');
        expect(response.status).toBe(200);
        expect(UiOrgSnapshot.safeParse(response.body).success).toBe(true);
        const api = structuredClone(response.body) as unknown as Record<string, unknown>;
        const expected = sampleOrgSnapshot(sample.snapshots[org]!);
        const known = knownOrgDifferences(org, api, expected, content);
        const { api: a, sample: s } = normaliseOrg(api, expected);
        expect(differences(a, s)).toEqual([]);
        for (const check of known) check();
      });

      for (const ms of sample.snapshots[org]!.orgs.find((o) => o.id === org)!.ms) {
        it(`GET /ui/ms/${ms} equals the sample bundle and system keys`, async () => {
          const response = await clients.get(org)!.get<UiMsSnapshot>(`/api/v1/ui/ms/${ms}`);
          expect(response.status).toBe(200);
          const parsed = UiMsSnapshot.safeParse(response.body);
          expect(parsed.success ? [] : parsed.error.issues.slice(0, 5)).toEqual([]);
          const body = structuredClone(response.body);
          const known = knownMsDifferences(ms, body, content);
          const { api, sample: s, wireMismatches } = normaliseMs(body, sampleMsSnapshot(sample.snapshots[org]!, ms));
          expect(wireMismatches).toEqual([]);
          expect(differences(api, s)).toEqual([]);
          for (const check of known) check();
        });
      }
    });
  }
});

/**
 * Differences between the API and the sample that follow from decisions, asserted on the API side and then aligned
 * so the remaining comparison is exact:
 * - The sample organisation snapshot carries the licence card and `TITLES` of the whole sample for every organisation
 *   (WP-07 deviation 3). The API composes the licence card from the organisation's own licence (G.3: bound to the
 *   organisation, named after it) and its own systems, and lists titles of its own systems only (G.5). `CLAUSE_AT_RISK`
 *   lists the stages of the organisation's systems in both, under the system and the stage (`abms:control`, M2-04).
 * - `rina` is also a member of the test organisation `tst` (G.3), the last entry of her `orgs`.
 * - The sample lists only the repositories that a system uses; every organisation has a Managed Vault (A-41), so the
 *   API lists rmn's unused vault too (G.5 `REPOS[]`: repositories ordered by position).
 * - Milestone 2 E.3 (M2-04): the installed packs are at the content step, while the sample's pack cards keep the
 *   versions of Milestone 1, which `packs/scripts/extract-from-sample.mjs` checks against its pack table (the released
 *   version lives in `packs/content/<pack_id>/manifest.json`). The API shows the released versions.
 *   The update the sample's ABMS card offers (0.7.0) is that installed version, so the API offers none.
 * - Milestone 2 E.2 (M2-04): every Annex A control and every leaf clause row of the packs has an evidence example,
 *   while the sample keeps its ten Annex A examples. The API lists the examples of the active editions under the
 *   system and the key of the row (`isms:8.13`, `qms:7.2`): each sample example unchanged under the same key (the
 *   sample's keys carry the system too), and every row of every system with its own example.
 * - Milestone 2 E.2 (M2-04): the ISO 37001 chain asks auditor questions, while the sample's ABMS stages keep empty
 *   questions, because the Indonesian question table of the extractor (`packs/scripts`) does not hold them yet.
 */
function knownOrgDifferences(org: DemoOrg, api: Record<string, unknown>, expected: Record<string, unknown>, content: PackContent): (() => void)[] {
  const checks: (() => void)[] = [];
  // G.3: rina is also a member of the test organisation, which the sample does not know.
  const orgs = api.orgs as { id: string }[];
  checks.push(() => expect(orgs.at(-1)).toMatchObject({ id: 'tst', name: 'Test Organisation', ms: ['isms'], sites: 1 }));
  api.orgs = orgs.filter((o) => o.id !== 'tst');
  // Milestone 2 E.3 (M2-04): the released versions of the content step in place of the sample's card versions.
  expected.PACKS = Object.fromEntries(
    Object.entries(expected.PACKS as Record<string, { v: string }>).map(([ms, card]) => [
      ms,
      {
        ...card,
        v: card.v
          .split(', ')
          .map((entry) => {
            const [, ...marks] = entry.split(' ');
            const edition = marks.map((m) => m.replace(/[()]/g, '')).find((m) => /^\d{4}$/.test(m)) ?? '';
            const packId = CARD_PACKS[ms]?.[edition];
            if (!packId) throw new Error(`no pack for the card entry "${entry}" of ${ms}`);
            return [releasedVersion(packId), ...marks].join(' ');
          })
          .join(', '),
      },
    ]),
  );
  // Milestone 2 E.3 (M2-04): the update the sample's ABMS card offers (0.7.0) is the installed content step, so the API
  // offers no update for that edition.
  const apiPacks = api.PACKS as Record<string, { update?: unknown }>;
  const expectedPacks = expected.PACKS as Record<string, { update?: unknown }>;
  if (apiPacks.abms && expectedPacks.abms) {
    const offered = apiPacks.abms.update ?? null;
    checks.push(() => expect(offered).toBeNull());
    checks.push(() => expect(releasedVersion('ISO37001-2025')).toBe('0.7.0'));
    expectedPacks.abms = { ...expectedPacks.abms, update: offered };
  }
  // Milestone 2 E.2 (M2-04): evidence examples of the packs, each under its system and the key of its own pack row.
  const apiExamples = (api.EXAMPLES as Record<string, string> | undefined) ?? {};
  const sampleExamples = (expected.EXAMPLES as Record<string, string> | undefined) ?? {};
  checks.push(() => {
    // The sample's keys carry the system already (`isms:8.13`); each of its examples is listed unchanged.
    expect(Object.keys(sampleExamples).length).toBeGreaterThan(0);
    for (const [key, example] of Object.entries(sampleExamples)) {
      expect(key, key).toMatch(/^isms:/);
      expect(apiExamples[key], key).toBe(example);
    }
    expect(Object.keys(apiExamples).length).toBeGreaterThan(Object.keys(sampleExamples).length);
    const owners = exampleOwners(org, content);
    // Every row of every system is listed under its own key with its own example, and no key comes from anywhere else.
    expect(Object.keys(apiExamples).sort()).toEqual([...owners.keys()].sort());
    for (const [key, example] of owners) expect(apiExamples[key], key).toBe(example);
    // Rows of two systems with the same number keep their own examples (QMS 7.2 Competence and Annex A 7.2).
    const slugs = (content.systems.get(org) ?? []).map((s) => s.slug);
    if (slugs.includes('isms') && slugs.includes('qms')) expect(apiExamples['qms:7.2']).not.toBe(apiExamples['isms:7.2']);
  });
  api.EXAMPLES = Object.fromEntries(Object.keys(sampleExamples).map((key) => [key, apiExamples[key]]));
  // Milestone 2 E.2 (M2-04): the auditor questions of the ISO 37001 chain.
  const apiStages = api.STAGES as Record<string, { q?: string }[]>;
  if (apiStages.abms) {
    const sampleAbms = (expected.STAGES as Record<string, { q?: string }[]>).abms ?? [];
    const questions = apiStages.abms.map((s) => s.q);
    checks.push(() => expect(questions).toEqual(content.abmsStages.map((stage) => stage.q)));
    checks.push(() => expect(content.abmsStages.length > 0 && content.abmsStages.every((stage) => stage.q !== '')).toBe(true));
    apiStages.abms = apiStages.abms.map((stage, i) => ({ ...stage, q: sampleAbms[i]?.q ?? '' }));
  }
  if (org === 'ndt') return checks;
  const systems = (api.MS as { id: string; code: string }[]).length;
  const licence = api.LICENCE as Record<string, unknown>;
  const name = org === 'bsd' ? 'PT Bank Sentosa Digital' : 'RS Medika Nusantara';
  checks.push(() => expect(licence).toMatchObject({ org: name, fw: `${systems} of 4`, ms: `${systems} of 10`, users: '86 of 150' }));
  expected.LICENCE = { ...(expected.LICENCE as Record<string, unknown>), org: name, fw: `${systems} of 4`, ms: `${systems} of 10` };
  const codes = new Set(Object.values(api.CHAINS as Record<string, { id: string; nodes: [string, string | null][] }[]>).flat().flatMap((c) => [c.id, ...c.nodes.map((n) => n[1])]));
  expected.TITLES = Object.fromEntries(Object.entries(expected.TITLES as Record<string, string>).filter(([k]) => codes.has(k)));
  if (org === 'rmn') {
    const repos = api.REPOS as { id: string; ms: string[] }[];
    checks.push(() => expect(repos.find((r) => r.id === 'vault')).toMatchObject({ ms: [] }));
    api.REPOS = repos.filter((r) => r.id !== 'vault');
  }
  return checks;
}

/**
 * Differences of one system snapshot, asserted on the API side: the chain items of the ABMS carry the auditor question
 * of their stage (M2-04, the ISO 37001 chain fixes of E.2), while the sample's are empty. `normaliseMs` aligns them
 * (one question per stage); this check adds that each is the question of the installed pack.
 */
function knownMsDifferences(ms: string, api: UiMsSnapshot, content: PackContent): (() => void)[] {
  if (ms !== 'abms') return [];
  const questions = new Map(content.abmsStages.map((stage) => [stage.key, stage.q]));
  const asked = api.bundle.chain.items.map((item) => [item.stage, item.q] as const);
  return [
    () => {
      expect(asked.length).toBeGreaterThan(0);
      for (const [stage, q] of asked) expect(q, stage).toBe(questions.get(stage));
    },
  ];
}

/** The example of each pack row of an organisation's systems by its `EXAMPLES` key (`<system>:<key of the row>`). */
function exampleOwners(org: DemoOrg, content: PackContent): Map<string, string> {
  const owners = new Map<string, string>();
  for (const system of content.systems.get(org) ?? []) {
    for (const [key, row] of content.examplesByEdition.get(system.editionId) ?? []) {
      const owner = `${system.slug}:${key}`;
      expect(owners.has(owner), owner).toBe(false);
      owners.set(owner, row.example);
    }
  }
  return owners;
}
