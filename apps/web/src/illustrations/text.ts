// Texts of the illustration scenes in English and Indonesian (MILESTONE-2 MOT-03, D2-01): the name of each scene, its
// text alternative and where a screen uses it. `{done}` and `{steps}` in the Getting started text are filled in.
import type { SceneName } from './scenes';

type Pair = readonly [en: string, id: string];

export interface SceneText {
  /** Short name, for the gallery. */
  title: Pair;
  /** The text alternative of the picture (`aria-label`). */
  alt: Pair;
  /** Where screens use the scene. */
  use: Pair;
}

export const SCENE_TEXT: Readonly<Record<SceneName, SceneText>> = {
  'getting-started': {
    title: ['Getting started', 'Memulai'],
    alt: ['A path of steps rising to a flag. {done} of {steps} steps are lit.', 'Jalur langkah yang naik menuju bendera. {done} dari {steps} langkah menyala.'],
    use: ['The Getting started page. One more step lights up as the checklist gets done.', 'Halaman Memulai. Satu langkah lagi menyala setiap kali daftar periksa makin selesai.'],
  },
  'no-systems': {
    title: ['No management systems yet', 'Belum ada sistem manajemen'],
    alt: ['Four empty tiles for management systems, the first one ready to add.', 'Empat petak kosong untuk sistem manajemen, petak pertama siap ditambahkan.'],
    use: ['Pages that need a management system before the first one is added.', 'Halaman yang memerlukan sistem manajemen sebelum sistem pertama ditambahkan.'],
  },
  'no-documents': {
    title: ['No documents yet', 'Belum ada dokumen'],
    alt: ['An empty page with a plus sign, waiting for the first document.', 'Halaman kosong dengan tanda tambah, menunggu dokumen pertama.'],
    use: ['The document register and document lists with nothing in them.', 'Register dokumen dan daftar dokumen yang masih kosong.'],
  },
  'no-evidence': {
    title: ['No evidence yet', 'Belum ada bukti'],
    alt: ['An empty file above an open folder, waiting for the first evidence.', 'Berkas kosong di atas map terbuka, menunggu bukti pertama.'],
    use: ['Evidence lists and file lists with no files linked yet.', 'Daftar bukti dan daftar berkas yang belum memiliki berkas tertaut.'],
  },
  'no-findings': {
    title: ['No findings', 'Tidak ada temuan'],
    alt: ['A clipboard with every check ticked and a magnifying glass that found nothing.', 'Papan klip dengan semua pemeriksaan tercentang dan kaca pembesar yang tidak menemukan apa pun.'],
    use: ['Finding and corrective action lists when an audit raised nothing.', 'Daftar temuan dan tindakan korektif ketika audit tidak menemukan apa pun.'],
  },
  'all-done': {
    title: ['All done', 'Semua selesai'],
    alt: ['A chain of six steps, all lit, ending in a seal with a tick.', 'Rantai enam langkah, semuanya menyala, berakhir pada segel bercentang.'],
    use: ['Task lists and checklists when nothing is left to do.', 'Daftar tugas dan daftar periksa ketika tidak ada lagi yang perlu dikerjakan.'],
  },
  error: {
    title: ['Something went wrong', 'Terjadi kesalahan'],
    alt: ['A page panel whose thread is broken, with a warning sign on its corner.', 'Panel halaman yang benangnya putus, dengan tanda peringatan di sudutnya.'],
    use: ['A part of a page that could not be loaded, next to a Try again button.', 'Bagian halaman yang tidak dapat dimuat, di samping tombol Coba lagi.'],
  },
  offline: {
    title: ['Connection lost', 'Koneksi terputus'],
    alt: ['A cable pulled out of its socket, below a cloud that cannot be reached.', 'Kabel yang tercabut dari soketnya, di bawah awan yang tidak dapat dijangkau.'],
    use: ['The connection to the server is lost, next to a Try again button.', 'Koneksi ke server terputus, di samping tombol Coba lagi.'],
  },
};
