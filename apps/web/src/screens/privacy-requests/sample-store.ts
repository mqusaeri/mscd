// Sample state of Personal data requests and Personal data checks (MILESTONE-3 M3-04), shared by the sample adapters of
// both screens and of "My data" in My account: per sample organisation, three requests about people of the sample
// snapshot and one invented person without an account (R-19), with their system checks and the mentions the checks
// find. Times count from the moment the store is first read, so the time left reads the same on every day. Loaded only
// by the sample adapters (dynamic imports), so an API build holds none of it (R-13).
import type { ControllerData } from '../../data/types';
import type { ActionView, CheckView, RequestDetail, RequestType } from './model';

export interface SampleMention {
  recordKind: string;
  recordId: string;
  code: string | null;
  field: string;
  excerpt: string;
}

export interface SampleRequest extends RequestDetail {
  /** The mentions each system's check finds, by system. */
  mentions: Record<string, SampleMention[]>;
  /** The handle of the person of the request (member subjects). */
  subjectHandle: string | null;
}

const HOUR = 3_600_000;
const byOrg = new Map<string, SampleRequest[]>();
let started = 0;
let sequence = 3;
let ids = 1000;

/** Forgets the sample requests (unit tests). */
export function resetSamplePrivacy(): void {
  byOrg.clear();
  started = 0;
  sequence = 3;
  ids = 1000;
}

const isoAt = (offsetHours: number) => new Date(started + offsetHours * HOUR).toISOString();
const sampleId = (n: number) => `00000000-0000-4000-8000-0000000c${String(n).padStart(4, '0')}`;

/** The next sample number of the year of the store (`PR-2026-004`, ...). */
export function nextNumber(): string {
  sequence += 1;
  return `PR-${new Date(started || Date.now()).getUTCFullYear()}-${String(sequence).padStart(3, '0')}`;
}


/** A new sample id. */
export function newSampleId(): string {
  ids += 1;
  return sampleId(ids);
}

/** The systems of a sample organisation, by slug. */
export function systemsOf(D: ControllerData | null, org: string): string[] {
  const entry = D?.orgs?.find((o) => o.id === org);
  if (entry?.ms?.length) return [...entry.ms];
  return (D?.MS ?? []).map((m) => m.id);
}

function personOf(D: ControllerData | null, handle: string): { handle: string; name: string } | null {
  const entry = D?.PEOPLE?.[handle];
  return entry ? { handle, name: entry[0] } : null;
}

