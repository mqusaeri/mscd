// What an import file is checked against (Milestone 2 D.1, M2-08), read once per file inside the upload's tenant
// transaction: the system and its edition, the active members of the organisation, the controls and clauses of the
// edition (`applicability.targets`), the entries of the system with their current values, and the codes and lookups
// of the kind (frequencies, document types, risk profiles, treatment options, records that already exist). Every row
// is then checked in memory, so a file of 5,000 rows costs a few queries and not a few per row.
import type { ImportKind, Messages } from '@mscd/shared';
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';

export interface ImportSystem {
  id: string;
  slug: string;
  code: string;
  name: string;
  versionId: string;
}

export interface ImportMember {
  id: string;
  handle: string;
  email: string;
  name: string;
}

/** A catalogue item or requirement of the edition, as `applicability.targets` lists it. */
export interface ImportTarget {
  type: 'catalogue_item' | 'requirement';
  code: string;
  title: string;
  retired: boolean;
  assessable: boolean;
  /** A requirement row without a child row that is still in the standard (D2-09); catalogue items always. */
  leaf: boolean;
  defaultFrequency: string | null;
}

/** An entry of the system with the values the import compares with. */
export interface ImportEntry {
  id: string;
  updatedAt: Date;
  isApplicable: boolean | null;
  status: string | null;
  inclusion: string | null;
  exclusion: string | null;
  /** Handle of the owner, `none` when unassigned. */
  owner: string;
  note: string | null;
  frequency: string | null;
  risks: string[];
  documents: string[];
}

export interface ImportLookup {
  code: string;
  labelEn: string;
  labelId: string;
}

export interface RiskProfileInfo {
  code: string;
  likelihood: { min: number; max: number };
  consequence: { min: number; max: number };
}

export interface ImportLookups {
  system: ImportSystem;
  members: ImportMember[];
  /** The other systems of the organisation by slug (documents and risks may name them). */
  systems: ImportSystem[];
  /** Targets by `targetKey` (`catalogue_item:A.5.1`, `requirement:4.1`). */
  targets: Map<string, ImportTarget>;
  /** Entries of the system by `targetKey`. */
  entries: Map<string, ImportEntry>;
  frequencies: ImportLookup[];
  docTypes: ImportLookup[];
  treatmentOptions: ImportLookup[];
  profiles: RiskProfileInfo[];
  /** Risk codes linked to the system. */
  systemRisks: Set<string>;
  /** Document codes of the system: linked to it or organisation-wide. */
  systemDocuments: Set<string>;
  /** Codes of the kind that already exist in the organisation (documents, risks, evidence). */
  existingCodes: Set<string>;
}

export function targetKey(type: ImportTarget['type'], code: string): string {
  return `${type}:${code}`;
}

/** G.5 business id of a target: the item code, or `Cl. ` and the clause code. */
export function businessId(target: Pick<ImportTarget, 'type' | 'code'>): string {
  return target.type === 'catalogue_item' ? target.code : `Cl. ${target.code}`;
}

function scale(value: unknown): { min: number; max: number } {
  if (value && typeof value === 'object') {
    const v = value as { min?: unknown; max?: unknown };
    if (typeof v.min === 'number' && typeof v.max === 'number') return { min: v.min, max: v.max };
  }
  return { min: 1, max: 5 };
}

