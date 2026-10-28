// Reading an import file (Milestone 2 D.1, M2-08): CSV or XLSX, at most 5 MB and 5,000 data rows. The first row
// that is not empty is the header; every later row that is not empty is a data row, numbered from the header (row 1
// is the line after it), so a row number points at the same line in the spreadsheet even when blank lines sit in
// between. Every cell is read as text:
// - a formula cell is read as its formula text (`=SUM(A1:A3)`), never as its cached result (F.15), so a formula in
//   a justification is stored as text and an export neutralises it again;
// - a cell the exports neutralised (`'=HYPERLINK(...)`, F.15) gets its leading quote back off, so an export imports
//   as the text it showed;
// - a date cell is `YYYY-MM-DD`, a number its decimal text, rich text and links their plain text.
// The row limit counts data rows (records with text), never physical lines: a quoted CSV cell may hold line breaks,
// so a file is read whole or refused with 413, never cut off. An XLSX file is a ZIP archive: its entries are inflated
// off the event loop with a ceiling first, so a small file that expands to gigabytes is refused before exceljs reads it.
import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, type Messages } from '@mscd/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { ProblemError } from '../../common/problems';

/** Largest size the entries of an XLSX file may expand to. */
export const MAX_XLSX_EXPANDED_BYTES = 64 * 1024 * 1024;

/** Most columns read from a row. */
export const MAX_IMPORT_COLUMNS = 60;

const inflateRawAsync = promisify(inflateRaw);

export type ImportFileFormat = 'xlsx' | 'csv';

export interface ImportFileRow {
  /** 1 for the first line after the header. */
  row: number;
  /** One text per header column ('' for an empty cell). */
  cells: string[];
}

export interface ImportFile {
  format: ImportFileFormat;
  /** Header texts as written in the file. */
  headers: string[];
  rows: ImportFileRow[];
}

/** 422 for a file that cannot be read, with the reason in both languages. */
export function unreadable(messageKey: string, messages: Messages): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages, detail: messages.en });
}

/** 413 with the size or row limit in both languages. */
function tooLarge(messageKey: string, messages: Messages): ProblemError {
  return new ProblemError('payload-too-large', { messageKey, messages, detail: messages.en });
}

/** 413 for a file found to hold more data rows than the limit while it is read. */
function tooManyRows(): ProblemError {
  return tooLarge('imports.too_many_rows', {
    en: `The file has more than ${MAX_IMPORT_ROWS.toLocaleString('en')} rows. Split it into several files.`,
    id: `Berkas memiliki lebih dari ${MAX_IMPORT_ROWS.toLocaleString('id')} baris. Bagi menjadi beberapa berkas.`,
  });
}

/** True for a row with text in at least one cell (a blank row is skipped and not counted). */
function hasText(cells: readonly string[]): boolean {
  return cells.some((c) => c.trim() !== '');
}

/** Thrown from the CSV parser's record callback once the data rows pass the limit. */
class TooManyRows extends Error {}

const FORMULA_START = /^[=+\-@\t\r]/;

/** The text of a neutralised cell (F.15: a leading quote before a formula start) without the quote. */
export function unneutralise(text: string): string {
  return text.startsWith("'") && FORMULA_START.test(text.slice(1)) ? text.slice(1) : text;
}

/** A local date of an exceljs date cell (exceljs reads dates as UTC instants). */
function isoDay(date: Date): string {
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** The text of one exceljs cell (formula cells as their formula text, F.15). */
export function cellText(cell: ExcelJS.Cell): string {
  if (cell.type === ExcelJS.ValueType.Formula) {
    const formula = cell.formula;
    return formula ? `=${formula}` : '';
  }
  return valueText(cell.value);
}

function valueText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return unneutralise(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return isoDay(value);
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if (typeof v.formula === 'string' || typeof v.sharedFormula === 'string') return typeof v.formula === 'string' ? `=${v.formula}` : '';
    if (Array.isArray(v.richText)) return unneutralise((v.richText as { text?: unknown }[]).map((r) => String(r.text ?? '')).join(''));
    if (v.text !== undefined) return valueText(v.text as ExcelJS.CellValue);
    if (typeof v.error === 'string') return v.error;
  }
  return '';
}

/**
 * Inflates every entry of a ZIP archive with a ceiling on the total size (off the event loop), so an archive that
 * expands far beyond `max` is refused before a reader keeps it in memory. Archives exceljs could not read either
 * (no central directory, ZIP64, unknown compression) are refused as unreadable.
 */