function emailOf(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).join('.')}@nusantaradigital.co.id`;
}

function checksFor(request: number, systems: readonly string[], doneUntil: number): CheckView[] {
  return systems.map((ms, i) => ({
    id: sampleId(500 + request * 10 + i),
    ms,
    status: i < doneUntil ? 'done' : 'open',
    doneBy: i < doneUntil ? { handle: 'rina', displayName: 'Rina Kusuma' } : null,
    doneAt: i < doneUntil ? isoAt(-6) : null,
    note: i < doneUntil ? 'Two records checked; nothing to change' : null,
  }));
}

function mentionsFor(D: ControllerData | null, systems: readonly string[], name: string): Record<string, SampleMention[]> {
  const out: Record<string, SampleMention[]> = {};
  systems.forEach((ms, i) => {
    const doc = D?.bundles?.[ms]?.docs?.[0];
    out[ms] = i === 0 && doc
      ? [
        { recordKind: 'document', recordId: doc.id, code: doc.id, field: 'title', excerpt: `${doc.title}` },
        { recordKind: 'risk', recordId: sampleId(900 + i), code: 'R-031', field: 'description', excerpt: `... reported by ${name} of the cleaning contractor ...` },
      ]
      : [];
  });
  return out;
}

function action(name: string, offsetHours: number, actor: string | null = 'rina'): ActionView {
  return { action: name, at: isoAt(offsetHours), actor: actor ? { handle: actor, displayName: actor === 'rina' ? 'Rina Kusuma' : actor } : null };
}

function seed(D: ControllerData | null, org: string): SampleRequest[] {
  const systems = systemsOf(D, org);
  const handles = Object.keys(D?.PEOPLE ?? {}).filter((h) => h !== 'none' && h !== 'rina');
  const first = personOf(D, handles.includes('bagus') ? 'bagus' : handles[0] ?? 'rina') ?? { handle: 'bagus', name: 'Bagus Prasetyo' };
  const second = personOf(D, handles.includes('dewi') ? 'dewi' : handles[1] ?? first.handle) ?? first;
  const year = new Date(started).getUTCFullYear();
  const base = (n: number, type: RequestType) => ({ id: sampleId(n), requestNo: `PR-${year}-${String(n).padStart(3, '0')}`, type });
  return [
    {
      ...base(1, 'access'),
      status: 'in_progress',
      subject: { kind: 'member', userId: sampleId(101), handle: first.handle, name: first.name, email: emailOf(first.name) },
      subjectHandle: first.handle,
      channel: 'email',
      receivedAt: isoAt(-30),
      dueAt: isoAt(42),
      closedAt: null,
      handledBy: { handle: 'rina', displayName: 'Rina Kusuma' },
      overdue: false,
      etag: 'W/"1"',
      note: 'Asked by email for a copy of their data',
      identityCheckNote: 'Identity checked by a video call',
      identityCheckedBy: { handle: 'rina', displayName: 'Rina Kusuma' },
      outcome: null,
      result: null,
      checks: checksFor(1, systems, 1),
      actions: [action('privacy_request.created', -29), action('privacy_request.updated', -28)],
      exportTaskId: null,
      mentions: mentionsFor(D, systems, first.name),
    },
    {
      ...base(2, 'erasure'),
      status: 'received',
      subject: { kind: 'other', userId: null, handle: null, name: 'Bima Haryanto', email: 'bima.haryanto@supplier.example' },
      subjectHandle: null,
      channel: 'letter',
      receivedAt: isoAt(-70),
      dueAt: isoAt(2),
      closedAt: null,
      handledBy: null,
      overdue: false,
      etag: 'W/"2"',
      note: 'Former supplier contact asks to be erased',
      identityCheckNote: null,
      identityCheckedBy: null,
      outcome: null,
      result: null,
      checks: checksFor(2, systems, 0),
      actions: [action('privacy_request.created', -69)],
      exportTaskId: null,
      mentions: mentionsFor(D, systems, 'Bima Haryanto'),
    },
    {
      ...base(3, 'rectification'),
      status: 'completed',
      subject: { kind: 'member', userId: sampleId(102), handle: second.handle, name: second.name, email: emailOf(second.name) },
      subjectHandle: second.handle,
      channel: 'self_service',
      receivedAt: isoAt(-100),
      dueAt: isoAt(-28),
      closedAt: isoAt(-40),
      handledBy: { handle: 'rina', displayName: 'Rina Kusuma' },
      overdue: false,
      etag: 'W/"3"',
      note: null,
      identityCheckNote: 'Signed in to My account',
      identityCheckedBy: { handle: 'rina', displayName: 'Rina Kusuma' },
      outcome: 'Job title corrected',
      result: { rectified: 1, fieldsChanged: 1 },
      checks: [],
      actions: [action('privacy_request.created', -100, second.handle), action('privacy_request.updated', -60), action('privacy_request.rectified', -41), action('privacy_request.closed', -40)],
      exportTaskId: null,
      mentions: {},
    },
  ];
}

/** The sample requests of an organisation (seeded on first read). */
export function requestsOf(D: ControllerData | null, org: string): SampleRequest[] {
  if (!started) started = Date.now();
  let list = byOrg.get(org);
  if (!list) {
    list = seed(D, org);
    byOrg.set(org, list);
  }
  for (const r of list) r.overdue = (r.status === 'received' || r.status === 'in_progress') && new Date(r.dueAt).getTime() < Date.now();
  return list;
}

/** The instant of the store's start plus `offsetHours` (new sample rows). */
export function sampleInstant(offsetHours = 0): string {
  if (!started) started = Date.now();
  return isoAt(offsetHours);
}

/** The time of the store's start (the base of every sample time). */
export function sampleStart(): number {
  if (!started) started = Date.now();
  return started;
}
