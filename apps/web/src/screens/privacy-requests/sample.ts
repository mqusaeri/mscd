// Sample adapter of Personal data requests (MILESTONE-3 M3-04): the requests of the sample store per organisation, the
// people of the snapshot as members, and every move and action with the server's rules (J.8, D.6): start needs a
// received request, an action needs work started and the right type, an erasure needs every check done, closing needs
// the action of the type. A copy of the data is ready at once in the sample build. Nothing leaves the browser.
import type { ApiResult } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import type { TextPair } from '../types';
import type { ExportState, Member, Outcome, PrivacyRequestsAdapter, RequestDetail, RequestRow } from './model';
import { filterRows, isOpen } from './model';
import { newSampleId, nextNumber, requestsOf, sampleInstant, systemsOf, type SampleRequest } from './sample-store';

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, status: 200, data });
const refuse = <T,>(status: number, message: TextPair, messageKey?: string, rule?: string): ApiResult<T> => ({
  ok: false, status, error: { status, message: [message[0], message[1]], ...(messageKey ? { messageKey } : {}), ...(rule ? { rule } : {}) },
});

const R = {
  notFound: ['No such personal data request.', 'Permintaan data pribadi tidak ditemukan.'] as TextPair,
  transition: ['This move is not allowed for the request now.', 'Perpindahan ini tidak diizinkan untuk permintaan saat ini.'] as TextPair,
  startFirst: ['Start work on the request first: record how you checked who is asking.', 'Mulai tangani permintaan terlebih dahulu: catat cara Anda memeriksa siapa yang meminta.'] as TextPair,
  wrongType: ['This action does not answer a request of this type.', 'Tindakan ini tidak menjawab permintaan dengan jenis ini.'] as TextPair,
  checksOpen: ['Every system check must be done first. The Management System Managers mark them done in Personal data checks.', 'Setiap pemeriksaan sistem harus selesai terlebih dahulu. Manajer Sistem Manajemen menandainya selesai di Pemeriksaan data pribadi.'] as TextPair,
  actionFirst: ['Take the action this request asks for before you close it.', 'Lakukan tindakan yang diminta permintaan ini sebelum menutupnya.'] as TextPair,
  lastAdmin: ['The person is the last active Tenant Admin. Give another member the Tenant Admin role first.', 'Orang tersebut adalah Tenant Admin aktif terakhir. Berikan peran Tenant Admin kepada anggota lain terlebih dahulu.'] as TextPair,
};

const ME = { handle: 'rina', displayName: 'Rina Kusuma' };

function rowOf(r: SampleRequest): RequestRow {
  return {
    id: r.id, requestNo: r.requestNo, type: r.type, status: r.status, subject: { ...r.subject }, channel: r.channel, receivedAt: r.receivedAt, dueAt: r.dueAt,
    closedAt: r.closedAt, handledBy: r.handledBy, overdue: r.overdue, etag: r.etag,
  };
}

function detailOf(r: SampleRequest): RequestDetail {
  return { ...rowOf(r), note: r.note, identityCheckNote: r.identityCheckNote, identityCheckedBy: r.identityCheckedBy, outcome: r.outcome, result: r.result ? { ...r.result } : null, checks: r.checks.map((c) => ({ ...c })), actions: r.actions.map((a) => ({ ...a })), exportTaskId: r.exportTaskId };
}

