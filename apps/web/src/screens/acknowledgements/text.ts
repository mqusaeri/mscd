// Texts of "Policy read confirmations" (MILESTONE-3 M3-05, D.7) and of the read confirmation section of a document's
// detail: every label in English and Indonesian (R-22). Plain English, no em dash and no centre dot. `{name}`
// placeholders are filled with `ctx.fill`.
export const TEXT = {
  title: ['Policy read confirmations', 'Konfirmasi baca kebijakan'],
  teraWhat: [
    'Who has read and confirmed each approved version of a policy or another controlled document. ISO/IEC 27001 A.5.1 asks that policies are acknowledged by the people concerned, and clause 7.3 of each standard asks that people know the policy.',
    'Siapa yang telah membaca dan mengonfirmasi setiap versi kebijakan atau dokumen terkendali lain yang disetujui. ISO/IEC 27001 A.5.1 meminta kebijakan diakui oleh orang yang terkait, dan klausul 7.3 setiap standar meminta orang memahami kebijakan.',
  ],
  teraHow1: [
    'A document that asks for read confirmation sends each new approved version to the people with a role in its systems. Set this in the document\'s detail, under "Read confirmation".',
    'Dokumen yang meminta konfirmasi baca mengirim setiap versi baru yang disetujui kepada orang yang memiliki peran di sistemnya. Atur ini di detail dokumen, pada "Konfirmasi baca".',
  ],
  teraHow2: [
    'Open a request to see who confirmed, who is still pending and who is overdue. Remind the pending people, or download the register as CSV.',
    'Buka permintaan untuk melihat siapa yang sudah mengonfirmasi, siapa yang masih tertunda, dan siapa yang terlambat. Ingatkan orang yang tertunda, atau unduh register sebagai CSV.',
  ],
  teraHow3: [
    'When enough people have confirmed, close the request and file the register as a new file of an evidence item, for example the evidence of A.5.1 or clause 7.3.',
    'Jika sudah cukup banyak orang yang mengonfirmasi, tutup permintaan dan simpan register sebagai berkas baru sebuah item bukti, misalnya bukti A.5.1 atau klausul 7.3.',
  ],
  noSystem: ['Choose a management system first.', 'Pilih sistem manajemen terlebih dahulu.'],
  intro: [
    'Each approved version of a document that asks for read confirmation goes to the people concerned. They open it and confirm that they have read and understood it.',
    'Setiap versi dokumen yang disetujui dan meminta konfirmasi baca dikirim kepada orang yang terkait. Mereka membukanya dan mengonfirmasi bahwa mereka telah membaca dan memahaminya.',
  ],
  totalsOnly: [
    'You see the totals of each request. The list of people is shown to the Management System Manager and the Programme Owner.',
    'Anda melihat total setiap permintaan. Daftar orang ditampilkan kepada Management System Manager dan Programme Owner.',
  ],
  ask: ['Ask for confirmation', 'Minta konfirmasi'],
  listTitle: ['Confirmation requests', 'Permintaan konfirmasi'],
  listSub: ['Requests of the documents of this system, open first', 'Permintaan dokumen sistem ini, yang terbuka lebih dulu'],
  loading: ['Loading the confirmation requests', 'Memuat permintaan konfirmasi'],
  loadFailed: ['The confirmation requests could not be loaded', 'Permintaan konfirmasi tidak dapat dimuat'],
  tryAgain: ['Try again', 'Coba lagi'],
  emptyTitle: ['No confirmation requests yet', 'Belum ada permintaan konfirmasi'],
  emptyText: [
    'Turn on read confirmation in a document\'s detail, or ask for confirmation of an approved document.',
    'Aktifkan konfirmasi baca di detail dokumen, atau minta konfirmasi untuk dokumen yang disetujui.',
  ],

  colDocument: ['Document', 'Dokumen'],
  colVersion: ['Version', 'Versi'],
  colDue: ['Due date', 'Tenggat'],
  colConfirmed: ['Confirmed', 'Dikonfirmasi'],
  colPending: ['Pending', 'Tertunda'],
  colOverdue: ['Overdue', 'Terlambat'],
  colExcused: ['Excused', 'Dikecualikan'],
  colState: ['State', 'Keadaan'],
  confirmedOf: ['{confirmed} of {audience}', '{confirmed} dari {audience}'],
  stateOpen: ['Open', 'Terbuka'],
  stateClosed: ['Closed', 'Ditutup'],

  drawerCrumb: ['Confirmation request', 'Permintaan konfirmasi'],
  drawerTitle: ['{code} version {version}', '{code} versi {version}'],
  factDocument: ['Document', 'Dokumen'],
  factAudience: ['Who is asked', 'Siapa yang diminta'],
  factDue: ['Confirm by', 'Konfirmasi paling lambat'],
  factStarted: ['Asked on', 'Diminta pada'],
  factReminded: ['Last reminder', 'Pengingat terakhir'],
  factClosed: ['Closed on', 'Ditutup pada'],
  factEvidence: ['Filed as evidence', 'Disimpan sebagai bukti'],
  never: ['Not yet', 'Belum'],
  statConfirmed: ['Confirmed', 'Dikonfirmasi'],
  statPending: ['Pending', 'Tertunda'],
  statOverdue: ['Overdue', 'Terlambat'],
  statExcused: ['Excused', 'Dikecualikan'],
  totalsLabel: ['Totals of the request', 'Total permintaan'],
  peopleTitle: ['People', 'Orang'],
  colPerson: ['Person', 'Orang'],
  colOpened: ['Opened', 'Dibuka'],
  colConfirmedAt: ['Confirmed on', 'Dikonfirmasi pada'],
  colReminders: ['Reminders', 'Pengingat'],
  personPending: ['Pending', 'Tertunda'],
  personOverdue: ['Overdue', 'Terlambat'],
  personConfirmed: ['Confirmed', 'Dikonfirmasi'],
  personExcused: ['Excused', 'Dikecualikan'],
  remind: ['Remind', 'Ingatkan'],
  remindedToday: ['The pending people were reminded today.', 'Orang yang tertunda sudah diingatkan hari ini.'],
  exportCsv: ['Export CSV', 'Ekspor CSV'],
  closeFile: ['Close and file as evidence', 'Tutup dan simpan sebagai bukti'],
  closedNote: ['This request is closed. Reminders stopped.', 'Permintaan ini sudah ditutup. Pengingat berhenti.'],
  detailFailed: ['The request could not be loaded', 'Permintaan tidak dapat dimuat'],

  // Audience
  scopeSystemRoles: ['Everyone with a role in the document\'s systems', 'Semua orang yang memiliki peran di sistem dokumen'],
  scopeRoles: ['Only the roles I choose', 'Hanya peran yang saya pilih'],
  scopeOrganisation: ['Everyone with a role in any system of the organisation', 'Semua orang yang memiliki peran di sistem mana pun dalam organisasi'],
  rolesOf: ['Holders of: {roles}', 'Pemegang peran: {roles}'],

  // Ask for confirmation
  askTitle: ['Ask for confirmation', 'Minta konfirmasi'],
  askSub: [
    'The people you choose get a task and a notification to read and confirm the current approved version.',
    'Orang yang Anda pilih mendapat tugas dan notifikasi untuk membaca dan mengonfirmasi versi yang berlaku dan disetujui.',
  ],
  askDocument: ['Approved document', 'Dokumen yang disetujui'],
  askDocumentHint: ['Only approved documents with a current version can be confirmed.', 'Hanya dokumen yang disetujui dengan versi berlaku yang dapat dikonfirmasi.'],
  askNoDocuments: ['This system has no approved document yet.', 'Sistem ini belum memiliki dokumen yang disetujui.'],
  audience: ['Who is asked', 'Siapa yang diminta'],
  roles: ['Roles', 'Peran'],
  rolesHint: ['Choose at least one role.', 'Pilih setidaknya satu peran.'],
  dueDays: ['Days to confirm', 'Hari untuk mengonfirmasi'],
  dueDaysHint: ['From 1 to 90 days. The default is 14.', 'Dari 1 sampai 90 hari. Bawaannya 14.'],
  send: ['Send the request', 'Kirim permintaan'],
  chooseDocument: ['Choose a document.', 'Pilih dokumen.'],
  chooseRoles: ['Choose at least one role.', 'Pilih setidaknya satu peran.'],
  badDays: ['Enter a whole number of days from 1 to 90.', 'Masukkan jumlah hari bulat dari 1 sampai 90.'],
  asked: ['Asked {n} people to confirm {code}', '{n} orang diminta mengonfirmasi {code}'],

  // Close and file
  closeTitle: ['Close the request of {code}', 'Tutup permintaan {code}'],
  closeSub: [
    'Reminders stop and the people still pending are no longer asked. The register is filed as a new file of the evidence item you choose, so it counts as evidence for the audit.',
    'Pengingat berhenti dan orang yang masih tertunda tidak lagi diminta. Register disimpan sebagai berkas baru item bukti yang Anda pilih, sehingga terhitung sebagai bukti untuk audit.',
  ],
  closeEvidence: ['Evidence item', 'Item bukti'],
  closeEvidenceHint: ['For example the evidence of A.5.1 or clause 7.3.', 'Misalnya bukti A.5.1 atau klausul 7.3.'],
  closeNoEvidence: ['This system has no evidence item yet.', 'Sistem ini belum memiliki item bukti.'],
  closeAndFile: ['Close and file', 'Tutup dan simpan'],
  closeOnly: ['Close without filing', 'Tutup tanpa menyimpan'],
  chooseEvidence: ['Choose an evidence item, or close without filing.', 'Pilih item bukti, atau tutup tanpa menyimpan.'],
  closed: ['Request of {code} closed', 'Permintaan {code} ditutup'],

  // Read confirmation section of a document's detail
  sectionTitle: ['Read confirmation', 'Konfirmasi baca'],
  sectionOn: ['Each new approved version is sent for read confirmation: {audience}, {days} days.', 'Setiap versi baru yang disetujui dikirim untuk konfirmasi baca: {audience}, {days} hari.'],
  sectionOff: ['New approved versions are not sent for read confirmation.', 'Versi baru yang disetujui tidak dikirim untuk konfirmasi baca.'],
  sectionUnknown: [
    'The read confirmation settings stored for this document are not shown on this page. Saving new settings replaces them.',
    'Pengaturan konfirmasi baca yang tersimpan untuk dokumen ini tidak ditampilkan di halaman ini. Menyimpan pengaturan baru akan menggantikannya.',
  ],
  sectionLatest: ['Version {version}: {confirmed} of {audience} confirmed', 'Versi {version}: {confirmed} dari {audience} mengonfirmasi'],
  sectionOverdue: ['{n} overdue', '{n} terlambat'],
  sectionNone: ['No confirmation request for this document yet.', 'Belum ada permintaan konfirmasi untuk dokumen ini.'],
  settings: ['Read confirmation settings', 'Pengaturan konfirmasi baca'],
  openRegister: ['Open read confirmations', 'Buka konfirmasi baca'],
  settingsTitle: ['Read confirmation of {code}', 'Konfirmasi baca {code}'],
  settingsSub: [
    'When a new version of this document is approved, the people you choose are asked to open it and confirm that they have read and understood it.',
    'Saat versi baru dokumen ini disetujui, orang yang Anda pilih diminta membukanya dan mengonfirmasi bahwa mereka telah membaca dan memahaminya.',
  ],
  required: ['Ask people to confirm each new approved version', 'Minta orang mengonfirmasi setiap versi baru yang disetujui'],
  requiredLegend: ['Read confirmation of new versions', 'Konfirmasi baca versi baru'],
  notRequired: ['Do not ask for read confirmation', 'Jangan minta konfirmasi baca'],
  chooseRequired: ['Choose whether people are asked to confirm new versions.', 'Pilih apakah orang diminta mengonfirmasi versi baru.'],
  settingsUnknown: [
    'The settings stored for this document are not shown here. The fields below start from the defaults, and saving replaces the stored settings.',
    'Pengaturan yang tersimpan untuk dokumen ini tidak ditampilkan di sini. Isian di bawah dimulai dari nilai bawaan, dan menyimpan akan menggantikan pengaturan yang tersimpan.',
  ],
  save: ['Save', 'Simpan'],
  saved: ['Read confirmation of {code} saved', 'Konfirmasi baca {code} disimpan'],
  sharedTitle: ['Change a shared document', 'Ubah dokumen bersama'],
  applyAll: ['Apply to every system', 'Terapkan ke setiap sistem'],
  noRecord: ['This document is not in the loaded data. Reload the page and try again.', 'Dokumen ini tidak ada di data yang dimuat. Muat ulang halaman lalu coba lagi.'],

  // Page action of the Document register
  pageAction: ['Read confirmations', 'Konfirmasi baca'],

  // Sample build
  sampleNote: [
    'This is sample data. Changes stay in this browser tab and are gone after a reload.',
    'Ini data contoh. Perubahan hanya tersimpan di tab browser ini dan hilang setelah dimuat ulang.',
  ],
  sampleNoFiles: ['The sample build has no stored files.', 'Versi contoh tidak memiliki berkas tersimpan.'],
  unexpected: ['The server sent an answer this screen cannot read.', 'Server mengirim jawaban yang tidak dapat dibaca layar ini.'],
} as const;

