// Sample adapter of the notification bell and panel: four notifications of the sample organisation, built from the
// sample snapshot (a reminder on an ISMS control, a document due for review, a role grant waiting for approval and the
// licence reminder, which is read). "Mark read" and "Mark all read" stay for the browser session.
import type { ControllerData } from '../../data/types';
import type { NotificationModel, NotificationsAdapter } from './model';

const read = new Set<string>();

/** Forgets what was marked read in this session (unit tests). */
export function resetSampleNotifications(): void {
  read.clear();
}

/** The sample notifications, newest first. */
export function sampleNotifications(D: ControllerData | null): NotificationModel[] {
  const req = D?.bundles?.isms?.reqs?.find((r) => r.st !== 'implemented') ?? D?.bundles?.isms?.reqs?.[0];
  const doc = D?.bundles?.isms?.docs?.[0];
  const items: NotificationModel[] = [];
  if (req) {
    items.push({
      id: 'sample-n1', kind: 'reminder', ms: 'isms', key: `isms:req:${req.id}`, ref: { entityType: 'applicability_entry', id: 'sample-r1', code: req.id },
      title: ['Reminder', 'Pengingat'],
      body: [`Reminder from Rina Kusuma: ${req.id} ${req.title}`, `Pengingat dari Rina Kusuma: ${req.id} ${req.title}`],
      createdAt: '2026-09-29T02:00:00Z', readAt: null,
    });
  }
  if (doc) {
    items.push({
      id: 'sample-n2', kind: 'document_review_due', ms: 'isms', key: `isms:doc:${doc.id}`, ref: { entityType: 'document', id: 'sample-d1', code: doc.id },
      title: ['Document review due', 'Review dokumen jatuh tempo'],
      body: [`${doc.id} ${doc.title} is due for its review`, `${doc.id} ${doc.title} sudah waktunya direview`],
      createdAt: '2026-09-28T01:30:00Z', readAt: null,
    });
  }
  items.push(
    {
      id: 'sample-n3', kind: 'role_grant_pending', ms: null, ref: null,
      title: ['Role grant waits for approval', 'Pemberian peran menunggu persetujuan'],
      body: ['Tono Hartono granted Domain Owner in ISMS to himself. A second administrator approves it.', 'Tono Hartono memberikan peran Pemilik Domain di ISMS kepada dirinya sendiri. Administrator kedua menyetujuinya.'],
      createdAt: '2026-09-27T07:45:00Z', readAt: null,
    },
    {
      id: 'sample-n4', kind: 'licence_expiring', ms: null, ref: null,
      title: ['Licence ends in 6 months', 'Lisensi berakhir dalam 6 bulan'],
      body: ['The licence of PT Nusantara Digital Teknologi is valid until 31 Mar 2027.', 'Lisensi PT Nusantara Digital Teknologi berlaku sampai 31 Mar 2027.'],
      createdAt: '2026-09-20T03:00:00Z', readAt: '2026-09-21T03:00:00Z',
    },
  );
  return items.map((n) => (read.has(n.id) && !n.readAt ? { ...n, readAt: '2026-09-29T08:00:00Z' } : n));
}

export function createSampleAdapter(getD: () => ControllerData | null): NotificationsAdapter {
  return {
    async unreadCount() {
      return { ok: true, data: sampleNotifications(getD()).filter((n) => !n.readAt).length };
    },
    async list({ page, pageSize, unreadOnly }) {
      const all = sampleNotifications(getD()).filter((n) => !unreadOnly || !n.readAt);
      return { ok: true, data: { items: all.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: all.length } };
    },
    async markRead(id) {
      read.add(id);
      return { ok: true, data: null };
    },
    async markAllRead() {
      for (const n of sampleNotifications(getD())) read.add(n.id);
      return { ok: true, data: null };
    },
  };
}
