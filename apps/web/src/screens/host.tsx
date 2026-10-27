// Host glue of the controller (MILESTONE-2 C.3): pure functions and small components MscdApp.jsx calls to place host
// screens in the sidebar, decide who may open them, build their header values and render them in the host slots of
// the generated views (C.1), plus the host context of C.4.
import { Suspense } from 'react';
import type { ReactNode } from 'react';
import type { ApiClient } from '../data/api/ApiClient';
import type { CommandResult, ControllerData, DataSource, ManagementSystem, MeView, MsId, Organisation, UiRole } from '../data/types';
import { claimFor, detailExtensionsFor, extraPageActionsFor, slotItems } from './actions';
import type { ActionId } from './actions';
import { HOST_SCREENS, hostById } from './registry';
import { SCREEN_GROUPS } from './types';
import type {
  ActionArgs, DetailKind, DetailProps, GoExtra, HostContext, HostPerm, Lang, PickedFile, PickerOptions, ScreenDef, ScreenGroup, TextLike, TextPair, Theme,
} from './types';
import { Boundary, Failed, HostCtx, UI_TEXT, fillText, textOf } from './ui';

export { HOST_SCREENS, hostById };

// ---------------------------------------------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------------------------------------------

const permList = (perm: HostPerm): readonly string[] => (Array.isArray(perm) ? perm : [perm as string]);

/**
 * Permissions of the sample personas (sample builds only). The sample has no permission data; the manager persona
 * stands for the administrators of the sample organisation (C.2), the others get read access and the rights of their
 * persona that the host screens ask for. Permissions taken from the F.6 matrix are Milestone 3 (plan B).
 */
const SAMPLE_GRANTS: Readonly<Record<UiRole, '*' | readonly string[]>> = {
  manager: '*',
  top: ['ms.read', 'license.read', 'pack.read', 'audit.pending.aggregate', 'management_review.manage'],
  auditor: ['ms.read', 'finding.raise', 'internal_audit.manage', 'audit_trail.read', 'reminder.send'],
  owner: ['ms.read', 'applicability.complete', 'evidence.file.submit', 'document.version.create', 'record.complete_action'],
};

/** True when the sample persona holds one of the permissions. */
export function sampleCan(role: UiRole | null | undefined, perm: HostPerm): boolean {
  if (!role) return false;
  const grants = SAMPLE_GRANTS[role];
  if (!grants) return false;
  return grants === '*' || permList(perm).some((p) => grants.includes(p));
}

/** True when the permission set of `Me` (or the snapshot) holds one of the permissions in the system. */
export function apiCan(permissions: MeView['permissions'] | undefined | null, ms: MsId | null | undefined, perm: HostPerm): boolean {
  if (!permissions || !ms) return false;
  const held = (permissions.ms && permissions.ms[ms]) || [];
  return permList(perm).some((p) => (held as readonly string[]).includes(p));
}

/** True when the organisation and platform permissions hold one of the permissions. */
export function apiOrgCan(permissions: MeView['permissions'] | undefined | null, perm: HostPerm): boolean {
  if (!permissions) return false;
  return permList(perm).some((p) => (permissions.org as readonly string[]).includes(p));
}

// ---------------------------------------------------------------------------------------------------------------
// Visibility and the sidebar
// ---------------------------------------------------------------------------------------------------------------

/**
 * Whether the session may open a host screen. Sample builds: the screen lists the persona in `roles` (C.2). API mode:
 * the permission in the screen's scope (the selected system for `ms` screens, which need one).
 */
export function canOpenHost(id: string, ctx: HostContext, role: UiRole | null | undefined): boolean {
  const def = hostById(id);
  if (!def) return false;
  if (ctx.mode === 'sample') return Boolean(role) && def.roles.includes(role as UiRole) && (def.scope !== 'ms' || Boolean(ctx.msObj));
  if (def.scope === 'ms') return Boolean(ctx.msObj) && ctx.can(ctx.msObj!.id, def.perm);
  if (def.scope === 'platform') return ctx.platformCan(def.perm);
  return ctx.orgCan(def.perm);
}

/** Labels of the sidebar groups that the generated navigation does not name itself. */
export const GROUP_LABELS: Readonly<Record<ScreenGroup, TextPair | null>> = {
  top: null,
  impl: ['Implementation', 'Implementasi'],
  audit: ['Audit', 'Audit'],
  surv: ['Surveillance', 'Surveilans'],
  tasks: null,
  admin: ['Administration', 'Administrasi'],
  ops: ['Operations', 'Operasi'],
};

export interface NavItem {
  id: string;
  label: string;
  /** Position in the group; built-in entries get 10, 20, 30 in their given order. */
  order?: number;
  host?: boolean;
  icon?: string;
  /** Sidebar badge of a host screen. */
  n?: number;
}

export interface NavGroup {
  id: ScreenGroup;
  label: string | null;
  items: NavItem[];
}

/**
 * The sidebar: the built-in groups (already filtered to what the role may open) with every visible host screen
 * inserted into its group by order. A group missing from `groups` is added in its place; empty groups are dropped.
 */
