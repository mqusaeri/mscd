// Columns of the import files (Milestone 2 D.1, M2-08). The templates start with the header row of the existing
// exports (the Statement of Applicability for `applicability`, the document register for `documents`, F.15 writers in
// modules/exports), so an export imports again as it is; columns the import needs and the export does not have follow
// them. A column of the export that describes state the import does not set (status, versions, freshness) is read
// only: it may be in the file and is ignored. A header matches in English or Indonesian, in any case and spacing.
import type { ImportKind, Messages } from '@mscd/shared';
import { unreadable } from './import-file';

export type Pair = readonly [en: string, id: string];

export interface ColumnDef {
  /** Key of the value in the row (`read` columns). */
  key: string;
  /** Header in English and Indonesian (the export's header for export columns). */
  header: Pair;
  /** `read`: the import takes the value; `ignored`: a read-only column of the export. */
  use: 'read' | 'ignored';
  /** `always`: the file must have the column (the template marks it with an asterisk in the Allowed values sheet). */
  required?: 'always';
  /** Width in the template. */
  width: number;
  /** What the column takes, for the Allowed values sheet. */
  help: Pair;
}

export const YES_NO: Pair = ['Yes or No', 'Ya atau Tidak'];
const PERSON: Pair = ['Handle, email or full name of an active member of the organisation', 'Handle, email atau nama lengkap anggota aktif organisasi'];
const DATE: Pair = ['A date as YYYY-MM-DD (or a date cell)', 'Tanggal sebagai YYYY-MM-DD (atau sel tanggal)'];
const READ_ONLY: Pair = ['Read only: ignored by the import', 'Hanya baca: diabaikan oleh impor'];

/** SoA columns of the export (exports/export-content.service.ts `soaColumns`), then the import's own. */
const APPLICABILITY: readonly ColumnDef[] = [
  { key: 'code', header: ['ID', 'ID'], use: 'read', required: 'always', width: 12, help: ['Control or clause code of the edition in use, for example A.5.1 or Cl. 4.1', 'Kode kontrol atau klausul dari edisi yang digunakan, misalnya A.5.1 atau Cl. 4.1'] },
  { key: 'title', header: ['Title', 'Judul'], use: 'ignored', width: 44, help: READ_ONLY },
  { key: 'theme', header: ['Theme', 'Tema'], use: 'ignored', width: 22, help: READ_ONLY },
  { key: 'applicable', header: ['Applicable', 'Berlaku'], use: 'read', width: 11, help: ['Yes or No. A new entry without a value applies', 'Ya atau Tidak. Entri baru tanpa nilai dianggap berlaku'] },
  { key: 'justification', header: ['Justification', 'Justifikasi'], use: 'read', width: 48, help: ['Why it applies, or why it does not apply (required when Applicable is No)', 'Mengapa berlaku, atau mengapa tidak berlaku (wajib bila Berlaku bernilai Tidak)'] },
  { key: 'status', header: ['Status', 'Status'], use: 'ignored', width: 24, help: ['Read only: the status changes through the workflow on screen', 'Hanya baca: status berubah melalui alur kerja di layar'] },
  { key: 'owner', header: ['Owner', 'Pemilik'], use: 'read', width: 22, help: [`${PERSON[0]}; none leaves it unassigned`, `${PERSON[1]}; none berarti belum ditugaskan`] },
  { key: 'documents', header: ['Implementing document', 'Dokumen pelaksana'], use: 'read', width: 20, help: ['Document codes of the system to link, separated by commas; documents already linked stay linked', 'Kode dokumen dari sistem yang ditautkan, dipisahkan koma; dokumen yang sudah tertaut tetap tertaut'] },
  { key: 'frequency', header: ['Frequency', 'Frekuensi'], use: 'read', width: 14, help: ['Evidence frequency (see the list below); required for a new entry', 'Frekuensi bukti (lihat daftar di bawah); wajib untuk entri baru'] },
  { key: 'lastEvidence', header: ['Last evidence', 'Bukti terakhir'], use: 'ignored', width: 14, help: READ_ONLY },
  { key: 'freshness', header: ['Freshness', 'Kesegaran'], use: 'ignored', width: 12, help: READ_ONLY },
  { key: 'integrity', header: ['Integrity', 'Integritas'], use: 'ignored', width: 12, help: READ_ONLY },
  { key: 'risks', header: ['Risks', 'Risiko'], use: 'read', width: 18, help: ['Risk codes of the system that justify the entry, separated by commas; risks already linked stay linked', 'Kode risiko dari sistem yang menjadi dasar entri, dipisahkan koma; risiko yang sudah tertaut tetap tertaut'] },
  { key: 'note', header: ['Status note', 'Catatan status'], use: 'read', width: 30, help: ['A short note on the progress', 'Catatan singkat tentang kemajuan'] },
];

