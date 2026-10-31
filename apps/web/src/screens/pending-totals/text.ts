// Texts of the Open work totals screen (MILESTONE-3 M3-08, D.10), as [English, Indonesian] pairs. The screen shows
// counts only (product decision 2), so no text names a person.
export const TEXT = {
  title: ['Open work totals', 'Total pekerjaan terbuka'],
  teraWhat: [
    'How much work is open and overdue along the chain of a management system, per stage and per business role. The screen shows counts only and never who holds an item.',
    'Berapa banyak pekerjaan yang terbuka dan terlambat di sepanjang rantai sebuah sistem manajemen, per tahap dan per peran bisnis. Layar ini hanya menampilkan jumlah dan tidak pernah menampilkan siapa yang memegang item.',
  ],
  teraHow1: [
    'Read the totals of the selected system at the top: the open items, those overdue or missing, and those still on time.',
    'Baca total sistem yang dipilih di bagian atas: item terbuka, item yang terlambat atau hilang, dan item yang masih tepat waktu.',
  ],
  teraHow2: [
    'The table splits the open items by chain stage and by the business role of the person who holds them. Unassigned items, and holders without a role in the system, count under "No role or unassigned".',
    'Tabel membagi item terbuka per tahap rantai dan per peran bisnis orang yang memegangnya. Item yang belum ditugaskan, dan pemegang tanpa peran di sistem ini, dihitung pada "Tanpa peran atau belum ditugaskan".',
  ],
  teraHow3: [
    'Open "All my systems" to compare every system where you see these totals, then choose "Show table" to read the table of one system.',
    'Buka "Semua sistem saya" untuk membandingkan setiap sistem tempat Anda melihat total ini, lalu pilih "Lihat tabel" untuk membaca tabel satu sistem.',
  ],
  countsOnly: [
    'This screen shows counts only. It never shows who holds an item.',
    'Layar ini hanya menampilkan jumlah. Layar ini tidak pernah menampilkan siapa yang memegang item.',
  ],
  tabsLabel: ['Views of the open work totals', 'Tampilan total pekerjaan terbuka'],
  tabSystem: ['This system', 'Sistem ini'],
  tabAll: ['All my systems', 'Semua sistem saya'],
  loading: ['Loading the open work totals', 'Memuat total pekerjaan terbuka'],

  summaryTitle: ['Open work in {system}', 'Pekerjaan terbuka di {system}'],
  summarySub: ['Every open item along the chain of this management system', 'Setiap item terbuka di sepanjang rantai sistem manajemen ini'],
  statOpen: ['Open items', 'Item terbuka'],
  statOverdue: ['Overdue / missing', 'Terlambat / hilang'],
  statOnTime: ['On time', 'Tepat waktu'],
  statStages: ['Stages with open work', 'Tahap dengan pekerjaan terbuka'],
  stagesValue: ['{n} of {total}', '{n} dari {total}'],
  shareValue: ['{n}% of the open items', '{n}% dari item terbuka'],
  onTimeSub: ['Open and not yet due', 'Terbuka dan belum jatuh tempo'],
  stagesSub: ['Stages of the chain of this system', 'Tahap rantai sistem ini'],

  matrixTitle: ['By stage and role', 'Per tahap dan peran'],
  matrixSub: [
    'Each cell shows the open items of a stage held by a business role; below the number, how many of them are overdue or missing.',
    'Setiap sel menampilkan item terbuka suatu tahap yang dipegang oleh suatu peran bisnis; di bawah angkanya, berapa banyak yang terlambat atau hilang.',
  ],
  matrixCaption: ['Open items per chain stage and business role', 'Item terbuka per tahap rantai dan peran bisnis'],
  colStage: ['Stage', 'Tahap'],
  colAllRoles: ['All roles', 'Semua peran'],
  rowAllStages: ['All stages', 'Semua tahap'],
  noRole: ['No role or unassigned', 'Tanpa peran atau belum ditugaskan'],
  overdueCount: ['{n} overdue', '{n} terlambat'],

  emptyTitle: ['No open work in {system}', 'Tidak ada pekerjaan terbuka di {system}'],
  emptyText: [
    'Every item along the chain of this system is done. New work shows here as soon as it opens.',
    'Semua item di sepanjang rantai sistem ini sudah selesai. Pekerjaan baru muncul di sini segera setelah dibuka.',
  ],

  allTitle: ['All my systems', 'Semua sistem saya'],
  allSub: [
    'Every management system where you see the open work totals. Choose "Show table" to read the table of one system.',
    'Setiap sistem manajemen tempat Anda melihat total pekerjaan terbuka. Pilih "Lihat tabel" untuk membaca tabel satu sistem.',
  ],
  allCaption: ['Open work per management system', 'Pekerjaan terbuka per sistem manajemen'],
  colSystem: ['System', 'Sistem'],
  colOpen: ['Open', 'Terbuka'],
  colOverdue: ['Overdue / missing', 'Terlambat / hilang'],
  colShare: ['Share overdue', 'Porsi terlambat'],
  colAction: ['Table', 'Tabel'],
  rowAllSystems: ['All systems', 'Semua sistem'],
  showTable: ['Show table', 'Lihat tabel'],
  showTableOf: ['Show the table of {system}', 'Lihat tabel {system}'],
  current: ['Selected system', 'Sistem terpilih'],
  systemLoading: ['Loading', 'Memuat'],
  systemFailed: ['Could not be loaded', 'Tidak dapat dimuat'],
  someFailed: [
    'The totals of some systems could not be loaded, so the sum covers the other systems only.',
    'Total beberapa sistem tidak dapat dimuat, sehingga jumlahnya hanya mencakup sistem lainnya.',
  ],
  noSystems: [
    'You do not see the open work totals of any management system.',
    'Anda tidak melihat total pekerjaan terbuka dari sistem manajemen mana pun.',
  ],

  loadFailed: ['The open work totals could not be loaded.', 'Total pekerjaan terbuka tidak dapat dimuat.'],
  tryAgain: ['Try again', 'Coba lagi'],
  unexpected: ['The server sent an answer this screen cannot read.', 'Server mengirim jawaban yang tidak dapat dibaca oleh layar ini.'],
  unknownSystem: ['This management system is not part of the organisation.', 'Sistem manajemen ini bukan bagian dari organisasi.'],
  noSystem: ['Choose a management system to see its open work totals.', 'Pilih sistem manajemen untuk melihat total pekerjaan terbukanya.'],
  notAllowed: [
    'You cannot see the open work totals of this system. Top Management, the Programme Owner and the Management System Manager see them.',
    'Anda tidak dapat melihat total pekerjaan terbuka sistem ini. Manajemen Puncak, Pemilik Program, dan Management System Manager dapat melihatnya.',
  ],
  openAction: ['Open work totals', 'Total pekerjaan terbuka'],
} as const;
