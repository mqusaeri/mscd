// Fixed texts of the UI kit, in English and Indonesian (D2-01), and the language helpers its components use.
import { useContext } from 'react';
import type { Lang } from '../types';
import { HostCtx } from './host-context';

/** A text: an [English, Indonesian] pair or one string (shown as it is in both languages). */
export type TextLike = string | readonly [string, string];

export const UI_TEXT = {
  cancel: ['Cancel', 'Batal'],
  close: ['Close', 'Tutup'],
  confirm: ['Confirm', 'Konfirmasi'],
  save: ['Save', 'Simpan'],
  saving: ['Saving', 'Menyimpan'],
  loading: ['Loading', 'Memuat'],
  required: ['Required', 'Wajib'],
  requiredMark: ['required', 'wajib'],
  noRows: ['Nothing to show yet', 'Belum ada yang dapat ditampilkan'],
  search: ['Search', 'Cari'],
  choose: ['Choose', 'Pilih'],
  none: ['None', 'Tidak ada'],
  previous: ['Previous', 'Sebelumnya'],
  next: ['Next', 'Berikutnya'],
  page: ['Page {page} of {pages}', 'Halaman {page} dari {pages}'],
  typeToConfirm: ['Type {text} to confirm', 'Ketik {text} untuk mengonfirmasi'],
  noMatch: ['No match', 'Tidak ada yang cocok'],
  selected: ['Selected', 'Dipilih'],
  chooseFile: ['Choose file', 'Pilih berkas'],
  noFile: ['No file chosen', 'Belum ada berkas dipilih'],
  failed: ['This part of the page could not be shown.', 'Bagian halaman ini tidak dapat ditampilkan.'],
} as const satisfies Record<string, readonly [string, string]>;

/** The text of a pair (or a plain string) in `lang`. */
export function textOf(text: TextLike | null | undefined, lang: Lang): string {
  if (text === null || text === undefined) return '';
  return Array.isArray(text) ? text[lang === 'id' ? 1 : 0] : String(text);
}

/** `textOf` with `{name}` placeholders replaced. */
export function fillText(text: TextLike, values: Record<string, string | number>, lang: Lang): string {
  return textOf(text, lang).replace(/\{(\w+)\}/g, (m, name: string) => (name in values ? String(values[name]) : m));
}

/** The interface language of the host context; English outside a host screen. */
export function useLang(): Lang {
  return useContext(HostCtx)?.lang ?? 'en';
}

/** A text function bound to the interface language. */
export function useText(): (text: TextLike | null | undefined) => string {
  const lang = useLang();
  return (text) => textOf(text, lang);
}
