// Texts of the document control forms (MILESTONE-2 M2-12): every label in English and Indonesian (D2-01). Plain
// English, no em dash and no centre dot (R-08). `{name}` placeholders are filled with `ctx.fill`.
type Pair = readonly [string, string];

export const TEXT = {
  // Detail extension of a document
  panelTitle: ['Document control', 'Pengendalian dokumen'],
  tabActions: ['Actions', 'Tindakan'],
  tabVersions: ['Versions', 'Versi'],
  tabsLabel: ['Document control', 'Pengendalian dokumen'],
  external: ['External document', 'Dokumen eksternal'],
  currentSummary: ['Change summary of the version in force', 'Ringkasan perubahan versi yang berlaku'],
  hintDraftEmpty: ['This draft has no file yet. Attach the first version to send it for review.', 'Draf ini belum memiliki berkas. Lampirkan versi pertama untuk mengirimnya ke review.'],
  hintDraft: ['This document is a draft. Upload a new version to send it for review.', 'Dokumen ini masih draf. Unggah versi baru untuk mengirimnya ke review.'],
  hintReview: ['A version is in review. Open the review to approve it or return it to draft.', 'Ada versi dalam review. Buka review untuk menyetujuinya atau mengembalikannya ke draf.'],
  hintExpired: ['The review date has passed. Start a review or upload a new version.', 'Tanggal review sudah lewat. Mulai review atau unggah versi baru.'],
  hintApproved: ['Approved and in force. A new version goes to review before it replaces this one.', 'Disetujui dan berlaku. Versi baru melewati review sebelum menggantikan versi ini.'],
  readOnly: ['You can read this document. Changes are made by the MS Manager of this system.', 'Anda dapat membaca dokumen ini. Perubahan dilakukan oleh MS Manager sistem ini.'],
  edit: ['Edit', 'Ubah'],
  changeOwner: ['Change owner or approver', 'Ganti pemilik atau penyetuju'],
  reassign: ['Reassign', 'Alihkan'],
  attachFirst: ['Attach first version', 'Lampirkan versi pertama'],
  uploadNew: ['Upload new version', 'Unggah versi baru'],
  uploadWithSummary: ['Upload with change summary', 'Unggah dengan ringkasan perubahan'],

  // Versions
  versionsLoading: ['Loading versions', 'Memuat versi'],
  versionsFailed: ['The versions could not be loaded.', 'Versi tidak dapat dimuat.'],
  noVersions: ['No version yet', 'Belum ada versi'],
  noVersionsText: ['The first version appears here once a file is attached.', 'Versi pertama muncul di sini setelah berkas dilampirkan.'],
  submittedBy: ['Submitted by {name}, {date}', 'Diajukan oleh {name}, {date}'],
  submittedOn: ['Submitted {date}', 'Diajukan {date}'],
  approvedBy: ['Approved by {name}, {date}', 'Disetujui oleh {name}, {date}'],
  approvedOn: ['Approved {date}', 'Disetujui {date}'],
  changeSummary: ['Change summary', 'Ringkasan perubahan'],
  rejectionNote: ['Returned to draft', 'Dikembalikan ke draf'],
  openFile: ['Open file', 'Buka berkas'],
  vDraft: ['Draft', 'Draf'],
  vInReview: ['In review', 'Dalam review'],
  vApproved: ['Approved', 'Disetujui'],
  vRejected: ['Returned', 'Dikembalikan'],
  vSuperseded: ['Superseded', 'Digantikan'],
  tryAgain: ['Try again', 'Coba lagi'],

  // New document
  newTitle: ['New document', 'Dokumen baru'],
  newCrumb: ['Document register, {system}', 'Register dokumen, {system}'],
  template: ['Start from a template', 'Mulai dari templat'],
  templateNone: ['No template', 'Tanpa templat'],
  templateHint: [
    'Fills in the code and type of a document the framework pack expects, and its title when the pack names one.',
    'Mengisi kode dan jenis dokumen yang diharapkan framework pack, serta judulnya bila pack menyebutkannya.',
  ],
  templateOutput: ['{code}, output of activity {no} {title}', '{code}, keluaran aktivitas {no} {title}'],
  templatesLoading: ['Loading the templates of this system', 'Memuat templat sistem ini'],
  code: ['Document code', 'Kode dokumen'],
  codeHint: ['Your own code, for example ISP-001, or the code of the pack template.', 'Kode Anda sendiri, misalnya ISP-001, atau kode templat pack.'],
  title: ['Title', 'Judul'],
  docType: ['Document type', 'Jenis dokumen'],
  owner: ['Owner', 'Pemilik'],
  ownerHint: ['Writes the document and submits its versions.', 'Menulis dokumen dan mengajukan versinya.'],
  approver: ['Approver', 'Penyetuju'],
  approverHint: ['Approves the versions. Leave empty to let any MS Manager or Programme Owner approve.', 'Menyetujui versi. Kosongkan agar MS Manager atau Programme Owner mana pun dapat menyetujui.'],
  classification: ['Classification', 'Klasifikasi'],
  classificationKeep: ['Keep the current classification', 'Pertahankan klasifikasi saat ini'],
  nextReview: ['Next review date', 'Tanggal review berikutnya'],
  nextReviewHint: ['Approval sets it a year ahead when it is empty or past.', 'Persetujuan mengaturnya setahun ke depan bila kosong atau sudah lewat.'],
  orgWide: ['Organisation-wide document', 'Dokumen untuk seluruh organisasi'],
  orgWideHint: ['Counts in every management system of the organisation.', 'Dihitung di setiap sistem manajemen organisasi.'],
  linkedSystems: ['Linked management systems', 'Sistem manajemen tertaut'],
  linkedHint: ['Linking more than one system needs the Integrated Management System feature of the licence.', 'Menautkan lebih dari satu sistem memerlukan fitur Sistem Manajemen Terintegrasi pada lisensi.'],
  thisSystem: ['{system} (this system)', '{system} (sistem ini)'],
  origin: ['Origin', 'Asal'],
  originInternal: ['Written by the organisation', 'Ditulis oleh organisasi'],
  originExternal: ['External, issued by someone else', 'Eksternal, diterbitkan pihak lain'],
  externalSource: ['Issued by', 'Diterbitkan oleh'],
  externalSourceHint: ['A standards body, regulator, customer or supplier.', 'Badan standar, regulator, pelanggan atau pemasok.'],
  externalRef: ['Issuer reference', 'Referensi penerbit'],
  externalRefHint: ['Their number, edition or version.', 'Nomor, edisi atau versi dari mereka.'],
  receivedAt: ['Date received', 'Tanggal diterima'],
  register: ['Register document', 'Daftarkan dokumen'],
  registered: ['{code} registered as a draft', '{code} didaftarkan sebagai draf'],
  registeredNext: ['{code} registered as a draft. Attach its first version from the document.', '{code} didaftarkan sebagai draf. Lampirkan versi pertamanya dari dokumen.'],

  // Validation
  required: ['Required', 'Wajib diisi'],
  codeFormat: ['Use 1 to 30 characters without a space at the start or end.', 'Gunakan 1 sampai 30 karakter tanpa spasi di awal atau akhir.'],
  titleLong: ['Use at most 255 characters.', 'Gunakan paling banyak 255 karakter.'],
  sourceRequired: ['Name who issued the external document.', 'Sebutkan siapa yang menerbitkan dokumen eksternal.'],
  summaryLong: ['Use at most 500 characters.', 'Gunakan paling banyak 500 karakter.'],
  noteRequired: ['Write what the author must change.', 'Tulis apa yang harus diubah penulis.'],
  nothingChanged: ['Nothing to change', 'Tidak ada yang diubah'],

  // Edit
  editTitle: ['Edit {code}', 'Ubah {code}'],
  saved: ['{code} saved', '{code} disimpan'],
  externalKeep: ['Leave a field empty to keep its current value.', 'Kosongkan kolom untuk mempertahankan nilainya saat ini.'],
  confirmShared: ['Change a shared document', 'Ubah dokumen bersama'],
  confirmApply: ['Apply to every system', 'Terapkan ke setiap sistem'],

  // Owner and approver
  ownerTitle: ['Owner and approver of {code}', 'Pemilik dan penyetuju {code}'],
  br16Same: [
    'The owner is also the approver. A document cannot be approved by its own author, so the versions this person submits need another approver.',
    'Pemilik juga menjadi penyetuju. Dokumen tidak dapat disetujui oleh penulisnya sendiri, sehingga versi yang diajukan orang ini memerlukan penyetuju lain.',
  ],
  br16Submitter: [
    '{name} submitted the version in review and cannot approve it. A document cannot be approved by its own author.',
    '{name} mengajukan versi yang sedang direview dan tidak dapat menyetujuinya. Dokumen tidak dapat disetujui oleh penulisnya sendiri.',
  ],

  // Reassign
  reassignTitle: ['Reassign the review of {code}', 'Alihkan review {code}'],
  reassignSub: ['The person who must act on the version in review.', 'Orang yang harus menindaklanjuti versi yang sedang direview.'],
  holder: ['Assigned to', 'Ditugaskan kepada'],
  due: ['Due date', 'Jatuh tempo'],
  dueHint: ['Optional. A date after the next audit gives a warning.', 'Opsional. Tanggal setelah audit berikutnya memberi peringatan.'],
  br17: ['A document in review needs a person who acts on it. Choose someone.', 'Dokumen dalam review memerlukan orang yang menindaklanjutinya. Pilih seseorang.'],
  reassigned: ['Review of {code} assigned to {name}', 'Review {code} ditugaskan kepada {name}'],

  // Upload
  uploadTitle: ['New version of {code}', 'Versi baru {code}'],
  firstTitle: ['First version of {code}', 'Versi pertama {code}'],
  file: ['File', 'Berkas'],
  summaryHint: ['What changed, in a sentence or two. Reviewers see it next to the version. Up to 500 characters.', 'Apa yang berubah, dalam satu atau dua kalimat. Reviewer melihatnya di samping versi. Maksimal 500 karakter.'],
  submitReview: ['Submit for review', 'Ajukan untuk review'],
  submitted: ['{code} submitted for review', '{code} diajukan untuk review'],
  uploadNote: ['The version goes to review. Another person approves it before it replaces the version in force.', 'Versi masuk ke review. Orang lain menyetujuinya sebelum menggantikan versi yang berlaku.'],
  noRecordId: ['This document is not loaded yet. Reload the page and try again.', 'Dokumen ini belum dimuat. Muat ulang halaman lalu coba lagi.'],

  // Review panel
  reviewTitle: ['Review of {code}', 'Review {code}'],
  draftTitle: ['Draft of {code}', 'Draf {code}'],
  inReviewVersion: ['Version in review', 'Versi dalam review'],
  submittedByL: ['Submitted by', 'Diajukan oleh'],
  submittedAtL: ['Submitted', 'Diajukan'],
  noNewFile: ['No new file in this review. Approving confirms the version in force for another review period.', 'Tidak ada berkas baru dalam review ini. Persetujuan mengonfirmasi versi yang berlaku untuk periode review berikutnya.'],
  approve: ['Approve', 'Setujui'],
  returnDraft: ['Return to draft', 'Kembalikan ke draf'],
  returnNote: ['Note for the author', 'Catatan untuk penulis'],
  returnNoteHint: ['Required. The author sees it with the returned version.', 'Wajib. Penulis melihatnya bersama versi yang dikembalikan.'],
  back: ['Back', 'Kembali'],
  youSubmitted: ['You submitted this version', 'Anda mengajukan versi ini'],
  noApproveRight: ['Only an MS Manager or a Programme Owner approves documents', 'Hanya MS Manager atau Programme Owner yang menyetujui dokumen'],
  notInReview: ['This document is no longer in review.', 'Dokumen ini tidak lagi dalam review.'],
  approved: ['{code} approved', '{code} disetujui'],
  approvedVersion: ['{code} v{label} approved', '{code} v{label} disetujui'],
  returned: ['{code} returned to draft', '{code} dikembalikan ke draf'],
  returnedOn: ['Version {label}, submitted on {date}, was returned to draft.', 'Versi {label}, diajukan pada {date}, dikembalikan ke draf.'],
  draftNoFile: ['No file yet. Attach the first version to send the document for review.', 'Belum ada berkas. Lampirkan versi pertama untuk mengirim dokumen ke review.'],
  draftWithFile: ['Upload a new version to send the document for review again.', 'Unggah versi baru untuk mengirim dokumen ke review lagi.'],
  noVersionRight: ['Only the owner or the MS Manager submits versions of this document.', 'Hanya pemilik atau MS Manager yang mengajukan versi dokumen ini.'],
  gone: ['This document is no longer in the register of this system.', 'Dokumen ini tidak lagi ada di register sistem ini.'],
} as const satisfies Record<string, Pair>;

/** Document types of the `doc_type` lookup, the same in every framework pack (packs/sources/<pack>/lookups.csv). */
export const DOC_TYPES: readonly { value: string; label: Pair }[] = [
  { value: 'policy', label: ['Policy', 'Kebijakan'] },
  { value: 'standard', label: ['Standard', 'Standar'] },
  { value: 'procedure', label: ['Procedure', 'Prosedur'] },
  { value: 'plan', label: ['Plan', 'Rencana'] },
  { value: 'register', label: ['Register', 'Register'] },
  { value: 'record', label: ['Record', 'Rekaman'] },
  { value: 'form', label: ['Form', 'Formulir'] },
];

/** Information classifications of a document (D-34). */
export const CLASSIFICATIONS: readonly { value: string; label: Pair }[] = [
  { value: 'public', label: ['Public', 'Publik'] },
  { value: 'internal', label: ['Internal', 'Internal'] },
  { value: 'confidential', label: ['Confidential', 'Rahasia'] },
  { value: 'restricted', label: ['Restricted', 'Terbatas'] },
];
