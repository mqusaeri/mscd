// The parts of the certification timeline forms that actions.ts registers (MILESTONE-2 C.5, M2-15): the panel of the
// `event` detail, the actions of `prep` and `cycle` rows and the layer item that renders the open form. Each loads its
// code as a lazy chunk on first use, so the main bundle holds only these wrappers and the small stylesheet.
import { Suspense, lazy, useEffect, useSyncExternalStore } from 'react';
import type { DetailProps, ScreenProps } from '../types';
import { adapterFor } from './adapter';
import { orgKeyOf } from './model';
import { formRequest, loadCycles, storeVersion, subscribe } from './store';
import './timeline-edit.css';

const EventPanel = lazy(() => import('./EventPanel'));
const ItemActions = lazy(() => import('./ItemActions'));
const Forms = lazy(() => import('./Forms'));

export function EventExtension(props: DetailProps) {
  return (
    <Suspense fallback={null}>
      <EventPanel {...props} />
    </Suspense>
  );
}

export function ItemExtension(props: DetailProps) {
  return (
    <Suspense fallback={null}>
      <ItemActions {...props} />
    </Suspense>
  );
}

/**
 * The open form, and on the timeline of an api build the cycles of the selected system, which the page actions
 * "Start certification cycle" and "Record certificate" read (C.5 `visible` is synchronous).
 */
export function TimelineLayer({ ctx }: ScreenProps) {
  useSyncExternalStore(subscribe, storeVersion, storeVersion);
  const request = formRequest();
  const ms = ctx.msObj?.id ?? null;
  const onTimeline = ctx.screen === 'timeline' && ctx.mode === 'api' && Boolean(ms);
  const org = orgKeyOf(ctx);
  useEffect(() => {
    if (onTimeline && ms) void loadCycles(ctx, adapterFor(ctx), ms);
  }, [onTimeline, ms, org]);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <Forms key={request.at} ctx={ctx} request={request} />
    </Suspense>
  );
}
