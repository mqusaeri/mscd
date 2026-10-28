// The view model of the Internal audit screen (MILESTONE-2 M2-14) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build), chosen by the build in adapter.ts (C.6).
//
// In plain words: an internal audit is the organisation's own check of its management system against the standard
// (ISO/IEC 27001 9.2, ISO 9001 9.2). The programme of a certification cycle shows which clauses (4 to 10) and applicable
// controls the internal audits covered; an audit lists its activities (what an auditor examines, with key questions
// and the evidence to request), its report, a short outcome and the findings it raised.
import type { MsId } from '../../data/types';
import type { HostContext, PickedFile, TextPair } from '../types';
import type { Tone } from '../ui';
import type { Classification, FindingStatus, TargetOption } from '../findings/model';
import type { Outcome, Result } from '../findings/shared';
import { filled } from '../findings/shared';
import { TEXT } from './text';

export const CYCLE_STATUSES = ['planned', 'active', 'certified', 'suspended', 'withdrawn', 'expired', 'closed'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];
export const CYCLE_STATUS_TEXT: Readonly<Record<CycleStatus, TextPair>> = {
  planned: TEXT.cyPlanned, active: TEXT.cyActive, certified: TEXT.cyCertified, suspended: TEXT.cySuspended, withdrawn: TEXT.cyWithdrawn, expired: TEXT.cyExpired, closed: TEXT.cyClosed,
};

