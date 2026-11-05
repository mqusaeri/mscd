// The view model of the Open work totals screen (MILESTONE-3 M3-08, D.10) and the interface both adapters implement
// (api.ts in API builds, sample.ts in the sample build, chosen by the build in adapter.ts): the open and overdue counts
// of a management system per chain stage and per business role, as `GET /ms/{ms}/audit/pending?aggregate=unit`
// (`readmodel.audit.pending`, permission `audit.pending.aggregate`) answers them. The rows carry no holder, name or due
// date (product decision 2), and nothing in this model adds one. No number on the screen belongs to one person (product
// owner decision 21, M3-15): the server merges every business role with fewer than two holders besides the reader in
// the system into one row per stage without a role name (`group: 'other_roles'`, shown as "Other roles"), and when
// those roles have fewer than two such holders together their counts join "No role or unassigned". The reader is left
// out of the count because they know their own open items; external auditors never count, since they hold no chain
// work. The sample adapter follows the same rule (`withoutOnePersonRows`), so both builds show the same columns.
import type { BusinessRole } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import type { ManagementSystem, MsId } from '../../data/types';
import { BUSINESS_ROLE_LABELS } from '../roles';
import type { HostContext, TextPair } from '../types';
import { TEXT } from './text';

/** The screen id (C.2). */
export const SCREEN_ID = 'pending-totals';

/** The icon of the screen and its page actions: bars of a chart over a base line. */
export const ICON = 'M4 20h16M7 16v-5M12 16V6M17 16v-8';

/** The permission that opens the screen and its route (F.6: Management System Manager, Programme Owner, Top Management). */
export const TOTALS_PERM = 'audit.pending.aggregate';

/** The tabs of the screen, in their order; the first is shown when the address names none (M2-20). */
export const TABS = ['system', 'all'] as const;
export type TabId = (typeof TABS)[number];

/**
 * Business roles in the order of `BUSINESS_ROLES` of @mscd/shared, which the server uses to pick the role a holder
 * counts under (`pendingAggregate`) and to sort the rows. Kept here because screens import only types from the shared
 * package (R-17); the unit test compares it with the shared list.
 */
export const ROLE_ORDER: readonly BusinessRole[] = [
  'ms_manager', 'programme_owner', 'domain_owner', 'risk_owner',
  'internal_auditor', 'top_management', 'external_auditor', 'compliance_investigator',
];

/** The flag of the row that merges the roles with fewer than two holders (`PendingAggregate.group`, M3-15). */
export const OTHER_ROLES_GROUP = 'other_roles';

/**
 * One row of the answer: the open and overdue counts of a stage held by a role; `role` null with `group` for the roles
 * with fewer than two holders together ("Other roles"), `role` null without it for unassigned items and holders
 * without a role.
 */
