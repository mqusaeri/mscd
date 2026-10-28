// Sample adapter of Required documented information (MILESTONE-2 M2-12): the documented information rows of the framework
// pack each sample system uses (packs/sources/<pack>/documented_info.csv, copied here because the sample build has no
// api), resolved against the documents and evidence of the sample snapshot the way the server resolves them
// (documented-info.service.ts): a `maintain` row by its template code or its own code, else by a pack code link made on
// this screen, else by the implementing document of a clause requirement of the system (the clause or a sub-clause of
// it; the ISMS applies Annex A controls, which the server does not use here); a `retain` row by the evidence of its
// clause, with the document that stands for its template code (BR-40) and, as in the api build, the link actions of that
// code only when an activity expects it or a row to maintain names it. Links are kept for this browser session.
import type { ControllerData, Evidence, MsId, Requirement } from '../../data/types';
import type { Outcome, Result } from '../docs-edit/model';
import { linkableCode } from './model';
import type { DiAdapter, DiRow, DiState } from './model';

/**
 * `[code, requirement code, kind, title, template code, Indonesian title]` of a pack's `documented_info.csv`, in its
 * sort order. The pack holds the English title only; the sample adds the Indonesian one so the sample build shows the
 * screen in both languages (the api build shows the pack title until the pack carries both; see the M2-12 handoff note).
 */
type InfoTuple = readonly [string, string, 'maintain' | 'retain', string, string, string];

