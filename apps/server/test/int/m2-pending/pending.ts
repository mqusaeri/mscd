// Route stubs of Milestone 2 that are still pending (docs/platform/MILESTONE-2.md D.1, F): M2-02 mounts every new route
// with a stub that answers 501 `not-implemented` after the guard, and lists the route ids in `M2-nn.json` or
// `M2-Snn.json` of its building package. The WP-30 contract harness declares 501 for the listed routes, and the RBAC,
// owner-scope, cross-system and isolation sweeps treat a 501 from a listed route as "guard passed, handler pending".
// Each building package deletes its own file when it replaces the stubs, so this list only shrinks. Milestone 3 (D.3):
// M3-01 mounts the new routes the same way and lists them in `M3-nn.json` of the building package.
//
// A file holds `routes` (route ids answering 501 for every input) and optionally `pathValues` (existing routes whose
// new path values are pending: route id, path member and the pending values, for example the register kinds
// `objectives` and `competence` of registers.list until M2-07).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RouteDef } from '@mscd/shared';

export interface PendingFile {
  workPackage: string;
  routes: string[];
  pathValues?: Record<string, Record<string, string[]>>;
}

export const PENDING_DIR = __dirname;

/** Every pending file of the folder, by file name. */
export function pendingFiles(): Map<string, PendingFile> {
  const out = new Map<string, PendingFile>();
  for (const name of readdirSync(PENDING_DIR).filter((f) => /^(?:M2-S?|M3-)\d\d\.json$/.test(f)).sort()) {
    const file = JSON.parse(readFileSync(path.join(PENDING_DIR, name), 'utf8')) as PendingFile;
    if (`${file.workPackage}.json` !== name) throw new Error(`${name} names work package ${file.workPackage}`);
    out.set(name, file);
  }
  return out;
}

const FILES = pendingFiles();

/** Route ids whose every answer may be the stub's 501, with the work package that builds them. */
export const PENDING_ROUTES: ReadonlyMap<string, string> = new Map(
  [...FILES.values()].flatMap((f) => f.routes.map((id) => [id, f.workPackage] as const)),
);

/** Existing routes with pending path values: route id to member to values. */
export const PENDING_PATH_VALUES: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>> = new Map(
  [...FILES.values()].flatMap((f) => Object.entries(f.pathValues ?? {})),
);

/** True when the route (with this input) may answer 501 `not-implemented`: its handler, or this path value, is pending. */
export function isPending(def: Pick<RouteDef, 'id'>, input?: { params?: Record<string, unknown> }): boolean {
  if (PENDING_ROUTES.has(def.id)) return true;
  const members = PENDING_PATH_VALUES.get(def.id);
  if (!members) return false;
  return Object.entries(members).some(([member, values]) => values.includes(String(input?.params?.[member])));
}
