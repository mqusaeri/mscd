// Sample adapter of the Import screen (MILESTONE-2 M2-08): the dry run and the import of a CSV file against the sample
// snapshot, in the browser. It imports controls (the Statement of Applicability: applicability, justification, owner,
// status note) and documents (new register entries), the two kinds the sample data can show; the checks follow the
// api's where the sample has the data (known codes and people, Yes or No, a justification for an exclusion and the
// BR-03 warning for one that says nothing). XLSX needs the api, so the sample build asks for CSV.
import type { CommandResult, ImportKind, ImportRowResult, ImportRun, Messages } from '@mscd/shared';
import type { ControllerData, DataSource } from '../../data/types';
import type { Download, ImportAdapter, Result } from './model';
import { TEXT } from './text';

type Pair = readonly [string, string];

/** Columns of the sample files: the export's headers in both languages, by key. */
const COLUMNS: Readonly<Record<'applicability' | 'documents', readonly { key: string; header: Pair; required?: boolean }[]>> = {
  applicability: [
    { key: 'code', header: ['ID', 'ID'], required: true }, { key: 'title', header: ['Title', 'Judul'] }, { key: 'theme', header: ['Theme', 'Tema'] },
    { key: 'applicable', header: ['Applicable', 'Berlaku'] }, { key: 'justification', header: ['Justification', 'Justifikasi'] },
    { key: 'status', header: ['Status', 'Status'] }, { key: 'owner', header: ['Owner', 'Pemilik'] },
    { key: 'documents', header: ['Implementing document', 'Dokumen pelaksana'] }, { key: 'frequency', header: ['Frequency', 'Frekuensi'] },
    { key: 'lastEvidence', header: ['Last evidence', 'Bukti terakhir'] }, { key: 'freshness', header: ['Freshness', 'Kesegaran'] },
    { key: 'integrity', header: ['Integrity', 'Integritas'] }, { key: 'risks', header: ['Risks', 'Risiko'] }, { key: 'note', header: ['Status note', 'Catatan status'] },
  ],
  documents: [
    { key: 'code', header: ['ID', 'ID'], required: true }, { key: 'title', header: ['Title', 'Judul'], required: true },
    { key: 'type', header: ['Type', 'Jenis'], required: true }, { key: 'version', header: ['Version', 'Versi'] }, { key: 'status', header: ['Status', 'Status'] },
    { key: 'approved', header: ['Approved', 'Disetujui'] }, { key: 'nextReview', header: ['Next review', 'Tinjauan berikutnya'] },
    { key: 'owner', header: ['Owner', 'Pemilik'] }, { key: 'shared', header: ['Shared', 'Dibagikan'] }, { key: 'systems', header: ['System', 'Sistem'] },
    { key: 'classification', header: ['Classification', 'Klasifikasi'] }, { key: 'approver', header: ['Approver', 'Penyetuju'] },
    { key: 'orgWide', header: ['Organisation-wide', 'Seluruh organisasi'] }, { key: 'origin', header: ['Origin', 'Asal'] },
    { key: 'externalSource', header: ['External source', 'Sumber eksternal'] }, { key: 'externalRef', header: ['External reference', 'Referensi eksternal'] },
    { key: 'receivedAt', header: ['Received', 'Diterima'] },
  ],
};

const BR03: Messages = {
  en: 'The exclusion justification does not look meaningful. Explain why this does not apply.',
  id: 'Justifikasi pengecualian tampaknya tidak bermakna. Jelaskan mengapa ini tidak berlaku.',
};

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const headerKey = (s: string) => fold(s.replace(/[*:()[\]]/g, ' '));
const msg = (en: string, id: string): Messages => ({ en, id });

/** Rows of a CSV text (RFC 4180 quotes; comma, semicolon or tab as the separator of the header line). */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '');
  const first = body.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const count = (ch: string) => first.split(ch).length - 1;
  const sep = count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** A neutralised cell of an export (a leading quote before a formula start) without the quote (F.15). */
const unquote = (s: string) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

interface Planned {
  result: ImportRowResult;
  apply?: { kind: 'req'; id: string; patch: Record<string, unknown> } | { kind: 'doc'; row: Record<string, unknown> };
}

interface SampleRun {
  run: ImportRun;
  ms: string;
  planned: Planned[];
}

// Imports of this session (until the page is loaded again).
const runs = new Map<string, SampleRun>();
let next = 1;

/** Forgets the imports of the sample build (unit tests). */
export function resetSampleImports(): void {
  runs.clear();
  next = 1;
}

function failure(status: number, message: Pair): { ok: false; error: { status: number; message: [string, string] } } {
  return { ok: false, error: { status, message: [message[0], message[1]] } };
}

function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** The person of a cell: a handle or a full name of the sample people; `none` for an empty owner. */
function personOf(D: ControllerData, text: string): string | null {
  const key = fold(text);
  if (key === 'none' || key === '-') return 'none';
  for (const [handle, [name]] of Object.entries(D.PEOPLE)) if (fold(handle) === key || fold(name) === key) return handle;
  return null;
}

