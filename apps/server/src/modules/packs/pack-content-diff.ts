// What a newer version of an installed edition changes (Milestone 2 E.1, E.3): the requirement and catalogue codes
// it drops (refused: rule PACK-ROW-REMOVED, a row leaves the standard only by being marked retired), and the summary
// of an accepted update (codes added, retitled, retired, back in the standard; new cycle requirements; activity and
// preparation task templates the version no longer lists, which stay in ref). The summary goes into the
// `pack.installed` audit entry, and `applicability.sync` reads it from there for the `pack_content_updated` notice.
import type { PackDatasets } from '@mscd/pack-tools';
import { sql } from 'kysely';
import type { Trx } from '../../common/tokens';
import { PackRejectedError } from './pack-verification';

/** Rows of an installed edition that an update is compared with. */
export interface EditionRows {
  requirements: ReadonlyMap<string, { title: string; retired: boolean }>;
  catalogue: ReadonlyMap<string, { title: string; retired: boolean }>;
  cycleRequirements: ReadonlySet<string>;
  /** `<phase_no>.<activity_no>` */
  activities: ReadonlySet<string>;
  prepTasks: ReadonlySet<string>;
}

/** The change summary of an edition update (codes in pack order). */
export interface PackContentChanges {
  /** Requirement and catalogue item codes new in this version. */
  added: string[];
  /** Codes whose short title changed. */
  retitled: string[];
  /** Codes this version marks retired that were in the standard before. */
  retired: string[];
  /** Codes retired before and in the standard again. */
  restored: string[];
  /** Cycle requirement codes new in this version. */
  cycleRequirementsAdded: string[];
  /** Activity templates (`<phase>.<activity>`) this version no longer lists; they stay in ref. */
  activitiesDropped: string[];
  /** Preparation task templates this version no longer lists; they stay in ref. */
  prepTasksDropped: string[];
}

/** Requirement and catalogue codes of the installed edition that the new version does not list. */
export interface RemovedRows {
  requirements: string[];
  catalogue: string[];
}

/** The rows of one framework version (installer or app connection: `ref` is readable by both). */
export async function loadEditionRows(trx: Trx, frameworkVersionId: string): Promise<EditionRows> {
  // One connection: the queries run one after the other.
  const requirements = await sql<{ code: string; title: string; retired: boolean }>`
    select requirement_code as code, title_short as title, retired from ref.requirement where framework_version_id = ${frameworkVersionId}`.execute(trx);
  const catalogue = await sql<{ code: string; title: string; retired: boolean }>`
    select item_code as code, title_short as title, retired from ref.catalogue_item where framework_version_id = ${frameworkVersionId}`.execute(trx);
  const cycle = await sql<{ code: string }>`select code from ref.cycle_requirement_def where framework_version_id = ${frameworkVersionId}`.execute(trx);
  const activities = await sql<{ code: string }>`
    select phase_no::text || '.' || activity_no::text as code from ref.activity_template where framework_version_id = ${frameworkVersionId}`.execute(trx);
  const prep = await sql<{ code: string }>`select code from ref.prep_task_template where framework_version_id = ${frameworkVersionId}`.execute(trx);
  return {
    requirements: new Map(requirements.rows.map((r) => [r.code, { title: r.title, retired: r.retired }])),
    catalogue: new Map(catalogue.rows.map((r) => [r.code, { title: r.title, retired: r.retired }])),
    cycleRequirements: new Set(cycle.rows.map((r) => r.code)),
    activities: new Set(activities.rows.map((r) => r.code)),
    prepTasks: new Set(prep.rows.map((r) => r.code)),
  };
}

