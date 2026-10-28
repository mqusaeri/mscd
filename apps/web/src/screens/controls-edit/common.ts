// Helpers shared by the forms of M2-11 (MILESTONE-2 M2-11): controls-edit, evidence-edit and phases-edit. They read the
// host context and the controller snapshot only; screens call the api through their own adapters (R-17), and the
// shared contract is imported as types only.
import type { BusinessRole, CommandResult as WireResult, RecordRef } from '@mscd/shared';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ControllerData, MsId, Requirement } from '../../data/types';
import type { HostContext, TextPair } from '../types';
import type { Option, PersonOption } from '../ui';

/** The answer of an adapter call: its data, or the api's error with its message pair and field errors. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** A warn-and-allow rule result of a write (BR-03, BR-23, BR-47, ...). */
export interface Warn {
  rule: string;
  message: TextPair;
}

/** What a write answered: the systems to load again, warnings, the server's message and the record's new ref. */
export interface Outcome {
  changed: MsId[];
  warnings: Warn[];
  message?: TextPair;
  ref?: RecordRef;
  data?: unknown;
}

/** The outcome of a successful command answer (`CommandResult` of D.2). */
export function outcomeOf(res: ApiResult<WireResult>): Result<Outcome> {
  if (!res.ok) return { ok: false, error: res.error };
  const body = (res.data ?? { ok: true, changed: [] }) as Partial<WireResult>;
  const out: Outcome = {
    changed: Array.isArray(body.changed) ? [...body.changed] : [],
    warnings: (body.warnings ?? []).map((w) => ({ rule: w.rule, message: [w.messages.en, w.messages.id] })),
  };
  if (body.message) out.message = [body.message[0], body.message[1]];
  if (body.ref) out.ref = body.ref;
  if (body.data !== undefined) out.data = body.data;
  return { ok: true, data: out };
}

/** A local refusal with a message pair (no request was sent). */
export function refusal(status: number, message: TextPair, rule?: string): { ok: false; error: ApiError } {
  return { ok: false, error: { status, message: [message[0], message[1]], ...(rule ? { rule } : {}) } };
}

/** A call that never rejects: a failed module load or a thrown error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferred<A extends object>(load: () => Promise<A>, methods: readonly (keyof A)[]): A {
  let pending: Promise<A> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const out: Record<string, unknown> = {};
  for (const name of methods) {
    out[name as string] = (...args: unknown[]) => get().then((a) => (a[name] as unknown as (...x: unknown[]) => unknown)(...args));
  }
  return out as A;
}

/** The record reference behind a record key of the API snapshot (`refs`, G.5): uuid for commands, ETag for If-Match. */
export function refFor(D: ControllerData | null | undefined, key: string): RecordRef | null {
  const refs = (D as unknown as { refs?: Record<string, RecordRef> } | null)?.refs;
  return refs?.[key] ?? null;
}

/** `<ms>:<kind>:<id>`, the record key of the snapshot. */
export const recordKey = (ms: MsId, kind: string, id: string): string => `${ms}:${kind}:${id}`;

/** A requirement as the snapshot gives it, with the Milestone 2 member for rows no longer in the standard (E.1). */
export type EntryRecord = Requirement & { retired?: boolean };

/** The catalogue item or requirement behind a snapshot requirement: `A.5.7` is a control, `Cl. 5.1` a clause row. */
export function targetOfEntry(entry: Pick<Requirement, 'id'>): { targetType: 'catalogue_item' | 'requirement'; code: string } {
  const id = String(entry.id ?? '');
  return /^Cl\.\s/.test(id) ? { targetType: 'requirement', code: id.replace(/^Cl\.\s+/, '') } : { targetType: 'catalogue_item', code: id };
}

/** The snapshot id of a target: the code of a control, `Cl. <code>` of a clause row (G.5). */
export function entryIdOf(targetType: 'catalogue_item' | 'requirement', code: string): string {
  return targetType === 'catalogue_item' ? code : `Cl. ${code}`;
}

/** The people of the organisation for owner pickers, without the unassigned entry. */
export function peopleOf(D: ControllerData | null | undefined): PersonOption[] {
  const people = D?.PEOPLE ?? {};
  return Object.entries(people)
    .filter(([id]) => id !== 'none')
    .map(([id, p]) => ({ id, name: p[0], jobTitle: p[1] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The display name of a handle, or the handle itself. */
export function personName(D: ControllerData | null | undefined, handle: string | null | undefined): string {
  if (!handle || handle === 'none') return '-';
  return D?.PEOPLE?.[handle]?.[0] ?? handle;
}

/** The evidence frequencies of the snapshot in their order, as select options. */
export function frequencyOptions(D: ControllerData | null | undefined): Option[] {
  const freq = D?.FREQ ?? ({} as ControllerData['FREQ']);
  const order = (D?.FREQ_ORDER ?? Object.keys(freq)) as string[];
  return order.filter((id) => (freq as Record<string, unknown>)[id]).map((id) => {
    const f = (freq as Record<string, [string, string, number]>)[id];
    return { value: id, label: [f[0], f[1]] as const };
  });
}

/** The period in days of a frequency (0 for per event or an unknown code). */
export function periodOf(D: ControllerData | null | undefined, freq: string): number {
  const f = (D?.FREQ as Record<string, [string, string, number]> | undefined)?.[freq];
  return f ? Number(f[2]) || 0 : 0;
}

/**
 * Business roles that hold a permission in full (F.6). `Me.permissions` lists a permission also when a role holds it
 * for own records only, so a form checks the role before it acts on another person's record. The unit tests compare
 * these lists with the shared matrix.
 */
export const FULL_ROLES = {
  'applicability.manage': ['ms_manager'],
  'applicability.verify': ['ms_manager', 'programme_owner'],
  'record.delete': ['ms_manager'],
  'evidence.manage': ['ms_manager'],
  'activity.transition': ['ms_manager'],
  'activity.verify': ['ms_manager', 'programme_owner'],
} as const satisfies Record<string, readonly BusinessRole[]>;
export type FullPerm = keyof typeof FULL_ROLES;

/** True when the session holds the permission in the system for every record (a full grant). */
export function holdsInFull(ctx: Pick<HostContext, 'can' | 'me' | 'mode' | 'role'>, ms: MsId, perm: FullPerm): boolean {
  if (!ctx.can(ms, perm)) return false;
  if (ctx.mode !== 'api') return ctx.role === 'manager';
  const roles = ctx.me?.rolesByMs?.[ms] ?? [];
  return roles.some((r) => (FULL_ROLES[perm] as readonly string[]).includes(r));
}

/** True when the session may act on a record with an owner: a full grant, or an own grant on a record it owns. */
export function mayActOn(ctx: Pick<HostContext, 'can' | 'me' | 'mode' | 'role' | 'person'>, ms: MsId, perm: FullPerm, owner: string | null | undefined): boolean {
  if (!ctx.can(ms, perm)) return false;
  return holdsInFull(ctx, ms, perm) || (Boolean(owner) && owner === ctx.person.handle);
}

/** Loads the systems a write changed again, so the built-in screens show it (D2-08). */
export async function reloadChanged(ctx: Pick<HostContext, 'reload' | 'msObj'>, changed: readonly MsId[], fallback?: MsId | null): Promise<void> {
  const ids = [...new Set(changed.length ? changed : fallback ? [fallback] : [])];
  if (ids.length) await ctx.reload(ids);
}

/** True when a text has something in it after trimming. */
export const filled = (text: string | null | undefined): boolean => Boolean(text && text.trim());
