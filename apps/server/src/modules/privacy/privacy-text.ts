// Texts of requests from one person (Milestone 3 D.6, J.4) in English and Indonesian: the stored task of a system check,
// the notifications `privacy_request_received`, `privacy_request_due` and `privacy_check_requested`, the refusals of the
// routes and the reason stored on a confirmation that an erasure excuses. Plain English (writing rules of CLAUDE.md);
// the screen names are the labels of C.2 ("Personal data requests", "Personal data checks").
import type { Messages, PrivacyRequestType } from '@mscd/shared';
import { fmtDayTime } from '../../common/dates';

/** The screen of the Tenant Admins (C.2 `privacy-requests`). */
export const REQUESTS_SCREEN: Messages = { en: 'Personal data requests', id: 'Permintaan data pribadi' };

/** The screen of the Management System Managers (C.2 `privacy-checks`). */
export const CHECKS_SCREEN: Messages = { en: 'Personal data checks', id: 'Pemeriksaan data pribadi' };

/** The request types as the texts name them. */
export const TYPE_NAMES: Readonly<Record<PrivacyRequestType, Messages>> = {
  access: { en: 'copy of personal data', id: 'salinan data pribadi' },
  rectification: { en: 'correction of personal data', id: 'koreksi data pribadi' },
  restriction: { en: 'restriction of processing', id: 'pembatasan pemrosesan' },
  erasure: { en: 'erasure of personal data', id: 'penghapusan data pribadi' },
};

/** The title of a manager's stored task (C.3: it names the screen that completes it). */
export function checkTaskTitle(requestNo: string, type: PrivacyRequestType): Messages {
  return {
    en: `Check this system for ${requestNo} (${TYPE_NAMES[type].en}) in ${CHECKS_SCREEN.en}`,
    id: `Periksa sistem ini untuk ${requestNo} (${TYPE_NAMES[type].id}) di ${CHECKS_SCREEN.id}`,
  };
}

/** `privacy_check_requested`: a system check for a new access or erasure request. */
export function checkRequestedNotice(requestNo: string, type: PrivacyRequestType, dueAt: Date, timeZone: string): { title: Messages; body: Messages } {
  return {
    title: { en: `Check your system for request ${requestNo}`, id: `Periksa sistem Anda untuk permintaan ${requestNo}` },
    body: {
      en: `A person asked for a ${TYPE_NAMES[type].en}. Open ${CHECKS_SCREEN.en}, look at the records that name the person, edit what must change, hand over their open items and mark the check done. The answer is due by ${fmtDayTime(dueAt, timeZone, 'en')}.`,
      id: `Seseorang meminta ${TYPE_NAMES[type].id}. Buka ${CHECKS_SCREEN.id}, lihat rekaman yang menyebut orang tersebut, ubah yang perlu diubah, serahkan item terbukanya, lalu tandai pemeriksaan selesai. Jawaban jatuh tempo paling lambat ${fmtDayTime(dueAt, timeZone, 'id')}.`,
    },
  };
}

/** `privacy_request_received`: a member asked from "My account". */
export function receivedNotice(requestNo: string, type: PrivacyRequestType, dueAt: Date, timeZone: string): { title: Messages; body: Messages } {
  return {
    title: { en: `New personal data request ${requestNo}`, id: `Permintaan data pribadi baru ${requestNo}` },
    body: {
      en: `A member asked for a ${TYPE_NAMES[type].en} from My account. Check who is asking, then answer it in ${REQUESTS_SCREEN.en} by ${fmtDayTime(dueAt, timeZone, 'en')}.`,
      id: `Seorang anggota meminta ${TYPE_NAMES[type].id} dari Akun saya. Periksa siapa yang meminta, lalu jawab di ${REQUESTS_SCREEN.id} paling lambat ${fmtDayTime(dueAt, timeZone, 'id')}.`,
    },
  };
}

/** `privacy_request_due`: a request due within 24 hours, or past its due time. */
export function dueNotice(requestNo: string, type: PrivacyRequestType, dueAt: Date, timeZone: string, overdue: boolean): { title: Messages; body: Messages } {
  return overdue
    ? {
      title: { en: `Personal data request ${requestNo} is overdue`, id: `Permintaan data pribadi ${requestNo} terlambat` },
      body: {
        en: `The ${TYPE_NAMES[type].en} ${requestNo} was due at ${fmtDayTime(dueAt, timeZone, 'en')}. Answer the person as soon as possible in ${REQUESTS_SCREEN.en}.`,
        id: `${TYPE_NAMES[type].id} ${requestNo} jatuh tempo pada ${fmtDayTime(dueAt, timeZone, 'id')}. Jawab orang tersebut secepatnya di ${REQUESTS_SCREEN.id}.`,
      },
    }
    : {
      title: { en: `Personal data request ${requestNo} is due soon`, id: `Permintaan data pribadi ${requestNo} segera jatuh tempo` },
      body: {
        en: `The ${TYPE_NAMES[type].en} ${requestNo} is due at ${fmtDayTime(dueAt, timeZone, 'en')}. Answer it in ${REQUESTS_SCREEN.en}.`,
        id: `${TYPE_NAMES[type].id} ${requestNo} jatuh tempo pada ${fmtDayTime(dueAt, timeZone, 'id')}. Jawab di ${REQUESTS_SCREEN.id}.`,
      },
    };
}

