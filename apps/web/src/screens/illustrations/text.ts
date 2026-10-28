// Texts of the illustration gallery page in English and Indonesian (MILESTONE-2 MOT-03, D2-01). Only the lazy gallery
// chunk loads them; the label and help of the screen definition are in definition.ts.
export const TEXT = {
  introTitle: ['Illustration library', 'Pustaka ilustrasi'],
  introSub: ['Shown in the sample build only, for review', 'Hanya tampil di build contoh, untuk ditinjau'],
  intro: [
    'Quiet scenes for empty states, Getting started and error states. Each one plays a short entrance once, in under 1.2 seconds, then stays still. Screens pick a scene by its name.',
    'Adegan tenang untuk keadaan kosong, Memulai dan keadaan galat. Setiap adegan memutar animasi masuk singkat satu kali, kurang dari 1,2 detik, lalu diam. Layar memilih adegan berdasarkan namanya.',
  ],
  replay: ['Replay entrance', 'Putar ulang animasi masuk'],
  still: ['Show still frames', 'Tampilkan bingkai diam'],
  stillNote: [
    'People who ask their system for reduced motion always see the still frame.',
    'Orang yang meminta gerakan dikurangi di sistemnya selalu melihat bingkai diam.',
  ],
  scenes: ['Scenes', 'Adegan'],
  code: ['Name in code', 'Nama dalam kode'],
  alt: ['Text alternative', 'Teks alternatif'],
  emptyTitle: ['In an empty state', 'Dalam keadaan kosong'],
  emptySub: ['How a screen shows a scene above its message', 'Cara layar menampilkan adegan di atas pesannya'],
  emptyExampleTitle: ['No documents yet', 'Belum ada dokumen'],
  emptyExampleText: [
    'Documents you create or link appear here, with their owner and next review date.',
    'Dokumen yang Anda buat atau tautkan muncul di sini, beserta pemilik dan tanggal tinjauan berikutnya.',
  ],
  emptyExampleAction: ['New document', 'Dokumen baru'],
  exampleOnly: ['Example only: nothing was created.', 'Hanya contoh: tidak ada yang dibuat.'],
  progressTitle: ['Getting started progress', 'Kemajuan Memulai'],
  progressSub: ['One more step lights up as the checklist gets done', 'Satu langkah lagi menyala setiap kali daftar periksa makin selesai'],
  progressValue: ['{pct}% done, {done} of {steps} steps lit', '{pct}% selesai, {done} dari {steps} langkah menyala'],
  sizesTitle: ['Sizes', 'Ukuran'],
  sizesSub: ['Small, medium (the default) and large', 'Kecil, sedang (bawaan) dan besar'],
  sizeSm: ['Small, 128 px wide', 'Kecil, lebar 128 px'],
  sizeMd: ['Medium, 192 px wide', 'Sedang, lebar 192 px'],
  sizeLg: ['Large, 288 px wide', 'Besar, lebar 288 px'],
} as const satisfies Record<string, readonly [string, string]>;
