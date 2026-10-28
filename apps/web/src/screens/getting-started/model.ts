// The view model of the Getting started screen (MILESTONE-2 M2-16) and the interface both adapters implement (api.ts
// in API builds, sample.ts in the sample build). The steps are those of `GET /admin/onboarding` (D.5): states,
// counts and the primary MS Manager of each system only, so a Tenant Admin sees no compliance content (F.6).
import type { ApiError } from '../../data/api/ApiClient';
import type { TextPair } from '../types';
import { TEXT } from './text';

export const STEP_KEYS = [
  'licence', 'second_admin', 'sign_in', 'local_login', 'repository', 'routing', 'systems', 'team',
  'ms_manager', 'verifiers', 'internal_auditor', 'implementing', 'applicability', 'audit_dates', 'pending_grants',
] as const;
export type StepKey = (typeof STEP_KEYS)[number];
export type StepState = 'done' | 'pending' | 'optional';

export interface StepModel {
  key: StepKey;
  state: StepState;
  /** The screen id that completes the step. */
  screen: string;
  count?: number;
  limit?: number;
  /** The management system of a per-system step. */
  ms?: string;
  /** Steps the management system manager does (`applicability`, `audit_dates`). */
  doneBy?: 'ms_manager';
  /** The primary MS Manager of the system: name and email (null while none is granted). */
  assignee?: { name: string; email: string } | null;
}

export type Loaded = { ok: true; steps: StepModel[] } | { ok: false; error: ApiError };

export interface OnboardingAdapter {
  /** The checklist, computed by the server on every call. */
  load(): Promise<Loaded>;
}

/** Steps that may stay open; they are not counted in the progress. */
export const OPTIONAL_KEYS: ReadonlySet<StepKey> = new Set(['sign_in', 'local_login', 'internal_auditor']);

/** The permission that lets the session do a step of the MS Manager itself (instead of emailing the manager). */
export const MANAGER_STEP_PERM: Readonly<Partial<Record<StepKey, string>>> = {
  applicability: 'applicability.manage',
  audit_dates: 'audit_event.manage',
};

/** Title, explanation and the text of the count of each step. */
export const STEP_TEXT: Readonly<Record<StepKey, { title: TextPair; help: TextPair; count?: TextPair }>> = {
  licence: { title: TEXT.licence, help: TEXT.licenceHelp, count: TEXT.licenceCountOnly },
  second_admin: { title: TEXT.second_admin, help: TEXT.second_adminHelp, count: TEXT.second_adminCount },
  sign_in: { title: TEXT.sign_in, help: TEXT.sign_inHelp, count: TEXT.sign_inCount },
  local_login: { title: TEXT.local_login, help: TEXT.local_loginHelp },
  repository: { title: TEXT.repository, help: TEXT.repositoryHelp, count: TEXT.repositoryCount },
  routing: { title: TEXT.routing, help: TEXT.routingHelp, count: TEXT.routingCount },
  systems: { title: TEXT.systems, help: TEXT.systemsHelp, count: TEXT.systemsCount },
  team: { title: TEXT.team, help: TEXT.teamHelp, count: TEXT.teamCount },
  ms_manager: { title: TEXT.ms_manager, help: TEXT.ms_managerHelp },
  verifiers: { title: TEXT.verifiers, help: TEXT.verifiersHelp, count: TEXT.verifiersCount },
  internal_auditor: { title: TEXT.internal_auditor, help: TEXT.internal_auditorHelp, count: TEXT.internal_auditorCount },
  implementing: { title: TEXT.implementing, help: TEXT.implementingHelp },
  applicability: { title: TEXT.applicability, help: TEXT.applicabilityHelp, count: TEXT.applicabilityCount },
  audit_dates: { title: TEXT.audit_dates, help: TEXT.audit_datesHelp, count: TEXT.audit_datesCount },
  pending_grants: { title: TEXT.pending_grants, help: TEXT.pending_grantsHelp, count: TEXT.pending_grantsCount },
};

export const STATE_TEXT: Readonly<Record<StepState, TextPair>> = {
  done: TEXT.stateDone,
  pending: TEXT.statePending,
  optional: TEXT.stateOptional,
};

/** The text of a step's count with its values (`{count}`, `{limit}`), or null when the step has none. */
export function countText(step: StepModel): { text: TextPair; values: Record<string, number> } | null {
  if (typeof step.count !== 'number') return null;
  if (step.key === 'licence' && typeof step.limit === 'number') return { text: TEXT.licenceCount, values: { count: step.count, limit: step.limit } };
  const text = STEP_TEXT[step.key]?.count;
  return text ? { text, values: { count: step.count } } : null;
}

/** Done and total of the required steps; `allDone` when every required step is done. */
export function progressOf(steps: readonly StepModel[]): { done: number; total: number; allDone: boolean; share: number } {
  const required = steps.filter((s) => !OPTIONAL_KEYS.has(s.key));
  const done = required.filter((s) => s.state === 'done').length;
  const total = required.length;
  return { done, total, allDone: total > 0 && done === total, share: total ? done / total : 0 };
}

export interface StepGroup {
  /** null for the organisation steps, else the system slug. */
  ms: string | null;
  steps: StepModel[];
}

/** The organisation steps first, then the steps of each system in the server's order. */
export function groupsOf(steps: readonly StepModel[]): StepGroup[] {
  const org: StepGroup = { ms: null, steps: [] };
  const systems = new Map<string, StepGroup>();
  for (const step of steps) {
    if (!step.ms) {
      org.steps.push(step);
      continue;
    }
    let group = systems.get(step.ms);
    if (!group) {
      group = { ms: step.ms, steps: [] };
      systems.set(step.ms, group);
    }
    group.steps.push(step);
  }
  return [org, ...systems.values()];
}

/** True while the organisation has fewer than two active Tenant Admins (D2-12). */
export function singleAdmin(steps: readonly StepModel[]): boolean {
  const step = steps.find((s) => s.key === 'second_admin');
  return Boolean(step && step.state !== 'done');
}

/** A pending step that carries the separation of duties warning (`verifiers`, `team`). */
export function warningOf(step: StepModel): TextPair | null {
  if (step.state !== 'pending') return null;
  if (step.key === 'verifiers') return TEXT.verifiersWarning;
  if (step.key === 'team') return TEXT.teamWarning;
  return null;
}

/** Labels of the built-in screens a step may open (the generated views name them so). */
export const BUILTIN_LABELS: Readonly<Record<string, TextPair>> = {
  controls: ['Controls & requirements', 'Kontrol & persyaratan'],
  timeline: ['Certification timeline', 'Linimasa sertifikasi'],
  storage: ['Storage repositories', 'Repositori penyimpanan'],
  fw: ['Framework library', 'Pustaka framework'],
};

/**
 * The prepared email of a step of the MS Manager: `mailto:` with the system and the step in the subject and the body.
 * Characters that would end the address part are dropped from the address.
 */
export function mailtoOf(
  assignee: { name: string; email: string },
  values: { step: string; system: string },
  fill: (text: TextPair, values: Record<string, string>) => string,
): string {
  const address = assignee.email.replace(/[?#&\s]/g, '');
  const subject = fill(TEXT.mailSubject, values);
  const body = fill(TEXT.mailBody, { ...values, name: assignee.name });
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
