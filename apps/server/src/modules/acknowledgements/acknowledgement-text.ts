// Texts of read confirmation (Milestone 3 D.7, J.4) in English and Indonesian: the stored task of each person, the
// notifications `acknowledgement_requested` and `acknowledgement_overdue`, the excusal reasons, the refusals of the
// routes, and the columns of the confirmation register CSV. Plain English (writing rules of CLAUDE.md); the screen
// names are the labels of C.2 ("Policies to confirm", "Policy read confirmations").
import type { Messages } from '@mscd/shared';
import { fmtDay } from '../../common/dates';

/** The screen a person confirms on (C.2 `my-confirmations`). */
export const CONFIRM_SCREEN: Messages = { en: 'Policies to confirm', id: 'Kebijakan untuk dikonfirmasi' };

/** The register screen of the managers (C.2 `acknowledgements`). */
export const REGISTER_SCREEN: Messages = { en: 'Policy read confirmations', id: 'Konfirmasi baca kebijakan' };

export interface DocumentFacts {
  code: string;
  title: string;
  version: string;
}

/** The title of a person's stored task (C.3: it names the screen that completes it). */
export function taskTitle(doc: DocumentFacts): Messages {
  return {
    en: `Read and confirm ${doc.code} ${doc.title}, version ${doc.version}, in ${CONFIRM_SCREEN.en}`,
    id: `Baca dan konfirmasi ${doc.code} ${doc.title}, versi ${doc.version}, di ${CONFIRM_SCREEN.id}`,
  };
}

/** `acknowledgement_requested`: a new request, a reminder by the manager or a scheduled reminder. */
export function requestedNotice(doc: DocumentFacts, dueOn: string, reminder: boolean): { title: Messages; body: Messages } {
  return {
    title: reminder
      ? { en: `Reminder: confirm that you have read ${doc.code}`, id: `Pengingat: konfirmasi bahwa Anda telah membaca ${doc.code}` }
      : { en: `Please read and confirm ${doc.code}`, id: `Mohon baca dan konfirmasi ${doc.code}` },
    body: {
      en: `${doc.code} ${doc.title}, version ${doc.version}, is approved. Open it in ${CONFIRM_SCREEN.en} and confirm that you have read and understood it by ${fmtDay(dueOn, 'en')}.`,
      id: `${doc.code} ${doc.title}, versi ${doc.version}, telah disetujui. Buka di ${CONFIRM_SCREEN.id} dan konfirmasi bahwa Anda telah membaca dan memahaminya paling lambat ${fmtDay(dueOn, 'id')}.`,
    },
  };
}

/** `acknowledgement_overdue` (digest): a request past its due date with people still to confirm. */
export function overdueNotice(doc: DocumentFacts, dueOn: string, pending: number): { title: Messages; body: Messages } {
  return {
    title: { en: `Read confirmation of ${doc.code} is overdue`, id: `Konfirmasi baca ${doc.code} terlambat` },
    body: {
      en: `${pending === 1 ? '1 person has' : `${pending} people have`} not confirmed ${doc.code} ${doc.title}, version ${doc.version}, which was due on ${fmtDay(dueOn, 'en')}. See ${REGISTER_SCREEN.en}.`,
      id: `${pending} orang belum mengonfirmasi ${doc.code} ${doc.title}, versi ${doc.version}, yang jatuh tempo pada ${fmtDay(dueOn, 'id')}. Lihat ${REGISTER_SCREEN.id}.`,
    },
  };
}

/** Why a person no longer needs to confirm (stored in `acknowledgement.excused_reason`, at most 200 characters). */
export const EXCUSED = {
  replaced: (version: string) => `Replaced by version ${version}`.slice(0, 200),
  membershipEnded: 'Membership of the organisation ended',
  roleEnded: 'No longer holds a role that is asked to confirm',
  restricted: 'The document is restricted to its owner, Management System Managers and Programme Owners',
} as const;

/** Refusals of the routes: message key and both texts. */
export const REFUSALS = {
  requestClosed: {
    key: 'acknowledgements.request_closed',
    en: 'This confirmation request is closed.',
    id: 'Permintaan konfirmasi ini sudah ditutup.',
  },
  remindedToday: {
    key: 'acknowledgements.reminded_today',
    en: 'The people of this request were reminded today already. You can remind them again tomorrow.',
    id: 'Orang-orang dalam permintaan ini sudah diingatkan hari ini. Anda dapat mengingatkan lagi besok.',
  },
  nothingPending: {
    key: 'acknowledgements.nothing_pending',
    en: 'Nobody in this request still has to confirm.',
    id: 'Tidak ada lagi orang dalam permintaan ini yang perlu mengonfirmasi.',
  },
  openRequest: {
    key: 'acknowledgements.open_request',
    en: 'This version already has an open confirmation request.',
    id: 'Versi ini sudah memiliki permintaan konfirmasi yang terbuka.',
  },
  notApproved: {
    key: 'acknowledgements.not_approved',
    en: 'Only an approved document with a current version can be confirmed. Approve a version first.',
    id: 'Hanya dokumen yang disetujui dengan versi berlaku yang dapat dikonfirmasi. Setujui sebuah versi terlebih dahulu.',
  },
  noAudience: {
    key: 'acknowledgements.no_audience',
    en: 'Nobody holds a role that is asked to confirm this document. Choose another audience.',
    id: 'Tidak ada yang memegang peran yang diminta mengonfirmasi dokumen ini. Pilih audiens lain.',
  },
  excused: {
    key: 'acknowledgements.excused',
    en: 'You no longer need to confirm this document.',
    id: 'Anda tidak perlu lagi mengonfirmasi dokumen ini.',
  },
  confirmed: {
    key: 'acknowledgements.confirmed',
    en: 'You have confirmed this document already.',
    id: 'Anda sudah mengonfirmasi dokumen ini.',
  },
  noFile: {
    key: 'acknowledgements.no_file',
    en: 'This version has no file to open. Ask the Management System Manager.',
    id: 'Versi ini tidak memiliki berkas untuk dibuka. Tanyakan kepada Management System Manager.',
  },
  restricted: {
    key: 'acknowledgements.restricted',
    en: 'This document is now restricted to its owner and to the Management System Managers and Programme Owners of its systems, so you are no longer asked to confirm it.',
    id: 'Dokumen ini kini dibatasi untuk pemiliknya serta Management System Manager dan Programme Owner sistemnya, sehingga Anda tidak lagi diminta mengonfirmasinya.',
  },
  noRole: {
    key: 'acknowledgements.no_role',
    en: 'You no longer hold a role in a management system of this document, so you are no longer asked to confirm it.',
    id: 'Anda tidak lagi memegang peran di sistem manajemen dokumen ini, sehingga Anda tidak lagi diminta mengonfirmasinya.',
  },
  fileNotReadable: {
    key: 'acknowledgements.file_not_readable',
    en: 'The file of this version can no longer be opened in MSCD, for example because the document was removed. Ask the Management System Manager for a copy.',
    id: 'Berkas versi ini tidak dapat dibuka lagi di MSCD, misalnya karena dokumennya telah dihapus. Minta salinannya kepada Management System Manager.',
  },
} as const;

/** The columns of the confirmation register CSV, in order. */
export const REGISTER_COLUMNS = [
  'Document', 'Title', 'Version', 'Due date', 'User name', 'Name', 'Status', 'Opened at', 'Confirmed at', 'Reminders', 'Overdue', 'Excused reason',
] as const;
