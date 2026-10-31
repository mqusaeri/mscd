// Sample adapter of "Policy read confirmations" (MILESTONE-3 M3-05, D.7, C.6): the requests of the sample organisation
// (sample-store.ts) with the rules the api applies: a request needs an approved document with a version and an audience,
// one open request per version (the request of an earlier version closes), reminders at most once a day and only while
// someone is pending, closing once, the register CSV with the columns of the api, and the settings of a document kept
// in this tab. Loaded only by the sample build (adapter.ts), so the api build holds none of it.
import type { ControllerData, MsId } from '../../data/types';
import type { AcknowledgementsAdapter, Download, Outcome, RequestDetail, RequestRow, Result, Settings } from './model';
import { DEFAULT_SETTINGS, refusal, settingsBody } from './model';
import type { SampleRequest } from './sample-store';
import { addDays, documentSystems, nextId, sampleAudience, sampleState, sampleToday, totalsOf, visibleIn } from './sample-store';
import { TEXT } from './text';

export interface SampleScope {
  getD(): ControllerData | null;
  org(): string | null;
}

/** The columns of the register CSV, as the api writes them. */
export const REGISTER_COLUMNS = [
  'Document', 'Title', 'Version', 'Due date', 'User name', 'Name', 'Status', 'Opened at', 'Confirmed at', 'Reminders', 'Overdue', 'Excused reason',
] as const;

const notFound = () => refusal(404, ['Record not found', 'Rekaman tidak ditemukan'], { slug: 'not-found' });
const conflict = (key: string, message: readonly [string, string]) => refusal(409, message, { slug: 'conflict', messageKey: key });
const rule = (key: string, message: readonly [string, string]) => refusal(422, message, { slug: 'business-rule', messageKey: key });