/** Packs of the sample systems: ISO/IEC 27001:2022, ISO 9001:2015, ISO 22301:2019 and ISO 37001:2025. */
export const SAMPLE_INFO: Readonly<Record<MsId, readonly InfoTuple[]>> = {
  isms: [
    ['DI-01', '4.3', 'maintain', 'Scope of the ISMS', 'SCO-01', 'Lingkup ISMS'],
    ['DI-02', '5.2', 'maintain', 'Information security policy', 'POL-01', 'Kebijakan keamanan informasi'],
    ['DI-03', '6.1.2', 'retain', 'Information security risk assessment process', 'PRC-04', 'Proses penilaian risiko keamanan informasi'],
    ['DI-04', '6.1.3', 'retain', 'Information security risk treatment process', 'PRC-04', 'Proses penanganan risiko keamanan informasi'],
    ['DI-05', '6.1.3', 'maintain', 'Statement of Applicability', 'SOA-01', 'Pernyataan Keberlakuan'],
    ['DI-06', '6.1.3', 'maintain', 'Information security risk treatment plan', 'PLN-01', 'Rencana penanganan risiko keamanan informasi'],
    ['DI-07', '6.2', 'retain', 'Information security objectives', 'REG-01', 'Sasaran keamanan informasi'],
    ['DI-08', '7.2', 'retain', 'Evidence of competence', 'REG-04', 'Bukti kompetensi'],
    ['DI-09', '8.1', 'retain', 'Records showing processes were carried out as planned', '', 'Rekaman bahwa proses telah dilaksanakan sesuai rencana'],
    ['DI-10', '8.2', 'retain', 'Results of information security risk assessments', 'REG-02', 'Hasil penilaian risiko keamanan informasi'],
    ['DI-11', '8.3', 'retain', 'Results of information security risk treatment', 'PLN-01', 'Hasil penanganan risiko keamanan informasi'],
    ['DI-12', '9.1', 'retain', 'Monitoring and measurement results', 'REC-01', 'Hasil pemantauan dan pengukuran'],
    ['DI-13', '9.2.2', 'retain', 'Audit programme and audit results', 'REC-02', 'Program audit dan hasil audit'],
    ['DI-14', '9.3.3', 'retain', 'Results of management reviews', 'REC-03', 'Hasil tinjauan manajemen'],
    ['DI-15', '10.2', 'retain', 'Nonconformities, actions taken and corrective action results', 'REC-04', 'Ketidaksesuaian, tindakan yang diambil dan hasil tindakan korektif'],
  ],
  qms: [
    ['DI-01', '4.3', 'maintain', 'Scope of the quality management system', 'SCO-Q01', 'Lingkup sistem manajemen mutu'],
    ['DI-02', '4.4.2', 'maintain', 'Information that supports the operation of processes', 'QM-01', 'Informasi yang mendukung pelaksanaan proses'],
    ['DI-03', '4.4.2', 'retain', 'Records showing processes are carried out as planned', '', 'Rekaman bahwa proses dilaksanakan sesuai rencana'],
    ['DI-04', '5.2.2', 'maintain', 'Quality policy', 'QM-01', 'Kebijakan mutu'],
    ['DI-05', '6.2.1', 'maintain', 'Quality objectives', 'REG-Q02', 'Sasaran mutu'],
    ['DI-06', '7.1.5.1', 'retain', 'Fitness for purpose of monitoring and measuring resources', 'REC-Q01', 'Kelayakan sumber daya pemantauan dan pengukuran untuk tujuannya'],
    ['DI-07', '7.1.5.2', 'retain', 'Basis used for calibration or verification', 'REC-Q01', 'Dasar yang digunakan untuk kalibrasi atau verifikasi'],
    ['DI-08', '7.2', 'retain', 'Evidence of competence', 'REG-Q03', 'Bukti kompetensi'],
    ['DI-09', '7.5.3.2', 'maintain', 'Documented information of external origin', 'IMS-01', 'Informasi terdokumentasi yang berasal dari luar'],
    ['DI-10', '8.1', 'retain', 'Records showing processes and outputs conform to requirements', '', 'Rekaman bahwa proses dan keluaran memenuhi persyaratan'],
    ['DI-11', '8.2.3.2', 'retain', 'Results of the review of requirements and any new requirements', 'REC-Q02', 'Hasil tinjauan persyaratan dan persyaratan baru'],
    ['DI-12', '8.3.2', 'retain', 'Records showing design and development requirements are met', 'REC-Q03', 'Rekaman bahwa persyaratan desain dan pengembangan terpenuhi'],
    ['DI-13', '8.3.3', 'retain', 'Design and development inputs', 'REC-Q03', 'Masukan desain dan pengembangan'],
    ['DI-14', '8.3.4', 'retain', 'Design and development control activities', 'REC-Q03', 'Kegiatan pengendalian desain dan pengembangan'],
    ['DI-15', '8.3.5', 'retain', 'Design and development outputs', 'REC-Q03', 'Keluaran desain dan pengembangan'],
    ['DI-16', '8.3.6', 'retain', 'Design and development changes, reviews and authorisations', 'REC-Q03', 'Perubahan, tinjauan dan otorisasi desain dan pengembangan'],
    ['DI-17', '8.4.1', 'retain', 'Evaluation, selection, monitoring and re-evaluation of external providers', 'REG-Q04', 'Evaluasi, pemilihan, pemantauan dan evaluasi ulang penyedia eksternal'],
    ['DI-18', '8.5.1', 'maintain', 'Characteristics of products and services and the results to be achieved', 'STD-Q01', 'Karakteristik produk dan jasa serta hasil yang akan dicapai'],
    ['DI-19', '8.5.2', 'retain', 'Unique identification of outputs where traceability is required', 'REC-Q04', 'Identifikasi unik keluaran bila ketertelusuran dipersyaratkan'],
    ['DI-20', '8.5.3', 'retain', 'Customer or external provider property lost, damaged or unsuitable', 'REC-Q04', 'Properti pelanggan atau penyedia eksternal yang hilang, rusak atau tidak layak pakai'],
    ['DI-21', '8.5.6', 'retain', 'Results of the review of changes and the actions decided', 'REC-Q05', 'Hasil tinjauan perubahan dan tindakan yang diputuskan'],
    ['DI-22', '8.6', 'retain', 'Release of products and services with the authorising person', 'REC-Q06', 'Pelepasan produk dan jasa beserta orang yang mengotorisasinya'],
    ['DI-23', '8.7.2', 'retain', 'Nonconforming outputs, actions taken and concessions', 'REC-Q07', 'Keluaran tidak sesuai, tindakan yang diambil dan konsesi'],
    ['DI-24', '9.1.1', 'retain', 'Results of monitoring and measurement', 'REC-Q08', 'Hasil pemantauan dan pengukuran'],
    ['DI-25', '9.2.2', 'retain', 'Audit programme and audit results', 'REC-Q09', 'Program audit dan hasil audit'],
    ['DI-26', '9.3.3', 'retain', 'Results of management reviews', 'REC-Q10', 'Hasil tinjauan manajemen'],
    ['DI-27', '10.2.2', 'retain', 'Nonconformities, actions taken and corrective action results', 'REC-Q07', 'Ketidaksesuaian, tindakan yang diambil dan hasil tindakan korektif'],
  ],
  bcms: [
    ['DI-01', '4.2.2', 'maintain', 'Legal, regulatory and other requirements', 'REG-B02', 'Persyaratan hukum, regulasi dan persyaratan lain'],
    ['DI-02', '4.3.2', 'maintain', 'Scope of the BCMS and the reasons for any exclusion', 'SCO-B01', 'Lingkup BCMS dan alasan setiap pengecualian'],
    ['DI-03', '5.2.1', 'maintain', 'Business continuity policy', 'POL-B01', 'Kebijakan kelangsungan usaha'],
    ['DI-04', '6.2.1', 'retain', 'Business continuity objectives', 'REG-B03', 'Sasaran kelangsungan usaha'],
    ['DI-05', '7.2', 'retain', 'Evidence of competence', 'REG-B04', 'Bukti kompetensi'],
    ['DI-06', '8.2.2', 'retain', 'Business impact analysis results', 'PLN-B01', 'Hasil analisis dampak bisnis'],
    ['DI-07', '8.2.3', 'retain', 'Risk assessment results', 'REG-B05', 'Hasil penilaian risiko'],
    ['DI-08', '8.4.3', 'maintain', 'Warning and communication procedures and records of the disruption', 'PRC-B02', 'Prosedur peringatan dan komunikasi serta rekaman gangguan'],
    ['DI-09', '8.4.4', 'maintain', 'Business continuity plans and procedures', 'PLN-B02', 'Rencana dan prosedur kelangsungan usaha'],
    ['DI-10', '8.4.5', 'maintain', 'Procedures to restore and return to normal operations', 'PRC-B03', 'Prosedur pemulihan dan kembali ke operasi normal'],
    ['DI-11', '8.5', 'retain', 'Exercise results and post-exercise reports', 'REC-B01', 'Hasil latihan dan laporan setelah latihan'],
    ['DI-12', '9.1', 'retain', 'Monitoring and measurement results', 'REC-B03', 'Hasil pemantauan dan pengukuran'],
    ['DI-13', '9.2.2', 'retain', 'Audit programme and audit results', 'REC-B04', 'Program audit dan hasil audit'],
    ['DI-14', '9.3.3', 'retain', 'Results of management reviews', 'REC-B05', 'Hasil tinjauan manajemen'],
    ['DI-15', '10.1', 'retain', 'Nonconformities, actions taken and corrective action results', 'IMS-03', 'Ketidaksesuaian, tindakan yang diambil dan hasil tindakan korektif'],
  ],
  abms: [
    ['DI-01', '4.3', 'maintain', 'Scope of the ABMS', 'SCO-A01', 'Lingkup ABMS'],
    ['DI-02', '4.5.3', 'retain', 'Bribery risk assessment and its results', 'REG-A01', 'Penilaian risiko penyuapan dan hasilnya'],
    ['DI-03', '5.2', 'maintain', 'Anti-bribery policy', 'POL-A01', 'Kebijakan anti-penyuapan'],
    ['DI-04', '6.2', 'retain', 'Anti-bribery objectives', 'REG-A02', 'Sasaran anti-penyuapan'],
    ['DI-05', '7.2.1', 'retain', 'Evidence of competence', 'REG-A03', 'Bukti kompetensi'],
    ['DI-06', '7.3', 'retain', 'Training procedures, content, dates and attendees', 'REG-A03', 'Prosedur, materi, tanggal dan peserta pelatihan'],
    ['DI-07', '8.2', 'retain', 'Due diligence results', 'PRC-A04', 'Hasil uji tuntas'],
    ['DI-08', '8.10', 'retain', 'Investigation records', 'PRC-A08', 'Rekaman investigasi'],
    ['DI-09', '9.1', 'retain', 'Monitoring and measurement results', 'REC-A01', 'Hasil pemantauan dan pengukuran'],
    ['DI-10', '9.2', 'retain', 'Audit programme and audit results', 'REC-A02', 'Program audit dan hasil audit'],
    ['DI-11', '9.3.1', 'retain', 'Results of the top management review', 'REC-A03', 'Hasil tinjauan manajemen puncak'],
    ['DI-12', '9.3.2', 'retain', 'Summary of the governing body review', 'REC-A03', 'Ringkasan tinjauan badan pengatur'],
    ['DI-13', '10.2', 'retain', 'Nonconformities, actions taken and corrective action results', 'IMS-03', 'Ketidaksesuaian, tindakan yang diambil dan hasil tindakan korektif'],
  ],
};

