// The dry run of an import file (Milestone 2 D.1, D2-13, M2-08): every data row is checked the way the command
// service of its kind checks a request, without writing anything, and gets a result `{row, status, messages}` with
// its business id and what the commit will do with it. The request the commit sends for the row is kept with the
// result (`apply`), so the commit applies exactly what was checked:
// - applicability: `ApplicabilityCreateRequest` for a control or clause without an entry, followed by the update
//   fields (`ApplicabilityPatch`: risks, documents, status note) when the row gives them, or an `ApplicabilityPatch`
//   with the values that differ from the entry's, sent with the entry's ETag, so a change made after the check makes
//   the commit fail instead of overwriting it. Risks and documents are added to the links the entry has (an export
//   lists only the first document of an entry, so importing it again removes nothing);
// - documents (`DocumentCreateRequest`, metadata only), risks (`RegisterCreate`) and evidence (`EvidenceCreate`)
//   register new records; a code that already exists is left as it is, with a warning.
// Business rules come from the rule engine (BR-02, BR-03 and APPL-ASSESS for applicability, BR-17 for risks), so the
// pack's activation and phrase lists apply as in the commands.
import {
  ApplicabilityCreateRequest, ApplicabilityPatch, CLASSIFICATIONS, DocumentCreateRequest, EvidenceCreate, RegisterCreate,
  type ImportKind, type ImportRowAction, type ImportRowStatus, type Messages, type RuleId,
} from '@mscd/shared';
import type { ZodType } from 'zod';
import { KIND_COLUMNS, type Pair } from './import-columns';
import type { ImportFile } from './import-file';
import {
  People, businessId, findTarget, fold, isoDate, matchLookup, splitList, targetKey, wholeNumber, yesNo, type ImportLookups, type Resolved,
} from './import-lookups';

/** What the commit sends for one row (absent for rows with an error and rows left unchanged). */
export type RowApply =
  | { op: 'applicability.create'; body: ApplicabilityCreateRequest; then?: ApplicabilityPatch }
  | { op: 'applicability.update'; entryId: string; etag: string; patch: ApplicabilityPatch }
  | { op: 'documents.create'; body: DocumentCreateRequest }
  | { op: 'risks.create'; body: RegisterCreate }
  | { op: 'evidence.create'; body: EvidenceCreate };

/** One checked row as `import_run.results` stores it. */
export interface PlannedRow {
  row: number;
  status: ImportRowStatus;
  messages: Messages[];
  code?: string;
  action?: ImportRowAction;
  apply?: RowApply;
}

/** What the check needs besides the file: the lookups, the caller and the rule engine of the system. */
export interface CheckContext {
  kind: ImportKind;
  lookups: ImportLookups;
  /** Handle of the caller, and true when the caller holds the kind's permission for own records only (evidence). */
  caller: { handle: string; ownOnly: boolean };
  /** Findings of a rule for the system (messages of the rule engine); null when the rule is not active. */
  rule(rule: RuleId, input: unknown): Promise<Messages | null>;
  /** True when the caller may link a document to another system (`document.manage` there, in full). */
  canLinkDocuments(slug: string): Promise<boolean>;
  /** Null when the licence includes the Integrated Management System feature, else why not. */
  integratedMode(): Promise<Messages | null>;
}

const MAX_CODE = 30;

function pair(en: string, id: string): Messages {
  return { en, id };
}

/** The messages and the outcome of one row while it is checked. */
class RowCheck {
  readonly errors: Messages[] = [];
  readonly warnings: Messages[] = [];

  error(message: Messages): void {
    this.errors.push(message);
  }

  warn(message: Messages): void {
    this.warnings.push(message);
  }

  /** The value of a resolved cell, recording its message when it did not resolve. */
  take<T>(resolved: Resolved<T>): T | undefined {
    if (resolved.ok) return resolved.value;
    this.error(resolved.message);
    return undefined;
  }

