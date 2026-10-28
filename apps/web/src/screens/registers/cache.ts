// The first page of the first register per system (MILESTONE-2 M2-13), kept in memory for the browser session, so the
// Registers screen shows its rows on its first render: the layer item of actions.ts reads the page when a system opens
// (Prefetch.tsx) and the screen keeps it current after each load. The screen reads the api again at once, so a kept
// page is only what shows until that answer arrives. Keyed by organisation, person, persona and system, since what a
// person may read differs (F.7, H.5).
//
// The same module keeps the proof files of competence records that are attached to their evidence record but not
// linked to the record yet (see `keepUnlinkedProof`).
import type { HostContext, PickedFile } from '../types';
import type { RegisterKind, RowPage } from './model';

/** Rows per page of a register list. */
export const PAGE_SIZE = 50;
/** The tab the screen opens on. */
export const FIRST_KIND: RegisterKind = 'context-issues';
/** A kept page younger than this is not read again in the background. */
export const PREFETCH_MAX_AGE_MS = 60_000;

const pages = new Map<string, { at: number; page: RowPage }>();

/** The key of a system's first page of a register for the session person. */
export function firstPageKey(ctx: Pick<HostContext, 'org' | 'me' | 'person' | 'role'>, ms: string, kind: RegisterKind): string {
  return [ctx.org?.id ?? '', ctx.me?.user?.handle ?? ctx.person.handle, ctx.role ?? '', ms, kind].join('|');
}

export function cachedFirstPage(key: string): RowPage | null {
  return pages.get(key)?.page ?? null;
}

/** How long ago the page was kept, or null when it was not. */
export function cacheAge(key: string): number | null {
  const hit = pages.get(key);
  return hit ? Date.now() - hit.at : null;
}

export function cacheFirstPage(key: string, page: RowPage): void {
  pages.set(key, { at: Date.now(), page });
}

/** A proof file attached to its evidence record (`evidence.files`) whose competence record does not point to it yet. */
export interface AttachedProof {
  file: PickedFile;
  /** Id of the evidence record that keeps the file. */
  holder: string;
  storageObjectId: string;
}

const unlinked = new Map<string, AttachedProof>();

/** The key of a competence record's unlinked proof for the session person. */
export function proofKey(ctx: Pick<HostContext, 'org' | 'me' | 'person'>, ms: string, recordId: string): string {
  return [ctx.org?.id ?? '', ctx.me?.user?.handle ?? ctx.person.handle, ms, recordId].join('|');
}

/**
 * The file a save attached to the evidence record before the record refused to point to it, so the next Edit of the
 * record starts with that file chosen and links it without attaching it to the evidence record a second time.
 */
export function unlinkedProof(key: string): AttachedProof | null {
  return unlinked.get(key) ?? null;
}

/** Keeps the unlinked proof of a record, or forgets it (null). */
export function keepUnlinkedProof(key: string, proof: AttachedProof | null): void {
  if (proof) unlinked.set(key, proof);
  else unlinked.delete(key);
}

/** Forgets every kept page and every unlinked proof (tests). */
export function resetRegisterCache(): void {
  pages.clear();
  unlinked.clear();
}