/** Why a pending confirmation no longer needs the person (at most 200 characters, `acknowledgement.excused_reason`). */
export const EXCUSED_BY_ERASURE = 'The person was erased at their request';

/** Refusals of the routes: message key and both texts. */
export const REFUSALS = {
  notMember: {
    key: 'privacy.not_member',
    en: 'The person is not a member of this organisation. Record a former member or a person without an account by name and email.',
    id: 'Orang tersebut bukan anggota organisasi ini. Catat mantan anggota atau orang tanpa akun dengan nama dan email.',
  },
  receivedLater: {
    key: 'privacy.received_in_future',
    en: 'The request cannot be received in the future.',
    id: 'Permintaan tidak dapat diterima di masa depan.',
  },
  startFirst: {
    key: 'privacy.start_first',
    en: 'Start work on the request first: record how you checked who is asking.',
    id: 'Mulai tangani permintaan terlebih dahulu: catat cara Anda memeriksa siapa yang meminta.',
  },
  closed: {
    key: 'privacy.request_closed',
    en: 'The request is closed. Record a new request if the person asks again.',
    id: 'Permintaan sudah ditutup. Catat permintaan baru jika orang tersebut meminta lagi.',
  },
  wrongType: {
    key: 'privacy.wrong_type',
    en: 'This action does not answer a request of this type.',
    id: 'Tindakan ini tidak menjawab permintaan dengan jenis ini.',
  },
  noAccount: {
    key: 'privacy.no_account',
    en: 'The person has no account in this organisation, so there is no account data to change. Edit the records that name the person instead.',
    id: 'Orang tersebut tidak memiliki akun di organisasi ini, jadi tidak ada data akun yang dapat diubah. Ubah rekaman yang menyebut orang tersebut.',
  },
  sharedAccount: {
    key: 'shared_account',
    en: 'The person also uses this account in another organisation, so only the person can correct the name and job title, in My account.',
    id: 'Orang tersebut juga memakai akun ini di organisasi lain, jadi hanya orang tersebut yang dapat mengoreksi nama dan jabatan, di Akun saya.',
  },
  lastTenantAdmin: {
    key: 'last_tenant_admin',
    en: 'The person is the last active Tenant Admin. Give another member the Tenant Admin role first.',
    id: 'Orang tersebut adalah Tenant Admin aktif terakhir. Berikan peran Tenant Admin kepada anggota lain terlebih dahulu.',
  },
  ownMembership: {
    key: 'privacy.own_membership',
    en: 'You cannot restrict or erase your own membership. Ask another Tenant Admin to answer this request.',
    id: 'Anda tidak dapat membatasi atau menghapus keanggotaan Anda sendiri. Minta Tenant Admin lain menjawab permintaan ini.',
  },
  alreadyRestricted: {
    key: 'privacy.already_restricted',
    en: 'The membership of the person is already disabled.',
    id: 'Keanggotaan orang tersebut sudah dinonaktifkan.',
  },
  alreadyErased: {
    key: 'privacy.already_erased',
    en: 'The person is already erased in this organisation.',
    id: 'Orang tersebut sudah dihapus di organisasi ini.',
  },
  checksOpen: {
    key: 'privacy.checks_open',
    en: 'Every system check must be done first. The Management System Managers mark them done in Personal data checks.',
    id: 'Setiap pemeriksaan sistem harus selesai terlebih dahulu. Manajer Sistem Manajemen menandainya selesai di Pemeriksaan data pribadi.',
  },
  actionFirst: {
    key: 'privacy.action_first',
    en: 'Take the action this request asks for before you close it.',
    id: 'Lakukan tindakan yang diminta permintaan ini sebelum menutupnya.',
  },
  checkClosed: {
    key: 'privacy.check_closed',
    en: 'The request of this check is closed, so the check cannot change any more.',
    id: 'Permintaan untuk pemeriksaan ini sudah ditutup, jadi pemeriksaan tidak dapat diubah lagi.',
  },
  checkDone: {
    key: 'privacy.check_done',
    en: 'This check is already done.',
    id: 'Pemeriksaan ini sudah selesai.',
  },
  noOrganisation: {
    key: 'privacy.no_organisation',
    en: 'Choose an organisation first.',
    id: 'Pilih organisasi terlebih dahulu.',
  },
  notMemberSelf: {
    key: 'privacy.not_member_self',
    en: 'Only a member of this organisation can ask it about their own data.',
    id: 'Hanya anggota organisasi ini yang dapat meminta tentang data dirinya sendiri.',
  },
  openRequest: {
    key: 'privacy.open_request',
    en: 'You already have an open request of this type. The organisation answers it first.',
    id: 'Anda sudah memiliki permintaan terbuka dengan jenis ini. Organisasi akan menjawabnya terlebih dahulu.',
  },
} as const;

export type Refusal = (typeof REFUSALS)[keyof typeof REFUSALS];
