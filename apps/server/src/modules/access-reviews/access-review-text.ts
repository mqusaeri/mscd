// Texts of the periodic access review (Milestone 3 D.9, J.4, M3-07) in English and Indonesian: the notices
// `access_review_due` and `access_review_overdue`, the title of the stored task of a system part (C.3: it names the
// screen that completes it), the refusals the routes give besides the platform rules, the warning REVIEW-SINGLE-ADMIN,
// the refusal of "Complete" for a system nobody may review, and the columns of the report CSV.
import type { Messages, Pair } from '@mscd/shared';
import { fmtDay } from '../../common/dates';
import { ruleMessages } from '../rules';

export interface Notice {
  title: Pair;
  body: Pair;
}

/** `access_review_due` to the Tenant Admins when a review opens (the organisation part). */
export function openedNoticeForAdmins(reviewNo: string, dueOn: string): Notice {
  return {
    title: [`Access review ${reviewNo} is open`, `Tinjauan akses ${reviewNo} dibuka`],
    body: [
      `Check every membership, admin role and linked company sign-in of the organisation by ${fmtDay(dueOn)} in Access reviews, then apply the revocations the reviewers decide.`,
      `Periksa setiap keanggotaan, peran admin, dan masuk perusahaan tertaut milik organisasi paling lambat ${fmtDay(dueOn, 'id')} di Tinjauan akses, lalu terapkan pencabutan yang diputuskan peninjau.`,
    ],
  };
}

/** `access_review_due` to the reviewers of a system part when a review opens. */
export function openedNoticeForSystem(reviewNo: string, code: string, dueOn: string): Notice {
  return {
    title: [`Access review ${reviewNo}: review the access in ${code}`, `Tinjauan akses ${reviewNo}: tinjau akses di ${code}`],
    body: [
      `Check each business role and guest auditor access of ${code} by ${fmtDay(dueOn)} in Access review of this system, then sign it off.`,
      `Periksa setiap peran bisnis dan akses auditor tamu di ${code} paling lambat ${fmtDay(dueOn, 'id')} di Tinjauan akses sistem ini, lalu tanda tangani.`,
    ],
  };
}

/** `access_review_due` a few days before the due date, to the reviewers whose part is still open. */
export function dueSoonNotice(reviewNo: string, dueOn: string, code: string | null): Notice {
  const where: Pair = code ? [`the access in ${code}`, `akses di ${code}`] : ['the access of the organisation', 'akses organisasi'];
  return {
    title: [`Access review ${reviewNo} is due on ${fmtDay(dueOn)}`, `Tinjauan akses ${reviewNo} jatuh tempo pada ${fmtDay(dueOn, 'id')}`],
    body: [
      `Finish reviewing ${where[0]}: decide every item and sign off or complete the review.`,
      `Selesaikan peninjauan ${where[1]}: putuskan setiap item dan tanda tangani atau selesaikan tinjauan.`,
    ],
  };
}

/** `access_review_overdue`, every 7 days after the due date while the review is open. */
export function overdueNotice(reviewNo: string, dueOn: string, code: string | null): Notice {
  const where: Pair = code ? [`the access in ${code}`, `akses di ${code}`] : ['the access of the organisation', 'akses organisasi'];
  return {
    title: [`Access review ${reviewNo} is overdue`, `Tinjauan akses ${reviewNo} terlambat`],
    body: [
      `It was due on ${fmtDay(dueOn)}. Finish reviewing ${where[0]} so the review can be completed and filed as evidence.`,
      `Tinjauan ini jatuh tempo pada ${fmtDay(dueOn, 'id')}. Selesaikan peninjauan ${where[1]} agar tinjauan dapat diselesaikan dan diarsipkan sebagai bukti.`,
    ],
  };
}

/** Title of the stored task of a system part (source `access_review`, entity `access_review_part`). */
export function taskTitle(reviewNo: string, code: string): { en: string; id: string } {
  return {
    en: `Review the access in ${code} on Access review of this system (${reviewNo})`,
    id: `Tinjau akses di ${code} pada Tinjauan akses sistem ini (${reviewNo})`,
  };
}

/**
 * The warning of a review (or a part) with items nobody else could decide (D.9, J.6): the rule's text for the single
 * Tenant Admin, a sentence per system whose only reviewer holds such an item, and the people concerned.
 */
export function singleReviewerWarning(input: { organisation: boolean; systems: readonly string[]; names: readonly string[] }): { rule: 'REVIEW-SINGLE-ADMIN'; messages: Messages } {
  const en: string[] = [];
  const id: string[] = [];
  if (input.organisation) {
    const base = ruleMessages('REVIEW-SINGLE-ADMIN');
    en.push(base.en);
    id.push(base.id);
  }
  for (const code of input.systems) {
    en.push(`In ${code} only one person holds the right to review access, so nobody else reviewed their own access there. Add a second Management System Manager or a Programme Owner for the next review.`);
    id.push(`Di ${code} hanya satu orang yang memegang hak untuk meninjau akses, sehingga tidak ada orang lain yang meninjau akses miliknya di sana. Tambahkan Management System Manager kedua atau Pemilik Program untuk tinjauan berikutnya.`);
  }
  if (input.names.length) {
    en.push(`Not reviewed by a second person: ${input.names.join(', ')}.`);
    id.push(`Tidak ditinjau oleh orang kedua: ${input.names.join(', ')}.`);
  }
  return { rule: 'REVIEW-SINGLE-ADMIN', messages: { en: en.join(' '), id: id.join(' ') } };
}

