// The read confirmations of the sample build (MILESTONE-3 M3-05, D.7, C.6), shared by "Policy read confirmations"
// (sample.ts) and "Policies to confirm" (screens/my-confirmations/sample.ts): per sample organisation, the requests of
// its approved policies with the people of each, and the read confirmation settings set in this tab. Built from the
// snapshot the first time an organisation is read: the people of a request are the members with an active role in the
// document's systems as the People and roles screen shows them in the sample build (`sampleMembers`). Every sample
// persona has already confirmed the requests the store starts with, so no persona has an open confirmation (and no
// banner) until a manager asks for one in the tab. Loaded only through the sample adapters' dynamic import (R-13).
import type { ControllerData, MsId } from '../../data/types';
import { sampleMembers } from '../users/sample';
import type { AcknowledgementRole, AcknowledgementScope, PersonStatus, RequestRow, Settings, Totals } from './model';
import { AUDIENCE_ROLES } from './model';

/** The sample personas (G.3 `ROLES`): rina, bagus, maya and hendra. */
const PERSONAS = new Set(['rina', 'bagus', 'maya', 'hendra']);

export interface SamplePerson {
  id: string;
  handle: string;
  /** The system the person's task is listed in (a system where they hold a role). */
  ms: MsId;
  status: PersonStatus;
  openedAt: string | null;
  confirmedAt: string | null;
  remindedAt: string | null;
  reminderCount: number;
  excusedReason: string | null;
}

export interface SampleRequest extends Omit<RequestRow, 'totals'> {
  /** The systems the document is linked to (the request shows in each). */
  systems: MsId[];
  /** Evidence item code the register was filed to. */
  evidenceCode: string | null;
  people: SamplePerson[];
}

export interface SampleState {
  requests: SampleRequest[];
  /** Settings saved in this tab, by `<ms>:<code>`. */
  settings: Map<string, Settings>;
  seq: number;
}

const states = new Map<string, SampleState>();

/** Forgets every sample state (unit tests). */
export function resetSampleAcknowledgements(): void {
  states.clear();
}

/** Today of the sample snapshot. */
export function sampleToday(D: ControllerData | null): string {
  return D?.TODAY_S ?? '2026-09-29';
}

/** The date `days` after an ISO date. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A new sample id of a kind. */
export function nextId(state: SampleState, kind: string): string {
  state.seq += 1;
  return `sample-${kind}-${state.seq}`;
}

/** The systems a document of the snapshot is linked to: every system whose bundle lists it. */
export function documentSystems(D: ControllerData | null, code: string): MsId[] {
  return (D?.MS ?? []).map((m) => m.id).filter((ms) => (D?.bundles?.[ms]?.docs ?? []).some((d) => d.id === code));
}

/**
 * The audience of a document (D.7 "Setting"): the members with an active role (not the external auditor) in the
 * document's systems, or in any system for scope `organisation`, only the chosen roles for scope `roles`; each with the
 * system their task is listed in (the request's system first).
 */
export function sampleAudience(D: ControllerData | null, systems: readonly MsId[], scope: AcknowledgementScope, roles: readonly AcknowledgementRole[] | null, primary: MsId): { handle: string; ms: MsId }[] {
  const all = (D?.MS ?? []).map((m) => m.id);
  const target = scope === 'organisation' ? all : systems;
  const out: { handle: string; ms: MsId }[] = [];
  for (const member of sampleMembers(D).members) {
    if (member.membershipStatus !== 'active' || member.kind !== 'person') continue;
    const held = member.roles.filter((r) => r.approvalStatus === 'active' && target.includes(r.ms) && (AUDIENCE_ROLES as readonly string[]).includes(r.role)
      && (scope !== 'roles' || (roles ?? []).includes(r.role as AcknowledgementRole)));
    if (!held.length) continue;
    const systemsHeld = [...new Set(held.map((r) => r.ms))].sort();
    out.push({ handle: member.handle, ms: systemsHeld.includes(primary) ? primary : systemsHeld[0]! });
  }
  return out.sort((a, b) => a.handle.localeCompare(b.handle));
}

/** The totals of a request on `today` (overdue: pending past the due date). */
export function totalsOf(request: Pick<SampleRequest, 'people' | 'dueOn'>, today: string): Totals {
  const count = (s: PersonStatus) => request.people.filter((p) => p.status === s).length;
  return {
    audience: request.people.length,
    confirmed: count('confirmed'),
    pending: count('pending'),
    overdue: request.dueOn < today ? count('pending') : 0,
    excused: count('excused'),
  };
}

/** Whether a request shows in a system: its own, or a system its document is linked to (D.7). */
export function visibleIn(request: SampleRequest, ms: MsId): boolean {
  return request.ms === ms || request.systems.includes(ms);
}

function seed(D: ControllerData | null): SampleState {
  const state: SampleState = { requests: [], settings: new Map(), seq: 0 };
  if (!D) return state;
  const today = sampleToday(D);
  const at = (day: string, hour = '03:00') => `${day}T${hour}:00Z`;
  const policies = (D.MS ?? []).flatMap((m) => (D.bundles?.[m.id]?.docs ?? [])
    .filter((d) => d.tier === 'Policy' && d.st === 'approved' && d.ver && d.ver !== '-' && !d.shared)
    .map((d) => ({ ms: m.id, doc: d })));
  policies.slice(0, 2).forEach(({ ms, doc }, index) => {
    const open = index === 0;
    const systems = documentSystems(D, doc.id);
    const started = addDays(today, open ? -10 : -40);
    const dueOn = addDays(started, 14);
    const people = sampleAudience(D, systems, 'system_roles', null, ms);
    const id = nextId(state, 'request');
    state.requests.push({
      id,
      ms,
      systems,
      document: { id: doc.id, code: doc.id, title: doc.title },
      version: { id: `${doc.id}-v${doc.ver}`, label: doc.ver },
      status: open ? 'open' : 'closed',
      audienceScope: 'system_roles',
      audienceRoles: null,
      dueOn,
      createdAt: at(started),
      lastRemindedAt: open ? at(addDays(started, 7), '01:10') : null,
      closedAt: open ? null : at(addDays(dueOn, 2)),
      evidenceId: null,
      evidenceCode: null,
      people: people.map((p, i) => {
        // The personas have confirmed; of the others, every third is still pending, and one left the audience.
        const pending = !PERSONAS.has(p.handle) && i % 3 === 0;
        const excused = !PERSONAS.has(p.handle) && !pending && i === people.length - 1;
        const opened = pending ? (i % 2 === 0 ? null : at(addDays(started, 2), '04:00')) : at(addDays(started, 1 + (i % 5)), '02:30');
        return {
          id: nextId(state, 'ack'),
          handle: p.handle,
          ms: p.ms,
          status: excused ? 'excused' : pending ? 'pending' : 'confirmed',
          openedAt: excused ? null : opened,
          confirmedAt: pending || excused ? null : at(addDays(started, 1 + (i % 5)), '02:40'),
          remindedAt: pending && open ? at(addDays(started, 7), '01:10') : null,
          reminderCount: pending && open ? 1 : 0,
          excusedReason: excused ? 'No longer holds a role that is asked to confirm' : null,
        };
      }),
    });
    state.settings.set(`${ms}:${doc.id}`, { required: true, scope: 'system_roles', roles: null, dueDays: 14 });
  });
  return state;
}

/** The sample state of an organisation (built from the snapshot on first use). */
export function sampleState(D: ControllerData | null, org: string | null): SampleState {
  const key = org ?? 'sample';
  let state = states.get(key);
  if (!state) {
    state = seed(D);
    states.set(key, state);
  }
  return state;
}