/** Document register columns of the export (`docColumns`), then the import's own. */
const DOCUMENTS: readonly ColumnDef[] = [
  { key: 'code', header: ['ID', 'ID'], use: 'read', required: 'always', width: 12, help: ['Document code, unique in the organisation, for example POL-01', 'Kode dokumen, unik di organisasi, misalnya POL-01'] },
  { key: 'title', header: ['Title', 'Judul'], use: 'read', required: 'always', width: 44, help: ['Title of the document', 'Judul dokumen'] },
  { key: 'type', header: ['Type', 'Jenis'], use: 'read', required: 'always', width: 14, help: ['Document type (see the list below)', 'Jenis dokumen (lihat daftar di bawah)'] },
  { key: 'version', header: ['Version', 'Versi'], use: 'ignored', width: 9, help: ['Read only: the import registers the document; versions and files are added on screen', 'Hanya baca: impor mendaftarkan dokumen; versi dan berkas ditambahkan di layar'] },
  { key: 'status', header: ['Status', 'Status'], use: 'ignored', width: 12, help: ['Read only: a new document starts as a draft', 'Hanya baca: dokumen baru dimulai sebagai draf'] },
  { key: 'approved', header: ['Approved', 'Disetujui'], use: 'ignored', width: 13, help: READ_ONLY },
  { key: 'nextReview', header: ['Next review', 'Tinjauan berikutnya'], use: 'read', width: 13, help: DATE },
  { key: 'owner', header: ['Owner', 'Pemilik'], use: 'read', width: 22, help: [`${PERSON[0]}; none leaves it unassigned`, `${PERSON[1]}; none berarti belum ditugaskan`] },
  { key: 'shared', header: ['Shared', 'Dibagikan'], use: 'ignored', width: 10, help: ['Read only: use Organisation-wide or System', 'Hanya baca: gunakan Seluruh organisasi atau Sistem'] },
  { key: 'systems', header: ['System', 'Sistem'], use: 'read', width: 14, help: ['Systems the document belongs to (slug or code, separated by commas); this system is always one of them', 'Sistem tempat dokumen berada (slug atau kode, dipisahkan koma); sistem ini selalu termasuk'] },
  { key: 'classification', header: ['Classification', 'Klasifikasi'], use: 'read', width: 14, help: ['public, internal, confidential or restricted; internal when empty', 'public, internal, confidential atau restricted; internal bila kosong'] },
  { key: 'approver', header: ['Approver', 'Penyetuju'], use: 'read', width: 22, help: PERSON },
  { key: 'orgWide', header: ['Organisation-wide', 'Seluruh organisasi'], use: 'read', width: 12, help: ['Yes when the document applies to every system; No when empty', 'Ya bila dokumen berlaku untuk semua sistem; Tidak bila kosong'] },
  { key: 'origin', header: ['Origin', 'Asal'], use: 'read', width: 12, help: ['Internal or External; Internal when empty', 'Internal atau Eksternal; Internal bila kosong'] },
  { key: 'externalSource', header: ['External source', 'Sumber eksternal'], use: 'read', width: 22, help: ['Who issued an external document (required for External)', 'Penerbit dokumen eksternal (wajib untuk Eksternal)'] },
  { key: 'externalRef', header: ['External reference', 'Referensi eksternal'], use: 'read', width: 16, help: ['The issuer\'s reference of an external document', 'Referensi penerbit untuk dokumen eksternal'] },
  { key: 'receivedAt', header: ['Received', 'Diterima'], use: 'read', width: 13, help: DATE },
];

