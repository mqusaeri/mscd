// Reading an import file and matching its header (Milestone 2 D.1, F.15, M2-08), without a database: CSV separators
// and quotes, row numbers across blank lines, formula and neutralised cells, dates and numbers of XLSX cells, the help
// sheet of the template, the row and size limits, an XLSX that expands far beyond its size, and the header rules.
import { deflateRawSync } from 'node:zlib';
import { MAX_IMPORT_ROWS } from '@mscd/shared';
import { describe, expect, it } from 'vitest';
import { mapColumns } from '../../../src/modules/imports/import-columns';
import { assertZipExpandsWithin, csvDelimiter, readImportFile, unneutralise } from '../../../src/modules/imports/import-file';
import { findTarget, splitList, targetKey, yesNo, type ImportTarget } from '../../../src/modules/imports/import-lookups';
import { ProblemError } from '../../../src/common/problems';
import { csvOf, xlsxOf } from './helpers';

const problemOf = async (run: () => Promise<unknown>): Promise<ProblemError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error('no problem was thrown');
};

describe('import file reader (M2-08)', () => {
  it('reads CSV with a byte order mark, quotes, the separator of the header line, and numbers rows from the header', async () => {
    const text = '\uFEFF\r\nID;Justification\r\nA.5.1;"Needed; see ""R-01"""\r\n\r\nA.5.2;"two\nlines"\r\n';
    const file = await readImportFile(Buffer.from(text, 'utf8'), 'soa.csv');
    expect(file.format).toBe('csv');
    expect(file.headers).toEqual(['ID', 'Justification']);
    // Row 1 is the line after the header; a blank line keeps its number, so row 3 is the third line after it.
    expect(file.rows).toEqual([{ row: 1, cells: ['A.5.1', 'Needed; see "R-01"'] }, { row: 3, cells: ['A.5.2', 'two\nlines'] }]);
    expect(csvDelimiter('ID\tTitle\tOwner')).toBe('\t');
    expect(csvDelimiter('"a;b",c')).toBe(',');
  });

  it('reads a formula cell as its formula text, never its result, and takes the quote off a neutralised cell (F.15)', async () => {
    const bytes = await xlsxOf(['ID', 'Justification', 'Status note', 'Next review', 'Likelihood'], [
      ['A.5.1', { formula: 'HYPERLINK("http://x","y")', result: 'y' }, "'=SUM(1)", new Date('2027-03-01T00:00:00Z'), 3],
    ], { help: true });
    const file = await readImportFile(bytes, 'soa.xlsx');
    expect(file.format).toBe('xlsx');
    expect(file.rows[0]!.cells).toEqual(['A.5.1', '=HYPERLINK("http://x","y")', '=SUM(1)', '2027-03-01', '3']);
    expect(unneutralise("'@cmd")).toBe('@cmd');
    expect(unneutralise("'quoted")).toBe("'quoted");
  });

  it('reads the first sheet that is not the Allowed values sheet of the template', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Nilai yang diizinkan').addRow(['Kolom']);
    const data = book.addWorksheet('Daftar risiko');
    data.addRow(['ID', 'Judul']);
    data.addRow(['R-1', 'Risk']);
    const file = await readImportFile(Buffer.from(await book.xlsx.writeBuffer()), 'risks.xlsx');
    expect(file.headers).toEqual(['ID', 'Judul']);
    expect(file.rows).toEqual([{ row: 1, cells: ['R-1', 'Risk'] }]);
  });

  it('refuses more than 5,000 rows, a legacy spreadsheet, text that is not UTF-8 and an empty file', async () => {
    const many = csvOf(['ID'], Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [`R-${i}`]));
    expect(await problemOf(() => readImportFile(many, 'big.csv'))).toMatchObject({ status: 413, extras: { messageKey: 'imports.too_many_rows' } });
    const exact = csvOf(['ID'], Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => [`R-${i}`]));
    expect((await readImportFile(exact, 'ok.csv')).rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(await problemOf(() => readImportFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'old.xls'))).toMatchObject({
      status: 422, extras: { messageKey: 'imports.unsupported_file' },
    });
    expect(await problemOf(() => readImportFile(Buffer.from([0x49, 0x44, 0x0a, 0xff, 0xfe]), 'latin.csv'))).toMatchObject({ extras: { messageKey: 'imports.not_utf8' } });
    expect(await problemOf(() => readImportFile(Buffer.from('\r\n\r\n'), 'empty.csv'))).toMatchObject({ extras: { messageKey: 'imports.empty_file' } });
  });

  it('counts rows, never lines: cells with line breaks are read whole, and the 413 counts data rows only', async () => {
    // 3,000 rows whose second cell holds 10 lines: about 33,000 physical lines, far past 4 lines a row.
    const note = (i: number) => Array.from({ length: 10 }, (_, l) => `Row ${i} paragraph ${l + 1}`).join('\n');
    const tall = csvOf(['ID', 'Status note'], Array.from({ length: 3000 }, (_, i) => [`A.${i + 1}`, note(i + 1)]));
    expect(tall.toString('utf8').split('\n').length).toBeGreaterThan(20_010);
    const read = await readImportFile(tall, 'tall.csv');
    expect(read.rows).toHaveLength(3000);
    expect(read.rows.at(-1)).toEqual({ row: 3000, cells: ['A.3000', note(3000)] });
    // One row past the limit is refused, however many lines the rows span.
    const over = csvOf(['ID', 'Status note'], Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [`A.${i + 1}`, 'one\ntwo\nthree']));
    expect(await problemOf(() => readImportFile(over, 'over.csv'))).toMatchObject({ status: 413, extras: { messageKey: 'imports.too_many_rows' } });
    // Blank lines and rows of empty cells do not count toward the limit.
    const rows: (string | number)[][] = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => [`R-${i + 1}`, `Risk ${i + 1}`]);
    const gappy = csvOf(['ID', 'Title'], rows.flatMap((r, i) => (i % 50 === 0 ? [r, ['', ' ']] : [r])));
    const full = await readImportFile(gappy, 'gaps.csv');
    expect(full.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(full.rows.at(-1)!.cells).toEqual([`R-${MAX_IMPORT_ROWS}`, `Risk ${MAX_IMPORT_ROWS}`]);
    const sheet = await xlsxOf(['ID', 'Title'], rows.flatMap((r, i) => (i % 50 === 0 ? [r, ['', '   ']] : [r])));
    expect((await readImportFile(sheet, 'gaps.xlsx')).rows).toHaveLength(MAX_IMPORT_ROWS);
  });

  it('refuses an archive that expands far beyond its size before it is read', async () => {
    const big = deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0x41));
    const name = Buffer.from('xl/worksheets/sheet1.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(big.length, 18);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(big.length, 20);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const centralStart = local.length + name.length + big.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(centralStart, 16);
    const zip = Buffer.concat([local, name, big, central, name, end]);
    expect(await problemOf(() => assertZipExpandsWithin(zip, 1024 * 1024))).toMatchObject({ status: 413, extras: { messageKey: 'imports.too_large' } });
    await expect(assertZipExpandsWithin(zip, 16 * 1024 * 1024)).resolves.toBeUndefined();
  });

  it('matches headers in English or Indonesian and refuses unknown, repeated and missing columns', () => {
    expect([...mapColumns('applicability', ['id', 'Berlaku', ' justification* ', '', 'Catatan status']).entries()]).toEqual([
      ['code', 0], ['applicable', 1], ['justification', 2], ['note', 4],
    ]);
    const message = (headers: string[]) => {
      try {
        mapColumns('documents', headers);
        return '';
      } catch (error) {
        return (error as ProblemError).extras.messages!.en;
      }
    };
    expect(message(['ID', 'Title', 'Type', 'Comment'])).toBe('The header row does not match the template. Columns that are not in the template: Comment.');
    expect(message(['ID', 'Title', 'Type', 'Judul'])).toBe('The header row does not match the template. Columns given twice: Judul.');
    expect(message(['Title'])).toBe('The header row does not match the template. Required columns missing: ID, Type.');
  });

  it('finds controls and clauses by their codes, and reads lists and Yes or No cells', () => {
    const targets = new Map<string, ImportTarget>();
    const add = (type: ImportTarget['type'], code: string) =>
      targets.set(targetKey(type, code), { type, code, title: code, retired: false, assessable: type === 'catalogue_item', leaf: true, defaultFrequency: null });
    add('catalogue_item', 'A.5.1');
    add('requirement', '5.1');
    add('requirement', '4.1');
    expect(findTarget({ targets }, 'a.5.1')).toMatchObject({ type: 'catalogue_item', code: 'A.5.1' });
    expect(findTarget({ targets }, 'Cl. 5.1')).toMatchObject({ type: 'requirement', code: '5.1' });
    expect(findTarget({ targets }, 'Klausul 4.1')).toMatchObject({ type: 'requirement', code: '4.1' });
    expect(findTarget({ targets }, '4.1')).toMatchObject({ type: 'requirement', code: '4.1' });
    expect(findTarget({ targets }, 'Cl. A.5.1')).toBeNull();
    expect(splitList('R-01, R-02;R-01\nR-03')).toEqual(['R-01', 'R-02', 'R-03']);
    expect(yesNo('Tidak', ['Applicable', 'Berlaku'])).toEqual({ ok: true, value: false });
    expect(yesNo('', ['Applicable', 'Berlaku'])).toEqual({ ok: true, value: undefined });
    expect(yesNo('maybe', ['Applicable', 'Berlaku'])).toMatchObject({ ok: false, message: { en: 'Applicable: the file has "maybe". Write Yes or No.' } });
  });
});