export async function assertZipExpandsWithin(bytes: Buffer, max: number): Promise<void> {
  const notXlsx = () => unreadable('imports.unreadable_xlsx', {
    en: 'The file is not a readable XLSX workbook. Save it again as an Excel workbook (.xlsx) or as CSV.',
    id: 'Berkas bukan buku kerja XLSX yang dapat dibaca. Simpan ulang sebagai buku kerja Excel (.xlsx) atau CSV.',
  });
  const expands = () => tooLarge('imports.too_large', {
    en: `The workbook expands to more than ${Math.round(max / 1024 / 1024)} MB. Remove sheets, pictures or formatting, or save it as CSV.`,
    id: `Buku kerja mengembang lebih dari ${Math.round(max / 1024 / 1024)} MB. Hapus lembar, gambar atau format, atau simpan sebagai CSV.`,
  });
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notXlsx();
  const entries = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) throw notXlsx();
    const method = bytes.readUInt16LE(p + 10);
    const compressed = bytes.readUInt32LE(p + 20);
    const nameLength = bytes.readUInt16LE(p + 28);
    const extraLength = bytes.readUInt16LE(p + 30);
    const commentLength = bytes.readUInt16LE(p + 32);
    const local = bytes.readUInt32LE(p + 42);
    if (compressed === 0xffffffff || local === 0xffffffff) throw notXlsx();
    p += 46 + nameLength + extraLength + commentLength;
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw notXlsx();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.length) throw notXlsx();
    if (method === 0) {
      total += compressed;
    } else if (method === 8) {
      let out: Buffer;
      try {
        out = await inflateRawAsync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, max - total) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) throw expands();
        throw notXlsx();
      }
      total += out.length;
    } else {
      throw notXlsx();
    }
    if (total > max) throw expands();
  }
}

/** Trailing empty cells removed. */
function trimRow(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1]!.trim() === '') end -= 1;
  return cells.slice(0, end);
}

/** Header and data rows of the lines of a sheet (each a list of cell texts), with the row limit. */
function toImportFile(format: ImportFileFormat, lines: { line: number; cells: string[] }[]): ImportFile {
  const filled = lines.map((l) => ({ line: l.line, cells: trimRow(l.cells) })).filter((l) => hasText(l.cells));
  const header = filled[0];
  if (!header) {
    throw unreadable('imports.empty_file', {
      en: 'The file is empty. Start from the template: keep its header row and add one row per record.',
      id: 'Berkas kosong. Mulai dari templat: pertahankan baris judulnya dan tambahkan satu baris per catatan.',
    });
  }
  if (header.cells.length > MAX_IMPORT_COLUMNS) {
    throw unreadable('imports.too_many_columns', {
      en: `The header row has more than ${MAX_IMPORT_COLUMNS} columns. Keep the columns of the template.`,
      id: `Baris judul memiliki lebih dari ${MAX_IMPORT_COLUMNS} kolom. Pertahankan kolom dari templat.`,
    });
  }
  const data = filled.slice(1);
  if (data.length > MAX_IMPORT_ROWS) {
    throw tooLarge('imports.too_many_rows', {
      en: `The file has ${data.length} rows; an import takes at most ${MAX_IMPORT_ROWS.toLocaleString('en')}. Split it into several files.`,
      id: `Berkas memiliki ${data.length} baris; satu impor menerima paling banyak ${MAX_IMPORT_ROWS.toLocaleString('id')}. Bagi menjadi beberapa berkas.`,
    });
  }
  const width = header.cells.length;
  return {
    format,
    headers: header.cells.map((c) => c.trim()),
    rows: data.map((l) => ({ row: l.line - header.line, cells: Array.from({ length: width }, (_, i) => (l.cells[i] ?? '').trim()) })),
  };
}

/** Names of the help sheet of the templates, which a reader skips. */
export const HELP_SHEET_NAMES: readonly string[] = ['Allowed values', 'Nilai yang diizinkan'];

