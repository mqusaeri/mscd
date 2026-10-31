// Sample adapter of "Policies to confirm" (MILESTONE-3 M3-05, D.7, C.6): the sample persona's rows of the read
// confirmation requests of the sample organisation (screens/acknowledgements/sample-store.ts, shared with "Policy read
// confirmations"), opening a version (the sample build has no stored files, so the row counts as opened) and the
// confirmation with the rule of the api (ACK-OPEN-FIRST before opening). Loaded only by the sample build (adapter.ts).
import type { ControllerData } from '../../data/types';
import { sampleState, sampleToday } from '../acknowledgements/sample-store';
import type { Confirmation, ConfirmationsAdapter } from './model';

export interface SampleScope {
  getD(): ControllerData | null;
  org(): string | null;
  me(): string;
}

/** The text of rule ACK-OPEN-FIRST (apps/server/src/modules/rules/messages.ts). */
export const ACK_OPEN_FIRST: readonly [string, string] = [
  'Open {document} first. You can confirm it only after you have opened the version you are asked to read.',
  'Buka {document} terlebih dahulu. Anda baru dapat mengonfirmasinya setelah membuka versi yang diminta untuk dibaca.',
];

export function createSampleAdapter(scope: SampleScope): ConfirmationsAdapter {
  const state = () => sampleState(scope.getD(), scope.org());
  const today = () => sampleToday(scope.getD());
  const now = () => `${today()}T03:00:00Z`;
  const rowOf = (id: string) => {
    for (const r of state().requests) {
      const p = r.people.find((x) => x.id === id && x.handle === scope.me());
      if (p) return { request: r, person: p };
    }
    return null;
  };
  const notFound = () => ({ ok: false as const, error: { status: 404, slug: 'not-found', message: ['Record not found', 'Rekaman tidak ditemukan'] as [string, string] } });
  const conflict = (key: string, message: [string, string]) => ({ ok: false as const, error: { status: 409, slug: 'conflict', messageKey: key, message } });
  return {
    sample: true,
    async mine() {
      const out: Confirmation[] = [];
      for (const r of state().requests) {
        for (const p of r.people) {
          if (p.handle !== scope.me()) continue;
          if (p.status === 'pending' && r.status !== 'open') continue;
          out.push({
            id: p.id, requestId: r.id, ms: p.ms, document: { code: r.document.code, title: r.document.title }, versionLabel: r.version.label, status: p.status,
            dueOn: r.dueOn, openedAt: p.openedAt, confirmedAt: p.confirmedAt, overdue: p.status === 'pending' && r.dueOn < today(),
          });
        }
      }
      return { ok: true, data: out };
    },
    async open(id) {
      const hit = rowOf(id);
      if (!hit) return notFound();
      if (hit.person.status === 'excused') return conflict('acknowledgements.excused', ['You no longer need to confirm this document.', 'Anda tidak perlu lagi mengonfirmasi dokumen ini.']);
      if (hit.person.status === 'pending' && hit.request.status !== 'open') return conflict('acknowledgements.request_closed', ['This confirmation request is closed.', 'Permintaan konfirmasi ini sudah ditutup.']);
      hit.person.openedAt ??= now();
      return { ok: true, data: { url: null } };
    },
    async confirm(id) {
      const hit = rowOf(id);
      if (!hit) return notFound();
      if (hit.person.status === 'confirmed') return conflict('acknowledgements.confirmed', ['You have confirmed this document already.', 'Anda sudah mengonfirmasi dokumen ini.']);
      if (hit.person.status === 'excused') return conflict('acknowledgements.excused', ['You no longer need to confirm this document.', 'Anda tidak perlu lagi mengonfirmasi dokumen ini.']);
      if (hit.request.status !== 'open') return conflict('acknowledgements.request_closed', ['This confirmation request is closed.', 'Permintaan konfirmasi ini sudah ditutup.']);
      if (!hit.person.openedAt) {
        const code = hit.request.document.code;
        return { ok: false, error: { status: 422, slug: 'business-rule', rule: 'ACK-OPEN-FIRST', messageKey: 'rule.ACK-OPEN-FIRST', message: [ACK_OPEN_FIRST[0].replace('{document}', code), ACK_OPEN_FIRST[1].replace('{document}', code)] } };
      }
      hit.person.status = 'confirmed';
      hit.person.confirmedAt = now();
      const { code } = hit.request.document;
      const version = hit.request.version.label;
      return { ok: true, data: { message: [`You confirmed ${code} version ${version}`, `Anda telah mengonfirmasi ${code} versi ${version}`], changed: [] } };
    },
  };
}
