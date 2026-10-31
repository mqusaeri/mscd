// Sample adapter of Organisation export (MILESTONE-3 M3-09): the exports of the current sample organisation from the
// store of the sample service that the operator console shares (ops/sample-orgs.ts), so an export the operator starts,
// the final export of a move to offboarding and the read-only period show here too. PT Nusantara Digital Teknologi has
// two Tenant Admins (Rina Kusuma and Tono Hartono): Tono's request waits for Rina's approval, Rina's own request of 26
// Sep is ready, one request was rejected and one export has expired. A request, approval or rejection follows the rules
// of the server (H.2: the requester never approves, `export_in_progress`, `export_not_requested`); a queued export is
// built one step per read of the list, and the downloads are small text files with their real SHA-256 (R-13: only the
// sample build loads this module).
import type { ControllerData } from '../../data/types';
import { textFile } from '../auditor-access/shared';
import { addDaysIso, advanceExports, inFlight, manifestText, newExport, partText } from '../ops/sample-lifecycle';
import type { SampleExport } from '../ops/sample-lifecycle';
import { sampleId, sampleNow, sampleServiceOrgs } from '../ops/sample-orgs';
import type { SampleOrg } from '../ops/sample-orgs';
import type { OrgExport, OrgExportAdapter, OrgExportDetail, Result } from './model';
import { manifestName } from './model';

type Extra = { slug?: string; messageKey?: string; rule?: string; errors?: { path: string; message: string }[] };
const refuse = <T,>(status: number, message: readonly [string, string], extra: Extra = {}): Result<T> => ({ ok: false, error: { status, message: [message[0], message[1]], ...extra } });

/** The days from archiving to the deletion that the read-only period announces (H.1). */
const GRACE_DAYS = 30;

const listItem = ({ parts: _parts, manifestSha256: _manifest, ...e }: SampleExport): OrgExport => ({
  ...e, requestedBy: e.requestedBy ? { ...e.requestedBy } : null, decidedBy: e.decidedBy ? { ...e.decidedBy } : null,
});
const detailOf = (e: SampleExport): OrgExportDetail => ({ ...listItem(e), parts: e.parts.map((p) => ({ ...p })), manifestSha256: e.manifestSha256 });