/** A CSV cell: quoted when it holds a comma, a quote or a line break; formulas neutralised as the api does (F.15). */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The register of a request as CSV, the rows of the api. */
export function registerCsv(D: ControllerData | null, request: SampleRequest, today: string): string {
  const name = (h: string) => D?.PEOPLE?.[h]?.[0] ?? h;
  const lines = [REGISTER_COLUMNS.join(',')];
  for (const p of request.people) {
    lines.push([
      request.document.code, request.document.title, request.version.label, request.dueOn, p.handle, name(p.handle), p.status, p.openedAt, p.confirmedAt,
      p.reminderCount, p.status === 'pending' && request.dueOn < today ? 'yes' : 'no', p.excusedReason,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function createSampleAdapter(scope: SampleScope): AcknowledgementsAdapter {
  const state = () => sampleState(scope.getD(), scope.org());
  const today = () => sampleToday(scope.getD());
  const present = (r: SampleRequest): RequestRow => {
    const { systems: _s, evidenceCode: _e, people: _p, ...rest } = r;
    return { ...rest, totals: totalsOf(r, today()) };
  };
  const find = (ms: MsId, id: string) => state().requests.find((r) => r.id === id && visibleIn(r, ms));
  const done = (ms: MsId, extra: Partial<Outcome> = {}): Result<Outcome> => ({ ok: true, data: { changed: [ms], message: null, warnings: [], ...extra } });
  return {
    sample: true,

    async list(ms) {
      const rows = state().requests.filter((r) => visibleIn(r, ms));
      rows.sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === 'open' ? -1 : 1));
      return { ok: true, data: rows.map(present) };
    },

    async get(ms, id) {
      const r = find(ms, id);
      if (!r) return notFound();
      const D = scope.getD();
      const order = { pending: 0, confirmed: 1, excused: 2 } as const;
      const people = [...r.people]
        .sort((a, b) => order[a.status] - order[b.status] || (D?.PEOPLE?.[a.handle]?.[0] ?? a.handle).localeCompare(D?.PEOPLE?.[b.handle]?.[0] ?? b.handle))
        .map((p) => ({
          handle: p.handle,
          name: D?.PEOPLE?.[p.handle]?.[0] ?? p.handle,
          status: p.status,
          openedAt: p.openedAt,
          confirmedAt: p.confirmedAt,
          reminderCount: p.reminderCount,
          excusedReason: p.excusedReason,
          overdue: p.status === 'pending' && r.dueOn < today(),
        }));
      const detail: RequestDetail = { ...present(r), people };
      return { ok: true, data: detail };
    },

    async ask(ms, input) {
      const D = scope.getD();
      const doc = (D?.bundles?.[ms]?.docs ?? []).find((d) => d.id === input.documentId);
      if (!doc) return notFound();
      if (doc.st !== 'approved' || !doc.ver || doc.ver === '-') {
        return rule('acknowledgements.not_approved', ['Only an approved document with a current version can be confirmed. Approve a version first.', 'Hanya dokumen yang disetujui dengan versi berlaku yang dapat dikonfirmasi. Setujui sebuah versi terlebih dahulu.']);
      }
      const s = state();
      const versionId = `${doc.id}-v${doc.ver}`;
      if (s.requests.some((r) => r.version.id === versionId && r.status === 'open')) {
        return conflict('acknowledgements.open_request', ['This version already has an open confirmation request.', 'Versi ini sudah memiliki permintaan konfirmasi yang terbuka.']);
      }
      const systems = documentSystems(D, doc.id);
      const audience = sampleAudience(D, systems, input.scope, input.scope === 'roles' ? input.roles : null, ms);
      if (!audience.length) {
        return rule('acknowledgements.no_audience', ['Nobody holds a role that is asked to confirm this document. Choose another audience.', 'Tidak ada yang memegang peran yang diminta mengonfirmasi dokumen ini. Pilih audiens lain.']);
      }
      const now = `${today()}T03:00:00Z`;
      for (const earlier of s.requests.filter((r) => r.document.code === doc.id && r.status === 'open')) {
        earlier.status = 'closed';
        earlier.closedAt = now;
        for (const p of earlier.people) {
          if (p.status === 'pending') Object.assign(p, { status: 'excused', excusedReason: `Replaced by version ${doc.ver}` });
        }
      }
      const request: SampleRequest = {
        id: nextId(s, 'request'), ms, systems, document: { id: doc.id, code: doc.id, title: doc.title }, version: { id: versionId, label: doc.ver },
        status: 'open', audienceScope: input.scope, audienceRoles: input.scope === 'roles' ? [...input.roles] : null, dueOn: addDays(today(), input.dueDays),
        createdAt: now, lastRemindedAt: null, closedAt: null, evidenceId: null, evidenceCode: null,
        people: audience.map((p) => ({
          id: nextId(s, 'ack'), handle: p.handle, ms: p.ms, status: 'pending', openedAt: null, confirmedAt: null, remindedAt: null, reminderCount: 0, excusedReason: null,
        })),
      };
      s.requests.push(request);
      const n = audience.length;
      return done(ms, {
        count: n,
        data: { id: request.id, audience: n, dueOn: request.dueOn },
        message: [`Asked ${n === 1 ? '1 person' : `${n} people`} to confirm ${doc.id} version ${doc.ver}`, `${n} orang diminta mengonfirmasi ${doc.id} versi ${doc.ver}`],
      });
    },

    async remind(ms, id) {
      const r = find(ms, id);
      if (!r) return notFound();
      if (r.status !== 'open') return conflict('acknowledgements.request_closed', ['This confirmation request is closed.', 'Permintaan konfirmasi ini sudah ditutup.']);
      if (r.lastRemindedAt && r.lastRemindedAt.slice(0, 10) === today()) {
        return conflict('acknowledgements.reminded_today', ['The people of this request were reminded today already. You can remind them again tomorrow.', 'Orang-orang dalam permintaan ini sudah diingatkan hari ini. Anda dapat mengingatkan lagi besok.']);
      }
      const pending = r.people.filter((p) => p.status === 'pending');
      if (!pending.length) return conflict('acknowledgements.nothing_pending', ['Nobody in this request still has to confirm.', 'Tidak ada lagi orang dalam permintaan ini yang perlu mengonfirmasi.']);
      const now = `${today()}T03:00:00Z`;
      for (const p of pending) Object.assign(p, { remindedAt: now, reminderCount: p.reminderCount + 1 });
      r.lastRemindedAt = now;
      const n = pending.length;
      return done(ms, {
        count: n,
        message: [`Reminded ${n === 1 ? '1 person' : `${n} people`} to confirm ${r.document.code}`, `${n} orang diingatkan untuk mengonfirmasi ${r.document.code}`],
      });
    },

    async close(ms, id, evidenceCode) {
      const r = find(ms, id);
      if (!r) return notFound();
      if (r.status !== 'open') return conflict('acknowledgements.request_closed', ['This confirmation request is closed.', 'Permintaan konfirmasi ini sudah ditutup.']);
      if (evidenceCode && !(scope.getD()?.bundles?.[ms]?.evs ?? []).some((e) => e.code === evidenceCode)) return notFound();
      r.status = 'closed';
      r.closedAt = `${today()}T03:00:00Z`;
      r.evidenceId = evidenceCode;
      r.evidenceCode = evidenceCode;
      return done(ms, {
        data: evidenceCode ? { evidenceCode } : {},
        message: evidenceCode
          ? [`Request closed. The register is filed as a new file of ${evidenceCode}.`, `Permintaan ditutup. Register disimpan sebagai berkas baru ${evidenceCode}.`]
          : ['Request closed. Reminders stop.', 'Permintaan ditutup. Pengingat berhenti.'],
      });
    },

    async exportCsv(ms, row) {
      const r = find(ms, row.id);
      if (!r) return notFound();
      const csv = registerCsv(scope.getD(), r, today());
      const fileName = `read-confirmations-${r.document.code}-v${r.version.label}-${today()}.csv`;
      if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        return { ok: true, data: { href: `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`, fileName } };
      }
      const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const download: Download = { href, fileName, release: () => URL.revokeObjectURL(href) };
      return { ok: true, data: download };
    },

    async saveSettings(ms, code, settings: Settings) {
      const D = scope.getD();
      if (!(D?.bundles?.[ms]?.docs ?? []).some((d) => d.id === code)) return notFound();
      for (const system of documentSystems(D, code)) state().settings.set(`${system}:${code}`, settingsBody(settings));
      return done(ms, { message: [TEXT.saved[0].replace('{code}', code), TEXT.saved[1].replace('{code}', code)] });
    },

    settingsOf(ms, code) {
      // The tab's store holds every setting of the sample build: a document of the system without one has the defaults.
      const stored = state().settings.get(`${ms}:${code}`);
      if (stored) return stored;
      return (scope.getD()?.bundles?.[ms]?.docs ?? []).some((d) => d.id === code) ? { ...DEFAULT_SETTINGS } : null;
    },

    documentId: (ms, code) => ((scope.getD()?.bundles?.[ms]?.docs ?? []).some((d) => d.id === code) ? code : null),
    evidenceId: (ms, code) => ((scope.getD()?.bundles?.[ms]?.evs ?? []).some((e) => e.code === code) ? code : null),
  };
}