export function hostNav(groups: readonly NavGroup[], ctx: HostContext, role: UiRole | null | undefined): NavGroup[] {
  const byId = new Map<ScreenGroup, NavGroup>();
  for (const g of groups) byId.set(g.id, { ...g, items: g.items.map((it, i) => ({ ...it, order: it.order ?? (i + 1) * 10 })) });
  for (const def of HOST_SCREENS) {
    if (def.nav === false || !canOpenHost(def.id, ctx, role)) continue;
    let group = byId.get(def.group);
    if (!group) {
      const label = GROUP_LABELS[def.group];
      group = { id: def.group, label: label ? ctx.li(label) : null, items: [] };
      byId.set(def.group, group);
    }
    let n = 0;
    try {
      n = def.count ? Number(def.count(ctx)) || 0 : 0;
    } catch (e) {
      console.warn(`badge of ${def.id} failed`, e);
    }
    group.items.push({ id: def.id, label: ctx.li(def.label), order: def.order, host: true, icon: def.icon, n });
  }
  return SCREEN_GROUPS.map((id) => byId.get(id))
    .filter((g): g is NavGroup => Boolean(g && g.items.length))
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) }));
}

/** The first screen of the Administration group a session may open (C.3 administration landing), else null. */
export function firstAdminScreen(ctx: HostContext, role: UiRole | null | undefined): string | null {
  const def = HOST_SCREENS.find((d) => d.group === 'admin' && d.nav !== false && canOpenHost(d.id, ctx, role));
  return def ? def.id : null;
}

