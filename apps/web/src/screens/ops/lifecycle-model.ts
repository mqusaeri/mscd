// The end of a contract in the operator console (MILESTONE-3 M3-09, D.4, D.5): the exports of an organisation as the
// operator sees them (status, dates and sizes, never the content), its verified deletion with the steps and checks of
// the purge, the texts and tones of their states (`organization_export.status` and `organization_deletion.status` of
// J.8), and the pure rules of the deletion forms: the earliest date, the instant the date stands for, the reason and
// the slug typed again.
import type { Download } from '../auditor-access/shared';
import { EXPORT_SOURCE_TEXT, EXPORT_STATUS_TEXT, EXPORT_STATUS_TONE } from '../org-export/model';
import type { ExportSource, ExportStatus } from '../org-export/model';
import type { TextPair } from '../types';
import type { Tone } from '../ui';
import { LIFE_TEXT } from './lifecycle-text';

export { EXPORT_SOURCE_TEXT, EXPORT_STATUS_TEXT, EXPORT_STATUS_TONE };
export type { Download, ExportSource, ExportStatus };

/** `OpsOrganizationExportItem`: an export as the platform operator sees it. */
export interface OpsExport {
  id: string;
  status: ExportStatus;
  requestedVia: ExportSource;
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  isFinal: boolean;
  partCount: number | null;
  sizeBytes: number | null;
  downloadCount: number;
}

/** The answer of `ops.exports.create`. */
export interface ExportQueued {
  id: string;
  message: TextPair | null;
}

/** The states of `organization_deletion.status` (Milestone 3 J.7, J.8). */
export const DELETION_STATUSES = ['scheduled', 'cancelled', 'running', 'completed', 'failed'] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];
export const STEP_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** `OrganizationDeletionStep`: one step or check of a purge (D.5.2, D.5.3). Checks are named `check: <name>`. */
export interface DeletionStep {
  step: string;
  status: StepStatus;
  at: string | null;
  detail: string | null;
}

/** `OrganizationDeletionView` (`ops.deletion.get`). */
export interface DeletionView {
  id: string;
  status: DeletionStatus;
  scheduledFor: string;
  /** Null when the system scheduled it at the move to archived. */
  scheduledBy: { handle: string; displayName: string } | null;
  reason: string | null;
  archivedAt: string | null;
  /** Archiving plus `lifecycle.deletion_min_grace_days`: the earliest date the operator may choose. */
  earliestAllowed: string | null;
  finalExportId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedStep: string | null;
  error: string | null;
  steps: DeletionStep[];
  vaultObjectsDeleted: number | null;
  certificateId: string | null;
}

/** The body of `ops.deletion.schedule`. */
export interface DeletionSchedule {
  scheduledFor: string;
  reason: string;
  confirmSlug: string;
}

/** The answer of `ops.deletion.schedule`, `.cancel` and `.retry`. */
export interface DeletionDone {
  id: string;
  status: DeletionStatus;
  scheduledFor: string;
  message: TextPair | null;
}

export const DELETION_STATUS_TEXT: Readonly<Record<DeletionStatus, TextPair>> = {
  scheduled: LIFE_TEXT.statusScheduled, cancelled: LIFE_TEXT.statusCancelled, running: LIFE_TEXT.statusRunning,
  completed: LIFE_TEXT.statusCompleted, failed: LIFE_TEXT.statusFailed,
};
export const DELETION_STATUS_TONE: Readonly<Record<DeletionStatus, Tone>> = {
  scheduled: 'warn', cancelled: 'mute', running: 'info', completed: 'ok', failed: 'bad',
};
export const STEP_STATUS_TEXT: Readonly<Record<StepStatus, TextPair>> = {
  pending: LIFE_TEXT.stepPending, running: LIFE_TEXT.stepRunning, done: LIFE_TEXT.stepDone, failed: LIFE_TEXT.stepFailed,
};
export const STEP_STATUS_TONE: Readonly<Record<StepStatus, Tone>> = { pending: 'mute', running: 'info', done: 'ok', failed: 'bad' };

/** The steps of `org.purge` in order (D.5.2; `PURGE_STEPS` of the server). */
export const PURGE_STEPS = ['check', 'access', 'accounts', 'vault', 'database', 'audit', 'organization', 'checks', 'certificate', 'emails'] as const;
const STEP_TEXT: Readonly<Record<string, TextPair>> = {
  check: LIFE_TEXT.stepCheck, access: LIFE_TEXT.stepAccess, accounts: LIFE_TEXT.stepAccounts, vault: LIFE_TEXT.stepVault, database: LIFE_TEXT.stepDatabase,
  audit: LIFE_TEXT.stepAudit, organization: LIFE_TEXT.stepOrganization, checks: LIFE_TEXT.stepChecks, certificate: LIFE_TEXT.stepCertificate,
  emails: LIFE_TEXT.stepEmails,
};
/** The checks of D.5.3 as the purge names them (`check: <name>` in the steps). */
const CHECK_TEXT: Readonly<Record<string, TextPair>> = {
  schema: LIFE_TEXT.checkSchema, 'platform rows': LIFE_TEXT.checkRows, vault: LIFE_TEXT.checkVault, 'data key': LIFE_TEXT.checkKey,
  accounts: LIFE_TEXT.checkAccounts, 'audit chain': LIFE_TEXT.checkChain,
};

