// Helpers shared by the audit register screens of M2-14 (MILESTONE-2 M2-14): Internal audit, Findings and actions,
// and Management review. They read the host context and the controller snapshot only; each screen calls the api
// through its own adapter (R-17), and the shared contract is imported as types only.
import type { CommandResult as WireResult } from '@mscd/shared';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ControllerData, MsId } from '../../data/types';
import type { HostContext, TextPair } from '../types';
import type { PersonOption } from '../ui';

/** The answer of an adapter call: its data, or the api's error with its message pair and field errors. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** A warn-and-allow rule result of a write (for example `AUD-INDEP`). */
export interface Warn {
  rule: string;
  message: TextPair;
}

/** What a write answered: the systems to load again, warnings, the server's message and the record it made or changed. */
export interface Outcome {
  changed: MsId[];
  warnings: Warn[];
  message?: TextPair;
  count?: number;
  ref?: { id: string; code: string; etag?: string };
  data?: unknown;
}

/** The outcome of a command answer (`CommandResult` of D.2). */
export function outcomeOf(res: ApiResult<WireResult>): Result<Outcome> {
  if (!res.ok) return { ok: false, error: res.error };
  const body = (res.data ?? { ok: true, changed: [] }) as Partial<WireResult>;
  const out: Outcome = {
    changed: Array.isArray(body.changed) ? [...body.changed] : [],
    warnings: (body.warnings ?? []).map((w) => ({ rule: w.rule, message: [w.messages.en, w.messages.id] as const })),
  };
  if (Array.isArray(body.message)) out.message = [body.message[0], body.message[1]];
  if (typeof body.count === 'number') out.count = body.count;
  if (body.ref) out.ref = { id: body.ref.id, code: body.ref.code, ...(body.ref.etag ? { etag: body.ref.etag } : {}) };
  if (body.data !== undefined) out.data = body.data;
  return { ok: true, data: out };
}

/** A sample or local refusal with a message pair (no request was sent). */
export function refusal(status: number, message: TextPair, extra: Partial<ApiError> = {}): { ok: false; error: ApiError } {
  return { ok: false, error: { status, message: [message[0], message[1]], ...extra } };
}

/** A call that never rejects: a failed module load or a thrown error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** An adapter answer as the ApiResult `useMutation` of screens/api.ts takes; it never rejects. */
export function asApiResult<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return settled(promise).then((r): ApiResult<T> => (r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error }));
}

/**
 * An adapter whose module is loaded on first use (the sample adapters, C.6); a failed load keeps the next call free to
 * try again. Every method of `methods` returns a promise.
 */
export function deferred<A extends object>(load: () => Promise<A>, methods: readonly (keyof A)[], extra: Partial<A> = {}): A {
  let pending: Promise<A> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  const out: Record<string, unknown> = { ...extra };
  for (const name of methods) {
    out[name as string] = (...args: unknown[]) => get().then((a) => (a[name] as unknown as (...x: unknown[]) => unknown)(...args));
  }
  return out as A;
}

/** Reads every page of a D.1 list route (at most `maxPages` pages of 200). */
export async function allPages<T>(read: (page: number) => Promise<ApiResult<{ items: T[]; total: number }>>, maxPages = 25): Promise<Result<T[]>> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await read(page);
    if (!res.ok) return { ok: false, error: res.error };
    items.push(...res.data.items);
    if (items.length >= res.data.total || !res.data.items.length) break;
  }
  return { ok: true, data: items };
}

