// Types of the screen host (MILESTONE-2 C.2 to C.5): the definition of a host screen, the host context every screen
// and extension receives, page actions, action claims and detail extensions.
//
// A host screen is a hand-written React screen in its own folder `src/screens/<folder>/` (D2-01). Its `index.tsx`
// exports a `ScreenDef` as default; `registry.ts` collects every folder, so a new screen needs no edit of a shared
// file. Texts are [English, Indonesian] pairs, shown with `ctx.li()`.
import type { ComponentType, ReactNode } from 'react';
import type { ApiClient } from '../data/api/ApiClient';
import type {
  CommandResult, ControllerData, DataSource, ManagementSystem, MeView, MsId, Organisation, RecordKey, UiRole,
} from '../data/types';

export type Lang = 'en' | 'id';
export type Theme = 'light' | 'dark';

/** An [English, Indonesian] pair. */
export type TextPair = readonly [en: string, id: string];
/** A pair, or one string shown as it is in both languages. */
export type TextLike = string | TextPair;

/** Sidebar groups in display order: the portfolio, Implementation, Audit, Surveillance, My Tasks, Administration, Operations. */
export const SCREEN_GROUPS = ['top', 'impl', 'audit', 'surv', 'tasks', 'admin', 'ops'] as const;
export type ScreenGroup = (typeof SCREEN_GROUPS)[number];

/** Where a screen's permission is checked: the organisation, the selected management system, or the platform. */
export const SCREEN_SCOPES = ['org', 'ms', 'platform'] as const;
export type ScreenScope = (typeof SCREEN_SCOPES)[number];

/** A permission code of the F.6 matrix, or a list of codes where any one is enough. */
export type HostPerm = string | readonly string[];

/** The 14 screens of the generated views; no host screen may use these ids. */
export const BUILTIN_SCREEN_IDS = [
  'portfolio', 'm1overview', 'controls', 'phases', 'docs', 'audit', 'chain', 'gt', 'timeline', 'fresh', 'cal', 'mytasks', 'fw', 'storage',
] as const;
export type BuiltinScreenId = (typeof BUILTIN_SCREEN_IDS)[number];

/** Help text of the Tera panel: what the screen is for and the steps to use it. */
export interface TeraHelp {
  what: TextPair;
  how: TextPair[];
}

/** A button in the page header of a screen. Disabled actions are left out; a screen explains them on the page. */
export interface PageActionDef {
  label: TextPair;
  /** 24 by 24 stroke path of the icon. */
  icon: string;
  primary?: boolean;
  run(ctx: HostContext): void;
}

export interface ScreenProps {
  ctx: HostContext;
}

/** One host screen (C.2). */
export interface ScreenDef {
  /** Unique id, the last segment of `path` (D2-14); never one of BUILTIN_SCREEN_IDS. */
  id: string;
  /** Intended route of the screen, for example `/admin/license`. */
  path: string;
  group: ScreenGroup;
  /** Position in its group. Built-in entries have the orders 10, 20, 30 and so on, in their sidebar order. */
  order: number;
  label: TextPair;
  /** 24 by 24 stroke path of the sidebar icon. */
  icon: string;
  scope: ScreenScope;
  /** Sample personas that see the screen in the sample build (C.2). */
  roles: readonly UiRole[];
  /** Permission that opens the screen in API mode, checked in `scope`. */
  perm: HostPerm;
  /** False for screens opened only from another screen (no sidebar entry). Default true. */
  nav?: boolean;
  /** The screen body, usually `React.lazy(() => import('./Screen'))`. */
  Component: ComponentType<ScreenProps>;
  pageActions?(ctx: HostContext): PageActionDef[];
  /** Sidebar badge; 0 shows none. */
  count?(ctx: HostContext): number;
  tera?: TeraHelp;
}

