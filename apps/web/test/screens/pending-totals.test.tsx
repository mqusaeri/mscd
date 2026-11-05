// Open work totals (MILESTONE-3 M3-08, D.10): the route against the shared table, the model (rows of `aggregate=unit`,
// role columns, stage lines and sums), the API adapter over a fake fetch, the sample adapter over the sample snapshot,
// the page actions of Chain stages and the Overview (API builds only), and the views in both languages and themes,
// which show counts only and never a person's name (product decision 2). M3-14: each row of a role gives its holders.
// M3-15 (product owner decision 21): the roles with fewer than two holders are one row per stage without a role name
// ("Other roles"), and when they have fewer than two holders together their counts join "No role or unassigned", so
// no number on the screen belongs to one person; the reader is left out of the count (they know their own items) and
// external auditors never count (they hold no chain work); the sample build follows the same rule.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BUSINESS_ROLES, routeById } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/pending-totals/index';
import meta from '../../src/screens/pending-totals/meta.json';
import { ROUTES, ROUTE_IDS } from '../../src/screens/pending-totals/routes';
import { createApiAdapter } from '../../src/screens/pending-totals/api';
import { createSampleAdapter, sampleTotals } from '../../src/screens/pending-totals/sample';
import { adapterFor, deferredAdapter } from '../../src/screens/pending-totals/adapter';
import { extraPageActions, mayOpenTotals } from '../../src/screens/pending-totals/actions';
import {
  MIN_ROW_HOLDERS, NO_CHAIN_WORK_ROLES, OTHER_ROLES_GROUP, ROLE_ORDER, SCREEN_ID, TABS, TOTALS_PERM, aggregateItems, keyOf, keyOfRow, onTime, overdueShare, roleColumns, roleLabel,
  roleTotals, stageLines, stagesOf, stagesWithWork, sumOf, systemName, systemTitle, systemsWithTotals, toRows, withoutOnePersonRows,
} from '../../src/screens/pending-totals/model';
import { sampleMembers } from '../../src/screens/users/sample';
import type { PendingTotalsAdapter, TotalsRow } from '../../src/screens/pending-totals/model';
import PendingTotalsScreen, {
  AllSystemsView, CountCell, PendingTotalsBody, StageRoleTable, SummaryCard, SystemView,
} from '../../src/screens/pending-totals/Screen';
import type { LoadState } from '../../src/screens/pending-totals/Screen';
import { TEXT } from '../../src/screens/pending-totals/text';
import { BUSINESS_ROLE_LABELS } from '../../src/screens/roles';
import { HostCtx } from '../../src/screens/ui';
import type { HostContext, Lang } from '../../src/screens/types';
import type { ControllerData, MsId } from '../../src/data/types';
import * as SAMPLE from '../../src/data/mscd-data.js';
import { makeDates } from '../../src/data/dates.js';
import { createSampleDataSource } from '../../src/data/SampleDataSource.js';
import { fakeFetch, json, problem } from '../auth/helpers';

const snapshot = await createSampleDataSource().load();
const D = { ...makeDates(SAMPLE.TODAY_S), ...snapshot, TODAY_S: SAMPLE.TODAY_S } as unknown as ControllerData;
const isms = D.MS.find((m) => m.id === 'isms')!;
/** Every name of the sample organisation's people (the page must show none of them). */
const NAMES = Object.entries(D.PEOPLE).filter(([h]) => h !== 'none').map(([, p]) => p[0]);

function ctxOf(lang: Lang, over: Partial<HostContext> = {}): HostContext {
  const li = (t: unknown) => (Array.isArray(t) ? t[lang === 'id' ? 1 : 0] : String(t ?? ''));
  return {
    lang, li, fill: (t: unknown, v: Record<string, unknown>) => li(t).replace(/\{(\w+)\}/g, (_m: string, k: string) => String(v[k])),
    theme: 'light', D, msObj: isms, org: { id: 'ndt' }, me: null, person: { handle: 'hendra', name: 'Hendra Wijaya', jobTitle: '-' }, role: 'top', mode: 'sample',
    client: null, ds: null, screen: SCREEN_ID, params: {}, can: () => true, orgCan: () => false, platformCan: () => false, toast: vi.fn(), go: vi.fn(),
    track: <T,>(p: Promise<T>) => p, reload: vi.fn(async () => undefined), command: vi.fn(), openPicker: async () => null, layer: () => null,
    ...over,
  } as unknown as HostContext;
}

const render = (node: JSX.Element, ctx: HostContext, theme: 'light' | 'dark' = 'light') =>
  renderToStaticMarkup(<HostCtx.Provider value={ctx}><div className="mscd" data-theme={theme}>{node}</div></HostCtx.Provider>);

