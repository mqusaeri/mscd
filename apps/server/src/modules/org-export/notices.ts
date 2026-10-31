// The notifications of the organisation export (Milestone 3 J.4): `organization_export_requested` at every request,
// decision and download, to every active Tenant Admin and every primary Management System Manager, so a full download
// never goes unnoticed (H.2); `organization_export_ready` when the build ends, to the requester, or to every Tenant
// Admin for an export of the provider or the final export. Both go out in the app and by email (not digest).
import type { Messages } from '@mscd/shared';
import { SYSTEM_USER_ID, type NotificationWriter, type Trx } from '../../common/tokens';

/** The record ref of an export in notifications (module `admin`). */
export function exportRef(id: string, code: string) {
  return { module: 'admin' as const, entityType: 'organization_export', id, code };
}

/** Writes one notice of `kind` to every recipient in the caller's tenant transaction; returns how many were written. */
export async function notifyAll(
  writer: NotificationWriter,
  trx: Trx,
  recipients: readonly string[],
  input: { kind: 'organization_export_requested' | 'organization_export_ready'; title: Messages; body: Messages; id: string; code: string; createdBy?: string },
): Promise<number> {
  let written = 0;
  for (const recipient of recipients) {
    const id = await writer.create(trx, {
      recipientUserId: recipient,
      kind: input.kind,
      title: input.title,
      body: input.body,
      ref: exportRef(input.id, input.code),
      createdBy: input.createdBy ?? SYSTEM_USER_ID,
    });
    if (id) written += 1;
  }
  return written;
}

const REQUESTED_TITLE: Messages = { en: 'Organisation export requested', id: 'Ekspor organisasi diminta' };

export function requestedNotice(who: string, org: string, approvalNeeded: boolean, note?: string): { title: Messages; body: Messages } {
  const noteEn = note ? ` Note: ${note}` : '';
  const noteId = note ? ` Catatan: ${note}` : '';
  return {
    title: REQUESTED_TITLE,
    body: approvalNeeded
      ? {
          en: `${who} asked for a full export of all data of ${org}. Another Tenant Admin must approve it before it is built.${noteEn}`,
          id: `${who} meminta ekspor lengkap seluruh data ${org}. Tenant Admin lain harus menyetujuinya sebelum ekspor dibuat.${noteId}`,
        }
      : {
          en: `${who} asked for a full export of all data of ${org}. It was queued without a second approval, because the organisation has one Tenant Admin.${noteEn}`,
          id: `${who} meminta ekspor lengkap seluruh data ${org}. Ekspor diantrekan tanpa persetujuan kedua, karena organisasi hanya memiliki satu Tenant Admin.${noteId}`,
        },
  };
}

export function decidedNotice(who: string, requester: string, approved: boolean, note?: string): { title: Messages; body: Messages } {
  return approved
    ? {
        title: { en: 'Organisation export approved', id: 'Ekspor organisasi disetujui' },
        body: {
          en: `${who} approved the full export requested by ${requester}. It is being built.`,
          id: `${who} menyetujui ekspor lengkap yang diminta oleh ${requester}. Ekspor sedang dibuat.`,
        },
      }
    : {
        title: { en: 'Organisation export rejected', id: 'Ekspor organisasi ditolak' },
        body: {
          en: `${who} rejected the full export requested by ${requester}.${note ? ` Reason: ${note}` : ''}`,
          id: `${who} menolak ekspor lengkap yang diminta oleh ${requester}.${note ? ` Alasan: ${note}` : ''}`,
        },
      };
}

export function downloadedNotice(who: string, what: { part: number; parts: number } | 'manifest'): { title: Messages; body: Messages } {
  return {
    title: { en: 'Organisation export downloaded', id: 'Ekspor organisasi diunduh' },
    body:
      what === 'manifest'
        ? { en: `${who} downloaded the manifest of the full organisation export.`, id: `${who} mengunduh manifes ekspor lengkap organisasi.` }
        : {
            en: `${who} downloaded part ${what.part} of ${what.parts} of the full organisation export.`,
            id: `${who} mengunduh bagian ${what.part} dari ${what.parts} ekspor lengkap organisasi.`,
          },
  };
}

export function operatorNotice(org: string): { title: Messages; body: Messages } {
  return {
    title: REQUESTED_TITLE,
    body: {
      en: `Your MSCD service provider queued a full export of all data of ${org}. Tenant Admins can download it when it is ready.`,
      id: `Penyedia layanan MSCD Anda mengantrekan ekspor lengkap seluruh data ${org}. Tenant Admin dapat mengunduhnya setelah siap.`,
    },
  };
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

export function readyNotice(parts: number, bytes: number, until: string | null): { title: Messages; body: Messages } {
  const partsEn = parts === 1 ? '1 part' : `${parts} parts`;
  return {
    title: { en: 'Organisation export ready', id: 'Ekspor organisasi siap' },
    body: until
      ? {
          en: `The full organisation export is ready: ${partsEn}, ${size(bytes)}. It can be downloaded until ${until}.`,
          id: `Ekspor lengkap organisasi siap: ${parts} bagian, ${size(bytes)}. Ekspor dapat diunduh sampai ${until}.`,
        }
      : {
          en: `The final organisation export is ready: ${partsEn}, ${size(bytes)}. It can be downloaded until the organisation is closed.`,
          id: `Ekspor akhir organisasi siap: ${parts} bagian, ${size(bytes)}. Ekspor dapat diunduh sampai organisasi ditutup.`,
        },
  };
}
