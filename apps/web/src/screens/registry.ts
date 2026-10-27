// Screen registry (MILESTONE-2 C.2). Every folder `src/screens/<folder>/` with an `index.tsx` whose default export is
// a `ScreenDef` is a host screen; `import.meta.glob` finds them at build time, so adding a screen edits no shared file.
//
// The definitions are checked when this module loads: unique ids, no clash with the 14 built-in screens, a known
// group and scope, both languages in every text pair, an icon and a path that ends with the id. A broken definition
// stops the app with an error that names the screen, so it cannot reach a release unnoticed (the unit and E2E
// suites load the registry).
import { BUILTIN_SCREEN_IDS, SCREEN_GROUPS, SCREEN_SCOPES } from './types';
import type { ScreenDef, ScreenGroup } from './types';

/** Problems of a list of screen definitions; empty when every definition is valid. */
export function validateScreens(defs: readonly ScreenDef[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const pair = (where: string, value: unknown) => {
    if (!Array.isArray(value) || value.length !== 2 || value.some((s) => typeof s !== 'string' || !s.trim())) {
      problems.push(`${where}: needs an English and an Indonesian text`);
    }
  };
  for (const def of defs) {
    const id = def && typeof def.id === 'string' ? def.id : '';
    const at = `screen ${id || '(no id)'}`;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) problems.push(`${at}: the id must be lower case letters, digits and hyphens`);
    if (seen.has(id)) problems.push(`${at}: the id is used twice`);
    seen.add(id);
    if ((BUILTIN_SCREEN_IDS as readonly string[]).includes(id)) problems.push(`${at}: the id is a built-in screen`);
    if (!(SCREEN_GROUPS as readonly string[]).includes(def.group)) problems.push(`${at}: unknown group ${String(def.group)}`);
    if (!(SCREEN_SCOPES as readonly string[]).includes(def.scope)) problems.push(`${at}: unknown scope ${String(def.scope)}`);
    if (typeof def.order !== 'number' || !Number.isFinite(def.order)) problems.push(`${at}: order must be a number`);
    if (typeof def.path !== 'string' || !def.path.startsWith('/') || def.path.split('/').pop() !== id) {
      problems.push(`${at}: the path must start with / and end with the id (D2-14)`);
    }
    if (typeof def.icon !== 'string' || !/^M/.test(def.icon.trim())) problems.push(`${at}: needs an icon path`);
    if (!Array.isArray(def.roles)) problems.push(`${at}: roles must be a list of sample personas`);
    const perms = Array.isArray(def.perm) ? def.perm : [def.perm];
    if (!perms.length || perms.some((p) => typeof p !== 'string' || !p)) problems.push(`${at}: needs a permission`);
    if (!def.Component) problems.push(`${at}: needs a Component`);
    pair(`${at} label`, def.label);
    if (def.tera) {
      pair(`${at} tera.what`, def.tera.what);
      (def.tera.how ?? []).forEach((h, i) => pair(`${at} tera.how[${i}]`, h));
    }
  }
  return problems;
}

const GROUP_RANK = new Map<ScreenGroup, number>(SCREEN_GROUPS.map((g, i) => [g, i]));

/** Definitions sorted by sidebar group, then order, then id. */
export function sortScreens(defs: readonly ScreenDef[]): ScreenDef[] {
  return [...defs].sort((a, b) => (GROUP_RANK.get(a.group)! - GROUP_RANK.get(b.group)!) || a.order - b.order || a.id.localeCompare(b.id));
}

/** The folder of each screen file (`./license/index.tsx` gives `license`). */
export function folderOf(file: string): string {
  return file.replace(/^\.\//, '').split('/')[0];
}

const modules = import.meta.glob<{ default: ScreenDef }>('./*/index.tsx', { eager: true });

/** Screen definitions by folder, as found on disk. */
export const SCREEN_FOLDERS: Readonly<Record<string, ScreenDef>> = Object.fromEntries(
  Object.entries(modules).map(([file, mod]) => [folderOf(file), mod.default]),
);

const problems = validateScreens(Object.values(SCREEN_FOLDERS));
const missing = Object.entries(SCREEN_FOLDERS).filter(([, def]) => !def).map(([folder]) => `src/screens/${folder}/index.tsx has no default export`);
if (problems.length || missing.length) throw new Error(`Screen registry: ${[...missing, ...problems].join('; ')}`);

/** Every host screen, sorted by group and order. */
export const HOST_SCREENS: readonly ScreenDef[] = sortScreens(Object.values(SCREEN_FOLDERS));

const BY_ID = new Map(HOST_SCREENS.map((def) => [def.id, def]));

/** The host screen with this id, or undefined (built-in screens are not in the registry). */
export function hostById(id: string | null | undefined): ScreenDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}