/** The text of rendered markup without tags. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const ROWS: TotalsRow[] = [
  { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1 },
  { stage: 'risk', role: null, open: 2, overdue: 2 },
  { stage: 'control', role: 'ms_manager', open: 3, overdue: 0 },
  { stage: 'control', role: 'domain_owner', open: 5, overdue: 2 },
  { stage: 'evidence', role: 'top_management', open: 1, overdue: 1 },
];
const STAGES = [
  { id: 'context', l: ['Context issue', 'Isu konteks'] as const },
  { id: 'risk', l: ['Risk', 'Risiko'] as const },
  { id: 'control', l: ['Control', 'Kontrol'] as const },
  { id: 'evidence', l: ['Evidence', 'Bukti'] as const },
];

describe('pending-totals route', () => {
  it('matches the shared route table: readmodel.audit.pending, whose aggregate=unit answer needs audit.pending.aggregate', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
      expect(route.summary).toContain('aggregate=unit needs audit.pending.aggregate');
    }
    expect(ROUTE_IDS).toEqual({ pending: 'readmodel.audit.pending' });
  });
});

describe('pending-totals definition', () => {
  it('is an Audit screen of the system without a sidebar entry, opened by the permission of F.6', () => {
    expect(screen).toMatchObject({ id: 'pending-totals', path: '/ms/:ms/pending-totals', group: 'audit', scope: 'ms', perm: TOTALS_PERM, nav: false });
    expect(screen.roles).toEqual(['top', 'manager', 'sponsor']);
    expect(TOTALS_PERM).toBe('audit.pending.aggregate');
    expect(meta).toMatchObject({ id: screen.id, roles: ['top', 'manager', 'sponsor'], sampleRole: 'top', open: 'query', nav: false, pageActions: [] });
    expect(TABS).toEqual(['system', 'all']);
  });

  it('keeps the business roles in the order of the shared contract (the server counts a holder under the first)', () => {
    expect(ROLE_ORDER).toEqual([...BUSINESS_ROLES]);
  });

  it('has both languages in every text, Indonesian that differs, no em dash or centre dot and no person name', () => {
    for (const [key, value] of Object.entries(TEXT)) {
      expect(value, key).toHaveLength(2);
      expect(value[0].trim(), key).not.toBe('');
      expect(value[1], `${key}: Indonesian equals English`).not.toBe(value[0]);
      expect(value.join(' '), key).not.toMatch(/[\u2014\u00b7]/);
      for (const name of NAMES) expect(value.join(' '), key).not.toContain(name);
    }
  });
});

describe('pending-totals model', () => {
  it('reads the rows of aggregate=unit, keeps only the four fields and refuses other answers', () => {
    expect(toRows(ROWS)).toEqual(ROWS);
    // A field the server might add (a holder) never reaches the page.
    expect(toRows([{ stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holder: 'bagus', displayName: 'Bagus Prasetyo' }])).toEqual([{ stage: 'risk', role: 'domain_owner', open: 1, overdue: 0 }]);
    expect(toRows([])).toEqual([]);
    // The per-person answer (audit.pending.all) is not a list of aggregate rows.
    expect(toRows([{ holder: 'bagus', displayName: 'Bagus Prasetyo', jobTitle: 'IT', open: 3, overdue: 1, afterAudit: 0, stages: {} }])).toBeNull();
    for (const bad of [null, {}, 'rows', { items: [] }, [null], [{ stage: 'risk', role: 1, open: 1, overdue: 0 }], [{ stage: 'risk', role: null, open: -1, overdue: 0 }], [{ stage: 'risk', role: null, open: 1.5, overdue: 0 }]]) {
      expect(toRows(bad), JSON.stringify(bad)).toBeNull();
    }
    // The number of holders of a role (M3-14) is kept; a value that is not a count makes the answer unreadable.
    expect(toRows([{ stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holders: 3 }])).toEqual([{ stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holders: 3 }]);
    for (const holders of [-1, 1.5, '2', null]) expect(toRows([{ stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holders }]), String(holders)).toBeNull();
    // The merged row of the roles with fewer than two holders (M3-15) keeps its flag; a flag on a role row, or any other
    // flag, makes the answer unreadable.
    const merged = { stage: 'risk', role: null, open: 3, overdue: 1, holders: 2, group: 'other_roles' };
    expect(toRows([merged])).toEqual([merged]);
    expect(OTHER_ROLES_GROUP).toBe('other_roles');
    for (const bad of [{ ...merged, group: 'risk_owner' }, { ...merged, role: 'risk_owner' }, { ...merged, group: true }]) expect(toRows([bad]), JSON.stringify(bad)).toBeNull();
  });

  it('shows the merged row of the server as "Other roles", and no number on the screen belongs to one person (M3-15)', () => {
    const rows: TotalsRow[] = [
      { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1, holders: 3 },
      { stage: 'risk', role: null, open: 2, overdue: 2 },
      { stage: 'control', role: 'domain_owner', open: 5, overdue: 2, holders: 3 },
      { stage: 'control', role: null, open: 5, overdue: 1, holders: 2, group: 'other_roles' },
      { stage: 'evidence', role: null, open: 1, overdue: 1, holders: 2, group: 'other_roles' },
    ];
    expect(keyOfRow(rows[0]!)).toBe('domain_owner');
    expect(keyOfRow(rows[1]!)).toBe('none');
    expect(keyOfRow(rows[3]!)).toBe('other');
    expect(roleColumns(rows)).toEqual(['domain_owner', 'other', 'none']);
    expect(roleLabel('other')).toEqual(['Other roles', 'Peran lainnya']);
    expect(roleTotals(rows)).toEqual({ domain_owner: { open: 9, overdue: 3 }, other: { open: 6, overdue: 2 }, none: { open: 2, overdue: 2 } });
    const control = stageLines(rows, STAGES).find((l) => l.key === 'control')!;
    expect(control.cells).toEqual({ other: { open: 5, overdue: 1 }, domain_owner: { open: 5, overdue: 2 } });
    for (const lang of ['en', 'id'] as const) {
      const ctx = ctxOf(lang);
      const i = lang === 'id' ? 1 : 0;
      const html = render(<SystemView ctx={ctx} ms="isms" rows={rows} />, ctx);
      expect(html).toContain(`data-role="other">${TEXT.otherRoles[i]}</th>`);
      expect(html).toContain('data-other-note=""');
      expect(html).toContain(TEXT.otherRolesNote[i].replace(/"/g, '&quot;'));
      // The note stands under every table: a merge into "No role or unassigned" leaves no column to point to it.
      const plain = render(<SystemView ctx={ctx} ms="isms" rows={ROWS} />, ctx);
      expect(plain).toContain('data-other-note=""');
      expect(plain).not.toContain('data-role="other"');
    }
    expect(TEXT.otherRolesNote[0]).toContain('No number on this screen belongs to one person.');
    expect(TEXT.otherRolesNote[1]).toContain('Tidak ada angka di layar ini yang milik satu orang.');
  });

  it('merges the roles with fewer than two holders as the server does (decision 21, M3-15)', () => {
    const stageOrder = ['risk', 'control', 'evidence'];
    const raw: TotalsRow[] = [
      { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1, holders: 3 },
      { stage: 'risk', role: null, open: 2, overdue: 2 },
      { stage: 'control', role: 'ms_manager', open: 3, overdue: 0, holders: 1 },
      { stage: 'control', role: 'domain_owner', open: 5, overdue: 2, holders: 3 },
      { stage: 'control', role: 'risk_owner', open: 2, overdue: 1, holders: 1 },
      { stage: 'evidence', role: 'top_management', open: 1, overdue: 1, holders: 1 },
    ];
    expect(MIN_ROW_HOLDERS).toBe(2);
    // Two one-holder roles (and a third without open work): one row per stage that stands for all three people.
    const three = new Map([['domain_owner', 3], ['ms_manager', 1], ['risk_owner', 1], ['top_management', 1]] as const);
    expect(withoutOnePersonRows(raw, stageOrder, three)).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1, holders: 3 },
      { stage: 'risk', role: null, open: 2, overdue: 2 },
      { stage: 'control', role: 'domain_owner', open: 5, overdue: 2, holders: 3 },
      { stage: 'control', role: null, open: 5, overdue: 1, holders: 3, group: 'other_roles' },
      { stage: 'evidence', role: null, open: 1, overdue: 1, holders: 3, group: 'other_roles' },
    ]);
    // A lone one-holder role: the group would stand for one person, so its counts join the unassigned row.
    const lone: TotalsRow[] = [
      { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1, holders: 3 },
      { stage: 'risk', role: 'top_management', open: 2, overdue: 1, holders: 1 },
      { stage: 'risk', role: null, open: 2, overdue: 2 },
      { stage: 'evidence', role: 'top_management', open: 1, overdue: 0, holders: 1 },
    ];
    const loneOut = withoutOnePersonRows(lone, stageOrder, new Map([['domain_owner', 3], ['top_management', 1]] as const));
    expect(loneOut).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1, holders: 3 },
      { stage: 'risk', role: null, open: 4, overdue: 3 },
      { stage: 'evidence', role: null, open: 1, overdue: 0 },
    ]);
    expect(roleColumns(loneOut)).toEqual(['domain_owner', 'none']);
    // A role whose only holder left (0) is merged too; with one other one-holder role the group stands for one person.
    expect(withoutOnePersonRows([{ stage: 'risk', role: 'risk_owner', open: 2, overdue: 0, holders: 0 }], stageOrder, new Map([['domain_owner', 2], ['ms_manager', 1]] as const)))
      .toEqual([{ stage: 'risk', role: null, open: 2, overdue: 0 }]);
    // Only roles with two or more holders: nothing merges.
    const many = new Map([['domain_owner', 3], ['ms_manager', 2], ['risk_owner', 2], ['top_management', 2]] as const);
    expect(withoutOnePersonRows(raw, stageOrder, many).some((r) => r.group)).toBe(false);
    expect(withoutOnePersonRows(raw, stageOrder, many).filter((r) => r.role !== null).every((r) => (r.holders ?? 0) >= 2)).toBe(true);
    // The totals never change, only their rows.
    for (const holders of [three, many, new Map([['domain_owner', 3], ['top_management', 1]] as const)]) expect(sumOf(withoutOnePersonRows(raw, stageOrder, holders))).toEqual(sumOf(raw));
  });

  it('counts the people besides the reader, so a row never gives one other person\'s numbers after the reader takes away their own (decision 21, M3-15)', () => {
    const stageOrder = ['risk', 'control'];
    const raw: TotalsRow[] = [
      { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1, holders: 3 },
      { stage: 'risk', role: 'ms_manager', open: 2, overdue: 1, holders: 1 },
      { stage: 'control', role: 'top_management', open: 3, overdue: 0, holders: 1 },
      { stage: 'control', role: null, open: 1, overdue: 1 },
    ];
    // Top Management (the reader) and one Management System Manager: two holders, but only one besides the reader, so
    // the group would be the manager's work once the reader takes away their own. Both join the unassigned row.
    const holders = new Map([['domain_owner', 3], ['ms_manager', 1], ['top_management', 1]] as const);
    const others = new Map([['domain_owner', 3], ['ms_manager', 1]] as const);
    expect(withoutOnePersonRows(raw, stageOrder, holders)).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1, holders: 3 },
      { stage: 'risk', role: null, open: 2, overdue: 1, holders: 2, group: 'other_roles' },
      { stage: 'control', role: null, open: 3, overdue: 0, holders: 2, group: 'other_roles' },
      { stage: 'control', role: null, open: 1, overdue: 1 },
    ]);
    expect(withoutOnePersonRows(raw, stageOrder, holders, others)).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 4, overdue: 1, holders: 3 },
      { stage: 'risk', role: null, open: 2, overdue: 1 },
      { stage: 'control', role: null, open: 4, overdue: 1 },
    ]);
    // With a third one-holder role the group stands for two people besides the reader: it shows, and its holders count
    // the reader too (three people behind the row).
    const three = new Map([...holders, ['internal_auditor', 1]] as const);
    const threeOthers = new Map([...others, ['internal_auditor', 1]] as const);
    expect(withoutOnePersonRows(raw, stageOrder, three, threeOthers).filter((r) => r.group)).toEqual([
      { stage: 'risk', role: null, open: 2, overdue: 1, holders: 3, group: 'other_roles' },
      { stage: 'control', role: null, open: 3, overdue: 0, holders: 3, group: 'other_roles' },
    ]);
    // A role the reader shares with one other person is small for the reader: its row would be that person's numbers.
    const shared: TotalsRow[] = [{ stage: 'risk', role: 'top_management', open: 5, overdue: 2, holders: 2 }];
    const sharedHolders = new Map([['top_management', 2], ['domain_owner', 3]] as const);
    expect(withoutOnePersonRows(shared, stageOrder, sharedHolders)).toEqual([{ stage: 'risk', role: 'top_management', open: 5, overdue: 2, holders: 2 }]);
    expect(withoutOnePersonRows(shared, stageOrder, sharedHolders, new Map([['top_management', 1], ['domain_owner', 3]] as const))).toEqual([{ stage: 'risk', role: null, open: 5, overdue: 2 }]);
    for (const o of [holders, others]) expect(sumOf(withoutOnePersonRows(raw, stageOrder, holders, o))).toEqual(sumOf(raw));
  });

  it('adds counts, the items on time and the overdue share', () => {
    expect(sumOf(ROWS)).toEqual({ open: 15, overdue: 6 });
    expect(sumOf([])).toEqual({ open: 0, overdue: 0 });
    expect(onTime({ open: 15, overdue: 6 })).toBe(9);
    expect(onTime({ open: 1, overdue: 3 })).toBe(0);
    expect(overdueShare({ open: 15, overdue: 6 })).toBe(40);
    expect(overdueShare({ open: 3, overdue: 1 })).toBe(33);
    expect(overdueShare({ open: 0, overdue: 0 })).toBe(0);
  });

  it('orders the role columns by the business roles, with unassigned and unknown roles last', () => {
    expect(roleColumns(ROWS)).toEqual(['ms_manager', 'domain_owner', 'top_management', 'none']);
    expect(roleColumns([{ stage: 'risk', role: 'investigator' as never, open: 1, overdue: 0 }, { stage: 'risk', role: null, open: 1, overdue: 0 }, { stage: 'risk', role: 'risk_owner', open: 1, overdue: 0 }])).toEqual(['risk_owner', 'investigator', 'none']);
    expect(roleColumns([])).toEqual([]);
    expect(keyOf(null)).toBe('none');
    expect(roleLabel('none')).toEqual([...TEXT.noRole]);
    expect(roleLabel('programme_owner')).toEqual(BUSINESS_ROLE_LABELS.programme_owner);
    expect(roleLabel('investigator' as never)).toEqual(['investigator', 'investigator']);
  });

  it('lists every stage of the chain in order, then stages the snapshot does not know, with cells and totals', () => {
    const lines = stageLines([...ROWS, { stage: 'drift', role: null, open: 1, overdue: 0 }], STAGES);
    expect(lines.map((l) => l.key)).toEqual(['context', 'risk', 'control', 'evidence', 'drift']);
    expect(lines[0]).toEqual({ key: 'context', label: ['Context issue', 'Isu konteks'], cells: {}, total: { open: 0, overdue: 0 } });
    expect(lines[1].cells).toEqual({ domain_owner: { open: 4, overdue: 1 }, none: { open: 2, overdue: 2 } });
    expect(lines[2].total).toEqual({ open: 8, overdue: 2 });
    expect(lines[4]).toMatchObject({ key: 'drift', label: 'drift', total: { open: 1, overdue: 0 } });
    expect(stagesWithWork(lines)).toEqual({ n: 4, total: 5 });
    expect(stageLines(ROWS, null).map((l) => l.key)).toEqual(['risk', 'control', 'evidence']);
    expect(roleTotals(ROWS)).toEqual({ domain_owner: { open: 9, overdue: 3 }, none: { open: 2, overdue: 2 }, ms_manager: { open: 3, overdue: 0 }, top_management: { open: 1, overdue: 1 } });
  });

  it('counts chain items as the server does: first role in order, unassigned and roleless holders under null, overdue unless pending', () => {
    const roles: Record<string, string[]> = { rina: ['programme_owner', 'ms_manager'], bagus: ['domain_owner'], maya: [] };
    const rows = aggregateItems([
      { stage: 'control', h: 'bagus', st: 'overdue' },
      { stage: 'risk', h: 'rina', st: 'pending' },
      { stage: 'risk', h: 'none', st: 'missing' },
      { stage: 'risk', h: 'maya', st: 'pending' },
      { stage: 'control', h: 'bagus', st: 'pending' },
      { stage: 'risk', h: 'bagus', st: 'missing' },
    ], (h) => roles[h] ?? [], ['risk', 'control']);
    expect(rows).toEqual([
      { stage: 'risk', role: 'ms_manager', open: 1, overdue: 0 },
      { stage: 'risk', role: 'domain_owner', open: 1, overdue: 1 },
      { stage: 'risk', role: null, open: 2, overdue: 1 },
      { stage: 'control', role: 'domain_owner', open: 2, overdue: 1 },
    ]);
    // With the people of the system, each row of a role gives its holders, as the server does (M3-14), and the roles
    // with fewer than two holders merge (M3-15): rina is the only Management System Manager, alone in the group, so
    // her item joins the unassigned row.
    const items = [{ stage: 'risk', h: 'bagus', st: 'pending' }, { stage: 'risk', h: 'rina', st: 'pending' }, { stage: 'risk', h: 'none', st: 'pending' }];
    const people = aggregateItems(items, (h) => ({ ...roles, dewi: ['domain_owner'] })[h] ?? [], ['risk'], ['rina', 'bagus', 'dewi', 'maya']);
    expect(people).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holders: 2 },
      { stage: 'risk', role: null, open: 2, overdue: 0 },
    ]);
    // With a Top Management holder too, the two one-holder roles are one "Other roles" row for two people.
    const two = aggregateItems(items, (h) => ({ ...roles, dewi: ['domain_owner'], hendra: ['top_management'] })[h] ?? [], ['risk'], ['rina', 'bagus', 'dewi', 'maya', 'hendra']);
    expect(two).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holders: 2 },
      { stage: 'risk', role: null, open: 1, overdue: 0, holders: 2, group: 'other_roles' },
      { stage: 'risk', role: null, open: 1, overdue: 0 },
    ]);
    // Read by Top Management (hendra), the same two one-holder roles stand for one person besides the reader, so rina's
    // item joins the unassigned row (the group would be her work once hendra takes away his own).
    const rolesTwo = (h: string) => ({ ...roles, dewi: ['domain_owner'], hendra: ['top_management'] })[h] ?? [];
    expect(aggregateItems(items, rolesTwo, ['risk'], ['rina', 'bagus', 'dewi', 'maya', 'hendra'], 'hendra')).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holders: 2 },
      { stage: 'risk', role: null, open: 2, overdue: 0 },
    ]);
    // An external auditor holds no chain work and is never a person of a row: with rina and a guest auditor alone in
    // the small roles, the group would be rina's work, so it joins the unassigned row; holders never count the auditor.
    expect(NO_CHAIN_WORK_ROLES).toEqual(['external_auditor']);
    const rolesAuditor = (h: string) => ({ ...roles, dewi: ['domain_owner'], eko: ['external_auditor'] })[h] ?? [];
    expect(aggregateItems(items, rolesAuditor, ['risk'], ['rina', 'bagus', 'dewi', 'eko'])).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holders: 2 },
      { stage: 'risk', role: null, open: 2, overdue: 0 },
    ]);
    const auditors = (h: string) => ({ ...roles, dewi: ['domain_owner'], eko: ['external_auditor'], ext2: ['external_auditor'] })[h] ?? [];
    const withAuditors = aggregateItems([...items, { stage: 'risk', h: 'eko', st: 'pending' }], auditors, ['risk'], ['rina', 'bagus', 'dewi', 'eko', 'ext2']);
    expect(withAuditors.some((r) => r.role === 'external_auditor' || r.group)).toBe(false);
    expect(withAuditors).toEqual([
      { stage: 'risk', role: 'domain_owner', open: 1, overdue: 0, holders: 2 },
      { stage: 'risk', role: null, open: 3, overdue: 0 },
    ]);
  });

  it('names the systems and lists those where the session sees the totals', () => {
    expect(systemName(ctxOf('en'), 'isms')).toBe('ISMS');
    expect(systemName(ctxOf('en'), 'zzz')).toBe('ZZZ');
    expect(systemTitle(ctxOf('id'), 'qms')).toEqual(['Quality management system', 'Sistem manajemen mutu']);
    expect(systemTitle(ctxOf('en'), 'zzz')).toBeNull();
    expect(stagesOf(ctxOf('en'), 'isms').map((s) => s.id)).toEqual(['context', 'risk', 'treatment', 'control', 'soa', 'document', 'evidence', 'metric']);
    expect(stagesOf(ctxOf('en', { D: null }), 'isms')).toEqual([]);
    expect(systemsWithTotals(ctxOf('en')).map((m) => m.id)).toEqual(['isms', 'qms', 'bcms', 'abms']);
    const some = ctxOf('en', { can: (ms: string | null | undefined, perm: unknown) => ms !== 'qms' && perm === TOTALS_PERM });
    expect(systemsWithTotals(some).map((m) => m.id)).toEqual(['isms', 'bcms', 'abms']);
  });
});

describe('pending-totals API adapter', () => {
  it('reads aggregate=unit of the system and keeps a refusal or an answer it cannot read as a failure', async () => {
    const f = fakeFetch({
      'GET /api/v1/ms/isms/audit/pending': json(ROWS),
      'GET /api/v1/ms/qms/audit/pending': problem(403, 'forbidden', { messages: { en: 'Pending counts per unit need audit.pending.aggregate', id: 'Perlu audit.pending.aggregate' } }),
      'GET /api/v1/ms/bcms/audit/pending': json([{ holder: 'bagus', displayName: 'Bagus Prasetyo', jobTitle: 'IT', open: 1, overdue: 0, afterAudit: 0, stages: {} }]),
    });
    const adapter = createApiAdapter(new ApiClient({ fetch: f.fetch }));
    expect(adapter.sample).toBe(false);
    expect(await adapter.totals('isms')).toEqual({ ok: true, data: ROWS });
    expect(f.calls[0]).toMatchObject({ method: 'GET', path: '/api/v1/ms/isms/audit/pending' });
    expect(new URL(f.calls[0].url, 'http://localhost').searchParams.get('aggregate')).toBe('unit');
    expect(await adapter.totals('qms')).toMatchObject({ ok: false, error: { status: 403, slug: 'forbidden', message: ['Pending counts per unit need audit.pending.aggregate', 'Perlu audit.pending.aggregate'] } });
    const odd = await adapter.totals('bcms');
    expect(odd).toEqual({ ok: false, error: { status: 200, message: [...TEXT.unexpected] } });
    expect(JSON.stringify(odd)).not.toContain('Bagus');
    expect(await createApiAdapter(null).totals('isms')).toMatchObject({ ok: false, error: { status: 0 } });
  });
});

describe('pending-totals sample adapter', () => {
  it('computes the ISMS totals from the sample chain items: 63 open, 24 overdue or missing, as Chain stages shows', async () => {
    const rows = sampleTotals(D, 'isms')!;
    expect(sumOf(rows)).toEqual({ open: 63, overdue: 24 });
    // Per stage as the tabs of Chain stages count them.
    const byStage = Object.fromEntries(stageLines(rows, stagesOf(ctxOf('en'), 'isms')).map((l) => [l.key, l.total.open]));
    expect(byStage).toEqual({ context: 1, risk: 5, treatment: 4, control: 28, soa: 3, document: 8, evidence: 10, metric: 4 });
    // The sample roles: rina manages every system, hendra is Top Management and maya the Internal Auditor, each the only
    // holder of the role in the ISMS, so the three roles are one "Other roles" row per stage that stands for the three of
    // them (M3-15); unassigned items count under no role.
    const isOnly = (role: string) => sampleMembers(D).members.filter((m) => m.membershipStatus === 'active' && m.roles.some((r) => r.ms === 'isms' && r.role === role && r.approvalStatus === 'active')).length;
    expect([isOnly('ms_manager'), isOnly('top_management'), isOnly('internal_auditor')]).toEqual([1, 1, 1]);
    expect(rows.filter((r) => r.role !== null).every((r) => typeof r.holders === 'number' && r.holders >= 2)).toBe(true);
    expect(rows.filter((r) => r.group === 'other_roles').every((r) => r.role === null && r.holders === 3)).toBe(true);
    expect(rows.some((r) => r.role === 'ms_manager' || r.role === 'top_management' || r.role === 'internal_auditor')).toBe(false);
    expect(roleColumns(rows)).toEqual(['domain_owner', 'other', 'none']);
    const items = D.bundles.isms.chain.items;
    const count = (pred: (h: string) => boolean) => items.filter((i) => pred(i.h)).length;
    const totals = roleTotals(rows);
    expect(totals.other!.open).toBe(count((h) => h === 'rina' || h === 'hendra' || h === 'maya'));
    expect(totals.none!.open).toBe(count((h) => h === 'none'));
    expect(totals.domain_owner!.open).toBe(count((h) => !['rina', 'hendra', 'maya', 'none'].includes(h)));
    for (const ms of ['qms', 'bcms', 'abms']) {
      const all = D.bundles[ms].chain.items;
      expect(sumOf(sampleTotals(D, ms)!), ms).toEqual({ open: all.length, overdue: all.filter((i) => i.st !== 'pending').length });
    }
    // As Top Management (hendra) or the Management System Manager (rina) read it, the group of the ISMS still stands
    // for two people besides the reader, so it shows the same.
    expect(sampleTotals(D, 'isms', 'hendra')).toEqual(rows);
    expect(sampleTotals(D, 'isms', 'rina')).toEqual(rows);
    // Without the Internal Auditor (a snapshot without maya, whose open work then counts under no role), rina and
    // hendra are the only one-holder roles of the ISMS. Read by anyone else they are one "Other roles" row for two
    // people; read by hendra (Top Management) they stand for one person besides him, so no "Other roles" row shows and
    // their items count under "No role or unassigned".
    const people = Object.fromEntries(Object.entries(D.PEOPLE).filter(([h]) => h !== 'maya'));
    const noAuditor = { ...D, PEOPLE: people } as unknown as ControllerData;
    const anyone = sampleTotals(noAuditor, 'isms')!;
    expect(anyone.filter((r) => r.group).every((r) => r.holders === 2)).toBe(true);
    expect(roleTotals(anyone).other?.open).toBe(count((h) => h === 'rina' || h === 'hendra'));
    const asHendra = sampleTotals(noAuditor, 'isms', 'hendra')!;
    expect(asHendra.some((r) => r.group || r.role === 'ms_manager' || r.role === 'top_management')).toBe(false);
    expect(roleTotals(asHendra).none?.open).toBe((roleTotals(anyone).none?.open ?? 0) + roleTotals(anyone).other!.open);
    expect(sumOf(asHendra)).toEqual(sumOf(anyone));
    expect(await createSampleAdapter(() => noAuditor, () => 'hendra').totals('isms')).toEqual({ ok: true, data: asHendra });
    const adapter = createSampleAdapter(() => D);
    expect(adapter.sample).toBe(true);
    expect(await adapter.totals('isms')).toEqual({ ok: true, data: rows });
    expect(await adapter.totals('zzz')).toMatchObject({ ok: false, error: { status: 404, message: [...TEXT.unknownSystem] } });
    expect(await createSampleAdapter(() => null).totals('isms')).toMatchObject({ ok: false, error: { status: 404 } });
  });

  it('loads the sample adapter on the first call in the sample build, once', async () => {
    const load = vi.fn(async () => createSampleAdapter(() => D));
    const deferred = deferredAdapter(load);
    expect(deferred.sample).toBe(true);
    expect(load).not.toHaveBeenCalled();
    await deferred.totals('isms');
    await deferred.totals('qms');
    expect(load).toHaveBeenCalledTimes(1);
    const ctx = ctxOf('en', { ds: {} as never });
    expect(adapterFor(ctx)).toBe(adapterFor(ctx));
    expect(adapterFor(ctx).sample).toBe(true);
    expect(sumOf((await adapterFor(ctx).totals('isms') as { ok: true; data: TotalsRow[] }).data)).toEqual({ open: 63, overdue: 24 });
    // The reader of the sample totals is the persona of the host context (the rule of decision 21 leaves them out).
    const noAuditor = { ...D, PEOPLE: Object.fromEntries(Object.entries(D.PEOPLE).filter(([h]) => h !== 'maya')) } as unknown as ControllerData;
    const top = ctxOf('en', { ds: {} as never, D: noAuditor });
    expect((await adapterFor(top).totals('isms') as { ok: true; data: TotalsRow[] }).data).toEqual(sampleTotals(noAuditor, 'isms', 'hendra'));
    expect((await adapterFor(top).totals('isms') as { ok: true; data: TotalsRow[] }).data.some((r) => r.group)).toBe(false);
    const other = ctxOf('en', { ds: {} as never, D: noAuditor, person: { handle: 'bagus', name: 'Bagus Prasetyo', jobTitle: '-' } });
    expect((await adapterFor(other).totals('isms') as { ok: true; data: TotalsRow[] }).data.some((r) => r.group)).toBe(true);
  });
});

describe('pending-totals page actions', () => {
  it('adds "Open work totals" to Chain stages and the Overview in API builds for holders of audit.pending.aggregate', () => {
    expect(extraPageActions.map((a) => [a.screen, a.id])).toEqual([['chain', 'chain.pendingTotals'], ['m1overview', 'm1overview.pendingTotals']]);
    for (const action of extraPageActions) expect(action.label).toEqual([...TEXT.openAction]);
    const api = ctxOf('en', { mode: 'api', can: (_ms: unknown, perm: unknown) => perm === TOTALS_PERM });
    expect(mayOpenTotals(api)).toBe(true);
    // The sample build keeps the page actions of the generated views (C.1).
    expect(mayOpenTotals(ctxOf('en'))).toBe(false);
    expect(mayOpenTotals(ctxOf('en', { mode: 'api', can: () => false }))).toBe(false);
    expect(mayOpenTotals(ctxOf('en', { mode: 'api', msObj: null }))).toBe(false);
    extraPageActions[0].run(api);
    expect(api.go).toHaveBeenCalledWith('pending-totals');
  });
});

describe('pending-totals views', () => {
  it('shows the totals and the stage by role table in both languages and themes, with counts only', () => {
    const rows = sampleTotals(D, 'isms')!;
    for (const lang of ['en', 'id'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const ctx = ctxOf(lang);
        const html = render(<SystemView ctx={ctx} ms="isms" rows={rows} />, ctx, theme);
        const i = lang === 'id' ? 1 : 0;
        expect(html).toContain(ctx.fill(TEXT.summaryTitle, { system: 'ISMS' }));
        expect(html).toContain(TEXT.matrixTitle[i]);
        expect(html).toContain('data-total-open="63"');
        expect(html).toContain('data-total-overdue="24"');
        expect(html).toContain(ctx.fill(TEXT.stagesValue, { n: 8, total: 8 }));
        expect(html).toContain(ctx.fill(TEXT.shareValue, { n: 38 }));
        expect(html).toMatch(/data-stat="ontime".*?data-value="">39</);
        // The Management System Manager, Top Management and the Internal Auditor are each held by one person in the sample
        // ISMS: "Other roles" (M3-15).
        expect(html).toContain(BUSINESS_ROLE_LABELS.domain_owner[i]);
        expect(html).toContain(`data-role="other">${TEXT.otherRoles[i]}</th>`);
        for (const role of ['ms_manager', 'top_management'] as const) expect(html).not.toContain(`data-role="${role}"`);
        expect(html).toContain(TEXT.noRole[i]);
        expect(html).toContain(TEXT.rowAllStages[i]);
        expect(html).toContain(TEXT.colAllRoles[i]);
        expect(html).toMatch(/<tr data-stage="control"><th scope="row">(Control|Kontrol)<\/th>/);
        expect(html).toMatch(/<td class="mx-num" data-role="all" data-open="28" data-overdue="\d+">/);
        expect(html).toMatch(/<tr data-stage="all">.*data-role="all" data-open="63" data-overdue="24"/);
        const text = textOf(html);
        for (const name of NAMES) expect(text, name).not.toContain(name);
        expect(text).not.toMatch(/[\u2014\u00b7]/);
      }
    }
  });

  it('marks a cell without open items with 0 and shows the overdue items under the open ones', () => {
    const ctx = ctxOf('en');
    expect(render(<CountCell ctx={ctx} count={undefined} />, ctx)).toContain('<span class="mx-pt-zero">0</span>');
    expect(render(<CountCell ctx={ctx} count={{ open: 0, overdue: 0 }} />, ctx)).toContain('mx-pt-zero');
    const cell = render(<CountCell ctx={ctx} count={{ open: 5, overdue: 2 }} />, ctx);
    expect(cell).toContain('<span class="mx-pt-open">5</span>');
    expect(cell).toContain('2 overdue');
    expect(render(<CountCell ctx={ctxOf('id')} count={{ open: 5, overdue: 2 }} />, ctxOf('id'))).toContain('2 terlambat');
    expect(render(<CountCell ctx={ctx} count={{ open: 3, overdue: 0 }} />, ctx)).not.toContain('overdue');
  });

  it('builds the table from the rows: role columns, every stage, the totals row', () => {
    const ctx = ctxOf('en');
    const lines = stageLines(ROWS, STAGES);
    const html = render(<StageRoleTable ctx={ctx} rows={ROWS} lines={lines} />, ctx);
    expect(html.match(/<th scope="col"/g)).toHaveLength(6);
    expect(html.match(/<tr data-stage=/g)).toHaveLength(5);
    expect(html).toContain('<tr data-stage="context"><th scope="row">Context issue</th>');
    expect(html).toContain('data-role="none" data-open="2" data-overdue="2"');
    expect(html).toContain('aria-label="Open items per chain stage and business role"');
    const summary = render(<SummaryCard ctx={ctx} ms="isms" total={sumOf(ROWS)} lines={lines} />, ctx);
    expect(summary).toContain('3 of 4');
    expect(summary).toContain('40% of the open items');
    expect(summary).toContain('data-tone="bad"');
  });

  it('shows the all-done scene when nothing is open', () => {
    for (const lang of ['en', 'id'] as const) {
      const ctx = ctxOf(lang);
      const html = render(<SystemView ctx={ctx} ms="qms" rows={[]} />, ctx);
      expect(html).toContain(ctx.fill(TEXT.emptyTitle, { system: 'QMS' }));
      expect(html).toContain(TEXT.emptyText[lang === 'id' ? 1 : 0]);
      expect(html).toContain('data-empty=""');
      expect(html).toContain('<svg');
      expect(html).not.toContain('data-total-open');
    }
  });

  it('lists every system of "All my systems" with its totals, the sum, a failure and a system still loading', () => {
    const ctx = ctxOf('en');
    const loads: Record<MsId, LoadState> = {
      isms: { status: 'ok', rows: sampleTotals(D, 'isms')! },
      qms: { status: 'ok', rows: sampleTotals(D, 'qms')! },
      bcms: { status: 'failed', error: { status: 500, message: ['Server error', 'Kesalahan server'] } },
      abms: { status: 'loading' },
    };
    const onShow = vi.fn();
    const html = render(<AllSystemsView ctx={ctx} systems={['isms', 'qms', 'bcms', 'abms']} loads={loads} onShow={onShow} onRetry={vi.fn()} />, ctx);
    expect(html).toContain('<tr data-ms="isms" data-open="63" data-overdue="24" aria-current="true">');
    expect(html).toContain('<tr data-ms="qms" data-open="18" data-overdue="5">');
    expect(html).toContain('Quality management system');
    expect(html).toContain(TEXT.current[0]);
    expect(html).toContain(TEXT.systemFailed[0]);
    expect(html).toContain(TEXT.systemLoading[0]);
    expect(html).toContain(TEXT.someFailed[0]);
    expect(html).toContain(TEXT.tryAgain[0]);
    // The totals row waits until every system has answered.
    expect(html).toMatch(/<tr data-ms="all"><th scope="row">All systems<\/th><td class="mx-num" colSpan="3"><span class="mx-small" role="status">Loading<\/span>/);
    expect(html.match(/title="Show the table of [A-Z]+"/g)).toHaveLength(4);
    // Without a system still loading, the sum covers the systems that answered.
    const failed = render(<AllSystemsView ctx={ctx} systems={['isms', 'qms', 'bcms']} loads={loads} onShow={onShow} />, ctx);
    expect(failed).toMatch(/<tr data-ms="all" data-open="81" data-overdue="29"><th scope="row">All systems<\/th><td class="mx-num">81<\/td><td class="mx-num">29<\/td><td class="mx-num">36%<\/td>/);
    expect(failed).toContain(TEXT.someFailed[0]);
    expect(failed).not.toContain(TEXT.tryAgain[0]);
    const done = render(<AllSystemsView ctx={ctxOf('id')} systems={['isms', 'qms']} loads={{ isms: loads.isms, qms: loads.qms }} onShow={onShow} />, ctxOf('id'));
    expect(done).toContain('<tr data-ms="all" data-open="81" data-overdue="29">');
    expect(done).toContain('Semua sistem');
    expect(done).toContain('Lihat tabel');
    expect(done).not.toContain(TEXT.someFailed[1]);
    const one = render(<AllSystemsView ctx={ctx} systems={['isms']} loads={{ isms: loads.isms }} onShow={onShow} />, ctx);
    expect(one).not.toContain('data-ms="all"');
    for (const name of NAMES) expect(textOf(html), name).not.toContain(name);
  });

  it('renders the body: the note, the tabs and the loading state; without a system or the permission it explains why', () => {
    const adapter: PendingTotalsAdapter = { sample: true, totals: vi.fn(async () => ({ ok: true as const, data: ROWS })) };
    for (const lang of ['en', 'id'] as const) {
      const ctx = ctxOf(lang);
      const i = lang === 'id' ? 1 : 0;
      const html = render(<PendingTotalsBody ctx={ctx} adapter={adapter} />, ctx);
      expect(html).toContain(TEXT.countsOnly[i]);
      expect(html).toContain(`role="tablist" aria-label="${TEXT.tabsLabel[i]}"`);
      expect(html).toContain(TEXT.tabSystem[i]);
      expect(html).toContain(TEXT.tabAll[i]);
      expect(html).toContain('data-tab="system"');
      expect(html).toContain(TEXT.loading[i]);
      expect(render(<PendingTotalsBody ctx={ctxOf(lang, { msObj: null })} adapter={adapter} />, ctx)).toContain(TEXT.noSystem[i]);
      expect(render(<PendingTotalsBody ctx={ctxOf(lang, { can: () => false })} adapter={adapter} />, ctx)).toContain(TEXT.notAllowed[i]);
    }
    // The tab of the address (M2-20) picks "All my systems".
    const routed = Object.assign(ctxOf('en'), { tab: 'all', setTab: vi.fn() });
    const all = render(<PendingTotalsBody ctx={routed} adapter={adapter} />, routed);
    expect(all).toContain('data-tab="all"');
    expect(all).toContain(TEXT.allCaption[0]);
    expect(all).toContain('<tr data-ms="abms">');
    const page = render(<PendingTotalsScreen ctx={ctxOf('en', { ds: {} as never })} />, ctxOf('en'));
    expect(page).toContain(TEXT.countsOnly[0]);
  });
});