function checkApplicability(D: ControllerData, ms: string, row: number, cell: (k: string) => string, seen: Map<string, number>): Planned {
  const messages: Messages[] = [];
  const reqs = D.bundles[ms]?.reqs ?? [];
  const code = cell('code');
  const req = reqs.find((r) => fold(r.id) === fold(code) || fold(`Cl. ${r.key}`) === fold(code));
  if (!code) return { result: { row, status: 'error', messages: [msg('ID is empty: give the control or clause code.', 'ID kosong: isi kode kontrol atau klausul.')] } };
  if (!req) return { result: { row, status: 'error', code, messages: [msg(`${code} is not a control or clause of this system.`, `${code} bukan kontrol atau klausul dari sistem ini.`)] } };
  if (seen.has(req.id)) return { result: { row, status: 'error', code: req.id, messages: [msg(`${req.id} is also in row ${seen.get(req.id)}. Give each record once per file.`, `${req.id} juga ada di baris ${seen.get(req.id)}. Cantumkan setiap catatan sekali per berkas.`)] } };
  seen.set(req.id, row);
  const patch: Record<string, unknown> = {};
  const applicable = fold(cell('applicable'));
  let applies = req.st !== 'na';
  if (applicable) {
    if (['yes', 'ya', 'y', 'true', '1'].includes(applicable)) applies = true;
    else if (['no', 'tidak', 'n', 'false', '0'].includes(applicable)) applies = false;
    else messages.push(msg(`Applicable: the file has "${cell('applicable')}". Write Yes or No.`, `Berlaku: berkas berisi "${cell('applicable')}". Tulis Ya atau Tidak.`));
  }
  if (applies !== (req.st !== 'na')) patch.st = applies ? 'ns' : 'na';
  const justification = cell('justification');
  if (justification && justification !== req.just) patch.just = justification;
  if (!applies && patch.st === 'na' && !justification) {
    messages.push(msg('Justification: a control or clause that does not apply needs a justification.', 'Justifikasi: kontrol atau klausul yang tidak berlaku memerlukan justifikasi.'));
  }
  if (cell('owner')) {
    const owner = personOf(D, cell('owner'));
    if (!owner) messages.push(msg(`Owner: ${cell('owner')} is not an active member of this organisation.`, `Pemilik: ${cell('owner')} bukan anggota aktif organisasi ini.`));
    else if (owner !== req.owner) patch.owner = owner;
  }
  if (cell('note') && cell('note') !== req.note) patch.note = cell('note');
  if (messages.length > 0) return { result: { row, status: 'error', code: req.id, messages } };
  const warnings = !applies && justification && fold(justification).length < 10 ? [BR03] : [];
  const changes = Object.keys(patch).length > 0;
  return {
    result: { row, status: warnings.length ? 'warning' : 'ok', code: req.id, messages: warnings, action: changes ? 'update' : 'unchanged' },
    ...(changes ? { apply: { kind: 'req' as const, id: req.id, patch } } : {}),
  };
}

function checkDocument(D: ControllerData, ms: string, row: number, cell: (k: string) => string, seen: Map<string, number>): Planned {
  const docs = D.bundles[ms]?.docs ?? [];
  const code = cell('code');
  if (!code) return { result: { row, status: 'error', messages: [msg('ID is empty: give the document code.', 'ID kosong: isi kode dokumen.')] } };
  if (seen.has(code)) return { result: { row, status: 'error', code, messages: [msg(`${code} is also in row ${seen.get(code)}. Give each record once per file.`, `${code} juga ada di baris ${seen.get(code)}. Cantumkan setiap catatan sekali per berkas.`)] } };
  seen.set(code, row);
  if (docs.some((d) => fold(d.id) === fold(code))) {
    return { result: { row, status: 'warning', code, action: 'unchanged', messages: [msg(`${code} is already registered: the import leaves this document as it is.`, `${code} sudah terdaftar: impor membiarkan dokumen ini apa adanya.`)] } };
  }
  const messages: Messages[] = [];
  if (!cell('title')) messages.push(msg('Title is empty.', 'Judul kosong.'));
  if (!cell('type')) messages.push(msg('Type is empty.', 'Jenis kosong.'));
  const owner = cell('owner') ? personOf(D, cell('owner')) : 'none';
  if (!owner) messages.push(msg(`Owner: ${cell('owner')} is not an active member of this organisation.`, `Pemilik: ${cell('owner')} bukan anggota aktif organisasi ini.`));
  const review = cell('nextReview');
  if (review && !/^\d{4}-\d{2}-\d{2}$/.test(review)) messages.push(msg(`Next review: the file has "${review}". Write the date as YYYY-MM-DD.`, `Tinjauan berikutnya: berkas berisi "${review}". Tulis tanggal sebagai YYYY-MM-DD.`));
  if (messages.length > 0) return { result: { row, status: 'error', code, messages } };
  return {
    result: { row, status: 'ok', code, messages: [], action: 'create' },
    apply: { kind: 'doc', row: { id: code, title: cell('title'), tier: cell('type'), ver: '-', st: 'draft', appr: '', rev: review, owner, shared: false, ms } },
  };
}