/** Everything a file of `kind` is checked against, for the system `msId`. */
export async function loadLookups(trx: Trx, msId: string, kind: ImportKind): Promise<ImportLookups> {
  const { rows: systemRows } = await sql<{ id: string; slug: string; code: string; name: string; version_id: string }>`
    select id, slug, code, name, framework_version_id as version_id from management_system where deleted_at is null order by position, slug`.execute(trx);
  const systems = systemRows.map((r) => ({ id: r.id, slug: r.slug, code: r.code, name: r.name, versionId: r.version_id }));
  const system = systems.find((s) => s.id === msId);
  if (!system) throw new Error(`No management system ${msId}`);
  const version = system.versionId;

  const { rows: members } = await sql<ImportMember>`
    select u.id, u.handle, u.email, u.display_name as name from platform.org_membership m
      join platform.app_user u on u.id = m.user_id
     where m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid and m.status = 'active' and m.deleted_at is null
       and u.status = 'active' and u.deleted_at is null and u.kind = 'person'
     order by u.handle`.execute(trx);

  const lookups: ImportLookups = {
    system, systems, members, targets: new Map(), entries: new Map(), frequencies: [], docTypes: [], treatmentOptions: [], profiles: [],
    systemRisks: new Set(), systemDocuments: new Set(), existingCodes: new Set(),
  };

  const lookupValues = async (domain: string) =>
    (await sql<{ code: string; label_en: string; label_id: string }>`
      select code, label_en, label_id from ref.lookup_value where framework_version_id = ${version} and domain = ${domain}
       order by sort_order, code`.execute(trx)).rows.map((r) => ({ code: r.code, labelEn: r.label_en, labelId: r.label_id }));

  if (kind === 'applicability' || kind === 'evidence') {
    lookups.frequencies = (await sql<{ code: string; label_en: string; label_id: string }>`
      select code, label_en, label_id from ref.evidence_frequency_rule where framework_version_id = ${version} order by sort_order, code`.execute(trx))
      .rows.map((r) => ({ code: r.code, labelEn: r.label_en, labelId: r.label_id }));
    const { rows: targets } = await sql<{
      type: ImportTarget['type']; code: string; title: string; retired: boolean; assessable: boolean; leaf: boolean; default_frequency: string | null;
    }>`
      select type, code, title, retired, assessable, leaf, default_frequency from (
        select 'catalogue_item' as type, c.item_code as code, c.title_short as title, c.retired, true as assessable, true as leaf,
               c.default_frequency_code as default_frequency, 0 as part, c.sort_order
          from ref.catalogue_item c where c.framework_version_id = ${version}
        union all
        select 'requirement' as type, r.requirement_code as code, r.title_short as title, r.retired, r.applicability_assessable as assessable,
               not exists (select 1 from ref.requirement child where child.parent_id = r.id and not child.retired) as leaf,
               r.default_frequency_code as default_frequency, 1 as part, r.sort_order
          from ref.requirement r where r.framework_version_id = ${version}
      ) t order by part, sort_order, code`.execute(trx);
    for (const t of targets) {
      lookups.targets.set(targetKey(t.type, t.code), {
        type: t.type, code: t.code, title: t.title, retired: t.retired, assessable: t.assessable, leaf: t.leaf, defaultFrequency: t.default_frequency,
      });
    }
    const { rows: entries } = await sql<{
      id: string; updated_at: Date; type: ImportTarget['type']; code: string; is_applicable: boolean | null; status: string | null;
      inclusion: string | null; exclusion: string | null; owner: string | null; note: string | null; frequency: string | null;
      risks: string[] | null; documents: string[] | null;
    }>`
      select e.id, e.updated_at, e.target_type as type, coalesce(ci.item_code, rq.requirement_code) as code, e.is_applicable,
             e.implementation_status as status, e.inclusion_justification as inclusion, e.exclusion_justification as exclusion,
             o.handle as owner, e.status_note as note,
             (select oc.frequency_code from operating_criteria oc where oc.applicability_entry_id = e.id and oc.deleted_at is null limit 1) as frequency,
             (select array_agg(r.code order by er.position, r.code) from applicability_entry_risk er join risk r on r.id = er.risk_id and r.deleted_at is null
               where er.applicability_entry_id = e.id and er.deleted_at is null) as risks,
             (select array_agg(d.doc_code order by ed.position, d.doc_code) from applicability_entry_document ed join document d on d.id = ed.document_id
               and d.deleted_at is null where ed.applicability_entry_id = e.id and ed.deleted_at is null) as documents
        from applicability_entry e
        left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
        left join ref.requirement rq on rq.id = e.requirement_id
        left join platform.app_user o on o.id = e.owner_user_id
       where e.management_system_id = ${msId} and e.deleted_at is null`.execute(trx);
    for (const e of entries) {
      lookups.entries.set(targetKey(e.type, e.code), {
        id: e.id, updatedAt: new Date(e.updated_at), isApplicable: e.is_applicable, status: e.status, inclusion: e.inclusion, exclusion: e.exclusion,
        owner: e.owner ?? 'none', note: e.note, frequency: e.frequency, risks: e.risks ?? [], documents: e.documents ?? [],
      });
    }
  }

  if (kind === 'applicability') {
    lookups.systemRisks = new Set((await sql<{ code: string }>`
      select r.code from risk r where r.deleted_at is null and exists (select 1 from entity_ms_link l where l.entity_type = 'risk'
        and l.entity_id = r.id and l.management_system_id = ${msId} and l.deleted_at is null)`.execute(trx)).rows.map((r) => r.code));
    lookups.systemDocuments = new Set((await sql<{ code: string }>`
      select d.doc_code as code from document d where d.deleted_at is null and (d.is_org_wide or exists (select 1 from entity_ms_link l
        where l.entity_type = 'document' and l.entity_id = d.id and l.management_system_id = ${msId} and l.deleted_at is null))`.execute(trx)).rows.map((r) => r.code));
  }

  if (kind === 'documents') {
    lookups.docTypes = await lookupValues('doc_type');
    lookups.existingCodes = new Set((await sql<{ code: string }>`select doc_code as code from document where deleted_at is null`.execute(trx)).rows.map((r) => r.code));
  }

  if (kind === 'risks') {
    lookups.treatmentOptions = await lookupValues('treatment_option');
    lookups.profiles = (await sql<{ code: string; definition: Record<string, unknown> }>`
      select code, definition from ref.risk_profile where framework_version_id = ${version} order by code`.execute(trx))
      .rows.map((r) => ({ code: r.code, likelihood: scale(r.definition?.likelihood_scale), consequence: scale(r.definition?.consequence_scale) }));
    lookups.existingCodes = new Set((await sql<{ code: string }>`select code from risk where deleted_at is null`.execute(trx)).rows.map((r) => r.code));
  }

  if (kind === 'evidence') {
    lookups.existingCodes = new Set((await sql<{ code: string }>`select evidence_code as code from evidence where deleted_at is null`.execute(trx)).rows.map((r) => r.code));
  }
  return lookups;
}

