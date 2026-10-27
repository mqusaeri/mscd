// Owner scope and read projections on every GET route (build plan J.5, D-04, D-34, F.7, G.5, Q-8):
// - a Domain Owner of ISMS who owns nothing gets no record of anyone on any GET route of ISMS, and every route of
//   another system is 403 for them; `/ui/org` shows chains, titles and people of ISMS only;
// - a Domain Owner sees the records they own, and a `restricted` document only when they own it;
// - the guest auditor gets the G.5 projection on every GET route: no holder names, no `web_url`, evidence only
//   through ready evidence packs;
// - Top Management gets pending data as aggregates only: no holder or due date of anyone else's pending work on any
//   GET route of the system (`GET /ui/ms/{ms}`, the per-screen endpoints and the register lists), with the counts of
//   the full view (WP-30 fixes of `ScopePolicyService.projectSnapshot` and of the D-04 list reads).
import { API_ROUTES, pathParamNames, type RouteDef, type UiMsSnapshot, type UiOrgSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import {
  addFixtureUser, callRoute, createFullApp, demoSession, exampleInput, msIdOf, pendingStub, resetRateLimits, rowsIn, sessionFor, userIdOf,
  type Client, type FullApp, type FixtureUser, type RouteInput,
} from '../contract/harness';
import { DIRECT, M2_READ_TABLES } from './record-tables';

/** GET routes of a signed-in user that read one system. */
const MS_READS: readonly RouteDef[] = API_ROUTES.filter(
  (r) => r.method === 'GET' && r.auth === 'session' && !r.testOnly && (r.msSource !== undefined || pathParamNames(r.path).includes('ms')),
);
/** GET routes of a signed-in user that name no system. */
const ORG_READS: readonly RouteDef[] = API_ROUTES.filter(
  (r) => r.method === 'GET' && r.auth === 'session' && !r.testOnly && r.msSource === undefined && !pathParamNames(r.path).includes('ms'),
);

/** Every RecordRef (`module`, `entityType`, `id`) in a body. */
function refsIn(body: unknown, out: { entityType: string; id: string; code?: string }[] = []) {
  if (Array.isArray(body)) for (const v of body) refsIn(v, out);
  else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.module === 'string' && typeof o.entityType === 'string' && typeof o.id === 'string') {
      out.push({ entityType: o.entityType, id: o.id, ...(typeof o.code === 'string' ? { code: o.code } : {}) });
    }
    for (const v of Object.values(o)) refsIn(v, out);
  }
  return out;
}

/** Values of keys that name people holding work (`owner`, `holder`, `h`, handles inside `holder` objects). */
function holdersIn(body: unknown, out: string[] = [], key = ''): string[] {
  if (Array.isArray(body)) for (const v of body) holdersIn(v, out, key);
  else if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if ((k === 'owner' || k === 'holder' || k === 'h' || k === 'approver') && typeof v === 'string') out.push(`${k}=${v}`);
      else if (k === 'holder' && v && typeof v === 'object' && typeof (v as { handle?: unknown }).handle === 'string') out.push(`holder=${(v as { handle: string }).handle}`);
      holdersIn(v, out, k);
    }
  }
  return out;
}

/** Keys naming the person who holds pending work, and keys of the dates that work is due. */
const HOLDER_KEYS: ReadonlySet<string> = new Set(['owner', 'holder', 'h', 'approver', 'auditee']);
const DUE_KEYS: ReadonlySet<string> = new Set(['due', 'dueAt', 'daysToDue', 'next', 'nextReviewAt', 'nextDueAt', 'targetFixAt', 'targetDate']);

/**
 * Per-person pending data of people other than `self` (Q-8): a holder key naming someone else, or a due date on a
 * record whose holder is not `self`. Values `none` and null name nobody. The system card of `/ui/ms` (`ms`, with
 * the manager and the gate approver) is kept for every reader.
 */