/**
 * The part of a review in the refusal of "Complete" for a system that nobody may review now (no active Management
 * System Manager or Programme Owner): the Tenant Admin assigns one, or cancels the review.
 */
export function noReviewerText(code: string): Messages {
  return {
    en: `${code} has no Management System Manager or Programme Owner to review it; assign one on People and roles, or cancel the review`,
    id: `${code} tidak memiliki Management System Manager atau Pemilik Program untuk meninjaunya; tetapkan salah satunya di Orang dan peran, atau batalkan tinjauan`,
  };
}

/** Refusals on the `conflict` slug (409) with their texts. */
export const REFUSALS = {
  openExists: {
    en: 'An access review is already open. Complete or cancel it before you start another one.',
    id: 'Tinjauan akses sudah dibuka. Selesaikan atau batalkan sebelum memulai yang lain.',
  },
  notOpen: { en: 'The access review is no longer open.', id: 'Tinjauan akses ini tidak lagi terbuka.' },
  partSignedOff: {
    en: 'This part of the review is signed off; its decisions can no longer change.',
    id: 'Bagian tinjauan ini sudah ditandatangani; keputusannya tidak dapat diubah lagi.',
  },
  applied: {
    en: 'The decision on this item has been applied or explained already; it can no longer change.',
    id: 'Keputusan atas item ini sudah diterapkan atau dijelaskan; keputusan tidak dapat diubah lagi.',
  },
  undecided: {
    en: 'Every item must be decided before this part is signed off.',
    id: 'Setiap item harus diputuskan sebelum bagian ini ditandatangani.',
  },
  notRevoke: { en: 'Only an item decided "revoke" is applied this way.', id: 'Hanya item dengan keputusan "cabut" yang diterapkan dengan cara ini.' },
  nothingToApply: {
    en: 'This item was decided "keep"; there is nothing to apply.',
    id: 'Item ini diputuskan "pertahankan"; tidak ada yang perlu diterapkan.',
  },
  notDecided: { en: 'Decide on the item first.', id: 'Putuskan item ini terlebih dahulu.' },
  guestOnSystem: {
    en: 'A guest auditor grant is revoked by a Management System Manager of the system on Access review of this system.',
    id: 'Akses auditor tamu dicabut oleh Management System Manager sistem tersebut di Tinjauan akses sistem ini.',
  },
  onlyGuest: {
    en: 'Only guest auditor grants are applied on this page; the Tenant Admins apply the other revocations on Access reviews.',
    id: 'Hanya akses auditor tamu yang diterapkan di halaman ini; Tenant Admin menerapkan pencabutan lainnya di Tinjauan akses.',
  },
  invitedMembership: {
    en: 'An invited membership cannot be disabled before the person accepts. Record that it is not applied, or mark it as applied once the invitation has lapsed.',
    id: 'Keanggotaan yang diundang tidak dapat dinonaktifkan sebelum orang tersebut menerima. Catat bahwa keputusan tidak diterapkan, atau tandai sudah diterapkan setelah undangan kedaluwarsa.',
  },
} as const satisfies Record<string, Messages>;

/** The answer of an applied decision, by the action recorded on the item. */
export const APPLIED_MESSAGES: Readonly<Record<string, Pair>> = {
  'role.revoked': ['Role revoked', 'Peran dicabut'],
  'membership.admin_role_removed': ['Admin role removed', 'Peran admin dihapus'],
  'membership.disabled': ['Membership disabled; the person was signed out of this organisation', 'Keanggotaan dinonaktifkan; orang tersebut telah dikeluarkan dari organisasi ini'],
  'identity.unlinked': ['Linked sign-in removed', 'Masuk tertaut dihapus'],
  'auditor_access.revoked': ['Guest access revoked; the auditor was signed out', 'Akses tamu dicabut; auditor telah dikeluarkan'],
  already_removed: ['The access was removed already; recorded as applied', 'Akses sudah dihapus; dicatat sebagai diterapkan'],
  marked_applied: ['Marked as applied', 'Ditandai sudah diterapkan'],
  not_applied: ['Recorded as not applied', 'Dicatat sebagai tidak diterapkan'],
};

/** The columns of the report CSV (formula-neutralised, F.15). */
export const REPORT_COLUMNS = [
  'review_no', 'opened_on', 'due_on', 'system', 'item_kind', 'person', 'handle', 'role', 'pending_approval', 'granted_by', 'requested_by', 'approved_by',
  'granted_at', 'valid_until',
  'last_sign_in_at', 'decision', 'decision_note', 'decided_by', 'decided_at', 'needs_second_reviewer', 'applied_action', 'applied_note', 'applied_by',
  'applied_at', 'not_applied_reason',
] as const;
