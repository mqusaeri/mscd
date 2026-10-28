// Helpers of the auditor workspace screens (MILESTONE-2 M2-15), used by Auditor access and Audit trail: date and time
// of an instant in the interface language, and saving a file the browser builds or the api serves.
import type { Lang } from '../types';

/** An instant as `29 Sep 2026, 06:00` (English) or `29 Sep 2026 06.00` (Indonesian), in the browser's time zone. */
export function formatInstant(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '-';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '-';
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

/** A file to save: an api link (the session cookie goes with it) or a file made in the browser (`release` frees it). */
export interface Download {
  href: string;
  fileName: string;
  release?: () => void;
}

/** A file made in the browser from text. */
export function textFile(text: string, fileName: string, type: string): Download {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Blob === 'undefined') return { href: `data:${type},${encodeURIComponent(text)}`, fileName };
  const href = URL.createObjectURL(new Blob([text], { type }));
  return { href, fileName, release: () => URL.revokeObjectURL(href) };
}

/** Saves a file through a hidden link with the `download` attribute. */
export function saveFile(file: Download): void {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = file.href;
  a.download = file.fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (file.release) setTimeout(file.release, 1000);
}