  done(row: number, code: string | undefined, action: ImportRowAction | undefined, apply: RowApply | undefined): PlannedRow {
    const status: ImportRowStatus = this.errors.length > 0 ? 'error' : this.warnings.length > 0 ? 'warning' : 'ok';
    const out: PlannedRow = { row, status, messages: [...this.errors, ...this.warnings] };
    if (code) out.code = code.slice(0, 60);
    if (status !== 'error') {
      if (action) out.action = action;
      if (apply && action !== 'unchanged') out.apply = apply;
    }
    return out;
  }
}

/** The header of a column of the kind (both languages). */
function headerOf(kind: ImportKind, key: string): Pair {
  return KIND_COLUMNS[kind].find((c) => c.key === key)?.header ?? [key, key];
}

/** Request members of each kind and the column that carries them (for the messages of a schema check). */
const MEMBER_COLUMNS: Readonly<Record<ImportKind, Readonly<Record<string, string>>>> = {
  applicability: {
    code: 'code', isApplicable: 'applicable', inclusionJustification: 'justification', exclusionJustification: 'justification', ownerHandle: 'owner',
    frequencyCode: 'frequency', riskCodes: 'risks', documentCodes: 'documents', statusNote: 'note',
  },
  documents: {
    docCode: 'code', title: 'title', docType: 'type', ownerHandle: 'owner', approverHandle: 'approver', nextReviewAt: 'nextReview',
    classification: 'classification', orgWide: 'orgWide', linkedMs: 'systems', origin: 'origin', externalSource: 'externalSource',
    externalRef: 'externalRef', receivedAt: 'receivedAt',
  },
  risks: {
    code: 'code', title: 'title', ownerHandle: 'owner', description: 'description', riskProfileCode: 'profile', isOpportunity: 'opportunity',
    likelihood: 'likelihood', consequence: 'consequence', treatmentOption: 'treatment', assessedAt: 'assessedAt', nextReviewAt: 'nextReview',
    residualLikelihood: 'residualLikelihood', residualConsequence: 'residualConsequence',
  },
  evidence: { code: 'code', title: 'title', ownerHandle: 'owner', frequencyCode: 'frequency', classification: 'classification', targets: 'targets' },
};