// ---------------------------------------------------------------------------------------------------------------
// Matching the texts of a file
// ---------------------------------------------------------------------------------------------------------------

/** A text as compared: NFKC, lower case, single spaces. */
export function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; message: Messages };

const NONE_WORDS = new Set(['none', '-', 'unassigned', 'tidak ada', 'belum ditugaskan']);

/** People of the file by handle, email or full name (handles and emails resolved to members, D.1). */
export class People {
  private readonly byHandle = new Map<string, ImportMember>();
  private readonly byEmail = new Map<string, ImportMember>();
  private readonly byName = new Map<string, ImportMember[]>();

  constructor(members: readonly ImportMember[]) {
    for (const m of members) {
      this.byHandle.set(fold(m.handle), m);
      this.byEmail.set(fold(m.email), m);
      const list = this.byName.get(fold(m.name)) ?? [];
      list.push(m);
      this.byName.set(fold(m.name), list);
    }
  }

  /** The handle of a person cell; `none` for an unassigned value. */
  resolve(text: string, column: readonly [string, string]): Resolved<string> {
    const key = fold(text);
    if (NONE_WORDS.has(key)) return { ok: true, value: 'none' };
    const found = this.byHandle.get(key) ?? this.byEmail.get(key);
    if (found) return { ok: true, value: found.handle };
    const named = this.byName.get(key) ?? [];
    if (named.length === 1) return { ok: true, value: named[0]!.handle };
    if (named.length > 1) {
      return {
        ok: false,
        message: {
          en: `${column[0]}: ${text} is the name of ${named.length} members. Give the handle or the email instead.`,
          id: `${column[1]}: ${text} adalah nama ${named.length} anggota. Gunakan handle atau email.`,
        },
      };
    }
    return {
      ok: false,
      message: {
        en: `${column[0]}: ${text} is not an active member of this organisation.`,
        id: `${column[1]}: ${text} bukan anggota aktif organisasi ini.`,
      },
    };
  }

