// Action claims, extra page actions and detail extensions (MILESTONE-2 C.5).
//
// Every page action and row action of the generated screens that only shows a toast today has a stable id below.
// A package claims an id by exporting a handler from `src/screens/<folder>/actions.ts`:
//
//   export const claims = { 'docs.new': (ctx, args) => ... };
//   export const extraPageActions = [{ screen: 'fw', id: 'fw.transition', label: [...], icon, run(ctx) {...} }];
//   export const detailExtensions = [{ id: 'docs-edit', kind: 'doc', order: 10, Component }];
//   export const topbarItems = [{ id: 'bell', order: 10, Component }];      // hostTopbar slot
//   export const layerItems = [{ id: 'invitations', order: 10, Component }]; // hostLayer slot
//
// The controller calls the claimed handler, else keeps its toast. Overrides replace an existing command the same
// way (`audit.auditorAccess`). Two packages claiming one id, or a claim of an unknown id, stop the app with an error
// that names both, like the screen registry.
import { BUILTIN_SCREEN_IDS, DETAIL_KINDS } from './types';
import type { ActionHandler, DetailExtension, DetailKind, ExtraPageAction, ScreenActions, SlotItem } from './types';

/** Claimable action ids with the place they belong to. */
export const ACTION_IDS = {
  'controls.add': 'Controls & requirements, page action "Add control"',
  'docs.new': 'Document register, page action "New document"',
  'docs.openReview': 'Document detail, "Open review" of a document in review',
  'docs.continueDraft': 'Document detail, "Continue draft" of a draft document',
  'phases.recordBlocker': 'Phase board, activity detail "Record blocker"',
  'timeline.addEvent': 'Certification timeline, page action "Add audit event" and "Add" of a lane without events',
  'storage.connect': 'Storage repositories, page action "Connect repository"',
  'storage.settings': 'Storage repositories, repository card "Settings"',
  'mytasks.openDoc': 'My Tasks, "Open document" of a document task in review or draft',
  // Overrides of commands that already call the api.
  'audit.auditorAccess': 'Audit readiness, page action "Auditor access" (today an email prompt and 14 days of guest access)',
} as const;

export type ActionId = keyof typeof ACTION_IDS;

/** Checks and merges the exports of every `actions.ts`; `source` names the file in error messages. */
export function collectActions(modules: Readonly<Record<string, ScreenActions>>): {
  claims: Map<string, ActionHandler>;
  extraPageActions: ExtraPageAction[];
  detailExtensions: DetailExtension[];
  topbarItems: SlotItem[];
  layerItems: SlotItem[];
  problems: string[];
} {
  const claims = new Map<string, ActionHandler>();
  const owner = new Map<string, string>();
  const extraPageActions: ExtraPageAction[] = [];
  const detailExtensions: DetailExtension[] = [];
  const problems: string[] = [];
  const extraIds = new Set<string>();
  const extIds = new Set<string>();
  const topbarItems: SlotItem[] = [];
  const layerItems: SlotItem[] = [];
  const slotIds = new Set<string>();
  for (const [source, mod] of Object.entries(modules)) {
    for (const [list, items] of [[topbarItems, mod.topbarItems], [layerItems, mod.layerItems]] as const) {
      for (const item of items ?? []) {
        if (slotIds.has(item.id)) problems.push(`${source}: slot item id ${item.id} is used twice`);
        slotIds.add(item.id);
        list.push(item);
      }
    }
    for (const [id, handler] of Object.entries(mod.claims ?? {})) {
      if (!(id in ACTION_IDS)) problems.push(`${source}: unknown action id ${id}`);
      else if (owner.has(id)) problems.push(`${source}: ${id} is already claimed by ${owner.get(id)}`);
      else if (typeof handler !== 'function') problems.push(`${source}: the claim of ${id} is not a function`);
      else {
        claims.set(id, handler);
        owner.set(id, source);
      }
    }
    for (const action of mod.extraPageActions ?? []) {
      if (!(BUILTIN_SCREEN_IDS as readonly string[]).includes(action.screen)) problems.push(`${source}: ${action.id} adds to unknown screen ${action.screen}`);
      if (extraIds.has(action.id)) problems.push(`${source}: page action id ${action.id} is used twice`);
      extraIds.add(action.id);
      extraPageActions.push(action);
    }
    for (const ext of mod.detailExtensions ?? []) {
      if (!(DETAIL_KINDS as readonly string[]).includes(ext.kind)) problems.push(`${source}: ${ext.id} has unknown kind ${ext.kind}`);
      if (extIds.has(ext.id)) problems.push(`${source}: detail extension id ${ext.id} is used twice`);
      extIds.add(ext.id);
      detailExtensions.push(ext);
    }
  }
  const byOrder = (a: { order: number; id: string }, b: { order: number; id: string }) => a.order - b.order || a.id.localeCompare(b.id);
  detailExtensions.sort(byOrder);
  topbarItems.sort(byOrder);
  layerItems.sort(byOrder);
  return { claims, extraPageActions, detailExtensions, topbarItems, layerItems, problems };
}

const modules = import.meta.glob<ScreenActions>('./*/actions.ts', { eager: true });
const collected = collectActions(modules);
if (collected.problems.length) throw new Error(`Screen actions: ${collected.problems.join('; ')}`);

/** The claimed handler of an action id, or undefined (the controller then keeps its toast). */
export function claimFor(id: ActionId): ActionHandler | undefined {
  return collected.claims.get(id);
}

/** Page actions packages add to a built-in screen, in the order the files were found. */
export function extraPageActionsFor(screen: string): ExtraPageAction[] {
  return collected.extraPageActions.filter((a) => a.screen === screen);
}

/** Detail extensions of a record kind, in ascending order. */
export function detailExtensionsFor(kind: DetailKind): DetailExtension[] {
  return collected.detailExtensions.filter((e) => e.kind === kind);
}

/** Components of the top bar and of the host layer, in ascending order. */
export function slotItems(slot: 'topbar' | 'layer'): SlotItem[] {
  return slot === 'topbar' ? collected.topbarItems : collected.layerItems;
}