/** The people of the organisation for person pickers, without the unassigned entry. */
export function peopleOf(D: ControllerData | null | undefined): PersonOption[] {
  const people = D?.PEOPLE ?? {};
  return Object.entries(people)
    .filter(([id]) => id !== 'none')
    .map(([id, p]) => ({ id, name: p[0], jobTitle: p[1] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The display name of a handle; `-` for nobody (`none` is also what Top Management sees of other people's records). */
export function personName(D: ControllerData | null | undefined, handle: string | null | undefined): string {
  if (!handle || handle === 'none') return '-';
  return D?.PEOPLE?.[handle]?.[0] ?? handle;
}

/** A date of the snapshot's format in the interface language, `-` without one. */
export function day(ctx: Pick<HostContext, 'D' | 'lang'>, iso: string | null | undefined): string {
  if (!iso) return '-';
  return ctx.D ? ctx.D.fmt(iso, ctx.lang) : iso;
}

/** Today of the organisation (the snapshot's date); the browser's date before the first load. */
export function todayOf(ctx: Pick<HostContext, 'D'>): string {
  return ctx.D?.TODAY_S ?? new Date().toISOString().slice(0, 10);
}

/** The session person's handle: `Me.user.handle` in API mode, the sample persona's person otherwise. */
export function meOf(ctx: Pick<HostContext, 'me' | 'person'>): string {
  return ctx.me?.user?.handle ?? ctx.person.handle;
}

/** True when a text has something in it after trimming. */
export const filled = (text: string | null | undefined): boolean => Boolean(text && text.trim());

/** The trimmed text, or undefined when it is empty (optional request members). */
export const optional = (text: string | null | undefined): string | undefined => (filled(text) ? (text as string).trim() : undefined);

/**
 * Business roles that hold a permission in full (F.6). `Me.permissions` lists a permission also when a role holds it for
 * own records only (`corrective_action.update` of Domain and Risk Owners), so a form checks the role before it acts on
 * another person's record. The unit tests compare this list with the shared matrix.
 */
export const OWN_SCOPED = {
  'corrective_action.update': ['ms_manager'],
} as const;

/** True when the session may act on a record with an owner: a full grant, or an own grant on a record it owns. */
export function mayActOn(
  ctx: Pick<HostContext, 'can' | 'me' | 'mode' | 'role' | 'person'>,
  ms: MsId,
  perm: keyof typeof OWN_SCOPED,
  owner: string | null | undefined,
): boolean {
  if (!ctx.can(ms, perm)) return false;
  if (ctx.mode !== 'api') return ctx.role === 'manager' || (Boolean(owner) && owner === meOf(ctx));
  const roles = ctx.me?.rolesByMs?.[ms] ?? [];
  const full = roles.some((r) => (OWN_SCOPED[perm] as readonly string[]).includes(r));
  return full || (Boolean(owner) && owner === meOf(ctx));
}

/**
 * The next free code of a register: `<prefix>-<year>-<nn>` after the highest number already used with that prefix and
 * year (`IA-2026-03` after `IA-2026-02`), or `<prefix>-<year>` when `plain` and that code is free.
 */
export function nextCode(prefix: string, year: string, existing: readonly string[], plain = false): string {
  const head = `${prefix}-${year}`;
  if (plain && !existing.includes(head)) return head;
  let max = 0;
  for (const code of existing) {
    const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${year}-(\\d+)$`).exec(code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${head}-${String(max + 1).padStart(2, '0')}`;
}

/** The clause or control code behind a snapshot requirement id: `Cl. 5.1` is clause 5.1, `A.5.18` control A.5.18. */
export function codeOfRequirement(id: string | null | undefined): string {
  return String(id ?? '').replace(/^Cl\.\s*/, '').trim();
}

/** Loads the systems a write changed again, so the built-in screens show it (D2-08). */
export async function reloadChanged(ctx: Pick<HostContext, 'reload'>, changed: readonly MsId[]): Promise<void> {
  const ids = [...new Set(changed)];
  if (ids.length) await ctx.reload(ids);
}

/** The toast of a write: the server's message (or `fallback`), with the warnings it gave after it. */
export function outcomeText(ctx: Pick<HostContext, 'li'>, outcome: Outcome, fallback: TextPair | string): string {
  const head = ctx.li(outcome.message ?? fallback);
  const warnings = outcome.warnings.map((w) => ctx.li(w.message));
  if (!warnings.length) return head;
  return [head, ...warnings].map((t) => (/[.!?]$/.test(t) ? t : `${t}.`)).join(' ');
}

/** A message pair or a plain message as a pair (sample errors are pairs already). */
export function pairOf(text: TextPair | string): TextPair {
  return Array.isArray(text) ? [text[0], text[1]] : [String(text), String(text)];
}

/** The short code of a system in the snapshot (`ISMS`), or the slug. */
export function msShort(D: ControllerData | null | undefined, ms: MsId): string {
  return D?.MS?.find((m) => m.id === ms)?.short ?? ms.toUpperCase();
}