/** Pack code links of this browser session, by `<ms>:<pack code>`: the code of the document that stands for it. */
const LINKS = new Map<string, string>();

/** Forgets the links of the session (unit tests). */
export function resetSampleLinks(): void {
  LINKS.clear();
}

/** The clause code of a sample evidence target (`Cl. 9.2` gives `9.2`); null for an Annex A control. */
function clauseOf(target: string): string | null {
  const m = /^Cl\.\s*(\S+)$/.exec(target);
  return m ? m[1] : null;
}

/**
 * True when evidence of clause `code` counts for a row of clause `row`: the same clause, a sub-clause, or (the sample
 * keeps evidence per top clause only) the clause the row's sub-clause belongs to.
 */
function sameClause(code: string, row: string): boolean {
  return code === row || code.startsWith(`${row}.`) || row.startsWith(`${code}.`);
}

/** True for a clause code that is the code or a sub-clause of `parent` (`9.2` covers `9.2` and `9.2.1`), as the server. */
function underClause(code: string, parent: string): boolean {
  return code === parent || code.startsWith(`${parent}.`);
}

/** The clause requirements of a sample system (`Cl. 4.3`), whose implementing documents the server reads. */
function clauseRequirements(reqs: readonly Requirement[]): Requirement[] {
  return reqs.filter((r) => /^Cl\.\s/.test(r.id));
}

