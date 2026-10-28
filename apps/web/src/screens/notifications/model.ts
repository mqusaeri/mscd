// The model of the notification bell and panel (MILESTONE-2 M2-16) and the interface both adapters implement (api.ts
// in API builds, sample.ts in the sample build), with the link from a notification to the screen of its record.
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext, TextPair } from '../types';

export interface NotificationModel {
  id: string;
  kind: string;
  title: TextPair;
  body: TextPair;
  ms: string | null;
  /** The record of the notification (`RecordRef`): entity type and uuid. */
  ref: { entityType: string; id: string; code: string } | null;
  /** The record key (`<ms>:<kind>:<id>`) when the source knows it (the sample does). */
  key?: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage {
  items: NotificationModel[];
  page: number;
  pageSize: number;
  total: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface NotificationsAdapter {
  /** Unread notifications of the session user (`GET /notifications?unread=true&pageSize=1`, its `total`). */
  unreadCount(): Promise<Result<number>>;
  list(query: { page: number; pageSize: number; unreadOnly: boolean }): Promise<Result<NotificationPage>>;
  markRead(id: string): Promise<Result<null>>;
  markAllRead(): Promise<Result<null>>;
}

/** Rows per page of the panel. */
export const PAGE_SIZE = 20;
/** How often the bell reads the unread count again while the person is active (poll.ts). */
export const POLL_MS = 60_000;
/**
 * How long after the last input the bell keeps reading the count: well under the idle timeout of every session (F.1:
 * 30 minutes for guest auditors), so the bell never keeps an unattended session alive.
 */
export const IDLE_AFTER_MS = 5 * 60_000;

/** The screen of a record key's kind (`isms:req:A.5.23` opens Controls with that record). */
const KEY_SCREENS: Readonly<Record<string, { screen: string; detail: boolean }>> = {
  req: { screen: 'controls', detail: true },
  soa: { screen: 'controls', detail: false },
  doc: { screen: 'docs', detail: true },
  ev: { screen: 'fresh', detail: true },
  x: { screen: 'chain', detail: true },
  act: { screen: 'phases', detail: false },
  prep: { screen: 'timeline', detail: false },
  cycle: { screen: 'timeline', detail: false },
  drift: { screen: 'fresh', detail: false },
  task: { screen: 'mytasks', detail: false },
};

/** The screen of a record's entity type when no record key is known. */
const ENTITY_SCREENS: Readonly<Record<string, string>> = {
  applicability_entry: 'controls',
  document: 'docs',
  document_version: 'docs',
  evidence_item: 'fresh',
  evidence_file: 'fresh',
  risk: 'chain',
  risk_treatment: 'chain',
  activity_instance: 'phases',
  audit_event: 'timeline',
  audit_prep_task: 'timeline',
  certification_cycle: 'timeline',
  task: 'mytasks',
  finding: 'audit',
  corrective_action: 'audit',
  management_review: 'audit',
  storage_repository: 'storage',
  import_run: 'import',
  user_ms_role: 'approvals',
};

/** The screen of a notification kind when it names no record. */
const KIND_SCREENS: Readonly<Record<string, string>> = {
  reminder: 'mytasks',
  task_overdue: 'mytasks',
  freshness_downgrade: 'fresh',
  evidence_aging: 'fresh',
  evidence_anomaly: 'fresh',
  drift_detected: 'fresh',
  document_new_version: 'docs',
  document_review_due: 'docs',
  document_expired: 'docs',
  finding_overdue: 'audit',
  prep_task_assigned: 'timeline',
  audit_date_changed: 'timeline',
  certificate_expiring: 'timeline',
  connector_revoked: 'storage',
  credential_expiring: 'storage',
  move_request: 'storage',
  licence_state: 'license',
  licence_expiring: 'license',
  edition_withdrawn: 'fw',
  pack_content_updated: 'fw',
  role_grant_pending: 'approvals',
  import_finished: 'import',
};

export interface Link {
  screen: string;
  /** What `ctx.go` receives: the system and, for list screens, the tab and the record to open. */
  extra: { ms?: string; sel?: string; expanded?: Record<string, boolean>; tab?: Record<string, string>; chip?: Record<string, string> };
}

/** The tab and filter of a list screen that show the record, as the generated detail links set them. */
function viewOf(ctx: HostContext, ms: string, kind: string, key: string): Pick<Link['extra'], 'tab' | 'chip'> | null {
  const bundle = ctx.D?.bundles?.[ms];
  if (kind === 'req') {
    const req = bundle?.reqs?.find((r) => r.key === key || `${ms}:req:${r.id}` === key);
    if (!req) return null;
    return { tab: { controls: req.st === 'partial' ? 'partial' : 'implemented' }, chip: { controls: req.st } };
  }
  if (kind === 'x') {
    const item = bundle?.chain?.items?.find((i) => i.key === key);
    return item ? { tab: { chain: item.stage } } : null;
  }
  return {};
}

/** The record key of a notification: its own, or the snapshot's key whose reference has the record's uuid (API). */
export function keyOf(ctx: HostContext, n: NotificationModel): string | null {
  if (n.key) return n.key;
  const refs = (ctx.D as unknown as { refs?: Record<string, { id?: string }> } | null)?.refs;
  if (!refs || !n.ref) return null;
  for (const [key, ref] of Object.entries(refs)) if (ref && ref.id === n.ref.id) return key;
  return null;
}

/** Where "Open" goes for a notification; null when it names nothing the app can show. */
export function linkOf(ctx: HostContext, n: NotificationModel): Link | null {
  const systems = new Set((ctx.D?.MS ?? []).map((m) => m.id));
  const key = keyOf(ctx, n);
  if (key) {
    const [ms, kind] = key.split(':');
    const target = KEY_SCREENS[kind];
    if (target && systems.has(ms)) {
      const view = target.detail ? viewOf(ctx, ms, kind, key) : null;
      return { screen: target.screen, extra: view ? { ms, ...view, sel: key, expanded: { [key]: true } } : { ms } };
    }
  }
  const screen = (n.ref && ENTITY_SCREENS[n.ref.entityType]) || KIND_SCREENS[n.kind];
  if (!screen) return null;
  return { screen, extra: n.ms && systems.has(n.ms) ? { ms: n.ms } : {} };
}

/** Date and time of an instant in the interface language: the controller's date and the local time. */
export function whenOf(ctx: HostContext, instant: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return instant;
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = ctx.D ? ctx.D.fmt(iso, ctx.lang) : iso;
  return `${day}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