/** True for a check of the result (`check: <name>`), false for a step of the purge. */
export const isCheck = (step: string): boolean => step.startsWith('check: ');

/** The label of a step or a check in both languages; one the console does not know keeps its name. */
export function stepLabel(step: string): TextPair {
  if (isCheck(step)) {
    const name = step.slice('check: '.length);
    return CHECK_TEXT[name] ?? [LIFE_TEXT.checkOther[0].replace('{name}', name), LIFE_TEXT.checkOther[1].replace('{name}', name)];
  }
  return STEP_TEXT[step] ?? [step, step];
}

/** True while an export of the organisation waits for approval or is queued or built (409 `export_in_progress`). */
export function exportInFlight(list: readonly Pick<OpsExport, 'status'>[]): boolean {
  return list.some((e) => e.status === 'requested' || e.status === 'queued' || e.status === 'building');
}

/** The organisation statuses in which an export can be made (409 `export_not_available` otherwise). */
export const EXPORTABLE: readonly string[] = ['active', 'offboarding'];

// ---------------------------------------------------------------------------------------------------------------
// Deletion forms
// ---------------------------------------------------------------------------------------------------------------

/** The reason of an operator action: 3 to 500 characters (`OpsActionReason`). */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

export interface ScheduleForm {
  /** `YYYY-MM-DD`. */
  day: string;
  reason: string;
  confirm: string;
}

export const EMPTY_SCHEDULE: ScheduleForm = { day: '', reason: '', confirm: '' };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calendar day of an instant (`YYYY-MM-DD`) in the browser's time zone, as the console shows the time of an
 * instant (`whenText`); a value that is no instant keeps its first ten characters.
 */
export function instantDay(instant: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return instant.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The first day the form offers: the later of today and the earliest allowed day. */
export function minScheduleDay(view: Pick<DeletionView, 'earliestAllowed'> | null, today: string): string {
  const earliest = view?.earliestAllowed ? instantDay(view.earliestAllowed) : today;
  return earliest > today ? earliest : today;
}

/** The form of "Change date" (the current date) or "Schedule deletion" (empty). */
export function scheduleForm(view: Pick<DeletionView, 'status' | 'scheduledFor'> | null): ScheduleForm {
  return { ...EMPTY_SCHEDULE, day: view && view.status === 'scheduled' ? instantDay(view.scheduledFor) : '' };
}

/** Errors of the schedule form before it is sent. */
export function scheduleErrors(slug: string, form: ScheduleForm, minDay: string): Partial<Record<'day' | 'reason' | 'confirmSlug', TextPair>> {
  const out: Partial<Record<'day' | 'reason' | 'confirmSlug', TextPair>> = {};
  if (!ISO_DAY.test(form.day)) out.day = LIFE_TEXT.dayMissing;
  else if (form.day < minDay) out.day = LIFE_TEXT.dayTooSoon;
  if (form.reason.trim().length < REASON_MIN) out.reason = LIFE_TEXT.reasonShort;
  const typed = form.confirm.trim();
  if (!typed) out.confirmSlug = LIFE_TEXT.slugMissing;
  else if (typed !== slug) out.confirmSlug = LIFE_TEXT.slugMismatch;
  return out;
}

/**
 * The instant a chosen day stands for: the day at the local time of day of the current date (or of the earliest allowed
 * one), never before the earliest allowed instant and never before `now` plus a minute, so the server's checks
 * (`deletion_too_soon`) accept the earliest day and today.
 */
export function scheduleInstant(day: string, view: Pick<DeletionView, 'scheduledFor' | 'earliestAllowed' | 'status'> | null, now: Date): string {
  const base = view?.status === 'scheduled' ? view.scheduledFor : view?.earliestAllowed ?? null;
  const baseAt = base ? new Date(base) : null;
  const valid = baseAt !== null && !Number.isNaN(baseAt.getTime());
  const [y, m, d] = day.split('-').map(Number);
  let at = new Date(y, m - 1, d, valid ? baseAt.getHours() : 0, valid ? baseAt.getMinutes() : 0, valid ? baseAt.getSeconds() : 0).getTime();
  if (view?.earliestAllowed) at = Math.max(at, Date.parse(view.earliestAllowed));
  at = Math.max(at, now.getTime() + 60_000);
  return new Date(at).toISOString();
}

/** The body of `ops.deletion.schedule` from a checked form. */
export function scheduleBody(form: ScheduleForm, view: Pick<DeletionView, 'scheduledFor' | 'earliestAllowed' | 'status'> | null, now: Date): DeletionSchedule {
  return { scheduledFor: scheduleInstant(form.day, view, now), reason: form.reason.trim(), confirmSlug: form.confirm.trim() };
}

/** Errors of a reason before it is sent (cancel and retry). */
export function reasonError(reason: string): TextPair | null {
  return reason.trim().length < REASON_MIN ? LIFE_TEXT.reasonShort : null;
}

/** "Change date" while scheduled; "Schedule deletion" for an archived organisation without a scheduled deletion. */
export function scheduleAction(orgStatus: string, view: Pick<DeletionView, 'status'> | null): 'change' | 'schedule' | null {
  if (orgStatus !== 'archived') return null;
  if (view?.status === 'scheduled') return 'change';
  if (!view || view.status === 'cancelled') return 'schedule';
  return null;
}