function pendingOfOthers(body: unknown, self: string, out: string[] = [], path = ''): string[] {
  if (Array.isArray(body)) body.forEach((v, i) => pendingOfOthers(v, self, out, `${path}[${i}]`));
  else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const handles: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (!HOLDER_KEYS.has(k)) continue;
      if (typeof v === 'string') handles.push(v);
      else if (v && typeof v === 'object' && typeof (v as { handle?: unknown }).handle === 'string') handles.push((v as { handle: string }).handle);
    }
    for (const h of handles) if (h !== 'none' && h !== self) out.push(`${path} names ${h}`);
    const held = handles.includes(self);
    const hasHolder = [...HOLDER_KEYS].some((k) => k in o);
    if (hasHolder && !held) {
      for (const k of DUE_KEYS) if (o[k] !== undefined && o[k] !== null) out.push(`${path}.${k} = ${String(o[k])} without holder`);
    }
    for (const [k, v] of Object.entries(o)) if (!(path === '' && k === 'ms')) pendingOfOthers(v, self, out, `${path}.${k}`);
  }
  return out;
}

/**
 * Keys that may name a person other than Top Management, and date keys that may stay on a record whose holder is
 * hidden: past facts, not pending work (the product owner decision recorded in the WP-30 handoff, Q-8). Any other
 * key naming someone, or any other date on such a record, fails the every-GET-route check below, so a later change
 * that exposes a pending holder or due date under a new name does not pass unnoticed.
 */
const PAST_PERSON_KEYS: ReadonlySet<string> = new Set(['implementedBy', 'verifiedBy']);
const PAST_DATE_KEYS: ReadonlySet<string> = new Set([
  'implementedAt', 'verifiedAt', 'heldAt', 'raisedAt', 'detectedAt', 'assessedAt', 'updatedAt', 'scheduledAt', 'plannedAt',
]);
/** `date` of a phase activity is its verification date when the activity is verified, else its due date. */
const pastDate = (o: Record<string, unknown>, k: string) => PAST_DATE_KEYS.has(k) || (k === 'date' && (o.st === 'verified' || o.status === 'verified'));
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/;

/** Handles of people named under a holder key anywhere in a body. */
function handlesIn(body: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(body)) for (const v of body) handlesIn(v, out);
  else if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (HOLDER_KEYS.has(k) && typeof v === 'string' && v !== 'none') out.add(v);
      else if (HOLDER_KEYS.has(k) && v && typeof v === 'object' && typeof (v as { handle?: unknown }).handle === 'string') out.add((v as { handle: string }).handle);
      handlesIn(v, out);
    }
  }
  return out;
}

/**
 * Person and date keys outside the pinned lists: a key other than a holder key whose value is the handle of someone
 * other than `self`, and on a record whose holder is hidden or someone else, a date under a key that is neither a
 * due key nor a pinned past fact. Found keys are returned as `key` strings (one per key name).
 */
function unpinnedKeys(body: unknown, self: string, handles: ReadonlySet<string>, out: Set<string> = new Set(), parentKey = '', path = ''): Set<string> {
  if (Array.isArray(body)) body.forEach((v, i) => unpinnedKeys(v, self, handles, out, parentKey, `${path}[${i}]`));
  else if (typeof body === 'string') {
    if (parentKey !== '' && !HOLDER_KEYS.has(parentKey) && !PAST_PERSON_KEYS.has(parentKey) && body !== self && handles.has(body)) out.add(`person ${parentKey}`);
  } else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const holders = [...HOLDER_KEYS].filter((k) => k in o).map((k) => {
      const v = o[k];
      return v && typeof v === 'object' ? (v as { handle?: unknown }).handle : v;
    });
    const hidden = holders.length > 0 && !holders.includes(self);
    for (const [k, v] of Object.entries(o)) {
      if (path === '' && k === 'ms') continue;
      if (hidden && typeof v === 'string' && DATE_VALUE.test(v) && !DUE_KEYS.has(k) && !pastDate(o, k)) out.add(`date ${k}`);
      unpinnedKeys(v, self, handles, out, k, `${path}.${k}`);
    }
  }
  return out;
}

/**
 * A valid input of a GET route for a system, with real ids where the route needs one: the record table of a
 * Milestone 2 route comes from its package's record-tables file (Milestone 2 F).
 */