/** The state of a `maintain` row from the UI status of its document (D.1 states). */
export function maintainState(doc: { st: string; rev: string } | null, today: string): DiState {
  if (!doc) return 'missing';
  if (doc.st === 'expired' || (doc.st === 'approved' && doc.rev && doc.rev < today)) return 'review_overdue';
  if (doc.st === 'review') return 'in_review';
  return doc.st === 'draft' ? 'draft' : 'approved';
}

/** The rows of a sample system, resolved against the snapshot. */
export function sampleRows(D: ControllerData | null, ms: MsId): DiRow[] {
  const tuples = SAMPLE_INFO[ms] ?? [];
  const bundle = D?.bundles?.[ms];
  const docs = bundle?.docs ?? [];
  const evs: Evidence[] = bundle?.evs ?? [];
  const clauses = clauseRequirements(bundle?.reqs ?? []);
  const today = D?.TODAY_S ?? '';
  const acts = (bundle?.phases ?? []).flatMap((p) => p.acts ?? []);
  const rowCodes = tuples.map(([code, , kind, , template]) => ({ code, kind, templateCode: template || null }));
  // The document that stands for a pack code: the one with the code, else the one linked to it (BR-40).
  const resolve = (c: string): { doc: (typeof docs)[number]; linked: boolean } | null => {
    const own = docs.find((d) => d.id === c);
    if (own) return { doc: own, linked: false };
    const linkedCode = LINKS.get(`${ms}:${c}`);
    const linked = linkedCode ? docs.find((d) => d.id === linkedCode) : undefined;
    return linked ? { doc: linked, linked: true } : null;
  };
  return tuples.map(([code, requirementCode, kind, title, template, titleId]): DiRow => {
    const base = { code, requirementCode, kind, title, titleId, templateCode: template || null };
    if (kind === 'retain') {
      const items = evs.filter((e) => {
        const c = clauseOf(e.ctrl);
        return c !== null && sameClause(c, requirementCode);
      });
      const state: DiState = items.length === 0 ? 'missing' : items.some((e) => e.fresh === 'fresh' || e.fresh === 'aging') ? 'fresh' : 'out_of_date';
      const standing = template ? resolve(template) : null;
      return {
        ...base,
        state,
        document: null,
        evidence: items.map((e) => ({ code: e.code, title: e.title, fresh: e.fresh })),
        templateDocument: standing ? { code: standing.doc.id, title: standing.doc.title, linked: standing.linked } : null,
        templateLinkable: template ? linkableCode(template, rowCodes, acts) : false,
      };
    }
    let found: { doc: (typeof docs)[number]; linked: boolean } | null = null;
    for (const c of [template, code]) {
      if (c && !found) found = resolve(c);
    }
    if (!found) {
      const entry = clauses.find((r) => underClause(r.key, requirementCode) && docs.some((d) => d.id === r.doc));
      const doc = entry ? docs.find((d) => d.id === entry.doc) : undefined;
      if (doc) found = { doc, linked: false };
    }
    const state = maintainState(found ? found.doc : null, today);
    if (!found) return { ...base, state, document: null, evidence: [] };
    const { doc, linked } = found;
    return {
      ...base,
      state,
      document: { id: doc.id, code: doc.id, title: doc.title, status: doc.st, nextReviewAt: doc.rev || null, owner: doc.owner, linked },
      evidence: [],
    };
  });
}

