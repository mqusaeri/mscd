// The view model of Personal data checks (MILESTONE-3 M3-04, D.6.4) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build): the checks of the system, the records that name the person of a check,
// and the check marked done with a note. `targetOf` gives the screen that edits a mentioned record.
import type { ApiResult } from '../../data/api/ApiClient';
import type { GoExtra, TextPair } from '../types';
import { docKey } from '../docs-edit/model';
import { KIND_TEXT, TEXT } from './text';

export type CheckType = 'access' | 'rectification' | 'restriction' | 'erasure';

export interface CheckRow {
  id: string;
  requestNo: string;
  type: CheckType;
  subject: { name: string; handle: string | null };
  dueAt: string;
  status: 'open' | 'done';
  doneAt: string | null;
}

export interface Mention {
  recordKind: string;
  recordId: string;
  code: string | null;
  field: string;
  excerpt: string;
}

export interface Mentions {
  items: Mention[];
  truncated: boolean;
}

export interface PrivacyChecksAdapter {
  readonly sample?: boolean;
  list(ms: string): Promise<ApiResult<CheckRow[]>>;
  mentions(ms: string, id: string): Promise<ApiResult<Mentions>>;
  done(ms: string, id: string, note: string): Promise<ApiResult<{ message: TextPair | null }>>;
}

export const TYPE_TEXT: Readonly<Record<CheckType, TextPair>> = {
  access: TEXT.typeAccess, erasure: TEXT.typeErasure, rectification: TEXT.typeRectification, restriction: TEXT.typeRestriction,
};

/** The label of a record kind; an unknown kind reads as its words. */
export function kindText(kind: string): TextPair {
  const known = KIND_TEXT[kind];
  if (known) return [known[0], known[1]];
  const words = kind.replace(/_/g, ' ');
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return [label, label];
}

/** The label of a searched field (`pending_action` reads "Pending action"). */
export function fieldText(field: string): string {
  const words = field.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const REGISTER_TABS: Readonly<Record<string, string>> = {
  context_issue: 'context-issues',
  interested_party: 'interested-parties',
  asset: 'assets',
  risk: 'risks',
  metric: 'metrics',
  quality_objective: 'objectives',
  competence_record: 'competence',
};

/** The screen that edits a mentioned record, with what it opens; null when the record has no screen of its own. */
export function targetOf(ms: string, mention: Mention): { screen: string; extra: GoExtra } | null {
  const tab = REGISTER_TABS[mention.recordKind];
  if (tab) return { screen: 'registers', extra: { ms, params: { tab } } };
  switch (mention.recordKind) {
    case 'document': {
      if (!mention.code) return null;
      const key = docKey(ms, mention.code);
      return { screen: 'docs', extra: { ms, sel: key, expanded: { [key]: true } } };
    }
    case 'evidence': {
      if (!mention.code) return null;
      const key = `${ms}:ev:${mention.code}`;
      return { screen: 'fresh', extra: { ms, sel: key, expanded: { [key]: true } } };
    }
    case 'finding':
      return { screen: 'findings', extra: { ms, params: { finding: mention.recordId, at: Date.now() } } };
    case 'corrective_action':
      return { screen: 'findings', extra: { ms, params: { tab: 'actions', at: Date.now() } } };
    case 'management_review':
      return { screen: 'management-review', extra: { ms } };
    case 'retention_rule':
    case 'retention_review':
    case 'retention_hold':
      return { screen: 'retention', extra: { ms } };
    case 'access_review':
      return { screen: 'access-review', extra: { ms } };
    default:
      return null;
  }
}

/** Open checks first by due time, then done ones newest first (the server's order). */
export function sortChecks(rows: readonly CheckRow[]): CheckRow[] {
  return [...rows].sort((a, b) => {
    const open = Number(b.status === 'open') - Number(a.status === 'open');
    if (open) return open;
    if (a.status === 'open') return a.dueAt.localeCompare(b.dueAt) || a.requestNo.localeCompare(b.requestNo);
    return (b.doneAt ?? '').localeCompare(a.doneAt ?? '') || b.requestNo.localeCompare(a.requestNo);
  });
}
