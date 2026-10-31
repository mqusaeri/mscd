// The view model of the Open work totals screen (MILESTONE-3 M3-08, D.10) and the interface both adapters implement
// (api.ts in API builds, sample.ts in the sample build, chosen by the build in adapter.ts): the open and overdue counts
// of a management system per chain stage and per business role, as `GET /ms/{ms}/audit/pending?aggregate=unit`
// (`readmodel.audit.pending`, permission `audit.pending.aggregate`) answers them. The rows carry no holder, name or due
// date (product decision 2), and nothing in this model adds one.
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

/** One row of the answer: the open and overdue counts of a stage held by a role (null: unassigned or no role). */
export interface TotalsRow {
  stage: string;
  role: BusinessRole | null;
  open: number;
  overdue: number;
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

/** The key of a role column: the role, or `none` for unassigned items and holders without a role. */
export type RoleKey = BusinessRole | 'none';

export const keyOf = (role: BusinessRole | null): RoleKey => role ?? 'none';

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

/** The role columns of the rows: the roles that hold open work in ROLE_ORDER, unknown roles after them, `none` last. */
export function roleColumns(rows: readonly TotalsRow[]): RoleKey[] {
  const keys = [...new Set(rows.filter((r) => r.open > 0).map((r) => keyOf(r.role)))];
  return keys.sort((a, b) => roleRank(a === 'none' ? null : a) - roleRank(b === 'none' ? null : b) || a.localeCompare(b));
}

/** The label of a role column. */
export function roleLabel(key: RoleKey): TextPair {
  if (key === 'none') return [TEXT.noRole[0], TEXT.noRole[1]];
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
      const k = keyOf(r.role);
      cells[k] = plus(cells[k] ?? ZERO, r);
    }
    return { key, label, cells, total: sumOf(Object.values(cells) as Count[]) };
  });
}

/** The totals of each role column across the stages. */
export function roleTotals(rows: readonly TotalsRow[]): Partial<Record<RoleKey, Count>> {
  const out: Partial<Record<RoleKey, Count>> = {};
  for (const r of rows) {
    const k = keyOf(r.role);
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
 * The rows of an answer of `aggregate=unit`, or null when the answer is not a list of such rows. Only the four fields
 * of `PendingAggregate` are kept, so nothing else the server might add can reach the page.
 */
export function toRows(data: unknown): TotalsRow[] | null {
  if (!Array.isArray(data)) return null;
  const rows: TotalsRow[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') return null;
    const r = item as Record<string, unknown>;
    if (typeof r.stage !== 'string' || !(r.role === null || typeof r.role === 'string') || !isCount(r.open) || !isCount(r.overdue)) return null;
    rows.push({ stage: r.stage, role: r.role as BusinessRole | null, open: r.open, overdue: r.overdue });
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
 * The sample adapter uses it with the sample chain items.
 */
export function aggregateItems(items: readonly ItemFacts[], rolesOf: (handle: string) => readonly string[], stageOrder: readonly string[]): TotalsRow[] {
  const roleOf = (handle: string): BusinessRole | null => {
    if (!handle || handle === 'none') return null;
    const held = rolesOf(handle);
    return ROLE_ORDER.find((r) => held.includes(r)) ?? null;
  };
  const counts = new Map<string, TotalsRow>();
  for (const i of items) {
    const role = roleOf(i.h);
    const key = `${i.stage}|${role ?? ''}`;
    const row = counts.get(key) ?? { stage: i.stage, role, open: 0, overdue: 0 };
    row.open += 1;
    if (i.st !== 'pending') row.overdue += 1;
    counts.set(key, row);
  }
  const at = (stage: string) => {
    const n = stageOrder.indexOf(stage);
    return n < 0 ? stageOrder.length : n;
  };
  return [...counts.values()].sort((a, b) => at(a.stage) - at(b.stage) || roleRank(a.role) - roleRank(b.role));
}
