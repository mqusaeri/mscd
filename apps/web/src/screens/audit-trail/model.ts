// The view model of the Audit trail screen (MILESTONE-2 M2-15) and the interface both adapters implement (api.ts in API
// builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6).
//
// `audit-trail.list` filters by system and date range and pages newest first; it takes no action or person filter
// (the query is strict, R-14), so the screen filters the entries it has loaded by action and person and loads older
// pages on request.
import type { ApiError } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { Download } from '../auditor-access/shared';
import type { HostContext, TextPair } from '../types';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type ActorKind = 'user' | 'system' | 'guest' | 'operator';
export const ACTOR_KIND_TEXT: Readonly<Record<ActorKind, TextPair>> = { user: TEXT.kUser, system: TEXT.kSystem, guest: TEXT.kGuest, operator: TEXT.kOperator };

/** An audit entry: full (with the record code and the changed fields) or metadata only (organisation view). */
export interface EntryModel {
  /** Unique within the list: chain and sequence number. */
  key: string;
  seq: number;
  occurredAt: string;
  actor: { handle: string | null; displayName: string | null; kind: ActorKind };
  action: string;
  entityType: string | null;
  entityCode: string | null;
  ms: string | null;
  edition: string | null;
  requestId: string | null;
  sourceIp: string | null;
  before: unknown;
  after: unknown;
  full: boolean;
}

export interface EntryPage {
  items: EntryModel[];
  total: number;
}

export interface TrailQuery {
  /** The system of full entries; null for the organisation's metadata. */
  ms: MsId | null;
  from: string | null;
  to: string | null;
}

export interface ChainResult {
  chain: string;
  checked: number;
  firstBrokenSeq: number | null;
  anchorOk: boolean;
}

export interface AuditTrailAdapter {
  readonly sample: boolean;
  list(query: TrailQuery, page: number, pageSize: number): Promise<Result<EntryPage>>;
  exportCsv(ms: MsId): Promise<Result<Download>>;
  verify(): Promise<Result<ChainResult[]>>;
  anchors(from: string | null, to: string | null): Promise<Result<Download>>;
}

export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** Keeps the answers of the newest list query only (see latestOnly). */
export interface LatestOnly {
  /** Starts a new generation: a new query, or leaving the screen. Answers of earlier generations are dropped. */
  start(): void;
  /** Wraps a request of the current generation; it resolves to null when a newer generation started meanwhile. */
  ask<T>(promise: Promise<T>): Promise<T | null>;
}

/**
 * The list's guard against late answers: a slow answer of an earlier date range or view, or a "Load more" of the old
 * query, must not overwrite or extend the list of the query now shown.
 */
export function latestOnly(): LatestOnly {
  let current = 0;
  return {
    start() {
      current += 1;
    },
    ask<T>(promise: Promise<T>) {
      const mine = current;
      return promise.then((value) => (mine === current ? value : null));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what (F.6, D.3)
// ---------------------------------------------------------------------------------------------------------------

/** Full entries of the system: `audit_trail.read` (MS Manager; the external auditor while its grant runs). */
export const mayReadSystem = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, 'audit_trail.read');
/** The organisation's metadata: `audit_trail.metadata.read` (Tenant Admin). */
export const mayReadOrg = (ctx: Pick<HostContext, 'orgCan'>): boolean => ctx.orgCan('audit_trail.metadata.read');

/**
 * "Verify chain" and "Download anchors": `audit_trail.read` in a system through a role other than the external auditor
 * (the `any_ms` check never counts that role, D.3), or the organisation's metadata permission.
 */
export function mayVerify(ctx: Pick<HostContext, 'can' | 'orgCan' | 'me' | 'mode'>, ms: MsId | null | undefined): boolean {
  if (mayReadOrg(ctx)) return true;
  if (!mayReadSystem(ctx, ms)) return false;
  if (ctx.mode !== 'api') return true;
  const roles = (ctx.me?.rolesByMs?.[ms as MsId] ?? []) as readonly string[];
  return roles.some((r) => r !== 'external_auditor');
}

// ---------------------------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------------------------

export interface Filters {
  action: string;
  person: string;
}

/** The person key of an entry: the handle, else the actor kind (system jobs, guests without a handle). */
export const personKey = (e: Pick<EntryModel, 'actor'>): string => e.actor.handle ?? `kind:${e.actor.kind}`;

export function applyFilters(entries: readonly EntryModel[], f: Filters): EntryModel[] {
  return entries.filter((e) => (!f.action || e.action === f.action) && (!f.person || personKey(e) === f.person));
}

/** The actions of the loaded entries, sorted. */
export const actionsOf = (entries: readonly EntryModel[]): string[] => [...new Set(entries.map((e) => e.action))].sort();

/** The people of the loaded entries: key and label, sorted by label. */
export function peopleOfEntries(ctx: Pick<HostContext, 'li'>, entries: readonly EntryModel[]): { value: string; label: string }[] {
  const out = new Map<string, string>();
  for (const e of entries) out.set(personKey(e), actorName(ctx, e));
  return [...out].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export function actorName(ctx: Pick<HostContext, 'li'>, e: Pick<EntryModel, 'actor'>): string {
  if (e.actor.displayName) return e.actor.displayName;
  if (e.actor.handle) return e.actor.handle;
  return ctx.li(ACTOR_KIND_TEXT[e.actor.kind] ?? TEXT.kSystem);
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function rangeError(from: string, to: string): TextPair | null {
  return ISO_DATE.test(from) && ISO_DATE.test(to) && from > to ? TEXT.badRange : null;
}

/** The changed fields of an entry as `field: before → after` lines (flat objects; other values as JSON). */
export function changeLines(before: unknown, after: unknown): string[] {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const b = obj(before);
  const a = obj(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const show = (v: unknown) => (v === undefined ? '-' : v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v));
  return keys.map((k) => `${k}: ${show(b[k])} > ${show(a[k])}`);
}
