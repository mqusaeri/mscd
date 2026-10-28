// Sample adapter of the document control forms (MILESTONE-2 M2-12). The sample build has no api, so the versions of the
// sample documents are kept here for the browser session and the documents of the sample snapshot change through
// `mutate` and `insert` of the sample data source (C.6), which the built-in screens show after the reload.
//
// It behaves as a live install does (A.4 5.7): a new version goes to In review, and only another person approves it
// in the review panel (BR-16); returning it to draft keeps the note. A shared document asks for the BR-22
// confirmation. The Milestone 1 commands of the sample (Start review, the picker's Upload new version) keep their own
// overrides, which win over `mutate`; when such an override holds the old status, the adapter applies the matching
// Milestone 1 command (Start review, a new approved version), and refuses the two changes no such command makes.
import type { CommandResult as SourceResult, ControllerData, DataSource, MsId, Snapshot } from '../../data/types';
import { SAMPLE_INFO } from '../documented-info/sample';
import type { PickedFile } from '../types';
import { DOC_TYPES } from './text';
import { docKey, docOf, docTypeOfTemplate, hasVersion, inReviewOf, nextVersionLabel, refusal, withActivityOutputs } from './model';
import type { DocRecord, DocsAdapter, Outcome, Result, TemplateOption, VersionRow } from './model';

/** Versions of the sample documents by `<ms>:<code>`, newest first. */
const VERSIONS = new Map<string, VersionRow[]>();
/** Classification and external facts given on screen, by `<ms>:<code>` (the sample snapshot has no member for them). */
const FACTS = new Map<string, Record<string, unknown>>();
let sequence = 0;

/** Forgets the versions of the session (unit tests). */
export function resetSampleDocs(): void {
  VERSIONS.clear();
  FACTS.clear();
  sequence = 0;
}

const NO_FILES: readonly [string, string] = [
  'The sample build keeps no stored files. On a live installation the file opens in a new tab.',
  'Build contoh tidak menyimpan berkas. Pada instalasi nyata berkas terbuka di tab baru.',
];
const SAMPLE_LIMIT: readonly [string, string] = [
  'The sample build cannot record this change after Start review or a file picked with Upload new version in this session. Reload the page to start again.',
  'Build contoh tidak dapat mencatat perubahan ini setelah Mulai review atau berkas yang dipilih dengan Unggah versi baru pada sesi ini. Muat ulang halaman untuk memulai lagi.',
];
const NOT_LOADED: readonly [string, string] = ['This document is not in the register of this system.', 'Dokumen ini tidak ada di register sistem ini.'];

/** The versions a sample document starts with: the version in force, or the draft or review version it shows. */
export function seedVersions(doc: DocRecord, fallbackApprover: string | null): VersionRow[] {
  if (!hasVersion(doc)) return [];
  const day = doc.appr || null;
  const row: VersionRow = {
    id: `sample-${doc.ms}-${doc.id}-${doc.ver}`,
    label: doc.ver,
    status: 'approved',
    storageObjectId: `sample-object-${doc.ms}-${doc.id}-${doc.ver}`,
    submittedBy: doc.owner && doc.owner !== 'none' ? doc.owner : null,
    submittedAt: day ? `${day}T02:00:00.000Z` : null,
    approvedBy: doc.approver ?? fallbackApprover,
    approvedAt: day,
    rejectionNote: null,
    changeSummary: doc.changeSummary ?? null,
  };
  // A draft shows the version being written; a document in review shows the version in force under its periodic review.
  if (doc.st === 'draft') return [{ ...row, status: 'draft', approvedBy: null, approvedAt: null }];
  return [row];
}

const ok = (changed: MsId[], extra: Partial<Outcome> = {}): Result<Outcome> => ({ ok: true, data: { changed, warnings: [], ...extra } });

/** The outcome of a command of the sample data source. */
function fromSource(res: SourceResult): Result<Outcome> {
  if (!res.ok) {
    const e = res.error ?? { status: 422, message: ['Action failed', 'Aksi gagal'] as [string, string] };
    return { ok: false, error: { status: e.status, message: [e.message[0], e.message[1]], ...(e.rule ? { rule: e.rule } : {}) } };
  }
  return ok([...res.changed], { warnings: (res.warnings ?? []).map((w) => ({ rule: w.rule, message: [w.message[0], w.message[1]] as const })) });
}

