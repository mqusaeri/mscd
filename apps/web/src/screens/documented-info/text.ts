// Texts of Required documented information (MILESTONE-2 M2-12): every label in English and Indonesian (D2-01), plain
// English without em dash or centre dot (R-08). `{name}` placeholders are filled with `ctx.fill`.
type Pair = readonly [string, string];

export const TEXT = {
  title: ['Required documented information', 'Informasi terdokumentasi wajib'],
  teraWhat: [
    'Lists the documents to maintain and the records to retain that the standard asks for, clause by clause, with the document or evidence of this system that covers each one.',
    'Mencantumkan dokumen yang harus dipelihara dan rekaman yang harus disimpan sesuai standar, per klausul, beserta dokumen atau bukti sistem ini yang memenuhinya.',
  ],
  teraHow1: ['Turn on Missing only to see what is not in place yet; the sidebar counts those items.', 'Aktifkan Hanya yang belum ada untuk melihat yang belum tersedia; sidebar menghitung item tersebut.'],
  teraHow2: [
    'Register from template creates the document with the code, title and type the framework pack expects.',
    'Daftarkan dari templat membuat dokumen dengan kode, judul dan jenis yang diharapkan framework pack.',
  ],
  teraHow3: [
    'Link existing document maps the pack code to your own document (for example ISP-001), so the activities that expect the pack code use it.',
    'Tautkan dokumen yang ada memetakan kode pack ke dokumen Anda sendiri (misalnya ISP-001), sehingga aktivitas yang mengharapkan kode pack memakainya.',
  ],

  // Scope (H.9)
  scope: ['Scope', 'Lingkup'],
  scopeSub: ['The scope text summarises the scope. The approved scope statement is the controlled version auditors check.', 'Teks lingkup merangkum lingkup. Pernyataan lingkup yang disetujui adalah versi terkendali yang diperiksa auditor.'],
  scopeText: ['Scope text of the management system', 'Teks lingkup sistem manajemen'],
  scopeTextHint: ['Set by the administrator under Management systems.', 'Diatur oleh administrator di Sistem manajemen.'],
  scopeStatement: ['Scope statement document', 'Dokumen pernyataan lingkup'],
  noScope: ['No approved scope statement', 'Belum ada pernyataan lingkup yang disetujui'],
  noScopeText: [
    'Register the scope statement from the pack template, or link your own scope document, then attach its file and have it approved.',
    'Daftarkan pernyataan lingkup dari templat pack, atau tautkan dokumen lingkup Anda sendiri, lalu lampirkan berkasnya dan minta persetujuan.',
  ],
  scopeState: ['{code} is registered and its state is {state}.', '{code} sudah terdaftar dan statusnya {state}.'],
  noScopeRow: ['The framework pack of this system names no scope statement.', 'Framework pack sistem ini tidak menyebutkan pernyataan lingkup.'],
  version: ['Version', 'Versi'],
  approvedOn: ['Approved', 'Disetujui'],
  nextReview: ['Next review', 'Review berikutnya'],

  // List
  missingOnly: ['Missing only', 'Hanya yang belum ada'],
  summary: ['{total} items, {missing} missing', '{total} item, {missing} belum ada'],
  loading: ['Loading the documented information of this system', 'Memuat informasi terdokumentasi sistem ini'],
  loadFailed: ['The documented information could not be loaded.', 'Informasi terdokumentasi tidak dapat dimuat.'],
  tryAgain: ['Try again', 'Coba lagi'],
  none: ['No documented information listed', 'Tidak ada informasi terdokumentasi'],
  noneText: ['The framework pack of this system lists no required documented information.', 'Framework pack sistem ini tidak mencantumkan informasi terdokumentasi wajib.'],
  nothingMissing: ['Nothing is missing', 'Tidak ada yang belum tersedia'],
  nothingMissingText: ['Every item has a document or evidence. Turn off Missing only to see them all.', 'Setiap item sudah memiliki dokumen atau bukti. Matikan Hanya yang belum ada untuk melihat semuanya.'],
  noSystem: ['Choose a management system to see its documented information.', 'Pilih sistem manajemen untuk melihat informasi terdokumentasinya.'],
  otherClauses: ['Other clauses', 'Klausul lain'],

  colCode: ['Code', 'Kode'],
  colInfo: ['Documented information', 'Informasi terdokumentasi'],
  colKind: ['Kind', 'Jenis'],
  colTemplate: ['Template', 'Templat'],
  colLinked: ['Linked item', 'Item tertaut'],
  colState: ['State', 'Status'],
  colActions: ['Actions', 'Tindakan'],
  clause: ['Clause {code}', 'Klausul {code}'],
  maintain: ['Document to maintain', 'Dokumen untuk dipelihara'],
  retain: ['Record to retain', 'Rekaman untuk disimpan'],
  linkedTag: ['Linked to {code}', 'Ditautkan ke {code}'],
  noEvidence: ['No evidence yet', 'Belum ada bukti'],
  cannotVerify: ['File cannot be verified', 'Berkas tak terverifikasi'],
  noDocument: ['No document yet', 'Belum ada dokumen'],

  stMissing: ['Missing', 'Belum ada'],
  stDraft: ['Draft', 'Draf'],
  stInReview: ['In review', 'Dalam review'],
  stApproved: ['Approved', 'Disetujui'],
  stOverdue: ['Review overdue', 'Review terlambat'],
  stFresh: ['Fresh', 'Mutakhir'],
  stOutOfDate: ['Out of date', 'Kedaluwarsa'],

  registerTemplate: ['Register from template', 'Daftarkan dari templat'],
  linkExisting: ['Link existing document', 'Tautkan dokumen yang ada'],
  changeLink: ['Change link', 'Ubah tautan'],
  removeLink: ['Remove link', 'Hapus tautan'],
  openDocument: ['Open document', 'Buka dokumen'],

  // Link dialog
  linkTitle: ['Link a document to {code}', 'Tautkan dokumen ke {code}'],
  linkSub: ['{title}. Activities and readiness that expect {code} then use the document you choose.', '{title}. Aktivitas dan kesiapan yang mengharapkan {code} lalu memakai dokumen yang Anda pilih.'],
  linkField: ['Document of this system', 'Dokumen sistem ini'],
  linkHint: ['Search by code or title. Your own codes are fine.', 'Cari berdasarkan kode atau judul. Kode Anda sendiri juga bisa.'],
  linkButton: ['Link document', 'Tautkan dokumen'],
  linkChoose: ['Choose a document first.', 'Pilih dokumen terlebih dahulu.'],
  noDocs: ['No document in this register yet', 'Belum ada dokumen di register ini'],
  noDocsText: ['Register the document first, then link it here.', 'Daftarkan dokumennya terlebih dahulu, lalu tautkan di sini.'],
  newDocument: ['New document', 'Dokumen baru'],
  linked: ['{doc} now stands for {code}', '{doc} kini mewakili {code}'],
  unlinked: ['The link of {code} was removed', 'Tautan {code} dihapus'],
  confirmUnlink: ['Remove the link of {code}?', 'Hapus tautan {code}?'],
  confirmUnlinkBody: ['{doc} no longer stands for {code}. Activities that expect {code} need another document before they can be completed.', '{doc} tidak lagi mewakili {code}. Aktivitas yang mengharapkan {code} memerlukan dokumen lain sebelum dapat diselesaikan.'],
} as const satisfies Record<string, Pair>;
