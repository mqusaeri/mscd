// Requirements and controls of a system (build plan G.5 `bundle.reqs`, C.11, UI 1.5). Milestone 2 (D2-09, M2-07): a
// clause entry (a requirement row) of a catalogue system has the key `cl-<code>`, so it never shares a key with the
// Annex A control of the same number (`5.1`).
import { clauseEntryKey, uiReqStatus, type Requirement } from '@mscd/shared';
import type { EntryRow } from './inputs';
import { NONE } from './text';

/** G.5 `id`: the catalogue item code (`A.5.23`), or `Cl. ` plus the requirement code (`Cl. 8.4`). */
export function requirementId(targetType: EntryRow['targetType'], code: string): string {
  return targetType === 'catalogue_item' ? code : `Cl. ${code}`;
}

/**
 * G.5 `key`: the code without a leading `A.` (`5.23`, `8.4`); with `clauseOfCatalogue` (a requirement row of a
 * system whose edition has a catalogue, D2-09) `cl-<code>` (`cl-5.1`).
 */
export function requirementKey(code: string, clauseOfCatalogue = false): string {
  return clauseOfCatalogue ? clauseEntryKey(code) : code.replace(/^A\./, '');
}

/** An entry as the key needs it: the loader marks the entries of a system whose edition has a catalogue (D2-09). */
export type KeyedEntry = Pick<EntryRow, 'targetType' | 'code'> & { catalogueSystem?: boolean };

/** The read model key of an applicability entry (`requirementKey` with the D2-09 rule for clause entries). */
export function entryKey(entry: KeyedEntry): string {
  return requirementKey(entry.code, entry.targetType === 'requirement' && entry.catalogueSystem === true);
}

/**
 * G.5 `theme`: `A.<n> <theme label>` for a catalogue item (`A.5 Organizational`, the label from the pack's
 * `catalogue.theme.<n>`), else `Clause <clause_group>`.
 */
export function requirementTheme(entry: Pick<EntryRow, 'targetType' | 'themeCode' | 'clauseGroup' | 'code'>, themeLabels: Readonly<Record<string, string>>): string {
  if (entry.targetType === 'catalogue_item') {
    const theme = entry.themeCode ?? entry.code.split('.').slice(0, 2).join('.');
    const label = themeLabels[theme.replace(/^A\./, '')];
    return label ? `${theme} ${label}` : theme;
  }
  return `Clause ${entry.clauseGroup ?? entry.code.split('.')[0]}`;
}

/** G.5 `just`: the exclusion justification of an entry that does not apply, else the inclusion justification. */
export function justificationOf(entry: Pick<EntryRow, 'status' | 'isApplicable' | 'inclusionJustification' | 'exclusionJustification'>): string {
  const excluded = entry.status === 'not_applicable' || entry.isApplicable === false;
  return (excluded ? entry.exclusionJustification : entry.inclusionJustification) ?? '';
}

/** One requirement of `bundle.reqs` (G.5). */
export function deriveRequirement(entry: EntryRow & { catalogueSystem?: boolean }, themeLabels: Readonly<Record<string, string>>): Requirement {
  const st = uiReqStatus(entry.status, entry.holdsGate);
  const requirement: Requirement = {
    id: requirementId(entry.targetType, entry.code),
    key: entryKey(entry),
    title: entry.title,
    theme: requirementTheme(entry, themeLabels),
    st,
    owner: entry.owner ?? NONE,
    doc: entry.documentCodes[0] ?? '',
    freq: entry.frequency,
    note: entry.statusNote ?? '',
    gate: entry.holdsGate,
    just: justificationOf(entry),
    risks: [...entry.riskCodes],
  };
  if (entry.completedBy) requirement.by = entry.completedBy;
  return requirement;
}