export const ACTIVITY_STATUSES = ['planned', 'done', 'cancelled'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const ACTIVITY_STATUS_TEXT: Readonly<Record<ActivityStatus, TextPair>> = { planned: TEXT.acPlanned, done: TEXT.acDone, cancelled: TEXT.acCancelled };
export const ACTIVITY_STATUS_TONE: Readonly<Record<ActivityStatus, Tone>> = { planned: 'info', done: 'ok', cancelled: 'mute' };

/** An internal audit of a cycle, as `ms.cycles.list` gives it. */
export interface AuditModel {
  id: string;
  shortLabel: string;
  scheduledAt: string;
  scopeText: string | null;
  reportDocumentId: string | null;
}

export interface CycleModel {
  id: string;
  status: CycleStatus;
  cycleStart: string;
  cycleEnd: string;
  /** Internal audits of the cycle, by date. */
  audits: AuditModel[];
}

export interface ProgrammeRow {
  code: string;
  title: string;
  kind: 'clause' | 'control';
  clauseGroup: string | null;
  covered: boolean;
  audits: { eventId: string; shortLabel: string; scheduledAt: string; activities: number }[];
}

export interface Programme {
  cycle: { id: string; cycleStart: string; cycleEnd: string } | null;
  rows: ProgrammeRow[];
}

/** An audit event with its name, days, lead auditor, outcome summary and findings (`readmodel.surveillance.event`). */
export interface AuditDetail {
  id: string;
  name: string;
  shortLabel: string;
  scheduledAt: string;
  auditDays: number | null;
  leadAuditor: string | null;
  outcomeSummary: string | null;
  findings: { id: string; code: string; classification: Classification; clause: string | null; title: string; status: FindingStatus }[];
}

export interface ActivityModel {
  id: string;
  /** The code shown: the template code, else the title. */
  code: string;
  templateCode: string | null;
  title: string;
  clauseRef: string | null;
  keyQuestions: string | null;
  evidenceToRequest: string | null;
  auditee: string | null;
  auditor: string | null;
  targetCode: string | null;
  scheduledAt: string | null;
  status: ActivityStatus;
  note: string | null;
}

/** A registered document of type record that can be the audit report. */
export interface RecordOption {
  id: string;
  code: string;
  title: string;
}

export interface PlanBody {
  eventType: 'internal_audit';
  nameEn: string;
  nameId: string;
  shortLabel: string;
  scheduledAt: string;
  auditDays?: number;
  leadAuditorName?: string;
  scopeText?: string;
}

export interface ActivityPatchBody {
  auditorHandle?: string;
  targetCode?: string | null;
  scheduledAt?: string | null;
  auditeeHandle?: string;
  status?: ActivityStatus;
  note?: string | null;
}

export interface EventPatchBody {
  reportDocumentId?: string | null;
  outcomeSummary?: string | null;
}

export interface InternalAuditAdapter {
  readonly sample: boolean;
  cycles(ms: MsId): Promise<Result<CycleModel[]>>;
  programme(ms: MsId, cycleId: string | null): Promise<Result<Programme>>;
  plan(ms: MsId, body: PlanBody, idempotencyKey: string): Promise<Result<Outcome>>;
  detail(ms: MsId, eventId: string): Promise<Result<AuditDetail>>;
  activities(ms: MsId, eventId: string): Promise<Result<ActivityModel[]>>;
  generate(ms: MsId, eventId: string): Promise<Result<Outcome>>;
  updateActivity(ms: MsId, activity: ActivityModel, patch: ActivityPatchBody): Promise<Result<Outcome>>;
  updateEvent(ms: MsId, eventId: string, patch: EventPatchBody): Promise<Result<Outcome>>;
  /** The documents of type record of the system the session may see. */
  records(ms: MsId): Promise<Result<RecordOption[]>>;
  /** Registers a new document of type record (owner: the session person); answers its id. */
  registerRecord(ms: MsId, body: { code: string; title: string; owner: string }, idempotencyKey: string): Promise<Result<RecordOption>>;
  /** Adds the chosen or uploaded file as the record's first version. */
  addFile(ms: MsId, record: RecordOption, file: PickedFile): Promise<Result<Outcome>>;
  targets(ms: MsId): Promise<Result<TargetOption[]>>;
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------------------------------------------

/** MS Managers and Internal Auditors plan and run internal audits (D.2: `internal_audit.manage`, or `audit_event.manage`). */
export const mayRun = (ctx: Pick<HostContext, 'can'>, ms: MsId | null | undefined): boolean => Boolean(ms) && ctx.can(ms, ['internal_audit.manage', 'audit_event.manage']);
/** Only an MS Manager registers a new record document (`document.manage`). */
export const mayRegisterRecord = (ctx: Pick<HostContext, 'can'>, ms: MsId): boolean => ctx.can(ms, 'document.manage');

// ---------------------------------------------------------------------------------------------------------------
// Cycles and the programme
// ---------------------------------------------------------------------------------------------------------------

/** The cycle shown first: the open one (planned or active), else the newest (the programme route's default). */
export function defaultCycle(cycles: readonly CycleModel[]): CycleModel | null {
  return cycles.find((c) => c.status === 'active') ?? cycles.find((c) => c.status === 'planned') ?? [...cycles].sort((a, b) => b.cycleStart.localeCompare(a.cycleStart))[0] ?? null;
}

export type ProgrammeFilter = 'all' | 'uncovered' | 'clause' | 'control';

export function filterProgramme(rows: readonly ProgrammeRow[], filter: ProgrammeFilter): ProgrammeRow[] {
  if (filter === 'uncovered') return rows.filter((r) => !r.covered);
  if (filter === 'clause' || filter === 'control') return rows.filter((r) => r.kind === filter);
  return [...rows];
}

/** True when an activity target (or template clause reference) covers a programme row (the server's rule). */
export function covers(target: string, code: string, kind: 'clause' | 'control'): boolean {
  if (target === code) return true;
  if (kind === 'control') return false;
  return code.startsWith(`${target}.`) || target.startsWith(`${code}.`);
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

export interface PlanForm {
  name: string;
  nameId: string;
  shortLabel: string;
  scheduledAt: string;
  auditDays: string;
  lead: string;
  scopeText: string;
}

export function emptyPlan(lang: 'en' | 'id', year: string): PlanForm {
  return {
    name: lang === 'id' ? `Audit internal ${year}` : `Internal audit ${year}`,
    nameId: '',
    shortLabel: `IA ${year}`,
    scheduledAt: '',
    auditDays: '1',
    lead: '',
    scopeText: '',
  };
}

export type FormErrors<K extends string> = Partial<Record<K, TextPair>>;

export function planErrors(form: PlanForm): FormErrors<keyof PlanForm> {
  const out: FormErrors<keyof PlanForm> = {};
  if (!filled(form.name)) out.name = TEXT.required;
  else if (form.name.trim().length > 200) out.name = TEXT.tooLong;
  if (form.nameId.trim().length > 200) out.nameId = TEXT.tooLong;
  if (!filled(form.shortLabel)) out.shortLabel = TEXT.required;
  else if (form.shortLabel.trim().length > 80) out.shortLabel = TEXT.tooLong;
  if (!form.scheduledAt) out.scheduledAt = TEXT.required;
  if (filled(form.auditDays) && !(/^\d+$/.test(form.auditDays.trim()) && Number(form.auditDays) >= 1 && Number(form.auditDays) <= 365)) out.auditDays = TEXT.badDays;
  if (form.scopeText.trim().length > 4000) out.scopeText = TEXT.tooLong;
  return out;
}

/** AuditEventCreateRequest of an internal audit; the lead auditor is a member, stored by name. */
export function planBody(form: PlanForm, leadName: string | null): PlanBody {
  const name = form.name.trim();
  return {
    eventType: 'internal_audit',
    nameEn: name,
    nameId: filled(form.nameId) ? form.nameId.trim() : name,
    shortLabel: form.shortLabel.trim(),
    scheduledAt: form.scheduledAt,
    ...(filled(form.auditDays) ? { auditDays: Number(form.auditDays) } : {}),
    ...(leadName ? { leadAuditorName: leadName.slice(0, 150) } : {}),
    ...(filled(form.scopeText) ? { scopeText: form.scopeText.trim() } : {}),
  };
}

export interface ActivityForm {
  auditor: string;
  targetCode: string;
  scheduledAt: string;
  auditee: string;
  status: ActivityStatus;
  note: string;
}

export function activityFormOf(a: ActivityModel): ActivityForm {
  return {
    auditor: a.auditor && a.auditor !== 'none' ? a.auditor : '',
    targetCode: a.targetCode ?? '',
    scheduledAt: a.scheduledAt ?? '',
    auditee: a.auditee && a.auditee !== 'none' ? a.auditee : '',
    status: a.status,
    note: a.note ?? '',
  };
}

/** The changed members of the activity form as an AuditActivityPatch; null when nothing changed. */
export function activityPatch(form: ActivityForm, a: ActivityModel): ActivityPatchBody | null {
  const out: ActivityPatchBody = {};
  const before = activityFormOf(a);
  if (form.auditor !== before.auditor) out.auditorHandle = form.auditor || 'none';
  if (form.targetCode !== before.targetCode) out.targetCode = form.targetCode || null;
  if (form.scheduledAt !== before.scheduledAt) out.scheduledAt = form.scheduledAt || null;
  if (form.auditee !== before.auditee) out.auditeeHandle = form.auditee || 'none';
  if (form.status !== before.status) out.status = form.status;
  if (form.note.trim() !== before.note.trim()) out.note = filled(form.note) ? form.note.trim() : null;
  return Object.keys(out).length ? out : null;
}

/**
 * True when "Generate from templates" created nothing for an audit that has no activity yet: the framework pack then
 * holds no activity template for internal audits (E.2), which the toast says instead of "already exists".
 */
export function noTemplates(created: number | undefined, activities: number): boolean {
  return (created ?? 0) === 0 && activities === 0;
}

/** The code a record of a new report gets by default: REC-<short label>, for example REC-IA-2026. */
export function reportCode(shortLabel: string): string {
  return `REC-${shortLabel.trim().replace(/\s+/g, '-').toUpperCase()}`.slice(0, 30);
}