async function readXlsx(bytes: Buffer): Promise<ImportFile> {
  await assertZipExpandsWithin(bytes, MAX_XLSX_EXPANDED_BYTES);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw unreadable('imports.unreadable_xlsx', {
      en: 'The file is not a readable XLSX workbook. Save it again as an Excel workbook (.xlsx) or as CSV.',
      id: 'Berkas bukan buku kerja XLSX yang dapat dibaca. Simpan ulang sebagai buku kerja Excel (.xlsx) atau CSV.',
    });
  }
  const sheet = workbook.worksheets.find((w) => !HELP_SHEET_NAMES.includes(w.name.trim()));
  if (!sheet) {
    throw unreadable('imports.empty_file', {
      en: 'The workbook has no sheet with data. Start from the template: keep its header row and add one row per record.',
      id: 'Buku kerja tidak memiliki lembar berisi data. Mulai dari templat: pertahankan baris judulnya dan tambahkan satu baris per catatan.',
    });
  }
  const lines: { line: number; cells: string[] }[] = [];
  // Rows with text: the header and at most MAX_IMPORT_ROWS data rows. Rows whose cells hold only spaces do not count.
  let filled = 0;
  sheet.eachRow({ includeEmpty: false }, (row, line) => {
    if (filled > MAX_IMPORT_ROWS + 1) return;
    const cells: string[] = [];
    const last = Math.min(row.cellCount, MAX_IMPORT_COLUMNS + 1);
    for (let c = 1; c <= last; c += 1) cells.push(cellText(row.getCell(c)));
    if (!hasText(cells)) return;
    filled += 1;
    if (filled <= MAX_IMPORT_ROWS + 1) lines.push({ line, cells });
  });
  if (filled > MAX_IMPORT_ROWS + 1) throw tooManyRows();
  return toImportFile('xlsx', lines);
}

/** The delimiter of a CSV header line: the one of comma, semicolon and tab that occurs most outside quotes. */
export function csvDelimiter(firstLine: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts] += 1;
  }
  return counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
}

function readCsv(bytes: Buffer): ImportFile {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw unreadable('imports.not_utf8', {
      en: 'The CSV file is not UTF-8 text. Save it as "CSV UTF-8" or as an Excel workbook (.xlsx).',
      id: 'Berkas CSV bukan teks UTF-8. Simpan sebagai "CSV UTF-8" atau sebagai buku kerja Excel (.xlsx).',
    });
  }
  if (text.includes('\u0000')) {
    throw unreadable('imports.unsupported_file', {
      en: 'The file is neither CSV nor XLSX. Download the template and save your file as XLSX or CSV.',
      id: 'Berkas bukan CSV maupun XLSX. Unduh templat dan simpan berkas Anda sebagai XLSX atau CSV.',
    });
  }
  // The separator is read from the header: the first line with text (a file may start with blank lines).
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).find((line) => line.trim() !== '') ?? '';
  let records: string[][];
  // Records with text: the header and at most MAX_IMPORT_ROWS data rows. The parser stops at the first record past
  // the limit, so a file of many short rows is refused early; a record is one row however many lines its cells span.
  let filled = 0;
  try {
    records = parseCsv(text, {
      bom: true,
      delimiter: csvDelimiter(firstLine),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      max_record_size: 1_000_000,
      on_record: (record: string[]) => {
        if (hasText(record)) {
          filled += 1;
          if (filled > MAX_IMPORT_ROWS + 1) throw new TooManyRows();
        }
        return record;
      },
    }) as string[][];
  } catch (error) {
    if (error instanceof TooManyRows) throw tooManyRows();
    throw unreadable('imports.unreadable_csv', {
      en: 'The CSV file cannot be read: check the quotes and separators, or save it as an Excel workbook (.xlsx).',
      id: 'Berkas CSV tidak dapat dibaca: periksa tanda kutip dan pemisahnya, atau simpan sebagai buku kerja Excel (.xlsx).',
    });
  }
  return toImportFile('csv', records.map((cells, i) => ({ line: i + 1, cells: cells.map((c) => unneutralise(c)) })));
}

/** The file format of an upload: XLSX for a ZIP archive, CSV for text; refused for anything else. */
export function formatOf(bytes: Buffer, fileName: string): ImportFileFormat {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return 'xlsx';
  const name = fileName.toLowerCase();
  const legacy = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (legacy || name.endsWith('.xls') || name.endsWith('.xlsx') || name.endsWith('.ods')) {
    throw unreadable('imports.unsupported_file', {
      en: 'This spreadsheet format is not supported. Save the file as an Excel workbook (.xlsx) or as CSV.',
      id: 'Format lembar kerja ini tidak didukung. Simpan berkas sebagai buku kerja Excel (.xlsx) atau CSV.',
    });
  }
  return 'csv';
}

/** Reads an upload into its header and data rows (422 for a file that cannot be read, 413 above the limits). */
export async function readImportFile(bytes: Buffer, fileName: string): Promise<ImportFile> {
  if (bytes.length > MAX_IMPORT_BYTES) {
    throw tooLarge('imports.too_large', {
      en: 'The file is larger than 5 MB. Split it into several files.',
      id: 'Berkas lebih besar dari 5 MB. Bagi menjadi beberapa berkas.',
    });
  }
  return formatOf(bytes, fileName) === 'xlsx' ? readXlsx(bytes) : readCsv(bytes);
}