/** Codes of the installed edition missing from the new version (sorted). */
export function removedRows(installed: EditionRows, datasets: Pick<PackDatasets, 'requirements' | 'catalogue'>): RemovedRows {
  const requirementCodes = new Set(datasets.requirements.map((r) => r.requirement_code));
  const itemCodes = new Set(datasets.catalogue.map((c) => c.item_code));
  return {
    requirements: [...installed.requirements.keys()].filter((code) => !requirementCodes.has(code)).sort(),
    catalogue: [...installed.catalogue.keys()].filter((code) => !itemCodes.has(code)).sort(),
  };
}

/** The refusal of a version that drops codes (422 `business-rule`, rule `PACK-ROW-REMOVED`), or null. */
export function rowRemovedError(pack: { packId: string; version: string }, removed: RemovedRows): PackRejectedError | null {
  const codes = [...removed.requirements, ...removed.catalogue];
  if (codes.length === 0) return null;
  const listed = codes.slice(0, 20).join(', ') + (codes.length > 20 ? ` and ${codes.length - 20} more` : '');
  return new PackRejectedError(
    'row_removed',
    `pack ${pack.packId} ${pack.version} drops ${codes.length === 1 ? 'a code' : `${codes.length} codes`} of the installed version without marking ${codes.length === 1 ? 'it' : 'them'} retired: ${listed}`,
    [
      ...removed.requirements.map((code) => `requirements.csv: ${code} is installed and missing from this version; keep the row with retired true`),
      ...removed.catalogue.map((code) => `catalogue.csv: ${code} is installed and missing from this version; keep the row with retired true`),
    ],
    pack,
  );
}

/** The change summary of a version against the installed rows of its edition. */
export function contentChanges(installed: EditionRows, datasets: PackDatasets): PackContentChanges {
  const changes: PackContentChanges = {
    added: [], retitled: [], retired: [], restored: [], cycleRequirementsAdded: [], activitiesDropped: [], prepTasksDropped: [],
  };
  const compare = (code: string, title: string, retired: boolean, before: { title: string; retired: boolean } | undefined) => {
    if (!before) {
      if (!retired) changes.added.push(code);
      return;
    }
    if (before.title !== title) changes.retitled.push(code);
    if (retired && !before.retired) changes.retired.push(code);
    if (!retired && before.retired) changes.restored.push(code);
  };
  for (const r of datasets.requirements) compare(r.requirement_code, r.title_short, r.retired, installed.requirements.get(r.requirement_code));
  for (const c of datasets.catalogue) compare(c.item_code, c.title_short, c.retired, installed.catalogue.get(c.item_code));
  changes.cycleRequirementsAdded = datasets.cycleRequirements.map((c) => c.code).filter((code) => !installed.cycleRequirements.has(code));
  const activityCodes = new Set(datasets.activities.map((a) => `${a.phase_no}.${a.activity_no}`));
  changes.activitiesDropped = [...installed.activities].filter((code) => !activityCodes.has(code)).sort(byNumbers);
  const prepCodes = new Set(datasets.prepTasks.map((p) => p.code));
  changes.prepTasksDropped = [...installed.prepTasks].filter((code) => !prepCodes.has(code)).sort();
  return changes;
}

/** True when the summary names no change. */
export function noContentChange(changes: PackContentChanges): boolean {
  return Object.values(changes).every((list) => list.length === 0);
}

function byNumbers(a: string, b: string): number {
  const [pa = 0, aa = 0] = a.split('.').map(Number);
  const [pb = 0, ab = 0] = b.split('.').map(Number);
  return pa - pb || aa - ab;
}

/** Reads a change summary stored in a `pack.installed` audit entry (written by this build), else null. */
export function parseContentChanges(value: unknown): PackContentChanges | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const list = (key: string): string[] => (Array.isArray(v[key]) ? (v[key] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  return {
    added: list('added'),
    retitled: list('retitled'),
    retired: list('retired'),
    restored: list('restored'),
    cycleRequirementsAdded: list('cycleRequirementsAdded'),
    activitiesDropped: list('activitiesDropped'),
    prepTasksDropped: list('prepTasksDropped'),
  };
}