  handleOf(id: string): string | null {
    for (const m of this.byHandle.values()) if (m.id === id) return m.handle;
    return null;
  }
}

/** A lookup by its code or its label in either language. */
export function matchLookup(values: readonly ImportLookup[], text: string): ImportLookup | null {
  const key = fold(text);
  return values.find((v) => fold(v.code) === key || fold(v.labelEn) === key || fold(v.labelId) === key) ?? null;
}

const CLAUSE_PREFIX = /^(cl\.?|clause|klausul)\s*/i;

/**
 * The target a code of the file names: `Cl. 4.1` (or `Clause 4.1`, `Klausul 4.1`) is a clause, any other code a
 * catalogue item when the edition has one with that code, else a clause. Letter case does not matter.
 */
export function findTarget(lookups: Pick<ImportLookups, 'targets'>, text: string): ImportTarget | null {
  const raw = text.trim();
  const clause = CLAUSE_PREFIX.test(raw);
  const code = raw.replace(CLAUSE_PREFIX, '').trim();
  const key = code.toLowerCase();
  const pick = (type: ImportTarget['type']) => {
    const exact = lookups.targets.get(targetKey(type, code));
    if (exact) return exact;
    for (const t of lookups.targets.values()) if (t.type === type && t.code.toLowerCase() === key) return t;
    return null;
  };
  if (clause) return pick('requirement');
  return pick('catalogue_item') ?? pick('requirement');
}

/** Codes of a list cell: separated by commas, semicolons or line breaks, each once, in file order. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,;\n\r]+/)) {
    const code = part.trim();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

const YES = new Set(['yes', 'ya', 'y', 'true', '1', 'x', 'applicable', 'berlaku']);
const NO = new Set(['no', 'tidak', 'n', 'false', '0', 'not applicable', 'tidak berlaku']);

/** A Yes or No cell; undefined when empty. */
export function yesNo(text: string, column: readonly [string, string]): Resolved<boolean | undefined> {
  if (text === '') return { ok: true, value: undefined };
  const key = fold(text);
  if (YES.has(key)) return { ok: true, value: true };
  if (NO.has(key)) return { ok: true, value: false };
  return { ok: false, message: { en: `${column[0]}: the file has "${text}". Write Yes or No.`, id: `${column[1]}: berkas berisi "${text}". Tulis Ya atau Tidak.` } };
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A date cell as `YYYY-MM-DD`; undefined when empty. */
export function isoDate(text: string, column: readonly [string, string]): Resolved<string | undefined> {
  if (text === '') return { ok: true, value: undefined };
  const m = ISO_DAY.exec(text.trim());
  if (m) {
    const date = new Date(`${m[0]}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === m[0]) return { ok: true, value: m[0] };
  }
  return { ok: false, message: { en: `${column[0]}: the file has "${text}". Write the date as YYYY-MM-DD.`, id: `${column[1]}: berkas berisi "${text}". Tulis tanggal sebagai YYYY-MM-DD.` } };
}

/** A whole number cell; undefined when empty. */
export function wholeNumber(text: string, column: readonly [string, string]): Resolved<number | undefined> {
  if (text === '') return { ok: true, value: undefined };
  if (/^-?\d+$/.test(text.trim())) return { ok: true, value: Number(text.trim()) };
  return { ok: false, message: { en: `${column[0]}: the file has "${text}". Write a whole number.`, id: `${column[1]}: berkas berisi "${text}". Tulis bilangan bulat.` } };
}