async function readInput(db: ReturnType<typeof useTestDatabase>, def: RouteDef, org: 'ndt' | 'tst', ms: string): Promise<RouteInput | null> {
  const msId = await msIdOf(db, org, ms);
  const names = pathParamNames(def.path);
  const ids: Record<string, string> = {};
  if (names.includes('id')) {
    const table = M2_READ_TABLES[def.id] ?? (def.id.startsWith('evidence-packs') ? 'evidence_pack' : 'audit_event');
    const [row] = DIRECT.has(table)
      ? await rowsIn<{ id: string }>(db, org, sql`select id from ${sql.table(table)} where management_system_id = ${msId} and deleted_at is null limit 1`)
      : await rowsIn<{ id: string }>(db, org, sql`select x.id from ${sql.table(table)} x where x.deleted_at is null and exists (select 1 from entity_ms_link l
          where l.entity_type = ${table} and l.entity_id = x.id and l.management_system_id = ${msId} and l.deleted_at is null) limit 1`);
    if (!row) return null;
    ids.id = row.id;
  }
  const override: RouteInput = { params: { ms, ...ids } };
  if (names.includes('n')) override.params!.n = 4;
  if (names.includes('key')) override.params!.key = 'risk';
  if (def.msSource === 'query') override.query = { ms };
  return exampleInput(def, { ms, ids, override });
}