/** Checks a request against its create or update schema; each failing member becomes a message naming its column. */
function schemaCheck<T>(check: RowCheck, kind: ImportKind, schema: ZodType<T>, body: unknown): T | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const seen = new Set<string>();
  for (const issue of parsed.error.issues) {
    const member = String(issue.path[0] ?? '');
    const column = headerOf(kind, MEMBER_COLUMNS[kind][member] ?? member);
    const key = `${column[0]}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    check.error(pair(`${column[0]}: ${issue.message}.`, `${column[1]}: nilai tidak valid (${issue.message}).`));
  }
  return undefined;
}

/** Length and character checks of a text cell, with messages in both languages. */
function text(check: RowCheck, column: Pair, value: string, max: number): string | undefined {
  if (value === '') return undefined;
  if (value.length > max) {
    check.error(pair(`${column[0]}: at most ${max} characters (this one has ${value.length}).`, `${column[1]}: paling banyak ${max} karakter (yang ini ${value.length}).`));
    return undefined;
  }
  return value;
}

/** A business code: 1 to 30 printable characters (`Code`). */
function codeCell(check: RowCheck, column: Pair, value: string, what: Pair): string | undefined {
  if (value === '') {
    check.error(pair(`${column[0]} is empty: give the ${what[0]}.`, `${column[1]} kosong: isi ${what[1]}.`));
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (value.length > MAX_CODE || /[\u0000-\u001f\u007f]/.test(value)) {
    check.error(pair(`${column[0]}: ${value} is not a valid code (at most ${MAX_CODE} characters, one line).`, `${column[1]}: ${value} bukan kode yang valid (paling banyak ${MAX_CODE} karakter, satu baris).`));
    return undefined;
  }
  return value;
}

const CLASSIFICATION_WORDS: Readonly<Record<string, (typeof CLASSIFICATIONS)[number]>> = {
  publik: 'public', umum: 'public', rahasia: 'confidential', terbatas: 'restricted', internal: 'internal',
};

function classification(check: RowCheck, column: Pair, value: string): (typeof CLASSIFICATIONS)[number] | undefined {
  if (value === '') return 'internal';
  const key = fold(value);
  const found = (CLASSIFICATIONS as readonly string[]).find((c) => c === key) as (typeof CLASSIFICATIONS)[number] | undefined;
  if (found) return found;
  if (CLASSIFICATION_WORDS[key]) return CLASSIFICATION_WORDS[key];
  check.error(pair(`${column[0]}: the file has "${value}". Write public, internal, confidential or restricted.`, `${column[1]}: berkas berisi "${value}". Tulis public, internal, confidential atau restricted.`));
  return undefined;
}

/** Checks every data row of a file of `ctx.kind`. `columns` maps column keys to their position in the file. */
export async function checkRows(ctx: CheckContext, file: ImportFile, columns: ReadonlyMap<string, number>): Promise<PlannedRow[]> {
  const people = new People(ctx.lookups.members);
  const seen = new Map<string, number>();
  const out: PlannedRow[] = [];
  for (const line of file.rows) {
    const cell = (key: string): string => {
      const at = columns.get(key);
      return at === undefined ? '' : (line.cells[at] ?? '').trim();
    };
    out.push(await checkRow(ctx, people, seen, line.row, cell));
  }
  return out;
}

type Cell = (key: string) => string;

async function checkRow(ctx: CheckContext, people: People, seen: Map<string, number>, row: number, cell: Cell): Promise<PlannedRow> {
  switch (ctx.kind) {
    case 'applicability':
      return checkApplicability(ctx, people, seen, row, cell);
    case 'documents':
      return checkDocument(ctx, people, seen, row, cell);
    case 'risks':
      return checkRisk(ctx, people, seen, row, cell);
    case 'evidence':
      return checkEvidence(ctx, people, seen, row, cell);
  }
}

/** Records the first row of a code; a later row with the same code is an error. */
function once(check: RowCheck, seen: Map<string, number>, key: string, code: string, row: number): boolean {
  const first = seen.get(key);
  if (first !== undefined) {
    check.error(pair(`${code} is also in row ${first}. Give each record once per file.`, `${code} juga ada di baris ${first}. Cantumkan setiap catatan sekali per berkas.`));
    return false;
  }
  seen.set(key, row);
  return true;
}

/** A person cell: undefined when empty, the handle (or `none`) when it names a member. */
function person(check: RowCheck, people: People, column: Pair, value: string): string | undefined {
  return value === '' ? undefined : check.take(people.resolve(value, column));
}

// -----------------------------------------------------------------------------------------------------------------
// Applicability (Statement of Applicability)
// -----------------------------------------------------------------------------------------------------------------

async function checkApplicability(ctx: CheckContext, people: People, seen: Map<string, number>, row: number, cell: Cell): Promise<PlannedRow> {
  const check = new RowCheck();
  const kind = ctx.kind;
  const col = (key: string) => headerOf(kind, key);
  const { lookups } = ctx;
  const raw = codeCell(check, col('code'), cell('code'), ['control or clause code', 'kode kontrol atau klausul']);
  if (raw === undefined) return check.done(row, undefined, undefined, undefined);
  const target = findTarget(lookups, raw);
  if (!target) {
    check.error(pair(`${raw} is not a control or clause of the edition this system uses.`, `${raw} bukan kontrol atau klausul dari edisi yang digunakan sistem ini.`));
    return check.done(row, raw, undefined, undefined);
  }
  const code = businessId(target);
  if (!once(check, seen, targetKey(target.type, target.code), code, row)) return check.done(row, code, undefined, undefined);
  const entry = lookups.entries.get(targetKey(target.type, target.code));

  const applicable = check.take(yesNo(cell('applicable'), col('applicable')));
  const justification = text(check, col('justification'), cell('justification'), 4000);
  const owner = person(check, people, col('owner'), cell('owner'));
  const note = text(check, col('note'), cell('note'), 1000);
  let frequency: string | undefined;
  if (cell('frequency') !== '') {
    const found = matchLookup(lookups.frequencies, cell('frequency'));
    if (found) frequency = found.code;
    else {
      const list = lookups.frequencies.map((f) => f.code).join(', ');
      check.error(pair(`${col('frequency')[0]}: ${cell('frequency')} is not a frequency of this edition (${list}).`, `${col('frequency')[1]}: ${cell('frequency')} bukan frekuensi dari edisi ini (${list}).`));
    }
  }
  const listed = (key: 'risks' | 'documents', known: ReadonlySet<string>, what: Pair): string[] | undefined => {
    if (cell(key) === '') return undefined;
    const codes = splitList(cell(key));
    const unknown = codes.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      check.error(pair(`${col(key)[0]}: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${what[0]} of this system.`, `${col(key)[1]}: ${unknown.join(', ')} bukan ${what[1]} dari sistem ini.`));
      return undefined;
    }
    return codes;
  };
  const risks = listed('risks', lookups.systemRisks, ['a risk', 'risiko']);
  const documents = listed('documents', lookups.systemDocuments, ['a document', 'dokumen']);
  if (check.errors.length > 0) return check.done(row, code, undefined, undefined);

  if (!entry) {
    // A control or clause without an entry: `applicability.create` (M2-07 rules), then the update fields.
    if (target.retired) {
      check.error(pair(`${code} is no longer in the standard and gets no new entry.`, `${code} tidak lagi ada dalam standar dan tidak mendapat entri baru.`));
      return check.done(row, code, undefined, undefined);
    }
    if (!target.leaf) {
      check.error(pair(`${code} has sub-clauses: import each sub-clause instead.`, `${code} memiliki sub-klausul: impor setiap sub-klausul sebagai gantinya.`));
      return check.done(row, code, undefined, undefined);
    }
    const isApplicable = applicable ?? true;
    if (!isApplicable) {
      if (!justification) {
        check.error(pair(`${col('justification')[0]}: a control or clause that does not apply needs a justification.`, `${col('justification')[1]}: kontrol atau klausul yang tidak berlaku memerlukan justifikasi.`));
      }
      if (!target.assessable) {
        const finding = await ctx.rule('APPL-ASSESS', { assessable: false, code });
        if (finding) check.error(finding);
      }
    }
    const frequencyCode = frequency ?? target.defaultFrequency ?? undefined;
    if (!frequencyCode) {
      check.error(pair(`${col('frequency')[0]}: a new entry needs a frequency.`, `${col('frequency')[1]}: entri baru memerlukan frekuensi.`));
    }
    if (check.errors.length > 0) return check.done(row, code, undefined, undefined);
    const body = schemaCheck(check, kind, ApplicabilityCreateRequest, {
      targetType: target.type,
      code: target.code,
      isApplicable,
      ...(justification ? (isApplicable ? { inclusionJustification: justification } : { exclusionJustification: justification }) : {}),
      ownerHandle: owner ?? 'none',
      frequencyCode,
    });
    const after: Record<string, unknown> = {};
    if (risks) after.riskCodes = risks;
    if (documents) after.documentCodes = documents;
    if (note) after.statusNote = note;
    const then = Object.keys(after).length > 0 ? schemaCheck(check, kind, ApplicabilityPatch, after) : undefined;
    if (!body || check.errors.length > 0) return check.done(row, code, undefined, undefined);
    if (!isApplicable && justification) {
      const filler = await ctx.rule('BR-03', { justification });
      if (filler) check.warn(filler);
    }
    if (isApplicable && !risks?.length && (await ctx.rule('BR-02', { applicable: true, riskCount: 0 }))) {
      check.warn(pair('No risk is linked yet: the new entry holds its gate until a risk is linked (BR-02).', 'Belum ada risiko yang ditautkan: entri baru menahan gerbangnya sampai risiko ditautkan (BR-02).'));
    }
    return check.done(row, code, 'create', { op: 'applicability.create', body, ...(then ? { then } : {}) });
  }

  // An existing entry: the values that differ, as `applicability.update` takes them.
  const applies = entry.isApplicable !== false && entry.status !== 'not_applicable';
  const willApply = applicable ?? applies;
  const patch: Record<string, unknown> = {};
  if (applicable !== undefined && applicable !== applies) patch.isApplicable = applicable;
  if (justification) {
    if (willApply && justification !== (entry.inclusion ?? '')) patch.inclusionJustification = justification;
    if (!willApply && justification !== (entry.exclusion ?? '')) patch.exclusionJustification = justification;
  }
  if (patch.isApplicable === false) {
    if (!(patch.exclusionJustification ?? entry.exclusion)) {
      check.error(pair(`${col('justification')[0]}: a control or clause that does not apply needs a justification.`, `${col('justification')[1]}: kontrol atau klausul yang tidak berlaku memerlukan justifikasi.`));
    }
    if (!target.assessable) {
      const finding = await ctx.rule('APPL-ASSESS', { assessable: false, code });
      if (finding) check.error(finding);
    }
  }
  if (owner !== undefined && owner !== entry.owner) patch.ownerHandle = owner;
  if (frequency !== undefined && frequency !== entry.frequency) patch.frequencyCode = frequency;
  if (note !== undefined && note !== (entry.note ?? '')) patch.statusNote = note;
  const added = (current: readonly string[], wanted: readonly string[] | undefined) =>
    wanted && wanted.some((c) => !current.includes(c)) ? [...current, ...wanted.filter((c) => !current.includes(c))] : undefined;
  const riskCodes = added(entry.risks, risks);
  if (riskCodes) patch.riskCodes = riskCodes;
  const documentCodes = added(entry.documents, documents);
  if (documentCodes) patch.documentCodes = documentCodes;
  if (patch.isApplicable !== undefined || patch.riskCodes !== undefined) {
    const finding = await ctx.rule('BR-02', { applicable: willApply, riskCount: (riskCodes ?? entry.risks).length });
    if (finding) check.error(finding);
  }
  if (check.errors.length > 0) return check.done(row, code, undefined, undefined);
  if (Object.keys(patch).length === 0) return check.done(row, code, 'unchanged', undefined);
  const parsed = schemaCheck(check, kind, ApplicabilityPatch, patch);
  if (!parsed) return check.done(row, code, undefined, undefined);
  if (typeof patch.exclusionJustification === 'string') {
    const filler = await ctx.rule('BR-03', { justification: patch.exclusionJustification });
    if (filler) check.warn(filler);
  }
  return check.done(row, code, 'update', { op: 'applicability.update', entryId: entry.id, etag: `W/"${entry.updatedAt.getTime()}"`, patch: parsed });
}

/** A record code that already exists: left as it is, with a warning (an export of the register imports again). */
function existing(check: RowCheck, row: number, code: string, what: Pair): PlannedRow {
  check.warn(pair(`${code} is already registered: the import leaves this ${what[0]} as it is.`, `${code} sudah terdaftar: impor membiarkan ${what[1]} ini apa adanya.`));
  return check.done(row, code, 'unchanged', undefined);
}

// -----------------------------------------------------------------------------------------------------------------
// Documents (metadata only)
// -----------------------------------------------------------------------------------------------------------------

const ORIGINS: Readonly<Record<string, 'internal' | 'external'>> = { internal: 'internal', external: 'external', eksternal: 'external', intern: 'internal' };

async function checkDocument(ctx: CheckContext, people: People, seen: Map<string, number>, row: number, cell: Cell): Promise<PlannedRow> {
  const check = new RowCheck();
  const kind = ctx.kind;
  const col = (key: string) => headerOf(kind, key);
  const { lookups } = ctx;
  const code = codeCell(check, col('code'), cell('code'), ['document code', 'kode dokumen']);
  if (code === undefined) return check.done(row, undefined, undefined, undefined);
  if (!once(check, seen, code, code, row)) return check.done(row, code, undefined, undefined);
  if (lookups.existingCodes.has(code)) return existing(check, row, code, ['document', 'dokumen']);

  const title = text(check, col('title'), cell('title'), 255);
  if (cell('title') === '') check.error(pair(`${col('title')[0]} is empty.`, `${col('title')[1]} kosong.`));
  let docType: string | undefined;
  if (cell('type') === '') check.error(pair(`${col('type')[0]} is empty.`, `${col('type')[1]} kosong.`));
  else {
    docType = matchLookup(lookups.docTypes, cell('type'))?.code;
    if (!docType) {
      const list = lookups.docTypes.map((t) => t.labelEn).join(', ');
      check.error(pair(`${col('type')[0]}: ${cell('type')} is not a document type of this edition (${list}).`, `${col('type')[1]}: ${cell('type')} bukan jenis dokumen dari edisi ini (${list}).`));
    }
  }
  const owner = person(check, people, col('owner'), cell('owner')) ?? 'none';
  const approver = person(check, people, col('approver'), cell('approver'));
  const nextReviewAt = check.take(isoDate(cell('nextReview'), col('nextReview')));
  const level = classification(check, col('classification'), cell('classification'));
  const orgWide = check.take(yesNo(cell('orgWide'), col('orgWide'))) ?? false;
  let origin: 'internal' | 'external' = 'internal';
  if (cell('origin') !== '') {
    const found = ORIGINS[fold(cell('origin'))];
    if (found) origin = found;
    else check.error(pair(`${col('origin')[0]}: the file has "${cell('origin')}". Write Internal or External.`, `${col('origin')[1]}: berkas berisi "${cell('origin')}". Tulis Internal atau Eksternal.`));
  }
  const externalSource = text(check, col('externalSource'), cell('externalSource'), 200);
  const externalRef = text(check, col('externalRef'), cell('externalRef'), 120);
  const receivedAt = check.take(isoDate(cell('receivedAt'), col('receivedAt')));
  if (origin === 'internal' && (externalSource || externalRef || receivedAt)) {
    check.error(pair(
      `${col('externalSource')[0]}, ${col('externalRef')[0]} and ${col('receivedAt')[0]} describe an external document: set ${col('origin')[0]} to External.`,
      `${col('externalSource')[1]}, ${col('externalRef')[1]} dan ${col('receivedAt')[1]} menggambarkan dokumen eksternal: isi ${col('origin')[1]} dengan Eksternal.`,
    ));
  }
  if (origin === 'external' && !externalSource) {
    check.error(pair(`${col('externalSource')[0]}: an external document names who issued it.`, `${col('externalSource')[1]}: dokumen eksternal menyebutkan penerbitnya.`));
  }

  // Systems: this one first (it holds the primary link), then the others the row names.
  const linkedMs = [lookups.system.slug];
  for (const name of splitList(cell('systems'))) {
    const key = fold(name);
    const system = lookups.systems.find((s) => fold(s.slug) === key || fold(s.code) === key || fold(s.name) === key);
    if (!system) {
      check.error(pair(`${col('systems')[0]}: ${name} is not a management system of this organisation.`, `${col('systems')[1]}: ${name} bukan sistem manajemen organisasi ini.`));
    } else if (!linkedMs.includes(system.slug)) {
      if (await ctx.canLinkDocuments(system.slug)) linkedMs.push(system.slug);
      else check.error(pair(`${col('systems')[0]}: linking a document to ${system.code} needs the right to manage documents there.`, `${col('systems')[1]}: menautkan dokumen ke ${system.code} memerlukan hak mengelola dokumen di sana.`));
    }
  }
  if (linkedMs.length > 1) {
    const refused = await ctx.integratedMode();
    if (refused) check.error(refused);
  }
  if (check.errors.length > 0) return check.done(row, code, undefined, undefined);
  const body = schemaCheck(check, kind, DocumentCreateRequest, {
    docCode: code,
    title,
    docType,
    ownerHandle: owner,
    ...(approver && approver !== 'none' ? { approverHandle: approver } : {}),
    ...(nextReviewAt ? { nextReviewAt } : {}),
    classification: level,
    orgWide,
    linkedMs,
    ...(origin === 'external'
      ? { origin, ...(externalSource ? { externalSource } : {}), ...(externalRef ? { externalRef } : {}), ...(receivedAt ? { receivedAt } : {}) }
      : {}),
  });
  if (!body) return check.done(row, code, undefined, undefined);
  return check.done(row, code, 'create', { op: 'documents.create', body });
}

// -----------------------------------------------------------------------------------------------------------------
// Risks
// -----------------------------------------------------------------------------------------------------------------

async function checkRisk(ctx: CheckContext, people: People, seen: Map<string, number>, row: number, cell: Cell): Promise<PlannedRow> {
  const check = new RowCheck();
  const kind = ctx.kind;
  const col = (key: string) => headerOf(kind, key);
  const { lookups } = ctx;
  const code = codeCell(check, col('code'), cell('code'), ['risk code', 'kode risiko']);
  if (code === undefined) return check.done(row, undefined, undefined, undefined);
  if (!once(check, seen, code, code, row)) return check.done(row, code, undefined, undefined);
  if (lookups.existingCodes.has(code)) return existing(check, row, code, ['risk', 'risiko']);

  const title = text(check, col('title'), cell('title'), 255);
  if (cell('title') === '') check.error(pair(`${col('title')[0]} is empty.`, `${col('title')[1]} kosong.`));
  const owner = person(check, people, col('owner'), cell('owner'));
  if (owner === undefined || owner === 'none') {
    // BR-17: a risk needs an owner.
    const finding = await ctx.rule('BR-17', { ownerUserId: null });
    check.error(finding ?? pair('A risk needs an owner.', 'Risiko memerlukan pemilik.'));
  }
  const description = text(check, col('description'), cell('description'), 4000);
  let profile = lookups.profiles.length === 1 ? lookups.profiles[0] : undefined;
  if (cell('profile') !== '') {
    const key = fold(cell('profile'));
    profile = lookups.profiles.find((p) => fold(p.code) === key);
    if (!profile) {
      const list = lookups.profiles.map((p) => p.code).join(', ');
      check.error(pair(`${col('profile')[0]}: ${cell('profile')} is not a risk profile of this edition (${list}).`, `${col('profile')[1]}: ${cell('profile')} bukan profil risiko dari edisi ini (${list}).`));
    }
  } else if (!profile) {
    const list = lookups.profiles.map((p) => p.code).join(', ');
    check.error(pair(`${col('profile')[0]}: name the risk profile (${list}).`, `${col('profile')[1]}: sebutkan profil risiko (${list}).`));
  }
  const isOpportunity = check.take(yesNo(cell('opportunity'), col('opportunity')));
  const scored = (key: string, range: 'likelihood' | 'consequence'): number | undefined => {
    const value = check.take(wholeNumber(cell(key), col(key)));
    if (value === undefined || !profile) return value;
    const { min, max } = profile[range];
    if (value < min || value > max) {
      check.error(pair(`${col(key)[0]}: ${value} is outside the scale ${min} to ${max} of profile ${profile.code}.`, `${col(key)[1]}: ${value} di luar skala ${min} sampai ${max} pada profil ${profile.code}.`));
      return undefined;
    }
    return value;
  };
  const likelihood = scored('likelihood', 'likelihood');
  const consequence = scored('consequence', 'consequence');
  const residualLikelihood = scored('residualLikelihood', 'likelihood');
  const residualConsequence = scored('residualConsequence', 'consequence');
  let treatmentOption: string | undefined;
  if (cell('treatment') !== '') {
    treatmentOption = matchLookup(lookups.treatmentOptions, cell('treatment'))?.code;
    if (!treatmentOption) {
      const list = lookups.treatmentOptions.map((t) => t.code).join(', ');
      check.error(pair(`${col('treatment')[0]}: ${cell('treatment')} is not a treatment option of this edition (${list}).`, `${col('treatment')[1]}: ${cell('treatment')} bukan opsi penanganan dari edisi ini (${list}).`));
    }
  }
  const assessedAt = check.take(isoDate(cell('assessedAt'), col('assessedAt')));
  const nextReviewAt = check.take(isoDate(cell('nextReview'), col('nextReview')));
  if (check.errors.length > 0) return check.done(row, code, undefined, undefined);
  const body = schemaCheck(check, kind, RegisterCreate, {
    code,
    title,
    ownerHandle: owner,
    ...(description ? { description } : {}),
    riskProfileCode: profile!.code,
    ...(isOpportunity !== undefined ? { isOpportunity } : {}),
    ...(likelihood !== undefined ? { likelihood } : {}),
    ...(consequence !== undefined ? { consequence } : {}),
    ...(treatmentOption ? { treatmentOption } : {}),
    ...(assessedAt ? { assessedAt } : {}),
    ...(nextReviewAt ? { nextReviewAt } : {}),
    ...(residualLikelihood !== undefined ? { residualLikelihood } : {}),
    ...(residualConsequence !== undefined ? { residualConsequence } : {}),
  });
  if (!body) return check.done(row, code, undefined, undefined);
  return check.done(row, code, 'create', { op: 'risks.create', body });
}

// -----------------------------------------------------------------------------------------------------------------
// Evidence
// -----------------------------------------------------------------------------------------------------------------

async function checkEvidence(ctx: CheckContext, people: People, seen: Map<string, number>, row: number, cell: Cell): Promise<PlannedRow> {
  const check = new RowCheck();
  const kind = ctx.kind;
  const col = (key: string) => headerOf(kind, key);
  const { lookups } = ctx;
  const code = codeCell(check, col('code'), cell('code'), ['evidence code', 'kode bukti']);
  if (code === undefined) return check.done(row, undefined, undefined, undefined);
  if (!once(check, seen, code, code, row)) return check.done(row, code, undefined, undefined);
  if (lookups.existingCodes.has(code)) return existing(check, row, code, ['evidence', 'bukti']);

  const title = text(check, col('title'), cell('title'), 255);
  if (cell('title') === '') check.error(pair(`${col('title')[0]} is empty.`, `${col('title')[1]} kosong.`));
  // Holders of evidence.manage for their own records only add evidence they own (F.6).
  let owner = person(check, people, col('owner'), cell('owner')) ?? (ctx.caller.ownOnly ? ctx.caller.handle : 'none');
  if (ctx.caller.ownOnly && owner !== ctx.caller.handle) {
    check.error(pair(`${col('owner')[0]}: you can add evidence only with yourself as the owner.`, `${col('owner')[1]}: Anda hanya dapat menambahkan bukti dengan diri sendiri sebagai pemilik.`));
    owner = ctx.caller.handle;
  }
  let frequencyCode: string | undefined;
  if (cell('frequency') === '') check.error(pair(`${col('frequency')[0]} is empty.`, `${col('frequency')[1]} kosong.`));
  else {
    frequencyCode = matchLookup(lookups.frequencies, cell('frequency'))?.code;
    if (!frequencyCode) {
      const list = lookups.frequencies.map((f) => f.code).join(', ');
      check.error(pair(`${col('frequency')[0]}: ${cell('frequency')} is not a frequency of this edition (${list}).`, `${col('frequency')[1]}: ${cell('frequency')} bukan frekuensi dari edisi ini (${list}).`));
    }
  }
  const level = classification(check, col('classification'), cell('classification'));
  const targets: { targetType: 'catalogue_item' | 'requirement'; code: string }[] = [];
  const codes = splitList(cell('targets'));
  if (codes.length === 0) {
    check.error(pair(`${col('targets')[0]}: name at least one control or clause of this system.`, `${col('targets')[1]}: sebutkan setidaknya satu kontrol atau klausul dari sistem ini.`));
  }
  const unknown: string[] = [];
  for (const name of codes) {
    const target = findTarget(lookups, name);
    if (!target || !lookups.entries.has(targetKey(target.type, target.code))) unknown.push(name);
    else if (!targets.some((t) => t.targetType === target.type && t.code === target.code)) targets.push({ targetType: target.type, code: target.code });
  }
  if (unknown.length > 0) {
    check.error(pair(`${col('targets')[0]}: ${unknown.join(', ')} ${unknown.length === 1 ? 'has' : 'have'} no entry in this system.`, `${col('targets')[1]}: ${unknown.join(', ')} tidak memiliki entri di sistem ini.`));
  }
  if (check.errors.length > 0) return check.done(row, code, undefined, undefined);
  const body = schemaCheck(check, kind, EvidenceCreate, { code, title, ownerHandle: owner, frequencyCode, classification: level, targets });
  if (!body) return check.done(row, code, undefined, undefined);
  return check.done(row, code, 'create', { op: 'evidence.create', body });
}

/** Counts of a checked file. */
export function countsOf(rows: readonly PlannedRow[]): { ok: number; warning: number; error: number } {
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const r of rows) counts[r.status] += 1;
  return counts;
}