const NOT_A_CODE: readonly [string, string] = ['This code is not used by the framework pack of this system', 'Kode ini tidak dipakai framework pack sistem ini'];
const UNKNOWN_DOC: readonly [string, string] = ['The document is not registered for this management system', 'Dokumen tidak terdaftar untuk sistem manajemen ini'];
const NO_CHANGE: readonly [string, string] = ['Nothing to change', 'Tidak ada yang diubah'];

export function createSampleAdapter(getD: () => ControllerData | null): DiAdapter {
  return {
    async list(ms): Promise<Result<DiRow[]>> {
      return { ok: true, data: sampleRows(getD(), ms) };
    },
    async link(ms, packCode, documentId): Promise<Result<Outcome>> {
      const codes = new Set((SAMPLE_INFO[ms] ?? []).flatMap(([code, , , , template]) => (template ? [code, template] : [code])));
      if (!codes.has(packCode)) return { ok: false, error: { status: 404, message: [NOT_A_CODE[0], NOT_A_CODE[1]] } };
      const key = `${ms}:${packCode}`;
      if (documentId === null) {
        if (!LINKS.has(key)) return { ok: true, data: { changed: [ms], warnings: [], message: [NO_CHANGE[0], NO_CHANGE[1]] } };
        LINKS.delete(key);
        return { ok: true, data: { changed: [ms], warnings: [] } };
      }
      const docs = getD()?.bundles?.[ms]?.docs ?? [];
      if (!docs.some((d) => d.id === documentId)) return { ok: false, error: { status: 422, message: [UNKNOWN_DOC[0], UNKNOWN_DOC[1]] } };
      if (LINKS.get(key) === documentId) return { ok: true, data: { changed: [ms], warnings: [], message: [NO_CHANGE[0], NO_CHANGE[1]] } };
      LINKS.set(key, documentId);
      return { ok: true, data: { changed: [ms], warnings: [] } };
    },
    documentId: (_ms, code) => code,
  };
}
