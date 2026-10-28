// Texts of the notification bell and its panel in English and Indonesian (D2-01).
export const TEXT = {
  bell: ['Notifications', 'Notifikasi'],
  bellUnread: ['Notifications, {n} unread', 'Notifikasi, {n} belum dibaca'],
  title: ['Notifications', 'Notifikasi'],
  crumb: ['Your notifications in this organisation', 'Notifikasi Anda di organisasi ini'],
  unreadOnly: ['Show unread only', 'Tampilkan yang belum dibaca saja'],
  markRead: ['Mark read', 'Tandai dibaca'],
  markAllRead: ['Mark all read', 'Tandai semua dibaca'],
  allMarked: ['Every notification is marked read', 'Semua notifikasi ditandai dibaca'],
  open: ['Open', 'Buka'],
  unread: ['New', 'Baru'],
  loading: ['Loading notifications', 'Memuat notifikasi'],
  loadFailed: ['The notifications could not be loaded.', 'Notifikasi tidak dapat dimuat.'],
  tryAgain: ['Try again', 'Coba lagi'],
  emptyTitle: ['You are all caught up', 'Semua sudah Anda baca'],
  emptyText: ['New reminders, review dates and approvals show here.', 'Pengingat, tanggal review dan persetujuan baru tampil di sini.'],
  emptyUnread: ['No unread notifications. Clear the filter to see the read ones.', 'Tidak ada notifikasi yang belum dibaca. Hapus filter untuk melihat yang sudah dibaca.'],
} as const satisfies Record<string, readonly [string, string]>;
