// The XLSX templates of the bulk import (Milestone 2 D.1, M2-08): a first sheet with the header row of the matching
// export (the Statement of Applicability for applicability, the document register for documents, `import-columns.ts`)
// and no data rows, and an "Allowed values" sheet that explains every column and lists the values of the system's
// edition (frequencies, document types, classifications, risk profiles with their scales, treatment options, and the
// controls and clauses for applicability and evidence). The reader skips that sheet (`HELP_SHEET_NAMES`). Every cell
// is written through the F.15 helpers, so no text becomes a formula. No person is listed: the template is open to
// everyone who reads the system, external auditors included.
import { CLASSIFICATIONS, type ImportKind } from '@mscd/shared';
import ExcelJS from 'exceljs';
import { addSafeRow } from '../../common/spreadsheet-safe';
import { KIND_COLUMNS, KIND_NAMES, SHEET_NAMES, YES_NO, type Pair } from './import-columns';
import { HELP_SHEET_NAMES } from './import-file';
import { businessId, type ImportLookups } from './import-lookups';

export type TemplateLang = 'en' | 'id';

const T = {
  column: ['Column', 'Kolom'],
  required: ['Required', 'Wajib'],
  takes: ['What it takes', 'Isian'],
  yes: ['Yes', 'Ya'],
  no: ['No', 'Tidak'],
  code: ['Code', 'Kode'],
  label: ['Name', 'Nama'],
  title: ['Title', 'Judul'],
  scale: ['Likelihood and consequence scale', 'Skala kemungkinan dan dampak'],
  frequencies: ['Frequencies', 'Frekuensi'],
  docTypes: ['Document types', 'Jenis dokumen'],
  classifications: ['Classifications', 'Klasifikasi'],
  profiles: ['Risk profiles', 'Profil risiko'],
  treatments: ['Treatment options', 'Opsi penanganan'],
  targets: ['Controls and clauses of the edition', 'Kontrol dan klausul dari edisi'],
  intro: [
    'One row per record after the header row of the first sheet. Keep the header row as it is; columns may be left out except the required ones. The file is checked first and nothing changes until you confirm the import.',
    'Satu baris per catatan setelah baris judul pada lembar pertama. Biarkan baris judul apa adanya; kolom boleh dihilangkan kecuali kolom wajib. Berkas diperiksa terlebih dahulu dan tidak ada yang berubah sampai Anda mengonfirmasi impor.',
  ],
  limits: ['At most 5,000 rows and 5 MB per file, as XLSX or CSV (UTF-8).', 'Paling banyak 5.000 baris dan 5 MB per berkas, sebagai XLSX atau CSV (UTF-8).'],
} as const satisfies Record<string, Pair>;

const CLASSIFICATION_LABELS: Readonly<Record<(typeof CLASSIFICATIONS)[number], Pair>> = {
  public: ['Public', 'Publik'],
  internal: ['Internal', 'Internal'],
  confidential: ['Confidential', 'Rahasia'],
  restricted: ['Restricted', 'Terbatas'],
};

/** Columns of the kind whose values the Allowed values sheet lists. */
const LISTS: Readonly<Record<ImportKind, readonly ('frequencies' | 'docTypes' | 'classifications' | 'profiles' | 'treatments' | 'targets' | 'yesNo')[]>> = {
  applicability: ['yesNo', 'frequencies', 'targets'],
  documents: ['docTypes', 'classifications', 'yesNo'],
  risks: ['profiles', 'treatments', 'yesNo'],
  evidence: ['frequencies', 'classifications', 'targets'],
};

/** The file name of a template: `<system code>-import-<kind>.xlsx`. */
export function templateFileName(systemCode: string, kind: ImportKind): string {
  return `${systemCode.replace(/[^A-Za-z0-9_-]+/g, '-')}-import-${kind}.xlsx`;
}

/** The template of `kind` for the system of `lookups`, in `lang`, as XLSX bytes. */
export async function templateXlsx(kind: ImportKind, lookups: ImportLookups, lang: TemplateLang, meta: { creator: string; created: Date }): Promise<Buffer> {
  const l = (p: Pair) => p[lang === 'id' ? 1 : 0];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.creator;
  workbook.created = meta.created;
  workbook.modified = meta.created;

  const columns = KIND_COLUMNS[kind];
  const sheet = workbook.addWorksheet(l(SHEET_NAMES[kind]).slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ width: c.width }));
  const header = addSafeRow(sheet, columns.map((c) => l(c.header)));
  header.font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const help = workbook.addWorksheet(HELP_SHEET_NAMES[lang === 'id' ? 1 : 0]!);
  help.columns = [{ width: 30 }, { width: 14 }, { width: 90 }];
  const bold = (values: unknown[]) => {
    addSafeRow(help, values).font = { bold: true };
  };
  bold([`${l(KIND_NAMES[kind])}: ${lookups.system.code} ${lookups.system.name}`]);
  addSafeRow(help, [l(T.intro)]);
  addSafeRow(help, [l(T.limits)]);
  addSafeRow(help, []);
  bold([l(T.column), l(T.required), l(T.takes)]);
  for (const c of columns) addSafeRow(help, [l(c.header), c.required === 'always' ? l(T.yes) : '', l(c.help)]);

  const list = (title: Pair, head: Pair[], rows: unknown[][]) => {
    addSafeRow(help, []);
    bold([l(title)]);
    bold(head.map(l));
    for (const r of rows) addSafeRow(help, r);
  };
  for (const which of LISTS[kind]) {
    switch (which) {
      case 'yesNo':
        list(YES_NO, [T.code], [[l(T.yes)], [l(T.no)]]);
        break;
      case 'frequencies':
        list(T.frequencies, [T.code, T.label], lookups.frequencies.map((f) => [f.code, lang === 'id' ? f.labelId : f.labelEn]));
        break;
      case 'docTypes':
        list(T.docTypes, [T.code, T.label], lookups.docTypes.map((f) => [f.code, lang === 'id' ? f.labelId : f.labelEn]));
        break;
      case 'classifications':
        list(T.classifications, [T.code, T.label], CLASSIFICATIONS.map((c) => [c, l(CLASSIFICATION_LABELS[c])]));
        break;
      case 'profiles':
        list(T.profiles, [T.code, T.scale], lookups.profiles.map((p) => [p.code, `${p.likelihood.min}-${p.likelihood.max} / ${p.consequence.min}-${p.consequence.max}`]));
        break;
      case 'treatments':
        list(T.treatments, [T.code, T.label], lookups.treatmentOptions.map((f) => [f.code, lang === 'id' ? f.labelId : f.labelEn]));
        break;
      case 'targets':
        list(T.targets, [T.code, T.title], [...lookups.targets.values()].filter((t) => t.leaf && !t.retired).map((t) => [businessId(t), t.title]));
        break;
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