export function createSampleAdapter(
  getD: () => ControllerData | null,
  getOrg: () => string | null,
  getPerson: () => { handle: string; name: string },
): OrgExportAdapter {
  const now = () => {
    const day = (getD() as { TODAY_S?: unknown } | null)?.TODAY_S;
    return sampleNow(typeof day === 'string' ? day : null);
  };
  const org = (): SampleOrg | null => sampleServiceOrgs(getD()).find((o) => o.slug === getOrg()) ?? null;
  const noOrg = <T,>(): Result<T> => refuse<T>(404, ['The organisation was not found.', 'Organisasi tidak ditemukan.'], { slug: 'not-found' });
  const missing = <T,>(): Result<T> => refuse<T>(404, ['The export was not found.', 'Ekspor tidak ditemukan.'], { slug: 'not-found' });
  const notReady = <T,>(e: SampleExport): Result<T> => refuse<T>(409, e.status === 'expired'
    ? ['This export has expired. Ask for a new export.', 'Ekspor ini sudah kedaluwarsa. Minta ekspor baru.']
    : ['This export is not ready yet.', 'Ekspor ini belum siap.'], { slug: 'conflict', messageKey: 'export_not_ready' });
  return {
    sample: true,
    async lifecycle() {
      const o = org();
      if (!o) return noOrg();
      const offboarding = o.status === 'offboarding' ? o.offboardingEndsAt : null;
      const scheduled = o.deletion && o.deletion.status !== 'cancelled' ? o.deletion.scheduledFor : null;
      return {
        ok: true,
        data: {
          activeAdminCount: Math.max(1, o.tenantAdmins),
          offboardingEndsAt: offboarding,
          deletionScheduledFor: offboarding ? addDaysIso(offboarding, GRACE_DAYS) : o.status === 'archived' ? scheduled : null,
        },
      };
    },
    async list() {
      const o = org();
      if (!o) return { ok: true, data: [] };
      advanceExports(o, now());
      return { ok: true, data: o.exports.map(listItem) };
    },
    async get(id) {
      const e = org()?.exports.find((x) => x.id === id);
      return e ? { ok: true, data: detailOf(e) } : missing();
    },
    async create(note) {
      const o = org();
      if (!o) return noOrg();
      if (note !== null && note.trim().length > 500) return refuse(400, ['Invalid request', 'Invalid request'], { slug: 'validation', errors: [{ path: 'body.note', message: 'Too big: expected string to have <=500 characters' }] });
      const at = now();
      if (inFlight(o, at)) {
        return refuse(409, [
          'Another export of this organisation is waiting for approval or being built. Wait until it is ready, rejected or failed.',
          'Ekspor lain dari organisasi ini sedang menunggu persetujuan atau sedang dibuat. Tunggu sampai ekspor itu siap, ditolak atau gagal.',
        ], { slug: 'conflict', messageKey: 'export_in_progress' });
      }
      const person = getPerson();
      const approvalNeeded = o.tenantAdmins > 1;
      const id = sampleId();
      o.exports.unshift(newExport({
        id, status: approvalNeeded ? 'requested' : 'queued', requestedVia: 'tenant_admin', requestedBy: { handle: person.handle, displayName: person.name }, requestedAt: at,
      }));
      return {
        ok: true,
        data: {
          id, status: approvalNeeded ? 'requested' : 'queued', approvalNeeded,
          message: approvalNeeded
            ? ['The export waits for another Tenant Admin to approve it.', 'Ekspor menunggu persetujuan Tenant Admin lain.']
            : ['The export was queued. Nobody else approved it, because the organisation has one Tenant Admin.', 'Ekspor diantrekan. Tidak ada orang lain yang menyetujuinya, karena organisasi hanya memiliki satu Tenant Admin.'],
        },
      };
    },
    async decide(id, approve, note) {
      const e = org()?.exports.find((x) => x.id === id);
      if (!e) return missing();
      if (!approve && !note?.trim()) return refuse(400, ['Invalid request', 'Invalid request'], { slug: 'validation', errors: [{ path: 'body.note', message: 'A rejection needs a note' }] });
      if (e.status !== 'requested') {
        return refuse(409, [
          `This export is ${e.status}. Only an export that waits for approval can be approved or rejected.`,
          `Ekspor ini berstatus ${e.status}. Hanya ekspor yang menunggu persetujuan yang dapat disetujui atau ditolak.`,
        ], { slug: 'conflict', messageKey: 'export_not_requested' });
      }
      const person = getPerson();
      if (e.requestedBy?.handle === person.handle) {
        return refuse(422, [
          'You cannot approve what you asked for yourself. Another person with the approval right must decide it.',
          'Anda tidak dapat menyetujui apa yang Anda minta sendiri. Orang lain yang memiliki hak persetujuan harus memutuskannya.',
        ], { slug: 'business-rule', rule: 'SOD-SELF-APPROVE', messageKey: 'rule.SOD-SELF-APPROVE' });
      }
      e.status = approve ? 'queued' : 'rejected';
      e.decidedBy = { handle: person.handle, displayName: person.name };
      e.decidedAt = now();
      e.decisionNote = note?.trim() || null;
      return { ok: true, data: { id, status: e.status, message: null } };
    },
    async partFile(detail, part) {
      const o = org();
      const e = o?.exports.find((x) => x.id === detail.id);
      if (!o || !e) return missing();
      if (e.status !== 'ready') return notReady(e);
      const total = e.parts.length;
      e.downloadCount += 1;
      return { ok: true, data: textFile(partText(o, e.id, part.part, total), part.name, 'text/plain') };
    },
    async manifestFile(detail) {
      const o = org();
      const e = o?.exports.find((x) => x.id === detail.id);
      if (!o || !e) return missing();
      if (e.status !== 'ready') return notReady(e);
      e.downloadCount += 1;
      return { ok: true, data: textFile(manifestText(o, e), manifestName(detail), 'application/json') };
    },
  };
}