/** The first `platform` screen a session may open (landing of a platform operator without a membership). */
export function firstPlatformScreen(ctx: HostContext): string | null {
  const def = HOST_SCREENS.find((d) => d.scope === 'platform' && d.nav !== false && canOpenHost(d.id, ctx, null));
  return def ? def.id : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Header values and the screen body
// ---------------------------------------------------------------------------------------------------------------

export interface HostPageAction {
  label: string;
  icon: string;
  primary: boolean;
  go(): void;
}

export interface HostVals {
  title: string;
  crumb1: string;
  crumb2: string | null;
  pageActions: HostPageAction[];
  tera: { what: string; how: string[] };
  body: ReactNode;
}

function safe<T>(what: string, run: () => T, fallback: T): T {
  try {
    return run();
  } catch (e) {
    console.error(`${what} failed`, e);
    return fallback;
  }
}

/** Title, breadcrumb, page actions, Tera help and body of an open host screen (C.3). */
export function hostVals(screen: string, ctx: HostContext): HostVals | null {
  const def = hostById(screen);
  if (!def) return null;
  const group = GROUP_LABELS[def.group];
  const title = ctx.li(def.label);
  const actions = safe(`page actions of ${def.id}`, () => def.pageActions?.(ctx) ?? [], []);
  return {
    title,
    crumb1: group ? ctx.li(group) : (ctx.org ? ctx.org.name : title),
    crumb2: group ? title : null,
    pageActions: actions.map((a) => ({ label: ctx.li(a.label), icon: a.icon, primary: Boolean(a.primary), go: () => a.run(ctx) })),
    tera: { what: def.tera ? ctx.li(def.tera.what) : '', how: (def.tera?.how ?? []).map((h) => ctx.li(h)) },
    body: <HostScreen key={def.id} def={def} ctx={ctx} />,
  };
}

/** Page actions packages add to a built-in screen (C.5 `extraPageActions`). */
export function hostExtraActions(screen: string, ctx: HostContext): HostPageAction[] {
  return extraPageActionsFor(screen)
    .filter((a) => safe(`visibility of ${a.id}`, () => (a.visible ? a.visible(ctx) : true), false))
    .map((a) => ({ label: ctx.li(a.label), icon: a.icon, primary: Boolean(a.primary), go: () => a.run(ctx) }));
}

function Loading({ lang }: { lang: Lang }) {
  return <div className="mx-small" role="status">{textOf(UI_TEXT.loading, lang)}</div>;
}

/** The body of a host screen: its context, an error boundary and Suspense for the lazy component. */
export function HostScreen({ def, ctx }: { def: ScreenDef; ctx: HostContext }) {
  const Body = def.Component;
  return (
    <HostCtx.Provider value={ctx}>
      <Boundary fallback={<Failed />}>
        <Suspense fallback={<Loading lang={ctx.lang} />}>
          <div className="mx-screen" data-screen={def.id}>
            <Body ctx={ctx} />
          </div>
        </Suspense>
      </Boundary>
    </HostCtx.Provider>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Detail extensions, claims and shell slots (C.5)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The detail extensions of a record kind for one record, or null when no visible extension exists (the slot of the
 * generated view then renders nothing). `inline` renders them as an atomic inline box (rows of the timeline).
 */
export function detailNode(kind: DetailKind, ctx: HostContext, props: Omit<DetailProps, 'ctx' | 'kind'>, inline = false): ReactNode {
  const all = detailExtensionsFor(kind);
  if (!all.length) return null;
  const shown = all.filter((e) => safe(`visibility of ${e.id}`, () => (e.visible ? e.visible(ctx, { ...props, kind }) : true), false));
  if (!shown.length) return null;
  const Tag = inline ? 'span' : 'div';
  return (
    <HostCtx.Provider value={ctx}>
      <Tag className={inline ? 'mx-ext-inline' : 'mx-ext'} data-ext={kind}>
        {shown.map((e) => {
          const Ext = e.Component;
          return (
            <Boundary key={e.id} fallback={<Failed />}>
              <Ext ctx={ctx} kind={kind} {...props} />
            </Boundary>
          );
        })}
      </Tag>
    </HostCtx.Provider>
  );
}

/** The claimed handler of an action, bound to the context; undefined when no package claims it. */
export function claimed(id: ActionId, ctx: HostContext): ((args?: ActionArgs) => void) | undefined {
  const handler = claimFor(id);
  return handler ? (args = {}) => handler(ctx, args) : undefined;
}

/** The components of a shell slot (`topbar`, `layer`) for this context, or null when none is visible. */
export function slotNode(slot: 'topbar' | 'layer', ctx: HostContext): ReactNode {
  const items = slotItems(slot).filter((i) => safe(`visibility of ${i.id}`, () => (i.visible ? i.visible(ctx) : true), false));
  if (!items.length) return null;
  return (
    <HostCtx.Provider value={ctx}>
      {items.map((i) => {
        const Item = i.Component;
        return (
          <Boundary key={i.id} fallback={null}>
            <Item ctx={ctx} />
          </Boundary>
        );
      })}
    </HostCtx.Provider>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The host context (C.4)
// ---------------------------------------------------------------------------------------------------------------

/** What the controller (MscdApp.jsx) offers to build the host context. */
export interface HostApp {
  readonly L: Lang;
  readonly api: boolean;
  readonly D: ControllerData | null;
  readonly ds: DataSource | null;
  readonly me: string;
  readonly MSL: ManagementSystem[];
  readonly msObj: ManagementSystem | undefined;
  readonly org: Organisation | undefined;
  readonly state: { theme?: Theme | null; role: UiRole; screen: string; params?: Record<string, unknown> | null };
  readonly props: { theme?: Theme };
  personOf(id: string): [string, string];
  toast(text: string): void;
  go(screen: string, extra?: GoExtra): void;
  track<T>(promise: Promise<T>): Promise<T>;
  reloadSystems(msIds: MsId[]): Promise<void>;
  command(run: (ds: DataSource) => Promise<CommandResult>, done?: (result: CommandResult) => void): void;
  pickFileFor(options: PickerOptions): Promise<PickedFile | null>;
  layerElement(): HTMLElement | null;
}

/** The host context of the current render. */
export function createHostContext(app: HostApp): HostContext {
  const lang: Lang = app.L === 'id' ? 'id' : 'en';
  const D = app.D;
  const api = app.api;
  const me = api && D ? ((D as unknown as { me?: MeView }).me ?? null) : null;
  const permissions = api && D ? ((D as unknown as { permissions?: MeView['permissions'] }).permissions ?? me?.permissions ?? null) : null;
  const hasMs = Boolean(D && app.MSL.length);
  const msObj = hasMs ? app.msObj ?? null : null;
  const role: UiRole | null = hasMs || !api ? app.state.role : null;
  const org = api && me && !me.org ? null : (D ? app.org ?? null : null);
  const handle = app.me;
  const [name, jobTitle] = D ? app.personOf(handle) : [handle, '-'];
  const li = (text: TextLike | null | undefined) => textOf(text, lang);
  const ctx: HostContext = {
    lang,
    li,
    fill: (text, values) => fillText(text, values, lang),
    theme: (app.state.theme ?? app.props.theme ?? 'light') === 'dark' ? 'dark' : 'light',
    D,
    msObj,
    org,
    me,
    person: { handle, name, jobTitle },
    role,
    mode: api ? 'api' : 'sample',
    client: api && app.ds ? ((app.ds as unknown as { client?: ApiClient }).client ?? null) : null,
    ds: app.ds,
    screen: app.state.screen,
    params: app.state.params ?? {},
    can: (ms, perm) => (api ? apiCan(permissions, ms, perm) : Boolean(ms) && sampleCan(role, perm)),
    orgCan: (perm) => (api ? apiOrgCan(permissions, perm) : sampleCan(app.state.role, perm)),
    platformCan: (perm) => (api ? apiOrgCan(permissions, perm) : sampleCan(app.state.role, perm)),
    toast: (text) => app.toast(text),
    go: (screen, extra) => app.go(screen, extra),
    track: (promise) => app.track(promise),
    reload: (msIds = []) => app.reloadSystems(msIds),
    command: (run, done) => app.command(run, done ?? (() => undefined)),
    openPicker: (options) => app.pickFileFor(options),
    layer: () => app.layerElement(),
  };
  return ctx;
}