/** The check of a CSV file against the sample snapshot (the dry run). */
export function checkSample(D: ControllerData, ms: string, kind: 'applicability' | 'documents', fileName: string, text: string): Result<SampleRun> {
  const lines = parseCsv(text).map((r) => r.map((c) => unquote(c.trim()))).filter((r) => r.some((c) => c !== ''));
  if (lines.length === 0) return failure(422, ['The file is empty. Start from the template: keep its header row and add one row per record.', 'Berkas kosong. Mulai dari templat: pertahankan baris judulnya dan tambahkan satu baris per catatan.']);
  const columns = COLUMNS[kind];
  const at = new Map<string, number>();
  const unknown: string[] = [];
  lines[0]!.forEach((h, i) => {
    if (!h) return;
    const column = columns.find((c) => c.header.some((x) => headerKey(x) === headerKey(h)));
    if (!column) unknown.push(h);
    else if (!at.has(column.key)) at.set(column.key, i);
  });
  const missing = columns.filter((c) => c.required && !at.has(c.key)).map((c) => c.header[0]);
  if (unknown.length > 0 || missing.length > 0) {
    const en = [unknown.length ? `Columns that are not in the template: ${unknown.join(', ')}` : '', missing.length ? `Required columns missing: ${missing.join(', ')}` : ''].filter(Boolean).join('. ');
    const id = [unknown.length ? `Kolom yang tidak ada di templat: ${unknown.join(', ')}` : '', missing.length ? `Kolom wajib tidak ada: ${missing.join(', ')}` : ''].filter(Boolean).join('. ');
    return failure(422, [`The header row does not match the template. ${en}.`, `Baris judul tidak sesuai dengan templat. ${id}.`]);
  }
  const seen = new Map<string, number>();
  const planned = lines.slice(1).map((cells, i) => {
    const cell = (key: string) => (at.has(key) ? (cells[at.get(key)!] ?? '').trim() : '');
    return kind === 'applicability' ? checkApplicability(D, ms, i + 1, cell, seen) : checkDocument(D, ms, i + 1, cell, seen);
  });
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const p of planned) counts[p.result.status] += 1;
  const id = `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
  const run: ImportRun = {
    id, kind, fileName, status: 'validated', rowCount: planned.length, counts, results: planned.map((p) => p.result),
    createdAt: new Date().toISOString(), committedAt: null, taskId: null,
  };
  return { ok: true, data: { run, ms, planned } };
}

/** A CSV template with the header row of a kind in the interface language. */
function templateCsv(kind: ImportKind, lang: 'en' | 'id'): string {
  const columns = COLUMNS[kind === 'documents' ? 'documents' : 'applicability'];
  return `\uFEFF${columns.map((c) => `"${c.header[lang === 'id' ? 1 : 0]}"`).join(',')}\r\n`;
}

export function createSampleAdapter(getD: () => ControllerData | null, getDs: () => DataSource | null): ImportAdapter {
  return {
    kinds: ['applicability', 'documents'],
    async template(ms, kind, lang): Promise<Download> {
      const blob = new Blob([templateCsv(kind, lang)], { type: 'text/csv' });
      const href = URL.createObjectURL(blob);
      return { href, fileName: `${ms}-import-${kind}.csv`, release: () => URL.revokeObjectURL(href) };
    },
    async check(ms, kind, file) {
      const D = getD();
      if (!D || (kind !== 'applicability' && kind !== 'documents')) return failure(422, TEXT.sampleCsvOnly);
      if (/\.xlsx?$/i.test(file.name)) return failure(422, TEXT.sampleCsvOnly);
      const checked = checkSample(D, ms, kind, file.name, await readText(file));
      if (!checked.ok) return checked;
      runs.set(checked.data.run.id, checked.data);
      return { ok: true, data: checked.data.run };
    },
    async get(_ms, id) {
      const found = runs.get(id);
      return found ? { ok: true, data: found.run } : failure(404, ['Not found', 'Tidak ditemukan']);
    },
    async commit(ms, id) {
      const found = runs.get(id);
      if (!found || found.ms !== ms) return failure(404, ['Not found', 'Tidak ditemukan']);
      if (found.run.status !== 'validated') return failure(409, ['This import was already committed.', 'Impor ini sudah dikonfirmasi.']);
      if (found.run.counts.error > 0) return failure(422, TEXT.blockedByErrors);
      const ds = getDs();
      let created = 0;
      let updated = 0;
      for (const p of found.planned) {
        if (!p.apply) continue;
        if (p.apply.kind === 'req') {
          await ds?.mutate?.(ms, 'req', p.apply.id, p.apply.patch);
          updated += 1;
        } else {
          await ds?.insert?.(ms, 'doc', p.apply.row);
          created += 1;
        }
      }
      const unchanged = found.planned.filter((p) => p.result.action === 'unchanged').length;
      const taskId = `00000000-0000-4000-9000-${id.slice(-12)}`;
      found.run = {
        ...found.run, status: 'committed', committedAt: new Date().toISOString(), taskId, progress: 100,
        summary: { created, updated, unchanged }, changed: [ms],
      };
      const result: CommandResult = { ok: true, changed: [ms], taskId };
      return { ok: true, data: result };
    },
  };
}
