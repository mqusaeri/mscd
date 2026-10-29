// Texts of the certification timeline forms (MILESTONE-2 M2-15), in English and Indonesian (D2-01). Audit terms in
// plain words: a certification cycle runs about three years from the certificate (Stage 1 and Stage 2 audits, then a
// surveillance audit each year, then recertification); the certification body suspends or withdraws a certificate
// when the organisation stops meeting the standard.
export const TEXT = {
  // Event types and outcomes
  tStage1: ['Stage 1', 'Tahap 1'],
  tStage2: ['Stage 2', 'Tahap 2'],
  tSurveillance: ['Surveillance', 'Surveilans'],
  tRecertification: ['Recertification', 'Resertifikasi'],
  tTransition: ['Transition audit', 'Audit transisi'],
  tSpecial: ['Special audit', 'Audit khusus'],
  tInternal: ['Internal audit', 'Audit internal'],
  oRecommended: ['Recommended', 'Direkomendasikan'],
  oConditions: ['Recommended with conditions', 'Direkomendasikan dengan syarat'],
  oNotRecommended: ['Not recommended', 'Tidak direkomendasikan'],
  oNone: ['No result yet', 'Belum ada hasil'],

  // Cycle statuses
  cyPlanned: ['Planned', 'Direncanakan'],
  cyActive: ['Active', 'Aktif'],
  cyCertified: ['Certified', 'Tersertifikasi'],
  cySuspended: ['Suspended', 'Dibekukan'],
  cyWithdrawn: ['Withdrawn', 'Dicabut'],
  cyExpired: ['Expired', 'Kedaluwarsa'],
  cyClosed: ['Closed', 'Ditutup'],

  // Activity statuses
  acPlanned: ['Planned', 'Direncanakan'],
  acDone: ['Done', 'Selesai'],
  acCancelled: ['Cancelled', 'Dibatalkan'],

  // Common
  required: ['Required.', 'Wajib diisi.'],
  badDate: ['Enter a date.', 'Isi tanggal.'],
  badDays: ['Enter a whole number from 1 to 365.', 'Isi bilangan bulat dari 1 sampai 365.'],
  badWindow: ['Enter a whole number from 0 to 365.', 'Isi bilangan bulat dari 0 sampai 365.'],
  tooLong: ['Too long.', 'Terlalu panjang.'],
  nothingChanged: ['Nothing changed.', 'Tidak ada yang berubah.'],
  loadFailed: ['The certification cycle could not be loaded.', 'Siklus sertifikasi tidak dapat dimuat.'],
  tryAgain: ['Try again', 'Coba lagi'],
  loading: ['Loading the certification cycle', 'Memuat siklus sertifikasi'],
  conflict: [
    'Someone changed this record since you opened it. The latest version is loaded; check it and try again.',
    'Seseorang mengubah rekaman ini sejak Anda membukanya. Versi terbaru sudah dimuat; periksa lalu coba lagi.',
  ],
  saved: ['Saved', 'Tersimpan'],
  daysUnit: ['{n} days', '{n} hari'],
  to: ['{from} to {to}', '{from} sampai {to}'],

  // Certificate panel
  panelTitle: ['Certification cycle', 'Siklus sertifikasi'],
  noCycle: ['This audit is not in a certification cycle yet.', 'Audit ini belum masuk siklus sertifikasi.'],
  noCycleHint: [
    'A cycle starts with the first Stage 1 or recertification audit, or with "Start certification cycle".',
    'Siklus dimulai dengan audit Tahap 1 atau resertifikasi pertama, atau dengan "Mulai siklus sertifikasi".',
  ],
  fCycle: ['Cycle', 'Siklus'],
  fCertificate: ['Certificate number', 'Nomor sertifikat'],
  fIssued: ['Issued', 'Diterbitkan'],
  fExpires: ['Expires', 'Berakhir'],
  fBody: ['Issuing body', 'Lembaga penerbit'],
  fScope: ['Certified scope', 'Ruang lingkup tersertifikasi'],
  fItems: ['Cycle items done', 'Item siklus selesai'],
  itemsOf: ['{done} of {total}', '{done} dari {total}'],
  notRecorded: ['Not recorded', 'Belum dicatat'],
  expiresIn: ['{date}, in {n} days', '{date}, {n} hari lagi'],
  expiresToday: ['{date}, today', '{date}, hari ini'],
  expiredOn: ['{date}, expired', '{date}, sudah berakhir'],
  expiringSoon: ['The certificate expires in {n} days. Plan the recertification audit before then.', 'Sertifikat berakhir dalam {n} hari. Rencanakan audit resertifikasi sebelum itu.'],
  suspendedNote: [
    'The certification body suspended this certificate. Reinstate it when the body lifts the suspension, or record the withdrawal.',
    'Lembaga sertifikasi membekukan sertifikat ini. Pulihkan saat lembaga mencabut pembekuan, atau catat pencabutan sertifikat.',
  ],
  activeNote: [
    'Record the certificate after the Stage 2 or recertification audit ends with a recommended result.',
    'Catat sertifikat setelah audit Tahap 2 atau resertifikasi selesai dengan hasil direkomendasikan.',
  ],
  plannedNote: [
    'This cycle is planned. Start it when the audits are booked with the certification body.',
    'Siklus ini direncanakan. Mulai saat audit sudah dijadwalkan dengan lembaga sertifikasi.',
  ],

  // Actions
  addEvent: ['Add audit event', 'Tambah event audit'],
  edit: ['Edit', 'Ubah'],
  recordResult: ['Record result', 'Catat hasil'],
  startCycle: ['Start certification cycle', 'Mulai siklus sertifikasi'],
  recordCertificate: ['Record certificate', 'Catat sertifikat'],
  suspend: ['Record suspension', 'Catat pembekuan'],
  reinstate: ['Reinstate certificate', 'Pulihkan sertifikat'],
  withdraw: ['Record withdrawal', 'Catat pencabutan'],
  closeCycle: ['Close cycle', 'Tutup siklus'],
  generate: ['Generate activities', 'Buat aktivitas'],
  editActivity: ['Edit activity', 'Ubah aktivitas'],
  markDone: ['Mark done', 'Tandai selesai'],
  reassign: ['Reassign or change due date', 'Alihkan atau ubah tenggat'],
  openInternal: ['Open Internal audit', 'Buka Audit internal'],

  // Event panel
  eventActions: ['This audit', 'Audit ini'],
  resultLine: ['Result: {outcome}', 'Hasil: {outcome}'],
  internalNote: [
    'Internal audits are planned and recorded on the Internal audit screen.',
    'Audit internal direncanakan dan dicatat di layar Audit internal.',
  ],
  notInCycle: [
    'The server lists this audit in no certification cycle, so it cannot be changed here.',
    'Server tidak mencantumkan audit ini dalam siklus sertifikasi mana pun, jadi audit ini tidak dapat diubah di sini.',
  ],
  resultLater: ['Record the result once the audit has taken place.', 'Catat hasil setelah audit berlangsung.'],

  // Activities
  activitiesTitle: ['Audit activities', 'Aktivitas audit'],
  activitiesSub: [
    'What the auditor examines, from the audit activity templates of the framework pack.',
    'Apa yang diperiksa auditor, dari templat aktivitas audit pada framework pack.',
  ],
  noActivities: ['No activities yet.', 'Belum ada aktivitas.'],
  activitiesFailed: ['The activities could not be loaded.', 'Aktivitas tidak dapat dimuat.'],
  activityClause: ['Clause {code}', 'Klausul {code}'],
  activityAuditee: ['auditee {name}', 'auditi {name}'],
  activityAuditor: ['auditor {name}', 'oleh auditor {name}'],
  activityNoOne: ['no auditee or auditor yet', 'belum ada auditi atau auditor'],
  noTemplates: [
    'The framework pack has no audit activity templates for this audit type.',
    'Framework pack belum memiliki templat aktivitas audit untuk jenis audit ini.',
  ],
  generated: ['{n} audit activities added from the templates.', '{n} aktivitas audit ditambahkan dari templat.'],
  allExist: ['Every template activity of this audit already exists.', 'Semua aktivitas templat untuk audit ini sudah ada.'],

  // Event form
  addTitle: ['Add audit event', 'Tambah event audit'],
  addSub: [
    'An audit by the certification body. The first Stage 1 or recertification audit starts the certification cycle.',
    'Audit oleh lembaga sertifikasi. Audit Tahap 1 atau resertifikasi pertama memulai siklus sertifikasi.',
  ],
  editTitle: ['Edit audit event', 'Ubah event audit'],
  editSub: [
    'Moving the date flags preparation tasks that now fall after the audit and notifies the people who hold items due after it (BR-42).',
    'Memindahkan tanggal menandai tugas persiapan yang kini jatuh setelah audit dan memberi tahu pemegang item yang jatuh tempo setelahnya (BR-42).',
  ],
  fType: ['Type', 'Jenis'],
  fNameEn: ['Name in English', 'Nama dalam bahasa Inggris'],
  fNameId: ['Name in Indonesian', 'Nama dalam bahasa Indonesia'],
  fNameIdHint: ['Left empty, the English name is used.', 'Jika dikosongkan, nama bahasa Inggris dipakai.'],
  fShort: ['Short label', 'Label singkat'],
  fShortHint: ['Shown on the timeline, for example "Surveillance 2".', 'Tampil di linimasa, misalnya "Surveillance 2".'],
  fDate: ['Date', 'Tanggal'],
  fDays: ['Audit days', 'Hari audit'],
  fLead: ['Lead auditor', 'Auditor utama'],
  fLeadHint: ['Name of the certification body\'s lead auditor.', 'Nama auditor utama dari lembaga sertifikasi.'],
  fWindow: ['Preparation window (days)', 'Jendela persiapan (hari)'],
  fWindowHint: ['How many days before the audit the preparation starts. Default 60.', 'Berapa hari sebelum audit persiapan dimulai. Bawaan 60.'],
  fWindowKeep: ['Left empty, the current window stays.', 'Jika dikosongkan, jendela saat ini tetap.'],
  fFocus: ['Expected focus', 'Fokus yang diharapkan'],
  fFocusHint: ['What the auditor said they will look at.', 'Hal yang akan diperiksa auditor menurut pemberitahuannya.'],
  internalType: ['Internal audits are planned on the Internal audit screen.', 'Audit internal direncanakan di layar Audit internal.'],
  added: ['Audit event {label} added', 'Event audit {label} ditambahkan'],
  eventSaved: ['Audit event {label} saved', 'Event audit {label} tersimpan'],
  notified: [
    'Audit event {label} saved. {n} people were notified of items now due after the audit (BR-42).',
    'Event audit {label} tersimpan. {n} orang diberi tahu tentang item yang kini jatuh tempo setelah audit (BR-42).',
  ],
  noAddRight: [
    'Only the MS Manager of this system adds audit events.',
    'Hanya MS Manager sistem ini yang menambahkan event audit.',
  ],
  loadingEvent: ['Loading the audit event', 'Memuat event audit'],
  eventLoadFailed: ['The audit event could not be loaded', 'Event audit tidak dapat dimuat'],

  // Result form
  resultTitle: ['Record audit result', 'Catat hasil audit'],
  resultSub: ['The recommendation in the certification body\'s audit report.', 'Rekomendasi dalam laporan audit lembaga sertifikasi.'],
  fOutcome: ['Recommendation', 'Rekomendasi'],
  fSummary: ['Summary', 'Ringkasan'],
  fSummaryHint: ['For example "Certified, 2 minor nonconformities, 1 opportunity for improvement".', 'Misalnya "Tersertifikasi, 2 ketidaksesuaian minor, 1 peluang perbaikan".'],
  hintStage1: ['Recommended means the auditor found the system ready for the Stage 2 audit.', 'Direkomendasikan berarti auditor menilai sistem siap untuk audit Tahap 2.'],
  hintCert: ['A recommended result lets you record the certificate.', 'Hasil direkomendasikan memungkinkan Anda mencatat sertifikat.'],
  hintSurveillance: ['Recommended means the certificate continues.', 'Direkomendasikan berarti sertifikat tetap berlaku.'],
  resultSaved: ['Result of {label} recorded', 'Hasil {label} dicatat'],

  // Start cycle
  startTitle: ['Start certification cycle', 'Mulai siklus sertifikasi'],
  startSub: [
    'A cycle holds the audits of about three years and the items the auditor checks in it. One cycle can be open at a time.',
    'Satu siklus mencakup audit selama sekitar tiga tahun dan item yang diperiksa auditor di dalamnya. Hanya satu siklus yang boleh terbuka.',
  ],
  startPlanned: ['The planned cycle of this system starts with these dates.', 'Siklus yang direncanakan untuk sistem ini dimulai dengan tanggal ini.'],
  activeExists: ['This system already has an active cycle ({from} to {to}).', 'Sistem ini sudah memiliki siklus aktif ({from} sampai {to}).'],
  fStart: ['Start date', 'Tanggal mulai'],
  fEnd: ['End date', 'Tanggal akhir'],
  fEndHint: ['Left empty, the cycle ends three years after the start.', 'Jika dikosongkan, siklus berakhir tiga tahun setelah tanggal mulai.'],
  endBeforeStart: ['The end date must be after the start date.', 'Tanggal akhir harus setelah tanggal mulai.'],
  started: ['Certification cycle started', 'Siklus sertifikasi dimulai'],

  // Certificate form
  certTitle: ['Record certificate', 'Catat sertifikat'],
  certSub: [
    'The certificate the certification body issued after the recommendation. The system becomes certified.',
    'Sertifikat yang diterbitkan lembaga sertifikasi setelah rekomendasi. Sistem menjadi tersertifikasi.',
  ],
  certNeedsActive: ['Start the certification cycle first.', 'Mulai siklus sertifikasi terlebih dahulu.'],
  certNeedsResult: [
    'Record the result of the Stage 2 or recertification audit first: the certificate needs the result Recommended or Recommended with conditions.',
    'Catat hasil audit Tahap 2 atau resertifikasi terlebih dahulu: sertifikat memerlukan hasil Direkomendasikan atau Direkomendasikan dengan syarat.',
  ],
  certBasis: ['Based on {label} of {date}: {outcome}.', 'Berdasarkan {label} tanggal {date}: {outcome}.'],
  fExpiresHint: ['Usually three years after the issue date.', 'Biasanya tiga tahun setelah tanggal terbit.'],
  expiresBeforeIssued: ['The expiry date must be after the issue date.', 'Tanggal berakhir harus setelah tanggal terbit.'],
  certRecorded: ['Certificate {no} recorded. The system is certified until {date}.', 'Sertifikat {no} dicatat. Sistem tersertifikasi sampai {date}.'],

  // Transitions
  suspendTitle: ['Record suspension', 'Catat pembekuan'],
  suspendSub: ['The certification body suspended the certificate. The system keeps its status; the certificate shows as suspended.', 'Lembaga sertifikasi membekukan sertifikat. Sistem tetap pada statusnya; sertifikat tampil sebagai dibekukan.'],
  reinstateTitle: ['Reinstate certificate', 'Pulihkan sertifikat'],
  reinstateSub: ['The certification body lifted the suspension.', 'Lembaga sertifikasi mencabut pembekuan.'],
  withdrawTitle: ['Record withdrawal', 'Catat pencabutan'],
  withdrawSub: ['The certification body withdrew the certificate. This cannot be undone; a new cycle can start afterwards.', 'Lembaga sertifikasi mencabut sertifikat. Ini tidak dapat dibatalkan; siklus baru dapat dimulai setelahnya.'],
  closeTitle: ['Close cycle', 'Tutup siklus'],
  closeSub: ['Close this cycle when it will not reach certification. A new cycle can start afterwards.', 'Tutup siklus ini bila tidak akan mencapai sertifikasi. Siklus baru dapat dimulai setelahnya.'],
  moveAlready: ['This cycle is already {status}, so there is nothing more to record.', 'Siklus ini sudah berstatus {status}, jadi tidak ada lagi yang perlu dicatat.'],
  moveStale: [
    'This cycle is now {status}, so this change no longer applies. Close the form to see what the cycle offers now.',
    'Siklus ini kini berstatus {status}, jadi perubahan ini tidak berlaku lagi. Tutup formulir untuk melihat pilihan siklus saat ini.',
  ],
  fReason: ['Reason', 'Alasan'],
  fReasonHint: ['The decision of the certification body, or why the cycle stops.', 'Keputusan lembaga sertifikasi, atau alasan siklus dihentikan.'],
  reasonShort: ['Give a reason of at least 3 characters.', 'Isi alasan minimal 3 karakter.'],
  transitioned: ['Certification cycle updated: {status}', 'Siklus sertifikasi diperbarui: {status}'],

  // Activity form
  activityTitle: ['Edit activity {code}', 'Ubah aktivitas {code}'],
  fAuditee: ['Auditee', 'Auditi'],
  fAuditor: ['Auditor', 'Auditor'],
  fTarget: ['Clause or control', 'Klausul atau kontrol'],
  fTargetHint: ['A code of the standard, for example 4.3 or A.5.15.', 'Kode standar, misalnya 4.3 atau A.5.15.'],
  fActivityDate: ['Planned date', 'Tanggal rencana'],
  fStatus: ['Status', 'Status'],
  fNote: ['Note', 'Catatan'],
  keyQuestions: ['Key questions', 'Pertanyaan kunci'],
  evidenceToRequest: ['Evidence to request', 'Bukti yang diminta'],
  fromTemplate: ['From the template of the framework pack', 'Dari templat framework pack'],
  activitySaved: ['Activity {code} saved', 'Aktivitas {code} tersimpan'],

  // Preparation and cycle items
  itemTitle: ['Reassign or change due date', 'Alihkan atau ubah tenggat'],
  itemSubPrep: ['Preparation task of the audit on {date}. It must be due before the audit (BR-43).', 'Tugas persiapan untuk audit tanggal {date}. Tenggatnya harus sebelum audit (BR-43).'],
  itemSubCycle: ['Item the auditor checks in this certification cycle.', 'Item yang diperiksa auditor dalam siklus sertifikasi ini.'],
  fHolder: ['Holder', 'Pemegang'],
  fDue: ['Due date', 'Tenggat'],
  br43: ['BR-43: the task must be due before the audit on {date}.', 'BR-43: tenggat tugas harus sebelum audit tanggal {date}.'],
  markedDone: ['{title} marked done', '{title} ditandai selesai'],
  itemSaved: ['{title} updated', '{title} diperbarui'],
  noRef: ['This item has no record on the server. Load the page again.', 'Item ini tidak memiliki rekaman di server. Muat ulang halaman.'],
} as const satisfies Record<string, readonly [string, string]>;
