// State of the certification timeline forms (MILESTONE-2 M2-15) that outlives a render of the controller:
// - the open form: claims, page actions and panels ask for one here, and the layer item of actions.ts renders it in
//   the host layer (C.5), so a form stays open while the timeline behind it renders again. One form at a time;
// - the certification cycles of each system and the audit activities of each event, read once and read again after a
//   write. The page actions "Start certification cycle" and "Record certificate" decide their visibility from the
//   cycles held here (C.5 `visible` is synchronous). A load runs through `ctx.track`, so the controller renders again
//   when it lands and the page actions follow it.
import type { ApiError } from '../../data/api/ApiClient';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { HostContext } from '../types';
import type { ActivityModel, CycleModel, CycleMove, EventModel, ItemModel, TimelineAdapter } from './model';
import { orgKeyOf } from './model';

export type TimelineRequest =
  | { type: 'add'; ms: MsId; at: number }
  | { type: 'edit'; ms: MsId; event: EventModel; at: number }
  | { type: 'result'; ms: MsId; event: EventModel; at: number }
  | { type: 'start'; ms: MsId; at: number }
  | { type: 'certificate'; ms: MsId; at: number }
  | { type: 'move'; ms: MsId; cycle: CycleModel; to: CycleMove; at: number }
  | { type: 'activity'; ms: MsId; event: EventModel; activity: ActivityModel; at: number }
  | { type: 'item'; ms: MsId; item: ItemModel; at: number };

/** A request without its time stamp (`openForm` adds it). */
export type TimelineRequestInput = TimelineRequest extends infer R ? (R extends TimelineRequest ? Omit<R, 'at'> : never) : never;

let current: TimelineRequest | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  version += 1;
  for (const l of [...listeners]) l();
};

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes with every change of the store (the snapshot of `useSyncExternalStore`). */
export const storeVersion = (): number => version;

export function formRequest(): TimelineRequest | null {
  return current;
}

/** Opens a form (replacing the one that is open); null closes it. */
export function openForm(request: TimelineRequestInput | null): void {
  current = request ? ({ ...request, at: Date.now() } as TimelineRequest) : null;
  notify();
}

export const closeForm = (): void => openForm(null);

// ---------------------------------------------------------------------------------------------------------------
// Cycles and activities
// ---------------------------------------------------------------------------------------------------------------

export interface Entry<T> {
  loading: boolean;
  data: T | null;
  error: ApiError | null;
}

const cycles = new Map<string, Entry<CycleModel[]>>();
const activities = new Map<string, Entry<ActivityModel[]>>();
const inflight = new Map<string, Promise<void>>();

/** Forgets everything (tests, and a new organisation). */
export function resetTimelineStore(): void {
  cycles.clear();
  activities.clear();
  inflight.clear();
  current = null;
  notify();
}

const cycleKey = (ctx: Pick<HostContext, 'org' | 'D'>, ms: MsId) => `${orgKeyOf(ctx)}|${ms}`;
const activityKey = (ctx: Pick<HostContext, 'org' | 'D'>, ms: MsId, eventId: string) => `${orgKeyOf(ctx)}|${ms}|${eventId}`;

/** The cycles of a system as loaded, or undefined before the first load. */
export function cyclesEntry(ctx: Pick<HostContext, 'org' | 'D'>, ms: MsId): Entry<CycleModel[]> | undefined {
  return cycles.get(cycleKey(ctx, ms));
}

export function activitiesEntry(ctx: Pick<HostContext, 'org' | 'D'>, ms: MsId, eventId: string): Entry<ActivityModel[]> | undefined {
  return activities.get(activityKey(ctx, ms, eventId));
}

function load<T>(
  map: Map<string, Entry<T>>,
  key: string,
  run: () => Promise<{ ok: true; data: T } | { ok: false; error: ApiError }>,
  ctx: Pick<HostContext, 'track'>,
  force: boolean,
): Promise<void> {
  const busy = inflight.get(key);
  if (busy && !force) return busy;
  const known = map.get(key);
  if (known && !known.loading && !force && !known.error) return Promise.resolve();
  map.set(key, { loading: true, data: known?.data ?? null, error: null });
  notify();
  // The data lands in the store before the busy bar ends, so the controller's next render sees it.
  const task = run().then(
    (res) => {
      map.set(key, res.ok ? { loading: false, data: res.data, error: null } : { loading: false, data: known?.data ?? null, error: res.error });
    },
    () => {
      map.set(key, { loading: false, data: known?.data ?? null, error: { status: 0, message: CONNECTION_LOST } });
    },
  ).then(() => {
    if (inflight.get(key) === task) inflight.delete(key);
    notify();
  });
  inflight.set(key, task);
  return ctx.track(task);
}

/** Loads the cycles of a system once (again with `force`, after a write). */
export function loadCycles(ctx: Pick<HostContext, 'org' | 'D' | 'track'>, adapter: TimelineAdapter, ms: MsId, force = false): Promise<void> {
  return load(cycles, cycleKey(ctx, ms), () => adapter.cycles(ms), ctx, force);
}

export function loadActivities(ctx: Pick<HostContext, 'org' | 'D' | 'track'>, adapter: TimelineAdapter, ms: MsId, event: EventModel, force = false): Promise<void> {
  return load(activities, activityKey(ctx, ms, event.id), () => adapter.activities(ms, event), ctx, force);
}
