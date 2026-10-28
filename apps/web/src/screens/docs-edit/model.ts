// The model of the document control forms (MILESTONE-2 M2-12): the adapter interface both builds implement (api.ts in
// API builds, sample.ts in the sample build, chosen in adapter.ts), the records the forms read from the controller
// snapshot, the permission rules of the F.6 matrix and the checks the forms show before Save (BR-16, BR-17).
// Types only from @mscd/shared (R-17).
import type { CommandResult as WireResult, RecordRef } from '@mscd/shared';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ChainItem, ControllerData, Document, MsId } from '../../data/types';
import type { HostContext, PickedFile, TextPair } from '../types';
import type { PersonOption } from '../ui';

/** The answer of an adapter call: its data, or the api's error with its message pair, rule and field errors. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** A warn-and-allow rule result of a write (BR-30, BR-41, BR-47). */
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

/** A document of the snapshot with the Milestone 2 members (origin, change summary of the version in force, D.3). */
export type DocRecord = Document & { origin?: 'internal' | 'external'; changeSummary?: string | null };

export type VersionStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'superseded';

/** One version of a document (`documents.versions.list`, D.1), newest first. */
export interface VersionRow {
  id: string;
  label: string;
  status: VersionStatus;
  storageObjectId: string | null;
  submittedBy: string | null;
  /** Instant (ISO) of the submission. */
  submittedAt: string | null;
  approvedBy: string | null;
  /** Local date of the approval. */
  approvedAt: string | null;
  rejectionNote: string | null;
  changeSummary: string | null;
}

/** The New document form (`DocumentCreateRequest`, D.2). */
export interface NewDocumentInput {
  docCode: string;
  title: string;
  docType: string;
  ownerHandle: string;
  approverHandle?: string;
  nextReviewAt?: string;
  classification: string;
  orgWide: boolean;
  linkedMs: MsId[];
  origin: 'internal' | 'external';
  externalSource?: string;
  externalRef?: string;
  receivedAt?: string;
}

/** A change of a document (`DocumentPatch`): only the members that change. */
export interface DocumentChange {
  title?: string;
  ownerHandle?: string;
  approverHandle?: string | null;
  nextReviewAt?: string | null;
  classification?: string;
  origin?: 'internal' | 'external';
  externalSource?: string | null;
  externalRef?: string | null;
  receivedAt?: string | null;
}

/** A document template of the system's framework pack, for the optional prefill of New document. */
export interface TemplateOption {
  code: string;
  /** The title of the documented information row that names the template; empty for an activity output. */
  title: string;
  docType: string;
  /** An output code that no documented information row names: the first activity of the system that expects it. */
  activity?: { no: string; title: string };
}

/** What New document starts with (a template of Required documented information, or nothing). */
export interface Prefill {
  docCode?: string;
  title?: string;
  docType?: string;
}