export function createSampleAdapter(getD: () => ControllerData | null, ds: DataSource | null, me: () => string): DocsAdapter {
  const today = () => getD()?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  const plusYear = (day: string) => getD()?.addD(day, 365) ?? day;
  const msApprover = (ms: MsId) => getD()?.MS.find((m) => m.id === ms)?.approver ?? null;

  const versionsOf = (ms: MsId, code: string): VersionRow[] | null => {
    const key = `${ms}:${code}`;
    const known = VERSIONS.get(key);
    if (known) return known;
    const doc = docOf(getD(), ms, code);
    if (!doc) return null;
    const seeded = seedVersions(doc, msApprover(ms));
    VERSIONS.set(key, seeded);
    return seeded;
  };

  /** The document as the sample source derives it now (its overrides applied). */
  const derived = async (ms: MsId, code: string): Promise<DocRecord | null> => {
    const D = getD();
    if (!D || !ds) return null;
    const snap = await ds.reload(D as unknown as Snapshot, [ms]);
    return ((snap.bundles[ms]?.docs ?? []) as DocRecord[]).find((d) => d.id === code) ?? null;
  };

  const mutate = async (ms: MsId, code: string, patch: Record<string, unknown>): Promise<Result<Outcome>> => {
    if (!ds?.mutate) return refusal(0, NOT_LOADED);
    return fromSource(await ds.mutate(ms, 'doc', code, patch));
  };

  /** Puts the document in review; a Milestone 1 override that holds another status gets Start review on top. */
  const toReview = async (ms: MsId, code: string): Promise<Result<Outcome>> => {
    const res = await mutate(ms, code, { st: 'review' });
    if (!res.ok) return res;
    if ((await derived(ms, code))?.st !== 'review' && ds) return fromSource(await ds.startReview(docKey(ms, code)));
    return res;
  };

  const systemsOf = (doc: DocRecord, ms: MsId): MsId[] => {
    const all = (getD()?.MS ?? []).map((m) => m.id);
    return doc.shared ? all.filter((id) => docOf(getD(), id, doc.id)) : [ms];
  };

  return {
    async create(ms, input) {
      if (!ds?.insert) return refusal(0, NOT_LOADED);
      const code = input.docCode.trim();
      for (const id of input.linkedMs) {
        if (docOf(getD(), id, code)) return refusal(409, [`Document ${code} already exists`, `Dokumen ${code} sudah ada`], { slug: 'conflict', messageKey: 'documents.duplicate_code' });
      }
      const tier = DOC_TYPES.find((t) => t.value === input.docType)?.label[0] ?? input.docType;
      const changed: MsId[] = [];
      for (const id of [ms, ...input.linkedMs.filter((x) => x !== ms)]) {
        const row: Record<string, unknown> = {
          id: code, title: input.title.trim(), tier, ver: '-', st: 'draft', appr: '', rev: input.nextReviewAt ?? '',
          owner: input.ownerHandle, shared: input.orgWide || input.linkedMs.length > 1, ms: id,
        };
        if (input.approverHandle) row.approver = input.approverHandle;
        if (input.origin === 'external') row.origin = 'external';
        const res = fromSource(await ds.insert(id, 'doc', row));
        if (!res.ok) return res;
        changed.push(id);
        FACTS.set(`${id}:${code}`, { classification: input.classification, externalSource: input.externalSource, externalRef: input.externalRef, receivedAt: input.receivedAt });
        VERSIONS.set(`${id}:${code}`, []);
      }
      return ok(changed, { ref: { module: 'implementation', entityType: 'document', id: `sample-${code}`, code } as Outcome['ref'] });
    },

    async update(ms, code, change, confirm) {
      const doc = docOf(getD(), ms, code);
      if (!doc) return refusal(404, NOT_LOADED);
      const systems = systemsOf(doc, ms);
      if (systems.length > 1 && !confirm) {
        const others = (getD()?.MS ?? []).filter((m) => systems.includes(m.id) && m.id !== ms).map((m) => m.short).join(', ');
        return refusal(409, [`This change also applies to: ${others}. Continue?`, `Perubahan ini juga berlaku untuk: ${others}. Lanjutkan?`], { slug: 'confirmation-required', rule: 'BR-22' });
      }
      const patch: Record<string, unknown> = {};
      if (change.title !== undefined) patch.title = change.title;
      if (change.nextReviewAt !== undefined) patch.rev = change.nextReviewAt ?? '';
      if (change.ownerHandle !== undefined) patch.owner = change.ownerHandle;
      if (change.approverHandle !== undefined) patch.approver = change.approverHandle ?? undefined;
      if (change.origin !== undefined) patch.origin = change.origin === 'external' ? 'external' : undefined;
      for (const id of systems) {
        const facts = { ...(FACTS.get(`${id}:${code}`) ?? {}) };
        for (const k of ['classification', 'externalSource', 'externalRef', 'receivedAt'] as const) if (change[k] !== undefined) facts[k] = change[k];
        FACTS.set(`${id}:${code}`, facts);
        if (Object.keys(patch).length) {
          const res = await mutate(id, code, patch);
          if (!res.ok) return res;
        }
      }
      return ok(systems);
    },

    async transition(ms, code, to, note) {
      const doc = docOf(getD(), ms, code);
      const versions = versionsOf(ms, code);
      if (!doc || !versions) return refusal(404, NOT_LOADED);
      if (to === 'in_review') return toReview(ms, code);
      const pending = inReviewOf(versions);
      const day = today();
      if (to === 'draft') {
        if (pending) {
          pending.status = 'rejected';
          pending.rejectionNote = (note ?? '').trim();
        }
        const res = await mutate(ms, code, { st: 'draft' });
        if (res.ok && (await derived(ms, code))?.st !== 'draft') return refusal(422, SAMPLE_LIMIT);
        return res;
      }
      // Approval (BR-16): never by the author of what is approved.
      const subject = pending ?? versions.find((v) => v.status === 'approved') ?? null;
      if (subject && subject.submittedBy === me()) {
        return refusal(422, ['A document cannot be approved by its own author. Approval is always separate from creation.', 'Dokumen tidak dapat disetujui oleh penulisnya sendiri. Persetujuan selalu terpisah dari pembuatan.'], { slug: 'business-rule', rule: 'BR-16' });
      }
      const rev = doc.rev && doc.rev > day ? doc.rev : plusYear(day);
      if (pending) {
        const res = await mutate(ms, code, { st: 'approved', ver: pending.label, appr: day, rev });
        if (!res.ok) return res;
        const now = await derived(ms, code);
        if ((now?.st !== 'approved' || now?.ver !== pending.label) && ds) {
          // A Milestone 1 override holds the old status: its new approved version is the next major one, as here.
          const forced = fromSource(await ds.uploadFile(docKey(ms, code), null));
          if (!forced.ok) return forced;
          if ((await derived(ms, code))?.ver !== pending.label) return refusal(422, SAMPLE_LIMIT);
        }
        for (const v of versions) if (v.status === 'approved') v.status = 'superseded';
        Object.assign(pending, { status: 'approved', approvedBy: me(), approvedAt: day });
        return ok([ms]);
      }
      const res = await mutate(ms, code, { st: 'approved', appr: day, rev });
      if (res.ok && (await derived(ms, code))?.st !== 'approved') return refusal(422, SAMPLE_LIMIT);
      return res;
    },

    async assign(ms, code, holder, due) {
      if (!ds) return refusal(0, NOT_LOADED);
      return fromSource(await ds.assign(docKey(ms, code), holder || 'none', due || null));
    },

    async addVersion(ms, code, file: PickedFile, changeSummary) {
      const versions = versionsOf(ms, code);
      if (!versions) return refusal(404, NOT_LOADED);
      const pending = inReviewOf(versions);
      if (pending) return refusal(409, [`Version ${pending.label} is already in review`, `Versi ${pending.label} sudah dalam review`], { slug: 'conflict', messageKey: 'files.version_in_review' });
      const doc = docOf(getD(), ms, code);
      const label = nextVersionLabel([...versions.map((v) => v.label), ...(doc && hasVersion(doc) ? [doc.ver] : [])]);
      sequence += 1;
      versions.unshift({
        id: `sample-version-${sequence}`,
        label,
        status: 'in_review',
        storageObjectId: `sample-object-${sequence}-${file.fileName}`,
        submittedBy: me(),
        submittedAt: new Date(`${today()}T03:00:00.000Z`).toISOString(),
        approvedBy: null,
        approvedAt: null,
        rejectionNote: null,
        changeSummary: changeSummary?.trim() ? changeSummary.trim() : null,
      });
      const res = await toReview(ms, code);
      if (!res.ok) {
        versions.shift();
        return res;
      }
      return ok(res.data.changed, { message: [`${code} v${label} submitted for review`, `${code} v${label} diajukan untuk review`] });
    },

    async versions(ms, code) {
      const versions = versionsOf(ms, code);
      if (!versions) return refusal(404, NOT_LOADED);
      return { ok: true, data: versions.map((v) => ({ ...v })) };
    },

    async openFile() {
      return refusal(0, NO_FILES);
    },

    async templates(ms) {
      const seen = new Set<string>();
      const out: TemplateOption[] = [];
      for (const [, , , title, template] of SAMPLE_INFO[ms] ?? []) {
        if (!template || seen.has(template)) continue;
        seen.add(template);
        out.push({ code: template, title, docType: docTypeOfTemplate(template) });
      }
      return { ok: true, data: withActivityOutputs(out, getD(), ms) };
    },

    recordId: (ms, code) => (docOf(getD(), ms, code) ? code : null),
  };
}

/** The classification and external facts a sample document was given on screen (tests). */
export function sampleFacts(ms: MsId, code: string): Record<string, unknown> | undefined {
  return FACTS.get(`${ms}:${code}`);
}
