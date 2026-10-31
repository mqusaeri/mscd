// `manifest.json` of the organisation export (Milestone 3 D.4), format version 1. The full manifest is stored as its
// own vault object and downloaded separately (`exports.organization.manifest`); a copy is the last entry of the last
// part. A file cannot hold its own hash, so in that copy (`copy: "last-part"`) the part that holds it has no size and
// no SHA-256; MSCD shows them and sends them with the download. Everything else is the same in both copies.
import type { EntryPiece, WrittenEntry } from './archive/archive-writer';

export const MANIFEST_FORMAT = 'mscd-organization-export';
export const MANIFEST_FORMAT_VERSION = 1;
export const MANIFEST_NAME = 'manifest.json';

export type ManifestEntryKind = 'readme' | 'table' | 'platform' | 'audit' | 'anchors' | 'key' | 'file' | 'file-list';

export interface ManifestEntry {
  path: string;
  kind: ManifestEntryKind;
  /** Part that holds the entry; null when it is cut into pieces. */
  part: number | null;
  sizeBytes: number;
  sha256: string;
  /** Rows of a table or data file. */
  rows?: number;
  /** Storage object id of a file. */
  objectId?: string;
  pieces?: EntryPiece[];
}

export interface ManifestPart {
  part: number;
  name: string;
  /** Null only for the part that holds the copy of the manifest, in that copy. */
  sizeBytes: number | null;
  sha256: string | null;
}

/** A file of the Managed Vault listed without content. */
export interface FileWithoutContent {
  objectId: string;
  repository: string;
  name: string | null;
  reason: 'disposed' | 'removed' | 'missing';
  detail: string;
}

export interface ExportManifest {
  format: typeof MANIFEST_FORMAT;
  formatVersion: typeof MANIFEST_FORMAT_VERSION;
  copy: 'download' | 'last-part';
  exportId: string;
  organization: { id: string; slug: string; name: string };
  createdAt: string;
  requestedVia: string;
  requestedBy: string | null;
  approvedBy: string | null;
  isFinal: boolean;
  mscd: { version: string; revision: string };
  /** Migrations of the organisation's schema: read from its migration table, or the list of the build (see the source). */
  tenantMigrations: readonly string[];
  /**
   * `schema` when the list was read from the schema's `kysely_migration` table; `build` when the application role may
   * not read that table (it is private to the migrator), so the list is the one compiled into this build, which
   * `mscd-server migrate` applies to every organisation schema before the API and the worker start.
   */
  tenantMigrationsSource: 'schema' | 'build';
  frameworkPacks: { system: string; packId: string; packVersion: string; role: string }[];
  parts: ManifestPart[];
  entries: ManifestEntry[];
  filesWithoutContent: FileWithoutContent[];
  audit: { chain: string; rows: number; anchors: number; anchorKeyIds: string[] };
  excluded: { item: string; reason: string }[];
  counts: { tables: number; rows: number; files: number; filesWithoutContent: number; externalFiles: number; fileBytes: number; entries: number; parts: number };
}

/** A written archive entry as a manifest entry. */
export function manifestEntry(written: WrittenEntry, kind: ManifestEntryKind, extra: Partial<Pick<ManifestEntry, 'rows' | 'objectId'>> = {}): ManifestEntry {
  return {
    path: written.path,
    kind,
    part: written.part,
    sizeBytes: written.sizeBytes,
    sha256: written.sha256,
    ...extra,
    ...(written.pieces ? { pieces: written.pieces } : {}),
  };
}

/** The manifest as UTF-8 JSON text (two-space indent, final newline). */
export function manifestBytes(manifest: ExportManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