export interface DocsAdapter {
  /** `POST /ms/{ms}/documents` (draft, no version yet). */
  create(ms: MsId, input: NewDocumentInput): Promise<Result<Outcome>>;
  /** `PATCH /ms/{ms}/documents/{id}`; a shared document answers 409 `confirmation-required` (BR-22) until `confirm`. */
  update(ms: MsId, code: string, change: DocumentChange, confirm: boolean): Promise<Result<Outcome>>;
  /** `POST .../transitions`: approve (BR-16), return to draft with a note, or start a review. */
  transition(ms: MsId, code: string, to: 'approved' | 'draft' | 'in_review', note?: string): Promise<Result<Outcome>>;
  /** `records.assign` with kind `doc`: the person who acts on the document and the due date. */
  assign(ms: MsId, code: string, holder: string, due: string | null): Promise<Result<Outcome>>;
  /** `POST .../versions`: the chosen or uploaded file as a new version in review, with its change summary. */
  addVersion(ms: MsId, code: string, file: PickedFile, changeSummary?: string): Promise<Result<Outcome>>;
  /** `GET .../versions`, newest first. */
  versions(ms: MsId, code: string): Promise<Result<VersionRow[]>>;
  /** `storage.objects.open`: a short-lived address of the stored file. */
  openFile(ms: MsId, storageObjectId: string): Promise<Result<{ url: string }>>;
  /** The document templates of the system's edition (from Required documented information). */
  templates(ms: MsId): Promise<Result<TemplateOption[]>>;
  /** The id `ctx.openPicker` takes for the document: its uuid (api) or its code (sample); null when not loaded. */
  recordId(ms: MsId, code: string): string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------------------------------------------

/** `<ms>:doc:<code>`, the record key of a document. */
export const docKey = (ms: MsId, code: string): string => `${ms}:doc:${code}`;

/** The code of a document key (the business id may itself hold colons). */
export function codeOfKey(key: string | null | undefined): string | null {
  const [ms, kind, ...rest] = String(key ?? '').split(':');
  return ms && kind === 'doc' && rest.length ? rest.join(':') : null;
}

/** The document of a system in the snapshot, or null. */
export function docOf(D: ControllerData | null | undefined, ms: MsId, code: string): DocRecord | null {
  const docs = (D?.bundles?.[ms]?.docs ?? []) as DocRecord[];
  return docs.find((d) => d.id === code) ?? null;
}

/** The record reference behind a record key of the API snapshot (`refs`, G.5): uuid for commands, ETag for If-Match. */
export function refFor(D: ControllerData | null | undefined, key: string): RecordRef | null {
  const refs = (D as unknown as { refs?: Record<string, RecordRef> } | null)?.refs;
  return refs?.[key] ?? null;
}

/** The open chain item of a document (holder and due date of the person who must act on it), or null. */
export function chainItemOf(D: ControllerData | null | undefined, ms: MsId, code: string): ChainItem | null {
  const items = D?.bundles?.[ms]?.chain?.items ?? [];
  return items.find((i) => i.kind === 'doc' && i.key === docKey(ms, code)) ?? null;
}

/** The people of the organisation for the pickers, without the unassigned entry. */
export function peopleOf(D: ControllerData | null | undefined): PersonOption[] {
  return Object.entries(D?.PEOPLE ?? {})
    .filter(([id]) => id !== 'none')
    .map(([id, p]) => ({ id, name: p[0], jobTitle: p[1] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The display name of a handle, or the handle itself; `-` for nobody. */
export function personName(D: ControllerData | null | undefined, handle: string | null | undefined): string {
  if (!handle || handle === 'none') return '-';
  return D?.PEOPLE?.[handle]?.[0] ?? handle;
}

/** The handle of the session person (the signed-in user, or the sample persona's person). */
export function meOf(ctx: Pick<HostContext, 'me' | 'person'>): string {
  return ctx.me?.user.handle ?? ctx.person.handle;
}

/** The local date of an instant or a date (`2026-10-28T03:00:00Z` gives `2026-10-28`); null for nothing. */
export function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

/** A date in the interface language (`28 Oct 2026`), or `-`. */
export function showDay(ctx: Pick<HostContext, 'D' | 'lang'>, value: string | null | undefined): string {
  const day = dayOf(value);
  if (!day) return '-';
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}

/** True when the document has a version in force (`ver` is `-` before the first approval). */
export function hasVersion(doc: Pick<Document, 'ver'>): boolean {
  return Boolean(doc.ver) && doc.ver !== '-';
}

// ---------------------------------------------------------------------------------------------------------------
// Permissions (F.6)
// ---------------------------------------------------------------------------------------------------------------

/** Business roles that hold a permission for every record of a system (the others hold it for their own records). */
export const FULL_ROLES = {
  'document.manage': ['ms_manager'],
  'document.approve': ['ms_manager', 'programme_owner'],
  'document.version.create': ['ms_manager'],
  'record.assign': ['ms_manager', 'programme_owner'],
} as const;

export type FullPerm = keyof typeof FULL_ROLES;

type PermCtx = Pick<HostContext, 'can' | 'me' | 'mode' | 'role'>;

/** True when the session holds the permission in the system for every record (a full grant). */
export function holdsInFull(ctx: PermCtx, ms: MsId, perm: FullPerm): boolean {
  if (!ctx.can(ms, perm)) return false;
  if (ctx.mode !== 'api') return ctx.role === 'manager';
  const roles = ctx.me?.rolesByMs?.[ms] ?? [];
  return roles.some((r) => (FULL_ROLES[perm] as readonly string[]).includes(r));
}

/** True when the session may act on a document: a full grant, or an own grant on a document it owns. */
export function mayActOn(ctx: PermCtx & Pick<HostContext, 'person'>, ms: MsId, perm: FullPerm, owner: string | null | undefined): boolean {
  if (!ctx.can(ms, perm)) return false;
  return holdsInFull(ctx, ms, perm) || (Boolean(owner) && owner === meOf(ctx as Pick<HostContext, 'me' | 'person'>));
}

// ---------------------------------------------------------------------------------------------------------------
// Templates, versions and checks
// ---------------------------------------------------------------------------------------------------------------

/** The `doc_type` of a pack template by its code prefix (`POL-01` policy, `PRC-04` procedure); empty when unknown. */
export function docTypeOfTemplate(code: string | null | undefined): string {
  const prefix = String(code ?? '').toUpperCase().split(/[-.\s]/)[0] ?? '';
  const types: Readonly<Record<string, string>> = {
    POL: 'policy', SCO: 'policy', QM: 'policy', STD: 'standard', PRC: 'procedure', IMS: 'procedure', PLN: 'plan',
    REG: 'register', SOA: 'register', REC: 'record', FRM: 'form',
  };
  return types[prefix] ?? '';
}

/**
 * The templates of Required documented information followed by the output codes of the system's activities that no
 * listed template covers (the other pack templates that BR-40 checks, for example IMS-01 or PRC-13 of ISO/IEC 27001),
 * typed by their code prefix. No route lists the document templates (follow-up 1 of M2-12), so an activity output
 * carries the activity that expects it instead of a template title.
 */
export function withActivityOutputs(options: readonly TemplateOption[], D: ControllerData | null, ms: MsId): TemplateOption[] {
  const out = [...options];
  const seen = new Set(options.map((o) => o.code));
  for (const a of (D?.bundles?.[ms]?.phases ?? []).flatMap((p) => p.acts ?? [])) {
    if (!a.out || seen.has(a.out)) continue;
    seen.add(a.out);
    out.push({ code: a.out, title: '', docType: docTypeOfTemplate(a.out), activity: { no: String(a.no ?? ''), title: String(a.title ?? '') } });
  }
  return out;
}

/** The version in review, or null. */
export function inReviewOf(versions: readonly VersionRow[] | null | undefined): VersionRow | null {
  return versions?.find((v) => v.status === 'in_review') ?? null;
}

/**
 * The author BR-16 checks when the document is approved: the submitter of the version in review, else (a review
 * started without a new file) the submitter of the approved version in force, the newest approved row; null when
 * neither is known.
 */
export function approvalAuthorOf(versions: readonly VersionRow[] | null | undefined): string | null {
  return (inReviewOf(versions) ?? versions?.find((v) => v.status === 'approved') ?? null)?.submittedBy ?? null;
}

/** The newest version, when it was returned to draft; else null. */
export function returnedOf(versions: readonly VersionRow[] | null | undefined): VersionRow | null {
  const newest = versions?.[0];
  return newest && newest.status === 'rejected' ? newest : null;
}

/** The next major version after the given labels (`3.0` after `2.1`), as the server labels uploads (A.4 5.7). */
export function nextVersionLabel(labels: readonly string[]): string {
  let max = 0;
  for (const label of labels) {
    const n = Number.parseFloat(String(label).replace(/^v/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return (Math.floor(max) + 1).toFixed(1);
}

/** BR-16 before Save of the owner and approver: the approver must not be the person who writes the versions. */
export function br16Conflicts(owner: string, approver: string, submitter: string | null): ('same' | 'submitter')[] {
  const out: ('same' | 'submitter')[] = [];
  if (approver && approver === owner) out.push('same');
  if (approver && submitter && approver === submitter && approver !== owner) out.push('submitter');
  return out;
}

/** Field errors of the New document form before it is sent; keys are the request members. */
export function checkNew(input: NewDocumentInput): Record<string, 'required' | 'codeFormat' | 'titleLong' | 'sourceRequired'> {
  const out: Record<string, 'required' | 'codeFormat' | 'titleLong' | 'sourceRequired'> = {};
  const code = input.docCode;
  if (!code.trim()) out.docCode = 'required';
  else if (code.length > 30 || code !== code.trim() || [...code].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) out.docCode = 'codeFormat';
  if (!input.title.trim()) out.title = 'required';
  else if (input.title.trim().length > 255) out.title = 'titleLong';
  if (!input.docType) out.docType = 'required';
  if (!input.ownerHandle || input.ownerHandle === 'none') out.ownerHandle = 'required';
  if (!input.classification) out.classification = 'required';
  if (input.origin === 'external' && !(input.externalSource ?? '').trim()) out.externalSource = 'sourceRequired';
  return out;
}

/** The request body of New document: empty optional members left out, external facts only for an external one. */
export function createBody(input: NewDocumentInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    docCode: input.docCode.trim(),
    title: input.title.trim(),
    docType: input.docType,
    ownerHandle: input.ownerHandle,
    classification: input.classification,
    orgWide: input.orgWide,
    linkedMs: [...input.linkedMs],
    origin: input.origin,
  };
  if (input.approverHandle && input.approverHandle !== 'none') body.approverHandle = input.approverHandle;
  if (input.nextReviewAt) body.nextReviewAt = input.nextReviewAt;
  if (input.origin === 'external') {
    body.externalSource = (input.externalSource ?? '').trim();
    if ((input.externalRef ?? '').trim()) body.externalRef = (input.externalRef ?? '').trim();
    if (input.receivedAt) body.receivedAt = input.receivedAt;
  }
  return body;
}

// ---------------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------------

/** The outcome of a successful command answer (`CommandResult` of D.2). */
export function outcomeOf(res: ApiResult<WireResult>): Result<Outcome> {
  if (!res.ok) return { ok: false, error: res.error };
  const body = (res.data ?? { ok: true, changed: [] }) as Partial<WireResult>;
  const out: Outcome = {
    changed: Array.isArray(body.changed) ? [...body.changed] : [],
    warnings: (body.warnings ?? []).map((w) => ({ rule: w.rule, message: [w.messages.en, w.messages.id] as const })),
  };
  if (body.message) out.message = [body.message[0], body.message[1]];
  if (body.ref) out.ref = body.ref;
  if (body.data !== undefined) out.data = body.data;
  return { ok: true, data: out };
}

/** An adapter result in the shape `useMutation` reads. */
export function asApi<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return promise.then((res): ApiResult<T> => (res.ok ? { ok: true, status: 200, data: res.data } : { ok: false, status: res.error.status, error: res.error }));
}

/** A local refusal with a message pair (no request was sent). */
export function refusal(status: number, message: TextPair, extra: Partial<ApiError> = {}): { ok: false; error: ApiError } {
  return { ok: false, error: { status, message: [message[0], message[1]], ...extra } };
}

/** A call that never rejects: a failed module load or a thrown error becomes "Connection lost". */
export function settled<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  return promise.catch((): Result<T> => ({ ok: false, error: { status: 0, message: CONNECTION_LOST } }));
}

/** True for the BR-22 answer of a change to a shared document. */
export const needsConfirmation = (error: ApiError | null | undefined): boolean => Boolean(error && error.status === 409 && (error.slug === 'confirmation-required' || error.rule === 'BR-22'));
