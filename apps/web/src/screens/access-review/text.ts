// Texts of Access review of this system (MILESTONE-3 M3-07, D.9), as [English, Indonesian] pairs; the item table, the
// decision forms and the states come from ../access-reviews/text.ts.
export const TEXT = {
  title: ['Access review of this system', 'Tinjauan akses sistem ini'],
  teraWhat: [
    'This system\'s part of the periodic access review: every business role and guest auditor grant in force when the review opened. ISO/IEC 27001 control A.5.18 (access rights) asks that access rights are reviewed at regular intervals.',
    'Bagian sistem ini dalam tinjauan akses berkala: setiap peran bisnis dan akses auditor tamu yang berlaku saat tinjauan dibuka. Kontrol ISO/IEC 27001 A.5.18 (hak akses) meminta hak akses ditinjau secara berkala.',
  ],
  teraHow1: [
    'Decide keep, change or revoke for each item, one at a time or for a selection. Your own access is decided by another reviewer.',
    'Putuskan pertahankan, ubah, atau cabut untuk setiap item, satu per satu atau untuk pilihan. Akses Anda sendiri diputuskan oleh peninjau lain.',
  ],
  teraHow2: [
    'Revoke a guest auditor grant decided "revoke" here; the Tenant Admins apply the revocations of business roles.',
    'Cabut akses auditor tamu yang diputuskan "cabut" di sini; Tenant Admin menerapkan pencabutan peran bisnis.',
  ],
  teraHow3: [
    'Sign off when every item is decided and name the evidence item for the system\'s rows; for ISO/IEC 27001 the item of control A.5.18 is proposed.',
    'Tandatangani setelah setiap item diputuskan dan pilih item bukti untuk baris sistem; untuk ISO/IEC 27001 item kontrol A.5.18 diusulkan.',
  ],
  noRight: ['Only the Management System Managers and Programme Owners of this system review its access.', 'Hanya Management System Manager dan Pemilik Program sistem ini yang meninjau aksesnya.'],
  noneTitle: ['Access review of {ms}', 'Tinjauan akses {ms}'],
  noneYet: ['No access review of this system yet', 'Belum ada tinjauan akses untuk sistem ini'],
  noneYetText: [
    'When the next review opens, the business roles and guest auditor grants of this system appear here for you to decide.',
    'Saat tinjauan berikutnya dibuka, peran bisnis dan akses auditor tamu sistem ini muncul di sini untuk Anda putuskan.',
  ],
  chooseReview: ['Review', 'Tinjauan'],
  partTitle: ['{ms} in access review {no}', '{ms} dalam tinjauan akses {no}'],
  partSub: ['Decide on every item, then sign off this system\'s part.', 'Putuskan setiap item, lalu tandatangani bagian sistem ini.'],
  reviewStatus: ['Review', 'Tinjauan'],
  itemsTitle: ['Business roles and guest auditors', 'Peran bisnis dan auditor tamu'],
  itemsSub: ['Every right of this system when the review opened.', 'Setiap hak di sistem ini saat tinjauan dibuka.'],
  secondHere: [
    '{n} item(s) concern the only reviewer of this system, so nobody else can decide them. The part can still be signed off; add a second Management System Manager or a Programme Owner for the next review.',
    '{n} item menyangkut satu-satunya peninjau sistem ini, sehingga tidak ada orang lain yang dapat memutuskannya. Bagian ini tetap dapat ditandatangani; tambahkan Management System Manager kedua atau Pemilik Program untuk tinjauan berikutnya.',
  ],
  revokeGuest: ['Revoke guest access', 'Cabut akses tamu'],
  guestRevoked: ['Guest access revoked; the auditor was signed out', 'Akses tamu dicabut; auditor telah dikeluarkan'],
  signOff: ['Sign off', 'Tandatangani'],
  signedOff: ['Signed off', 'Ditandatangani'],
  signOffTitle: ['Sign off {ms} in access review {no}', 'Tandatangani {ms} dalam tinjauan akses {no}'],
  signOffSub: [
    'Your decisions on this system become final. When the review completes, the system\'s rows are filed as a new file of the evidence item you name.',
    'Keputusan Anda atas sistem ini menjadi final. Saat tinjauan selesai, baris sistem diarsipkan sebagai berkas baru dari item bukti yang Anda pilih.',
  ],
  signOffSecond: ['{n} item(s) stay without a decision because only their own person could decide them.', '{n} item tetap tanpa keputusan karena hanya orangnya sendiri yang dapat memutuskannya.'],
  fEvidence: ['Evidence item for the system\'s rows', 'Item bukti untuk baris sistem'],
  fEvidenceProposed: ['{code} covers control A.5.18 (access rights) and is proposed.', '{code} mencakup kontrol A.5.18 (hak akses) dan diusulkan.'],
  fEvidenceHint: ['Optional. Without one, nothing is filed for this system.', 'Opsional. Tanpa item bukti, tidak ada yang diarsipkan untuk sistem ini.'],
  noEvidenceItems: ['This system has no evidence item yet; the review report stays available on Access reviews.', 'Sistem ini belum memiliki item bukti; laporan tinjauan tetap tersedia di Tinjauan akses.'],
  noEvidenceChosen: ['No evidence item chosen: the rows of this system are not filed.', 'Tidak ada item bukti yang dipilih: baris sistem ini tidak diarsipkan.'],
  evidenceChosen: ['The rows are filed to {code} when the review completes.', 'Baris diarsipkan ke {code} saat tinjauan selesai.'],
  chooseNone: ['Choose none', 'Tidak memilih'],
} as const satisfies Record<string, readonly [string, string]>;
