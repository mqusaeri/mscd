// Sample adapter of the Getting started screen: the checklist of the sample organisation, computed from the sample
// snapshot the way the server computes it from its tables (D.5). The licence seats, repositories, routing rules,
// systems and audit events come from the snapshot; the counts of administrators and verifiers follow the demo seed
// (two Tenant Admins; the ABMS has only its manager as a verifier, so its separation of duties warning shows).
import type { ControllerData } from '../../data/types';
import type { OnboardingAdapter, StepModel } from './model';

/** `<first>.<last>@nusantaradigital.co.id` of a sample name, as the demo seed writes them. */
function sampleEmail(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).join('.')}@nusantaradigital.co.id`;
}

/** `86 of 150` as `{used: 86, limit: 150}`. */
function usage(text: string | null | undefined): { used: number; limit: number } | null {
  const m = /^(\d+) of (\d+)$/.exec(String(text ?? '').trim());
  return m ? { used: Number(m[1]), limit: Number(m[2]) } : null;
}

const ADMINS = new Set(['rina', 'tono']);
/** Systems whose verifiers and internal auditors the demo seed grants (the others have their manager only). */
const STAFFED = new Set(['isms', 'qms', 'bcms']);

/** The checklist of the sample snapshot. */
export function sampleSteps(D: ControllerData | null): StepModel[] {
  if (!D) return [];
  const seats = usage(D.LICENCE?.users);
  const people = Object.keys(D.PEOPLE ?? {}).filter((h) => h !== 'none');
  const repos = (D.REPOS ?? []).filter((r) => r.status === 'ok').length;
  const steps: StepModel[] = [
    { key: 'licence', state: D.LICENCE ? 'done' : 'pending', screen: 'license', count: seats?.used ?? people.length, ...(seats ? { limit: seats.limit } : {}) },
    { key: 'second_admin', state: 'done', screen: 'users', count: ADMINS.size },
    { key: 'sign_in', state: 'done', screen: 'identity-providers', count: 1 },
    { key: 'local_login', state: 'optional', screen: 'identity-providers' },
    { key: 'repository', state: repos > 0 ? 'done' : 'pending', screen: 'storage', count: repos },
    { key: 'routing', state: (D.ROUTING ?? []).length ? 'done' : 'pending', screen: 'routing', count: (D.ROUTING ?? []).length },
    { key: 'systems', state: (D.MS ?? []).length ? 'done' : 'pending', screen: 'systems', count: (D.MS ?? []).length },
    { key: 'team', state: 'done', screen: 'users', count: people.filter((h) => !ADMINS.has(h)).length },
  ];
  for (const ms of D.MS ?? []) {
    const manager = D.PEOPLE?.[ms.mgr];
    const assignee = manager ? { name: manager[0], email: sampleEmail(manager[0]) } : null;
    const staffed = STAFFED.has(ms.id);
    const events = (D.EVENTS?.[ms.id] ?? []).map((e) => (Array.isArray(e.t) ? e.t[0] : String(e.t)));
    const stage1 = events.some((t) => /^Stage 1/.test(t));
    const stage2 = events.some((t) => /^Stage 2/.test(t));
    const entries = D.bundles?.[ms.id]?.reqs?.length ?? 0;
    steps.push(
      { key: 'ms_manager', state: assignee ? 'done' : 'pending', screen: 'users', ms: ms.id },
      { key: 'verifiers', state: staffed ? 'done' : 'pending', screen: 'users', ms: ms.id, count: staffed ? 2 : 1 },
      { key: 'internal_auditor', state: staffed ? 'done' : 'optional', screen: 'users', ms: ms.id, count: staffed ? 1 : 0 },
      { key: 'implementing', state: 'done', screen: 'systems', ms: ms.id },
      { key: 'applicability', state: entries > 0 ? 'done' : 'pending', screen: 'controls', ms: ms.id, count: entries, doneBy: 'ms_manager', assignee },
      { key: 'audit_dates', state: stage1 && stage2 ? 'done' : 'pending', screen: 'timeline', ms: ms.id, count: Number(stage1) + Number(stage2), doneBy: 'ms_manager', assignee },
    );
  }
  steps.push({ key: 'pending_grants', state: 'done', screen: 'approvals', count: 0 });
  return steps;
}

export function createSampleAdapter(getD: () => ControllerData | null): OnboardingAdapter {
  return {
    async load() {
      return { ok: true, steps: sampleSteps(getD()) };
    },
  };
}
