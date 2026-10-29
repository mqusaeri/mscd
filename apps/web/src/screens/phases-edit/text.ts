// Texts of the activity forms (MILESTONE-2 M2-11), in English and Indonesian (D2-01). The Indonesian interface uses
// "checkpoint" as its term, as the Phase board does (product decision 10; the code names keep "gate").
export const TEXT = {
  panelTitle: ['Work on this activity', 'Kerjakan aktivitas ini'],
  start: ['Start', 'Mulai'],
  startHint: ['Moves the activity to In progress.', 'Memindahkan aktivitas ke Berjalan.'],
  started: ['{no} started', '{no} dimulai'],
  sampleStart: ['The sample data keeps the status of activities as it is.', 'Data contoh mempertahankan status aktivitas apa adanya.'],
  // Record blocker
  blockerTitle: ['Record blocker for {no}', 'Catat blokir untuk {no}'],
  blockerSub: [
    'A blocked activity names the open checkpoint item that holds it and what is holding it (BR-39). It returns to work when the checkpoint item is resolved.',
    'Aktivitas yang diblokir menyebut item checkpoint terbuka yang menahannya dan apa yang menahannya (BR-39). Aktivitas kembali dikerjakan setelah item checkpoint diselesaikan.',
  ],
  gateItem: ['Checkpoint item', 'Item checkpoint'],
  gateItemNote: ['{type}, held by {holder}', '{type}, dipegang {holder}'],
  gateItemBlocks: ['{type}, already blocks {activities}', '{type}, sudah memblokir {activities}'],
  noGateItems: [
    'This system has no open checkpoint item, so there is nothing an activity can be blocked by. Resolve the work with the activity owner instead.',
    'Sistem ini tidak punya item checkpoint terbuka, sehingga tidak ada yang dapat memblokir aktivitas. Selesaikan pekerjaannya bersama pemilik aktivitas.',
  ],
  reason: ['What is holding this activity', 'Apa yang menahan aktivitas ini'],
  reasonHint: ['For example: the risk owner has not approved the treatment plan.', 'Misalnya: pemilik risiko belum menyetujui rencana penanganan.'],
  consistency: [
    'Checkpoint phase {phase}: {blocked} blocked activities and {open} open checkpoint items.',
    'Fase checkpoint {phase}: {blocked} aktivitas diblokir dan {open} item checkpoint terbuka.',
  ],
  mismatch: [
    'The number of blocked activities does not match the open checkpoint items. Check the blocking references.',
    'Jumlah aktivitas yang terblokir tidak sesuai dengan item checkpoint yang terbuka. Periksa rujukan pemblokirannya.',
  ],
  recordButton: ['Record blocker', 'Catat blokir'],
  recorded: ['Blocker recorded and linked to checkpoint item {gate}', 'Blokir dicatat dan ditautkan ke item checkpoint {gate}'],
  gateRequired: ['Choose the checkpoint item that holds this activity.', 'Pilih item checkpoint yang menahan aktivitas ini.'],
  reasonRequired: ['Say what is holding this activity, in up to 1,000 characters.', 'Sebutkan apa yang menahan aktivitas ini, hingga 1.000 karakter.'],
  noPermission: ['Only the activity owner or the Management System Manager records a blocker.', 'Hanya pemilik aktivitas atau Management System Manager yang mencatat blokir.'],
  notFound: ['This activity was not found. Load the page again and try again.', 'Aktivitas ini tidak ditemukan. Muat ulang halaman lalu coba lagi.'],
  // The Milestone 1 toast of the sample build (`toastBlocker` of static.js).
  sampleBlockerToast: ['Blocker recorded and linked to the checkpoint item', 'Blokir dicatat dan ditautkan ke item checkpoint'],
} as const satisfies Record<string, readonly [string, string]>;
