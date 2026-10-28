// The model of the Import screen (MILESTONE-2 M2-08) and the interface both adapters implement (api.ts in API builds,
// sample.ts in the sample build), chosen by the build in Screen.tsx (MILESTONE-2 C.6). The screen works on the
// ImportRun of the api (D.1), types only (R-17).
import type { BusinessRole, CommandResult, ImportKind, ImportRowResult, ImportRun } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext } from '../types';

export type { ImportKind, ImportRowResult, ImportRun };

/** The import kinds in the order the screen offers them. */
export const IMPORT_KINDS: readonly ImportKind[] = ['applicability', 'documents', 'risks', 'evidence'];

/** The permission each kind needs (Milestone 2 D.1, `imports.create`). */
export const KIND_PERMS: Readonly<Record<ImportKind, string>> = {
  applicability: 'applicability.manage',
  documents: 'document.manage',
  risks: 'risk.manage',
  evidence: 'evidence.manage',
};

/**
 * Business roles that hold the permission of each kind in full (F.6). `Me.permissions` also lists a permission that a
 * role holds for own records only, and `imports.create` takes own records for evidence only: a Risk Owner holds
 * `risk.manage` for own risks and gets 403 `imports.permission` for a risk import. test/screens/import.test.tsx checks
 * these lists against the shared matrix.
 */
export const FULL_ROLES: Readonly<Record<ImportKind, readonly BusinessRole[]>> = {
  applicability: ['ms_manager'],
  documents: ['ms_manager'],
  risks: ['ms_manager'],
  evidence: ['ms_manager'],
};

/** Kinds `imports.create` also takes from a person who holds the permission for own records only. */
export const OWN_RECORD_KINDS: readonly ImportKind[] = ['evidence'];

/**
 * True when a person may import the kind: they hold its permission (`held`), in full unless the kind takes own
 * records. `roles` are their business roles in the system; null when unknown (the sample build, whose personas the
 * permission check covers).
 */
export function mayImport(kind: ImportKind, held: boolean, roles: readonly string[] | null): boolean {
  if (!held) return false;
  if (roles === null || OWN_RECORD_KINDS.includes(kind)) return true;
  return roles.some((r) => (FULL_ROLES[kind] as readonly string[]).includes(r));
}

/** True when the session may import the kind in the system (`mayImport` with the session's permissions and roles). */
export function sessionMayImport(ctx: Pick<HostContext, 'can' | 'me' | 'mode'>, ms: string, kind: ImportKind): boolean {
  const roles = ctx.mode === 'api' ? (ctx.me?.rolesByMs?.[ms] ?? null) : null;
  return mayImport(kind, ctx.can(ms, KIND_PERMS[kind]), roles);
}

/** The screen that shows the records of a kind, opened from the result summary. */
export const KIND_SCREENS: Readonly<Record<ImportKind, { id: string; label: readonly [string, string] }>> = {
  applicability: { id: 'controls', label: ['Controls & requirements', 'Kontrol & persyaratan'] },
  documents: { id: 'docs', label: ['Document register', 'Daftar dokumen'] },
  risks: { id: 'chain', label: ['Chain stages', 'Tahap rantai'] },
  evidence: { id: 'fresh', label: ['Evidence freshness', 'Kesegaran bukti'] },
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** A file to save: a link of the api, or a file made in the browser (sample build). */
export interface Download {
  href: string;
  fileName: string;
  /** Frees an object URL made in the browser. */
  release?(): void;
}

export interface ImportAdapter {
  /** The kinds this build imports (the sample build: controls and documents). */
  readonly kinds: readonly ImportKind[];
  /** The template of a kind. */
  template(ms: string, kind: ImportKind, lang: 'en' | 'id'): Promise<Download>;
  /** Uploads a file and checks every row (`imports.create`, the dry run). */
  check(ms: string, kind: ImportKind, file: File): Promise<Result<ImportRun>>;
  /** The state and the results of an import (`imports.get`). */
  get(ms: string, id: string): Promise<Result<ImportRun>>;
  /** Commits an import (`imports.commit`): the task id while the worker applies the rows. */
  commit(ms: string, id: string): Promise<Result<CommandResult>>;
}

export type RowFilter = 'all' | 'error' | 'warning';

/** The rows a filter shows. */
export function filterRows(rows: readonly ImportRowResult[], filter: RowFilter): ImportRowResult[] {
  return filter === 'all' ? [...rows] : rows.filter((r) => r.status === filter);
}

/** Rows the commit applies: rows without an error that create or change a record. */
export function rowsToImport(run: ImportRun): number {
  return run.results.filter((r) => r.status !== 'error' && (r.action === 'create' || r.action === 'update')).length;
}

/** Why "Import N rows" is not available, or null when it is. */
export function importBlocked(run: ImportRun): 'errors' | 'nothing' | 'expired' | null {
  if (run.status === 'expired') return 'expired';
  if (run.counts.error > 0) return 'errors';
  if (rowsToImport(run) === 0) return 'nothing';
  return null;
}

/** True while the worker applies the rows. */
export function isRunning(run: ImportRun | null): boolean {
  return run?.status === 'committing';
}