const RISKS: readonly ColumnDef[] = [
  { key: 'code', header: ['ID', 'ID'], use: 'read', required: 'always', width: 12, help: ['Risk code, unique in the organisation, for example R-040', 'Kode risiko, unik di organisasi, misalnya R-040'] },
  { key: 'title', header: ['Title', 'Judul'], use: 'read', required: 'always', width: 44, help: ['Title of the risk', 'Judul risiko'] },
  { key: 'owner', header: ['Owner', 'Pemilik'], use: 'read', required: 'always', width: 22, help: ['Risk owner: handle, email or full name of an active member (BR-17)', 'Pemilik risiko: handle, email atau nama lengkap anggota aktif (BR-17)'] },
  { key: 'description', header: ['Description', 'Deskripsi'], use: 'read', width: 44, help: ['What can happen and why', 'Apa yang dapat terjadi dan mengapa'] },
  { key: 'profile', header: ['Risk profile', 'Profil risiko'], use: 'read', width: 18, help: ['Risk profile of the edition (see the list below); needed when the edition has several', 'Profil risiko dari edisi (lihat daftar di bawah); wajib bila edisi memiliki beberapa'] },
  { key: 'opportunity', header: ['Opportunity', 'Peluang'], use: 'read', width: 11, help: ['Yes for an opportunity; No when empty', 'Ya untuk peluang; Tidak bila kosong'] },
  { key: 'likelihood', header: ['Likelihood', 'Kemungkinan'], use: 'read', width: 11, help: ['A whole number on the likelihood scale of the profile', 'Bilangan bulat pada skala kemungkinan profil'] },
  { key: 'consequence', header: ['Consequence', 'Dampak'], use: 'read', width: 11, help: ['A whole number on the consequence scale of the profile', 'Bilangan bulat pada skala dampak profil'] },
  { key: 'treatment', header: ['Treatment option', 'Opsi penanganan'], use: 'read', width: 16, help: ['Treatment option of the edition (see the list below)', 'Opsi penanganan dari edisi (lihat daftar di bawah)'] },
  { key: 'assessedAt', header: ['Assessed', 'Dinilai'], use: 'read', width: 13, help: DATE },
  { key: 'nextReview', header: ['Next review', 'Tinjauan berikutnya'], use: 'read', width: 13, help: DATE },
  { key: 'residualLikelihood', header: ['Residual likelihood', 'Kemungkinan residual'], use: 'read', width: 12, help: ['A whole number on the likelihood scale of the profile', 'Bilangan bulat pada skala kemungkinan profil'] },
  { key: 'residualConsequence', header: ['Residual consequence', 'Dampak residual'], use: 'read', width: 12, help: ['A whole number on the consequence scale of the profile', 'Bilangan bulat pada skala dampak profil'] },
];