describe('J.5 owner scope and read projections on every GET route', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let nobody: Client;
  let nobodyUser: FixtureUser;
  let rina: Client;

  beforeAll(async () => {
    full = await createFullApp(db);
    nobodyUser = await addFixtureUser(db, 'ndt', 'wp30-do-none', { business: [{ ms: 'isms', role: 'domain_owner' }] });
    nobody = await sessionFor(full, nobodyUser.id, 'ndt');
    rina = await demoSession(full, db, 'rina', 'ndt');
  });

  afterAll(async () => {
    await full?.close();
  });

  it('gives an ISMS Domain Owner who owns nothing no record of anyone on every GET route of ISMS', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const def of MS_READS) {
      await resetRateLimits(db);
      const input = await readInput(db, def, 'ndt', 'isms');
      if (!input) continue;
      const reply = await callRoute(nobody, def, input);
      problems.push(...reply.violations);
      if (reply.status === 403 || reply.status === 404 || pendingStub(def, input, reply)) continue;
      if (reply.status !== 200) {
        problems.push(`${def.id}: ${reply.status} ${reply.text.slice(0, 160)}`);
        continue;
      }
      checked += 1;
      const refs = refsIn(reply.body).filter((r) => !['management_system', 'audit_event', 'evidence_pack', 'phase'].includes(r.entityType));
      if (refs.length > 0) problems.push(`${def.id}: refs ${refs.slice(0, 5).map((r) => `${r.entityType}:${r.code}`).join(', ')}`);
      const holders = holdersIn(reply.body).filter((h) => !/=(none|wp30-do-none)?$/.test(h));
      if (holders.length > 0) problems.push(`${def.id}: holders ${holders.slice(0, 5).join(', ')}`);
    }
    expect(checked).toBeGreaterThan(15);
    expect(problems).toEqual([]);
  });

  it('refuses an ISMS Domain Owner on every GET route of another system (403)', async () => {
    const problems: string[] = [];
    for (const ms of ['qms', 'abms']) {
      for (const def of MS_READS) {
        await resetRateLimits(db);
        const input = await readInput(db, def, 'ndt', ms);
        if (!input) continue;
        const reply = await callRoute(nobody, def, input);
        if (reply.status !== 403) problems.push(`${ms} ${def.id}: ${reply.status} ${reply.text.slice(0, 120)}`);
        problems.push(...reply.violations);
      }
    }
    expect(problems).toEqual([]);
  });

  it('shows the organisation views of ISMS only: chains, titles, people, tasks and notifications', async () => {
    const qmsCodes = new Set(
      (await rowsIn<{ code: string }>(db, 'ndt', sql`select d.doc_code as code from document d where d.deleted_at is null
        and exists (select 1 from entity_ms_link l join management_system m on m.id = l.management_system_id where l.entity_type = 'document' and l.entity_id = d.id and m.slug = 'qms')
        and not exists (select 1 from entity_ms_link l join management_system m on m.id = l.management_system_id where l.entity_type = 'document' and l.entity_id = d.id and m.slug = 'isms')`)).map((r) => r.code),
    );
    expect(qmsCodes.size).toBeGreaterThan(0);
    const org = await nobody.get<UiOrgSnapshot>('/api/v1/ui/org');
    expect(org.status).toBe(200);
    expect(Object.keys(org.body.CHAINS).filter((ms) => ms !== 'isms')).toEqual([]);
    for (const chains of Object.values(org.body.CHAINS)) expect(chains).toEqual([]);
    for (const code of Object.keys(org.body.TITLES)) expect(qmsCodes.has(code), code).toBe(false);
    expect(Object.keys(org.body.TITLES)).toEqual([]);
    const ismsPeople = new Set(
      (await rowsIn<{ handle: string }>(db, 'ndt', sql`select distinct u.handle from user_ms_role r join platform.app_user u on u.id = r.user_id
        join management_system m on m.id = r.management_system_id where m.slug = 'isms' and r.deleted_at is null and r.approval_status = 'active'`)).map((r) => r.handle),
    );
    for (const handle of Object.keys(org.body.PEOPLE)) expect(handle === 'none' || ismsPeople.has(handle), handle).toBe(true);
    for (const def of ORG_READS) {
      if (pathParamNames(def.path).length > 0) continue;
      const reply = await callRoute(nobody, def, exampleInput(def));
      expect(reply.violations).toEqual([]);
      if (reply.status !== 200) continue;
      const text = JSON.stringify(reply.body);
      for (const code of qmsCodes) expect(text.includes(`"${code}"`), `${def.id} ${code}`).toBe(false);
    }
  });

  it('shows a Domain Owner the records they own, and a restricted document only to its owner', async () => {
    const owner = await addFixtureUser(db, 'ndt', 'wp30-do-owner', { business: [{ ms: 'isms', role: 'domain_owner' }] });
    const client = await sessionFor(full, owner.id, 'ndt');
    const msId = await msIdOf(db, 'ndt', 'isms');
    const [doc] = await rowsIn<{ id: string; code: string }>(db, 'ndt', sql`select d.id, d.doc_code as code from document d join entity_ms_link l on l.entity_type = 'document'
      and l.entity_id = d.id and l.management_system_id = ${msId} and l.deleted_at is null where d.deleted_at is null and not d.is_org_wide order by d.doc_code limit 1`);
    await rowsIn(db, 'ndt', sql`update document set owner_user_id = ${owner.id}, classification = 'restricted' where id = ${doc!.id}`);
    const mine = await client.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
    expect(mine.body.bundle.docs.map((d) => d.id)).toEqual([doc!.code]);
    const listed = await client.get<{ items: { id: string }[] }>('/api/v1/ms/isms/documents');
    expect(listed.body.items.map((d) => d.id)).toEqual([doc!.code]);
    // Another Domain Owner, the Internal Auditor and Top Management do not see it; the MS Manager does.
    for (const handle of ['bagus', 'maya', 'hendra']) {
      const other = await demoSession(full, db, handle, 'ndt');
      const snapshot = await other.get<UiMsSnapshot>('/api/v1/ui/ms/isms');
      expect(snapshot.body.bundle.docs.map((d) => d.id), handle).not.toContain(doc!.code);
      const list = await other.get<{ items: { id: string }[] }>('/api/v1/ms/isms/documents?pageSize=200');
      expect(list.body.items.map((d) => d.id), handle).not.toContain(doc!.code);
    }
    expect((await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body.bundle.docs.map((d) => d.id)).toContain(doc!.code);
  });

  it('gives the guest auditor the G.5 projection on every GET route of the audited system', async () => {
    const guestId = await userIdOf(db, 'ext.auditor');
    const [grant] = await rowsIn<{ id: string }>(db, 'tst', sql`select id from auditor_access_grant where user_id = ${guestId} and revoked_at is null`);
    const guest = await sessionFor(full, guestId, 'tst', { authMethod: 'guest', authGrantId: grant!.id });
    const msId = await msIdOf(db, 'tst', 'isms');
    const packEvidence = new Set(
      (await rowsIn<{ code: string }>(db, 'tst', sql`select e.evidence_code as code from evidence_pack_item i join evidence_pack p on p.id = i.evidence_pack_id
        join evidence e on e.id = i.evidence_id where p.management_system_id = ${msId} and p.status = 'ready'`)).map((r) => r.code),
    );
    const allEvidence = (await rowsIn<{ code: string }>(db, 'tst', sql`select evidence_code as code from evidence where deleted_at is null`)).map((r) => r.code);
    const problems: string[] = [];
    let checked = 0;
    for (const def of [...MS_READS, ...ORG_READS.filter((r) => pathParamNames(r.path).length === 0)]) {
      await resetRateLimits(db);
      const input = await readInput(db, def, 'tst', 'isms');
      if (!input) continue;
      const reply = await callRoute(guest, def, input);
      problems.push(...reply.violations);
      if (reply.status !== 200) continue;
      checked += 1;
      // File and CSV answers carry no JSON body: their text is checked instead.
      const text = reply.body === undefined ? reply.text : JSON.stringify(reply.body);
      if (/"web_?[uU]rl"/.test(text)) problems.push(`${def.id}: web_url sent`);
      // G.5 keeps the system card fields (`MS[]`, with the manager and the gate approver); everything else names nobody.
      const { MS: _card, ...records } = (reply.body ?? {}) as Record<string, unknown>;
      const holders = holdersIn(records).filter((h) => !/=(none)?$/.test(h));
      if (holders.length > 0) problems.push(`${def.id}: holders ${holders.slice(0, 5).join(', ')}`);
      for (const code of allEvidence) if (!packEvidence.has(code) && text.includes(`"${code}"`)) problems.push(`${def.id}: evidence ${code} outside ready packs`);
    }
    expect(checked).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });

  it('gives Top Management no holder or due date of anyone else on every GET route of the system (Q-8)', async () => {
    const hendra = await demoSession(full, db, 'hendra', 'ndt');
    const problems: string[] = [];
    let checked = 0;
    let named = 0;
    const unpinned = new Map<string, Set<string>>();
    const handles = new Set<string>();
    const replies: [string, unknown][] = [];
    for (const def of MS_READS) {
      await resetRateLimits(db);
      const input = await readInput(db, def, 'ndt', 'isms');
      if (!input) continue;
      const reply = await callRoute(hendra, def, input);
      problems.push(...reply.violations);
      if (reply.status === 403 || reply.status === 404 || pendingStub(def, input, reply)) continue;
      if (reply.status !== 200) {
        problems.push(`${def.id}: ${reply.status} ${reply.text.slice(0, 160)}`);
        continue;
      }
      checked += 1;
      problems.push(...pendingOfOthers(reply.body, 'hendra').map((p) => `${def.id}: ${p}`));
      // The same route of the MS Manager names other people, so the check above is not empty by accident.
      const manager = await callRoute(rina, def, input);
      if (manager.status === 200 && pendingOfOthers(manager.body, 'hendra').length > 0) named += 1;
      if (manager.status === 200) handlesIn(manager.body, handles);
      replies.push([def.id, reply.body]);
    }
    // Person and date keys beyond the holder and due keys must be pinned past facts.
    for (const [id, body] of replies) for (const key of unpinnedKeys(body, 'hendra', handles)) unpinned.set(key, (unpinned.get(key) ?? new Set()).add(id));
    expect(Object.fromEntries([...unpinned].map(([k, ids]) => [k, [...ids]]))).toEqual({});
    expect(checked).toBeGreaterThan(15);
    expect(named).toBeGreaterThan(5);
    expect(problems).toEqual([]);
  });

  it('gives Top Management the register lists with the full counts but no owner or due date of anyone else (Q-8)', async () => {
    const hendra = await demoSession(full, db, 'hendra', 'ndt');
    type Row = { code?: string; conditionCode?: string; owner: string | null; dueAt?: string | null; targetFixAt?: string | null; nextReviewAt?: string | null };
    const lists: [string, string][] = [
      ['findings', '/api/v1/ms/isms/findings?pageSize=200'],
      ['corrective-actions', '/api/v1/ms/isms/corrective-actions?pageSize=200'],
      ['self-assessment', '/api/v1/ms/isms/self-assessments?pageSize=200'],
      ['risks', '/api/v1/ms/isms/registers/risks?pageSize=200'],
    ];
    let hidden = 0;
    for (const [name, url] of lists) {
      const top = await hendra.get<{ items: Row[]; total: number }>(url);
      const manager = await rina.get<{ items: Row[]; total: number }>(url);
      expect([top.status, manager.status], name).toEqual([200, 200]);
      // The same rows and the same total: counts are those of the full data.
      expect(top.body.total, name).toBe(manager.body.total);
      expect(top.body.items.map((r) => r.code ?? r.conditionCode), name).toEqual(manager.body.items.map((r) => r.code ?? r.conditionCode));
      top.body.items.forEach((row, i) => {
        const full = manager.body.items[i]!;
        if (full.owner === 'hendra') {
          expect(row, `${name} ${row.code}`).toEqual(full);
          return;
        }
        if (full.owner !== null && full.owner !== 'none') hidden += 1;
        expect([row.owner, row.dueAt ?? null, row.targetFixAt ?? null, row.nextReviewAt ?? null], `${name} ${row.code ?? row.conditionCode}`).toEqual([
          name === 'self-assessment' ? null : 'none', null, null, null,
        ]);
      });
    }
    expect(hidden).toBeGreaterThan(5);
    // Neither the owner filter nor the search finds rows by the name of someone else.
    const [someone] = (await rina.get<{ items: Row[] }>('/api/v1/ms/isms/registers/risks?pageSize=200')).body.items.filter((r) => r.owner !== 'hendra' && r.owner !== 'none');
    expect(someone).toBeDefined();
    expect((await hendra.get<{ total: number }>(`/api/v1/ms/isms/registers/risks?owner=${someone!.owner}`)).body.total).toBe(0);
    expect((await hendra.get<{ total: number }>(`/api/v1/ms/isms/registers/risks?q=${someone!.owner}`)).body.total).toBe(0);
    expect((await rina.get<{ total: number }>(`/api/v1/ms/isms/registers/risks?owner=${someone!.owner}`)).body.total).toBeGreaterThan(0);
    // `owner=none` lists the rows that are really unowned, the same rows for every role (a hidden owner matches no
    // owner filter).
    let othersOwned = 0;
    for (const register of ['risks', 'assets', 'metrics']) {
      const url = `/api/v1/ms/isms/registers/${register}?pageSize=200&owner=none`;
      const all = (await rina.get<{ items: Row[] }>(`/api/v1/ms/isms/registers/${register}?pageSize=200`)).body.items;
      const unowned = all.filter((r) => r.owner === 'none').map((r) => r.code);
      othersOwned += all.filter((r) => r.owner !== 'none' && r.owner !== 'hendra').length;
      expect((await rina.get<{ items: Row[] }>(url)).body.items.map((r) => r.code), register).toEqual(unowned);
      expect((await hendra.get<{ items: Row[] }>(url)).body.items.map((r) => r.code), register).toEqual(unowned);
    }
    expect(othersOwned).toBeGreaterThan(0);
  });

  it('gives Top Management pending data as aggregates only in GET /ui/ms/{ms} (Q-8)', async () => {
    const hendra = await demoSession(full, db, 'hendra', 'ndt');
    const top = (await hendra.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
    const manager = (await rina.get<UiMsSnapshot>('/api/v1/ui/ms/isms')).body;
    const others = (h: string | null) => h !== null && h !== 'none' && h !== 'hendra';
    // The full view has pending work of other people, so the rule is exercised.
    expect(manager.bundle.chain.items.filter((i) => others(i.h)).length).toBeGreaterThan(10);
    // Same aggregates: the same items (apart from restricted documents, which only their owner and the managers
    // see; an earlier test of this file made one), counts and stage totals.
    const restricted = new Set(
      (await rowsIn<{ code: string }>(db, 'ndt', sql`select doc_code as code from document where classification = 'restricted' and deleted_at is null`)).map((r) => r.code),
    );
    expect(top.bundle.chain.items.map((i) => i.key)).toEqual(manager.bundle.chain.items.filter((i) => !(i.key.includes(":doc:") && restricted.has(i.key.split(":").pop()!))).map((i) => i.key));
    expect(top.bundle.chain.recs).toEqual(manager.bundle.chain.recs);
    expect(top.bundle.gates.map((g) => g.id)).toEqual(manager.bundle.gates.map((g) => g.id));
    for (const item of top.bundle.chain.items) {
      if (item.h !== 'hendra') {
        expect(item.h, item.key).toBe('none');
        expect(item.due, item.key).toBeNull();
      }
    }
    for (const gate of top.bundle.gates) if (gate.h !== 'hendra') expect([gate.h, gate.due], gate.id).toEqual(['none', null]);
    for (const [stage, records] of Object.entries(top.X)) for (const x of records) if (x.h !== 'hendra') expect([x.h, x.due], `${stage} ${x.id}`).toEqual(['none', null]);
    // The bundle records behind a chain item whose holder is hidden carry no owner and no date either, so an item id
    // cannot be joined to them to read what the item hides (holderShown of read-model-api/screens.ts).
    const hiddenItems = top.bundle.chain.items.filter((i) => i.h !== 'hendra');
    expect(hiddenItems.length).toBeGreaterThan(10);
    let joined = 0;
    for (const item of hiddenItems) {
      if (item.kind === 'req') {
        const r = top.bundle.reqs.find((x) => x.id === item.id);
        if (r) { joined += 1; expect([r.owner, r.due ?? null, r.note], item.key).toEqual([undefined, null, undefined]); }
      } else if (item.kind === 'doc') {
        const doc = top.bundle.docs.find((x) => x.id === item.id);
        if (doc) { joined += 1; expect([doc.owner, doc.approver, doc.rev], item.key).toEqual([undefined, undefined, '']); }
      } else if (item.kind === 'ev') {
        const e = top.bundle.evs.find((x) => x.code === item.id);
        if (e) { joined += 1; expect([e.owner, e.next], item.key).toEqual([undefined, null]); }
      }
    }
    expect(joined).toBeGreaterThan(0);
    // No bundle record of anyone else names a holder or a date.
    for (const r of top.bundle.reqs) if (r.owner !== undefined) expect(r.owner, r.id).toBe('hendra');
    // Requirements of other people carry no blocker note, the same rule as the blocker text of phase activities
    // (the readiness export prints the note of blocked controls).
    for (const r of top.bundle.reqs) if (r.owner === undefined) expect(r.note, r.id).toBeUndefined();
    for (const doc of top.bundle.docs) if (doc.owner !== undefined || doc.approver !== undefined) expect(doc.owner, doc.id).toBe('hendra');
    for (const e of top.bundle.evs) if (e.owner !== undefined) expect(e.owner, e.code).toBe('hendra');
    for (const e of top.bundle.evs) if (e.owner === undefined) expect(e.next, e.code).toBeNull();
    // Phase activities of other people: no holder, no blocker text, no due date; the activity counts stay.
    expect(top.bundle.phases.map((p) => p.acts.length)).toEqual(manager.bundle.phases.map((p) => p.acts.length));
    expect(manager.bundle.phases.flatMap((p) => p.acts).filter((a) => others(a.owner)).length).toBeGreaterThan(0);
    for (const act of top.bundle.phases.flatMap((p) => p.acts)) {
      if (act.owner !== 'hendra') expect([act.owner, act.blocker, act.st === 'verified' ? null : act.date], act.key).toEqual(['none', null, null]);
    }
    // A document Top Management owns keeps its owner but not the approver, unless that is Top Management too.
    for (const doc of top.bundle.docs) if (doc.approver !== undefined) expect(doc.approver, doc.id).toBe('hendra');
    // Rows of PREP, CYCLE_ITEMS and DRIFT carry a due date, so only the caller's own rows are sent.
    expect(manager.PREP.length + manager.CYCLE_ITEMS.length).toBeGreaterThan(0);
    for (const row of top.PREP) expect(row[1]).toBe('hendra');
    for (const row of top.CYCLE_ITEMS) expect(row[2]).toBe('hendra');
    for (const pattern of top.DRIFT) for (const row of pattern.rows ?? []) expect(row[2]).toBe('hendra');
    expect(top.PREP).toEqual(manager.PREP.filter((row) => row[1] === 'hendra'));
    expect(top.CYCLE_ITEMS).toEqual(manager.CYCLE_ITEMS.filter((row) => row[2] === 'hendra'));
    // Top Management's own pending work keeps its holder and date.
    const own = manager.bundle.chain.items.filter((i) => i.h === 'hendra');
    for (const item of own) expect(top.bundle.chain.items.find((i) => i.key === item.key)).toMatchObject({ h: 'hendra', due: item.due });
  });
});