export function createSampleAdapter(getD: () => ControllerData | null, getOrg: () => string | null): PrivacyRequestsAdapter {
  const list = () => requestsOf(getD(), getOrg() ?? 'ndt');
  const find = (id: string) => list().find((r) => r.id === id) ?? null;
  const touch = (r: SampleRequest, action: string) => {
    r.etag = `W/"${Date.now()}${Math.floor(Math.random() * 1000)}"`;
    r.actions.push({ action, at: new Date().toISOString(), actor: { ...ME } });
    r.handledBy = { ...ME };
  };
  const act = (id: string, type: RequestDetail['type'] | null, run: (r: SampleRequest) => ApiResult<Outcome>): ApiResult<Outcome> => {
    const r = find(id);
    if (!r) return refuse(404, R.notFound);
    if (!isOpen(r.status)) return refuse(409, R.transition, 'privacy.request_closed');
    if (type && r.type !== type) return refuse(409, R.wrongType, 'privacy.wrong_type');
    if (type && r.status !== 'in_progress') return refuse(409, R.startFirst, 'privacy.start_first');
    return run(r);
  };
  return {
    sample: true,
    async list(filter) {
      return ok(filterRows(list().map(rowOf), filter).sort((a, b) => {
        const open = Number(isOpen(b.status)) - Number(isOpen(a.status));
        if (open) return open;
        return isOpen(a.status) ? a.dueAt.localeCompare(b.dueAt) : b.receivedAt.localeCompare(a.receivedAt);
      }));
    },
    async members() {
      const people = Object.entries(getD()?.PEOPLE ?? {}).filter(([h]) => h !== 'none');
      return ok(people.map(([handle, [name]]): Member => ({ id: `sample-${handle}`, handle, name, email: `${handle}@nusantaradigital.co.id` })));
    },
    async create(input) {
      const D = getD();
      const id = newSampleId();
      const requestNo = nextNumber();
      const receivedAt = input.receivedAt;
      const member = 'userId' in input.subject;
      const handle = member ? (input.subject as { userId: string }).userId.replace(/^sample-/, '') : null;
      const name = member ? (D?.PEOPLE?.[handle!]?.[0] ?? handle!) : (input.subject as { name: string }).name;
      const systems = input.type === 'access' || input.type === 'erasure' ? systemsOf(D, getOrg() ?? 'ndt') : [];
      list().push({
        id, requestNo, type: input.type, status: 'received',
        subject: { kind: member ? 'member' : 'other', userId: member ? (input.subject as { userId: string }).userId : null, handle, name, email: member ? `${handle}@nusantaradigital.co.id` : ((input.subject as { email?: string }).email ?? null) },
        subjectHandle: handle, channel: input.channel, receivedAt, dueAt: new Date(new Date(receivedAt).getTime() + 72 * 3_600_000).toISOString(), closedAt: null,
        handledBy: null, overdue: false, etag: `W/"${Date.now()}"`, note: input.note ?? null, identityCheckNote: null, identityCheckedBy: null, outcome: null, result: null,
        checks: systems.map((ms) => ({ id: newSampleId(), ms, status: 'open', doneBy: null, doneAt: null, note: null })),
        actions: [{ action: 'privacy_request.created', at: sampleInstant(0), actor: { ...ME } }], exportTaskId: null, mentions: {},
      });
      return ok({ id, requestNo });
    },
    async get(id) {
      const r = find(id);
      return r ? ok(detailOf(r)) : refuse(404, R.notFound);
    },
    async update(id, patch) {
      const r = find(id);
      if (!r) return refuse(404, R.notFound);
      if (patch.action === 'note') {
        r.note = patch.note;
        touch(r, 'privacy_request.updated');
        return ok({ message: null });
      }
      if (patch.action === 'start') {
        if (r.status !== 'received') return refuse(409, R.transition);
        r.status = 'in_progress';
        r.identityCheckNote = patch.identityCheckNote;
        r.identityCheckedBy = { ...ME };
        touch(r, 'privacy_request.updated');
        return ok({ message: null });
      }
      if (!isOpen(r.status)) return refuse(409, R.transition);
      r.status = patch.action === 'refuse' ? 'refused' : 'withdrawn';
      r.outcome = patch.reason;
      r.closedAt = new Date().toISOString();
      touch(r, 'privacy_request.updated');
      return ok({ message: null });
    },
    async rectify(id) {
      return act(id, 'rectification', (r) => {
        r.result = { ...(r.result ?? {}), rectified: (r.result?.rectified ?? 0) + 1 };
        touch(r, 'privacy_request.rectified');
        return ok({ message: null });
      });
    },
    async restrict(id) {
      return act(id, 'restriction', (r) => {
        if (r.subjectHandle === 'rina') return refuse(409, R.lastAdmin, 'last_tenant_admin');
        r.result = { ...(r.result ?? {}), restricted: 1 };
        touch(r, 'privacy_request.restricted');
        return ok({ message: null });
      });
    },
    async erase(id) {
      return act(id, 'erasure', (r) => {
        if (r.checks.some((c) => c.status === 'open')) return refuse(409, R.checksOpen, 'privacy.checks_open');
        if (r.subjectHandle === 'rina') return refuse(409, R.lastAdmin, 'last_tenant_admin');
        r.result = { ...(r.result ?? {}), erased: 1, systemsChecked: r.checks.length, ...(r.subject.kind === 'member' ? { rolesRevoked: 1, auditEntriesRedacted: 4 } : {}) };
        touch(r, 'privacy_request.erased');
        return ok({ message: null });
      });
    },
    async close(id, text) {
      return act(id, null, (r) => {
        if (r.status !== 'in_progress') return refuse(409, R.startFirst, 'privacy.start_first');
        if ((r.type === 'access' || r.type === 'erasure') && r.checks.some((c) => c.status === 'open')) return refuse(409, R.checksOpen, 'privacy.checks_open');
        const result = r.result ?? {};
        const member = r.subject.kind === 'member';
        const done = r.type === 'rectification' || (r.type === 'access' && (!member || (result.exportsQueued ?? 0) > 0))
          || (r.type === 'erasure' && (result.erased ?? 0) > 0) || (r.type === 'restriction' && (!member || (result.restricted ?? 0) > 0));
        if (!done) return refuse(409, R.actionFirst, 'privacy.action_first');
        r.status = 'completed';
        r.outcome = text;
        r.closedAt = new Date().toISOString();
        touch(r, 'privacy_request.closed');
        return ok({ message: null });
      });
    },
    async exportPerson(id) {
      return act(id, 'access', (r) => {
        r.exportTaskId = newSampleId();
        r.result = { ...(r.result ?? {}), exportsQueued: (r.result?.exportsQueued ?? 0) + 1 };
        return ok({ message: null, taskId: r.exportTaskId });
      });
    },
    async exportState() {
      const state: ExportState = { status: 'succeeded', downloadUrl: null };
      return ok(state);
    },
  };
}
