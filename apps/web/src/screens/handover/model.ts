// The view model of the Handover screen (MILESTONE-2 M2-10) and the interface both adapters implement (api.ts in API
// builds, sample.ts in the sample build, chosen by the build in adapter.ts): the open items one person holds in a
// system (`records.holdings`) and their move to a successor (`records.holdings.reassign`, BR-16, BR-17, BR-22, BR-41).
import type { HoldingKind, HoldingsReassign } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, TextPair } from '../types';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T; message?: TextPair | null } | { ok: false; error: ApiError };
export type { HoldingKind };

/** The kinds of open items in the order the screen lists them (HOLDING_KINDS of D.1). */
export const KIND_ORDER: readonly HoldingKind[] = [
  'applicability_entry', 'activity', 'document_owner', 'document_approver', 'evidence', 'risk', 'risk_treatment', 'finding',
  'corrective_action', 'prep_task', 'cycle_item', 'register_row', 'task',
];

/** One open item a person holds. */
export interface HeldItem {
  kind: HoldingKind;
  code: string;
  title: string;
  dueAt: string | null;
}

export interface HoldingsModel {
  handle: string;
  ms: string;
  items: HeldItem[];
  counts: Partial<Record<HoldingKind, number>>;
}

/** A rule's warning about one moved record; the text starts with the record's code. */
export interface MoveWarning {
  rule: string;
  text: TextPair;
}

export interface MoveOutcome {
  count: number;
  message: TextPair | null;
  warnings: MoveWarning[];
  /** Systems whose snapshot changed. */
  changed: string[];
}

export interface HandoverAdapter {
  holdings(ms: string, handle: string): Promise<Result<HoldingsModel>>;
  reassign(ms: string, handle: string, body: HoldingsReassign): Promise<Result<MoveOutcome>>;
}

/** The label of a holding kind. */
export function kindLabel(kind: string): TextPair {
  const key = `kind_${kind}` as keyof typeof TEXT;
  return (TEXT[key] as TextPair | undefined) ?? [kind, kind];
}

/** The kinds that hold at least one item, in KIND_ORDER, with their counts. */
export function kindRows(model: HoldingsModel): { kind: HoldingKind; count: number }[] {
  return KIND_ORDER.map((kind) => ({ kind, count: model.counts[kind] ?? model.items.filter((i) => i.kind === kind).length }))
    .filter((r) => r.count > 0);
}

/** The people of the organisation a holder or successor is chosen from: the snapshot's people, `none` left out. */
export function peopleOf(ctx: HostContext): { id: string; name: string; jobTitle: string }[] {
  const people = ctx.D?.PEOPLE ?? {};
  return Object.entries(people)
    .filter(([handle]) => handle !== 'none')
    .map(([handle, [name, job]]) => ({ id: handle, name, jobTitle: job }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A user name as the api accepts it in a path (`Handle`: lower case, 2 to 40 characters, never `none`). */
export const HANDLE_PATTERN = /^[a-z][a-z0-9._-]{1,39}$/;

/** A typed user name, trimmed and in lower case, or null when it cannot be a user name. */
export function handleOf(typed: string): string | null {
  const handle = typed.trim().toLowerCase();
  return HANDLE_PATTERN.test(handle) && handle !== 'none' ? handle : null;
}

/**
 * Every person the snapshot names as the holder of a record of the system: owners of requirements, documents, evidence
 * and phase activities, document approvers and pending holders, holders of chain items, gate items and registers, and
 * the people of audit preparation and the certification cycle. The snapshot keeps these handles after a person is
 * disabled or loses their last role, while `PEOPLE` lists only active members with a role.
 */
export function snapshotHolders(ctx: HostContext, ms: string): string[] {
  const D = ctx.D;
  const out = new Set<string>();
  if (!D) return [];
  const add = (handle: unknown) => {
    if (typeof handle === 'string' && handle !== 'none' && HANDLE_PATTERN.test(handle)) out.add(handle);
  };
  const b = D.bundles?.[ms];
  for (const r of b?.reqs ?? []) add(r.owner);
  for (const d of b?.docs ?? []) [d.owner, d.approver, d.h].forEach(add);
  for (const e of b?.evs ?? []) [e.owner, e.h].forEach(add);
  for (const p of b?.phases ?? []) for (const a of p.acts ?? []) add(a.owner);
  for (const i of b?.chain?.items ?? []) add(i.h);
  for (const g of b?.gates ?? []) add(g.h);
  for (const rows of Object.values(D.X?.[ms] ?? {})) for (const x of rows ?? []) add(x.h);
  for (const row of D.PREP?.[ms] ?? []) add(row[1]);
  for (const row of D.CYCLE_ITEMS?.[ms] ?? []) add(row[2]);
  return [...out];
}

/**
 * The people who may still hold items but are not among the active members with a role: the holders the snapshot
 * names that `PEOPLE` lacks (someone disabled, or whose last role was revoked), and `extra` (the person People and roles
 * opened the screen with, or a typed user name). Their names are known only when `names` gives them.
 */
export function formerPeople(ctx: HostContext, ms: string, extra: readonly string[] = [], names: Readonly<Record<string, string>> = {}): { id: string; name: string; jobTitle: string }[] {
  const people = ctx.D?.PEOPLE ?? {};
  const handles = new Set([...snapshotHolders(ctx, ms), ...extra.filter((h) => handleOf(h) === h)]);
  return [...handles]
    .filter((handle) => !people[handle])
    .map((handle) => ({ id: handle, name: names[handle] ?? handle, jobTitle: '' }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The display name of a handle in the snapshot, else the name People and roles gave, else the handle. */
export function nameOf(ctx: HostContext, handle: string, names: Readonly<Record<string, string>> = {}): string {
  return ctx.D?.PEOPLE?.[handle]?.[0] ?? names[handle] ?? handle;
}

/** `HoldingsReassign` of a move: every kind (no `kinds`), or the chosen kinds; `confirm` after the BR-22 question. */
export function reassignBody(successor: string, kinds: readonly HoldingKind[] | null, confirm = false): HoldingsReassign {
  return {
    successor,
    ...(kinds && kinds.length ? { kinds: KIND_ORDER.filter((k) => kinds.includes(k)) } : {}),
    ...(confirm ? { confirm: true } : {}),
  };
}

/** Why the move cannot be sent yet, or null. */
export function moveBlock(holder: string, successor: string, kinds: readonly HoldingKind[] | null): TextPair | null {
  if (!successor) return TEXT.chooseSuccessor;
  if (successor === holder) return TEXT.someoneElse;
  if (kinds && kinds.length === 0) return TEXT.chooseKinds;
  return null;
}

/** The items in KIND_ORDER, then by code. */
export function sortedItems(items: readonly HeldItem[]): HeldItem[] {
  const rank = new Map(KIND_ORDER.map((k, i) => [k, i]));
  return [...items].sort((a, b) => (rank.get(a.kind)! - rank.get(b.kind)!) || a.code.localeCompare(b.code, undefined, { numeric: true }));
}