const EVIDENCE: readonly ColumnDef[] = [
  { key: 'code', header: ['ID', 'ID'], use: 'read', required: 'always', width: 12, help: ['Evidence code, unique in the organisation, for example EV-0500', 'Kode bukti, unik di organisasi, misalnya EV-0500'] },
  { key: 'title', header: ['Title', 'Judul'], use: 'read', required: 'always', width: 44, help: ['What the evidence shows', 'Apa yang ditunjukkan bukti'] },
  { key: 'owner', header: ['Owner', 'Pemilik'], use: 'read', width: 22, help: [`${PERSON[0]}; none leaves it unassigned`, `${PERSON[1]}; none berarti belum ditugaskan`] },
  { key: 'frequency', header: ['Frequency', 'Frekuensi'], use: 'read', required: 'always', width: 14, help: ['Evidence frequency (see the list below)', 'Frekuensi bukti (lihat daftar di bawah)'] },
  { key: 'classification', header: ['Classification', 'Klasifikasi'], use: 'read', width: 14, help: ['public, internal, confidential or restricted; internal when empty', 'public, internal, confidential atau restricted; internal bila kosong'] },
  { key: 'targets', header: ['Controls and clauses', 'Kontrol dan klausul'], use: 'read', required: 'always', width: 30, help: ['Codes of the controls or clauses of this system it proves, separated by commas', 'Kode kontrol atau klausul dari sistem ini yang dibuktikannya, dipisahkan koma'] },
];

export const KIND_COLUMNS: Readonly<Record<ImportKind, readonly ColumnDef[]>> = {
  applicability: APPLICABILITY,
  documents: DOCUMENTS,
  risks: RISKS,
  evidence: EVIDENCE,
};

/** Sheet names of the templates (the export's for SoA and the document register). */
export const SHEET_NAMES: Readonly<Record<ImportKind, Pair>> = {
  applicability: ['Statement of Applicability', 'Pernyataan Keberlakuan'],
  documents: ['Document register', 'Daftar dokumen'],
  risks: ['Risk register', 'Daftar risiko'],
  evidence: ['Evidence', 'Bukti'],
};

/** Display names of the kinds, in both languages. */
export const KIND_NAMES: Readonly<Record<ImportKind, Pair>> = {
  applicability: ['Controls and requirements', 'Kontrol dan persyaratan'],
  documents: ['Documents', 'Dokumen'],
  risks: ['Risks', 'Risiko'],
  evidence: ['Evidence', 'Bukti'],
};

/** A header as compared: lower case, single spaces, without the marks people add (`*`, `:`, brackets). */
export function headerKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[*:()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Where each column of the kind sits in the file (a column the file does not have is not in the map), checked against
 * the template: every header must be a column of the kind, each once, and the required columns must be there.
 */
export function mapColumns(kind: ImportKind, headers: readonly string[]): Map<string, number> {
  const columns = KIND_COLUMNS[kind];
  const byHeader = new Map<string, ColumnDef>();
  for (const c of columns) for (const h of c.header) byHeader.set(headerKey(h), c);
  const at = new Map<string, number>();
  const unknown: string[] = [];
  const twice: string[] = [];
  headers.forEach((h, i) => {
    if (headerKey(h) === '') return;
    const column = byHeader.get(headerKey(h));
    if (!column) unknown.push(h);
    else if (at.has(column.key)) twice.push(h);
    else at.set(column.key, i);
  });
  const missing = columns.filter((c) => c.required === 'always' && !at.has(c.key)).map((c) => c.header[0]);
  const problems: Messages[] = [];
  if (unknown.length > 0) {
    problems.push({ en: `Columns that are not in the template: ${unknown.join(', ')}`, id: `Kolom yang tidak ada di templat: ${unknown.join(', ')}` });
  }
  if (twice.length > 0) problems.push({ en: `Columns given twice: ${twice.join(', ')}`, id: `Kolom yang muncul dua kali: ${twice.join(', ')}` });
  if (missing.length > 0) problems.push({ en: `Required columns missing: ${missing.join(', ')}`, id: `Kolom wajib tidak ada: ${missing.join(', ')}` });
  if (problems.length > 0) {
    throw unreadable('imports.header_mismatch', {
      en: `The header row does not match the template. ${problems.map((p) => p.en).join('. ')}.`,
      id: `Baris judul tidak sesuai dengan templat. ${problems.map((p) => p.id).join('. ')}.`,
    });
  }
  return at;
}