export interface TotalsRow {
  stage: string;
  role: BusinessRole | null;
  open: number;
  overdue: number;
  /** How many people of the system count under the row (absent on the unassigned row, and from a server before M3-14). */
  holders?: number;
  /** `other_roles` on the row that merges the roles with fewer than two holders (M3-15). */
  group?: typeof OTHER_ROLES_GROUP;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface PendingTotalsAdapter {
  /** True for the sample adapter (the sample build). */
  readonly sample: boolean;
  totals(ms: MsId): Promise<Result<TotalsRow[]>>;
}

/** Open and overdue counts. Overdue counts the items that are overdue or missing (the chain's "Overdue / missing"). */
export interface Count {
  open: number;
  overdue: number;
}

export const ZERO: Count = Object.freeze({ open: 0, overdue: 0 });

/**
 * The key of a role column: the role, `other` for the roles with fewer than two holders in the system ("Other roles"),
 * or `none` for unassigned items and holders without a role.
 */
export type RoleKey = BusinessRole | 'other' | 'none';

export const keyOf = (role: BusinessRole | null): RoleKey => role ?? 'none';

/** The column of a row: its role, `other` for the merged row of `group: 'other_roles'`, `none` for the unassigned row. */
export function keyOfRow(row: Pick<TotalsRow, 'role' | 'group'>): RoleKey {
  if (row.role !== null) return row.role;
  return row.group === OTHER_ROLES_GROUP ? 'other' : 'none';
}

/** The fewest people besides the reader a row may stand for (product owner decision 21). */
export const MIN_ROW_HOLDERS = 2;

/**
 * Business roles whose holders hold no chain work and never count as people behind a row (decision 21, M3-15), as on
 * the server (`NO_CHAIN_WORK_ROLES`): an external auditor, the only role of a guest, owns no record of the chain.
 */
export const NO_CHAIN_WORK_ROLES: readonly BusinessRole[] = ['external_auditor'];

/**
 * The rule of decision 21, as the server's `withoutOnePersonRows` applies it before it answers: every role with fewer
 * than two people besides the reader in the system (`othersByRole`, every role of the system, also those without open
 * work; `holdersByRole` when no reader is given) merges into one `other_roles` row per stage, which stands for the
 * people of all those roles (`holders` from `holdersByRole`); with fewer than two of them besides the reader together,
 * the merged counts join the unassigned row of the stage. Rows come back in stage order, then roles in ROLE_ORDER, the
 * group row and the unassigned row last.
 */
export function withoutOnePersonRows(
  rows: readonly TotalsRow[], stageOrder: readonly string[], holdersByRole: ReadonlyMap<BusinessRole, number>,
  othersByRole: ReadonlyMap<BusinessRole, number> = holdersByRole,
): TotalsRow[] {
  const small = (role: BusinessRole) => (othersByRole.get(role) ?? 0) < MIN_ROW_HOLDERS;
  let groupHolders = 0;
  let groupOthers = 0;
  for (const role of new Set([...holdersByRole.keys(), ...othersByRole.keys()])) {
    if (!small(role)) continue;
    groupHolders += holdersByRole.get(role) ?? 0;
    groupOthers += othersByRole.get(role) ?? 0;
  }
  const asGroup = groupOthers >= MIN_ROW_HOLDERS;
  const out = new Map<string, TotalsRow>();
  const add = (key: string, base: TotalsRow, from: TotalsRow) => {
    const row = out.get(key) ?? { ...base, open: 0, overdue: 0 };
    row.open += from.open;
    row.overdue += from.overdue;
    out.set(key, row);
  };
  for (const r of rows) {
    if (r.role === null) add(`${r.stage}|none`, { stage: r.stage, role: null, open: 0, overdue: 0 }, r);
    else if (!small(r.role)) add(`${r.stage}|${r.role}`, { stage: r.stage, role: r.role, open: 0, overdue: 0, holders: holdersByRole.get(r.role) ?? 0 }, r);
    else if (asGroup) add(`${r.stage}|other`, { stage: r.stage, role: null, open: 0, overdue: 0, holders: groupHolders, group: OTHER_ROLES_GROUP }, r);
    else add(`${r.stage}|none`, { stage: r.stage, role: null, open: 0, overdue: 0 }, r);
  }
  const at = (stage: string) => {
    const n = stageOrder.indexOf(stage);
    return n < 0 ? stageOrder.length : n;
  };
  const rank = (r: TotalsRow) => (r.role !== null ? roleRank(r.role) : r.group ? ROLE_ORDER.length + 1 : ROLE_ORDER.length + 2);
  return [...out.values()].sort((a, b) => at(a.stage) - at(b.stage) || rank(a) - rank(b) || a.stage.localeCompare(b.stage));
}

const plus = (a: Count, b: Count): Count => ({ open: a.open + b.open, overdue: a.overdue + b.overdue });

/** The sum of every row. */
export function sumOf(rows: readonly Count[]): Count {
  return rows.reduce<Count>((sum, r) => plus(sum, r), { ...ZERO });
}

/** Open items that are not overdue or missing. */
export function onTime(count: Count): number {
  return Math.max(0, count.open - count.overdue);
}

/** The share of open items that are overdue or missing, in whole percent (0 without open items). */
export function overdueShare(count: Count): number {
  return count.open > 0 ? Math.round((count.overdue / count.open) * 100) : 0;
}

/** The position of a role in ROLE_ORDER; unknown roles after the known ones. */
export function roleRank(role: string | null): number {
  if (role === null) return ROLE_ORDER.length + 1;
  const at = (ROLE_ORDER as readonly string[]).indexOf(role);
  return at < 0 ? ROLE_ORDER.length : at;
}

/** The position of a column: the roles in ROLE_ORDER, unknown roles, "Other roles", then `none`. */
function columnRank(key: RoleKey): number {
  if (key === 'none') return ROLE_ORDER.length + 2;
  if (key === 'other') return ROLE_ORDER.length + 1;
  return roleRank(key);
}

/**
 * The role columns of the rows: the roles that hold open work in ROLE_ORDER, unknown roles after them, then "Other
 * roles" (the roles with fewer than two holders), `none` last.
 */
export function roleColumns(rows: readonly TotalsRow[]): RoleKey[] {
  const keys = [...new Set(rows.filter((r) => r.open > 0).map(keyOfRow))];
  return keys.sort((a, b) => columnRank(a) - columnRank(b) || a.localeCompare(b));
}

/** The label of a role column. */
export function roleLabel(key: RoleKey): TextPair {
  if (key === 'none') return [TEXT.noRole[0], TEXT.noRole[1]];
  if (key === 'other') return [TEXT.otherRoles[0], TEXT.otherRoles[1]];
  const label = BUSINESS_ROLE_LABELS[key as BusinessRole];
  return label ? [label[0], label[1]] : [key, key];
}

/** A stage of the system as the snapshot names it (`STAGES[ms]`). */
export interface StageInfo {
  id: string;
  l: readonly [string, string] | string;
}

/** One line of the stage by role table. */
export interface StageLine {
  key: string;
  label: TextPair | string;
  cells: Partial<Record<RoleKey, Count>>;
  total: Count;
}

/**
 * The lines of the stage by role table: every stage of the system in chain order (also those without open work, so
 * the reader sees the whole chain), then any stage the rows name that the snapshot does not list, labelled by its key.
 */
export function stageLines(rows: readonly TotalsRow[], stages: readonly StageInfo[] | null | undefined): StageLine[] {
  const known = (stages ?? []).map((s) => ({ key: s.id, label: Array.isArray(s.l) ? ([s.l[0], s.l[1]] as TextPair) : String(s.l) }));
  const extra = [...new Set(rows.map((r) => r.stage))].filter((key) => !known.some((s) => s.key === key));
  return [...known, ...extra.map((key) => ({ key, label: key }))].map(({ key, label }) => {
    const cells: Partial<Record<RoleKey, Count>> = {};
    for (const r of rows) {
      if (r.stage !== key) continue;
      const k = keyOfRow(r);
      cells[k] = plus(cells[k] ?? ZERO, r);
    }
    return { key, label, cells, total: sumOf(Object.values(cells) as Count[]) };
  });
}

/** The totals of each role column across the stages. */
export function roleTotals(rows: readonly TotalsRow[]): Partial<Record<RoleKey, Count>> {
  const out: Partial<Record<RoleKey, Count>> = {};
  for (const r of rows) {
    const k = keyOfRow(r);
    out[k] = plus(out[k] ?? ZERO, r);
  }
  return out;
}

/** How many stages hold open work, of the stages the table lists. */
export function stagesWithWork(lines: readonly StageLine[]): { n: number; total: number } {
  return { n: lines.filter((l) => l.total.open > 0).length, total: lines.length };
}

/** The stages the snapshot lists for a system. */
export function stagesOf(ctx: HostContext, ms: MsId): StageInfo[] {
  const stages = (ctx.D?.STAGES as Record<string, StageInfo[]> | undefined)?.[ms];
  return Array.isArray(stages) ? stages : [];
}

/** The systems of the organisation where the session sees the totals ("All my systems"), in the snapshot's order. */
export function systemsWithTotals(ctx: HostContext): ManagementSystem[] {
  return (ctx.D?.MS ?? []).filter((m) => ctx.can(m.id, TOTALS_PERM));
}

/** The short name of a system for the page (ISMS), else its slug in capitals. */
export function systemName(ctx: HostContext, ms: MsId): string {
  const m = (ctx.D?.MS ?? []).find((s) => s.id === ms) ?? (ctx.msObj?.id === ms ? ctx.msObj : null);
  return m?.short ?? ms.toUpperCase();
}

/** The long name of a system ([English, Indonesian]), or null when the snapshot has none. */
export function systemTitle(ctx: HostContext, ms: MsId): TextPair | null {
  const m = (ctx.D?.MS ?? []).find((s) => s.id === ms) ?? (ctx.msObj?.id === ms ? ctx.msObj : null);
  return m && Array.isArray(m.name) ? [m.name[0], m.name[1]] : null;
}

/** True when the value is a count (a whole number of zero or more). */
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * The rows of an answer of `aggregate=unit`, or null when the answer is not a list of such rows. Only the fields of
 * `PendingAggregate` are kept (the four counts, the optional `holders` and the optional `group` of the merged row with
 * no role), so nothing else the server might add can reach the page.
 */
export function toRows(data: unknown): TotalsRow[] | null {
  if (!Array.isArray(data)) return null;
  const rows: TotalsRow[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') return null;
    const r = item as Record<string, unknown>;
    if (typeof r.stage !== 'string' || !(r.role === null || typeof r.role === 'string') || !isCount(r.open) || !isCount(r.overdue)) return null;
    if (r.holders !== undefined && !isCount(r.holders)) return null;
    if (r.group !== undefined && (r.group !== OTHER_ROLES_GROUP || r.role !== null)) return null;
    rows.push({
      stage: r.stage, role: r.role as BusinessRole | null, open: r.open, overdue: r.overdue,
      ...(isCount(r.holders) ? { holders: r.holders } : {}),
      ...(r.group === OTHER_ROLES_GROUP ? { group: OTHER_ROLES_GROUP } : {}),
    });
  }
  return rows;
}

/** One chain item as the aggregate reads it: its stage, its holder (`none`: unassigned) and its status. */
export interface ItemFacts {
  stage: string;
  h: string;
  st: string;
}

/**
 * The rows of `aggregate=unit` computed from chain items, as the server's `pendingAggregate` does: one row per stage
 * and role, a holder counted under the first of their roles in ROLE_ORDER (null without a role or when unassigned),
 * overdue for every item that is not `pending` (overdue or missing), sorted by stage order and then by role order.
 * With `people` (the handles of the system's role holders), each row of a role gives `holders`, how many of them count
 * under it (M3-14; holders of `NO_CHAIN_WORK_ROLES` never), and the roles with fewer than two holders besides `reader`
 * (the person who reads the screen) merge as decision 21 asks (`withoutOnePersonRows`, M3-15). The sample adapter uses
 * it with the sample chain items and the sample persona as the reader.
 */
export function aggregateItems(
  items: readonly ItemFacts[], rolesOf: (handle: string) => readonly string[], stageOrder: readonly string[], people?: readonly string[], reader?: string | null,
): TotalsRow[] {
  const roleOf = (handle: string): BusinessRole | null => {
    if (!handle || handle === 'none') return null;
    const held = rolesOf(handle);
    return ROLE_ORDER.find((r) => held.includes(r)) ?? null;
  };
  const holders = new Map<BusinessRole, number>();
  const others = new Map<BusinessRole, number>();
  for (const handle of people ?? []) {
    const role = roleOf(handle);
    if (!role || NO_CHAIN_WORK_ROLES.includes(role)) continue;
    holders.set(role, (holders.get(role) ?? 0) + 1);
    if (handle !== reader) others.set(role, (others.get(role) ?? 0) + 1);
  }
  const counts = new Map<string, TotalsRow>();
  for (const i of items) {
    const role = roleOf(i.h);
    const key = `${i.stage}|${role ?? ''}`;
    const row = counts.get(key) ?? { stage: i.stage, role, open: 0, overdue: 0, ...(people && role ? { holders: holders.get(role) ?? 0 } : {}) };
    row.open += 1;
    if (i.st !== 'pending') row.overdue += 1;
    counts.set(key, row);
  }
  if (people) return withoutOnePersonRows([...counts.values()], stageOrder, holders, others);
  const at = (stage: string) => {
    const n = stageOrder.indexOf(stage);
    return n < 0 ? stageOrder.length : n;
  };
  return [...counts.values()].sort((a, b) => at(a.stage) - at(b.stage) || roleRank(a.role) - roleRank(b.role));
}