/** Extra state of a navigation: `ms` switches the management system, `params` reach the target screen as ctx.params. */
export interface GoExtra {
  ms?: MsId;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

/** What `ctx.openPicker` asks for: the system and the record the file is for. */
export interface PickerOptions {
  ms: MsId;
  /** Storage object kind of the record. */
  kind: 'evidence' | 'document';
  /** Uuid of the record (API mode); any id in sample mode. */
  recordId: string;
}

/** The file chosen in the picker (`link`) or uploaded to the repository (`upload`); nothing is attached yet. */
export type PickedFile =
  | { source: 'link'; repository: string; externalItemId: string; externalVersionId?: string; fileName: string }
  | { source: 'upload'; uploadIntentId: string; fileName: string };

/** The session person in both modes: the signed-in user (API) or the sample persona's person. */
export interface HostPerson {
  handle: string;
  name: string;
  jobTitle: string;
}

/** The host context (C.4), built by the controller once per render. */
export interface HostContext {
  lang: Lang;
  /** The text of a pair (or a plain string) in the interface language. */
  li(text: TextLike | null | undefined): string;
  /** `li()` with `{name}` placeholders replaced from `values`. */
  fill(text: TextLike, values: Record<string, string | number>): string;
  theme: Theme;
  /** The controller's data: the snapshot with the static content and date helpers; null before the first load. */
  D: ControllerData | null;
  /** The selected management system; null when the user holds no role in a system (no-system path, C.3). */
  msObj: ManagementSystem | null;
  /** The current organisation; null for a platform operator without a membership. */
  org: Organisation | null;
  /** `GET /me` in API mode; null in sample mode. */
  me: MeView | null;
  person: HostPerson;
  /** UI role in the selected system (the sample persona in sample mode); null without a system. */
  role: UiRole | null;
  mode: 'sample' | 'api';
  /** The boot's ApiClient in API mode, null in sample mode (R-17: screens call the api only through it). */
  client: ApiClient | null;
  /** The data source: sample adapters change the sample snapshot through `mutate` and `insert` (C.6). */
  ds: DataSource | null;
  /** The open screen and the params it was opened with (`ctx.go(screen, {params})`). */
  screen: string;
  params: Record<string, unknown>;
  can(ms: MsId | null | undefined, perm: HostPerm): boolean;
  orgCan(perm: HostPerm): boolean;
  platformCan(perm: HostPerm): boolean;
  toast(text: string): void;
  go(screen: string, extra?: GoExtra): void;
  /** Shows the busy bar while the promise runs and returns it. */
  track<T>(promise: Promise<T>): Promise<T>;
  /** Loads the organisation snapshot again, with the bundles of `msIds` (D2-08: only when snapshot data changed). */
  reload(msIds?: MsId[]): Promise<void>;
  /** A command of the data source, then a reload of the systems it changed and `done(result)` (the controller's queue). */
  command(run: (ds: DataSource) => Promise<CommandResult>, done?: (result: CommandResult) => void): void;
  /** Opens the file picker of the system's repository (or the upload dialog of the Managed Vault); null when cancelled. */
  openPicker(options: PickerOptions): Promise<PickedFile | null>;
  /** The element host modals and drawers portal into; null outside a browser. */
  layer(): HTMLElement | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Action claims and detail extensions (C.5)
// ---------------------------------------------------------------------------------------------------------------

/** Record kinds that detail extensions attach to. */
export const DETAIL_KINDS = ['req', 'doc', 'ev', 'item', 'activity', 'event', 'prep', 'cycle'] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

/** What a claimed action receives: the system, and for row actions the record and its key. */
export interface ActionArgs {
  ms?: MsId;
  key?: RecordKey;
  record?: unknown;
  [name: string]: unknown;
}
export type ActionHandler = (ctx: HostContext, args: ActionArgs) => void;

/** A page action a package adds to a built-in screen (for example `fw`). */
export interface ExtraPageAction {
  /** Built-in screen id. */
  screen: BuiltinScreenId;
  id: string;
  label: TextPair;
  icon: string;
  primary?: boolean;
  /** Shown only when true (permission checks). Default: shown. */
  visible?(ctx: HostContext): boolean;
  run(ctx: HostContext): void;
}

export interface DetailProps {
  ctx: HostContext;
  kind: DetailKind;
  ms: MsId;
  /** Key of the record (`<ms>:<kind>:<id>`); null for kinds without a key. */
  recordKey: RecordKey | null;
  /** The record as the generated detail shows it (requirement, document, evidence, chain item, activity, event, row). */
  record: unknown;
  /** Closes the drawer or page detail. */
  close(): void;
}

export interface DetailExtension {
  id: string;
  kind: DetailKind;
  /** Extensions of one kind render in ascending order. */
  order: number;
  Component: ComponentType<DetailProps>;
  visible?(ctx: HostContext, props: Omit<DetailProps, 'ctx'>): boolean;
}

/**
 * A component a package adds to a shell slot: the top bar (`hostTopbar`, for example the notification bell) or the
 * host layer (`hostLayer`, for example a banner). It renders on every screen.
 */
export interface SlotItem {
  id: string;
  order: number;
  Component: ComponentType<ScreenProps>;
  visible?(ctx: HostContext): boolean;
}

/** The exports of `src/screens/<folder>/actions.ts`. */
export interface ScreenActions {
  claims?: Partial<Record<string, ActionHandler>>;
  extraPageActions?: ExtraPageAction[];
  detailExtensions?: DetailExtension[];
  topbarItems?: SlotItem[];
  layerItems?: SlotItem[];
}

/** A node the controller passes to a host slot of the generated views. */
export type SlotNode = ReactNode;
