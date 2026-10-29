// Claims, page actions and detail extensions of the certification timeline forms (MILESTONE-2 C.5, M2-15):
// - `timeline.addEvent` ("Add audit event" in the page header and "Add" of a lane without events) opens "Add audit
//   event" for the MS Manager of the system in both builds (the sample adapter adds the event to the sample snapshot);
// - page actions "Start certification cycle" (no active cycle, and the newest certificate is not suspended) and
//   "Record certificate" (an active cycle) on the timeline, in both builds, once the cycles of the system are loaded:
//   the layer item loads them on the timeline in API builds, and the panel of the selected audit event in both builds
//   (the sample adapter keeps the cycles of each sample organisation; the panel offers the same two forms);
// - the detail extension of `event` (this audit, its certification cycle with the certificate, its activities) and
//   of `prep` and `cycle` (Mark done, Reassign or change due date);
// - the layer item that renders the open form.
import type { ActionArgs, ExtraPageAction, HostContext, ScreenActions } from '../types';
import { itemVisible } from './items';
import { EventExtension, ItemExtension, TimelineLayer } from './extension';
import { activeCycle, cycleMayStart, mayManageEvents, mayMoveCycle } from './model';
import { cyclesEntry, openForm } from './store';
import { TEXT } from './text';

/** "Add audit event": the form for the MS Manager of the system. */
export function addEvent(ctx: HostContext, args: ActionArgs): void {
  const ms = typeof args.ms === 'string' ? args.ms : ctx.msObj?.id;
  if (!ms) return;
  if (!mayManageEvents(ctx, ms)) {
    ctx.toast(ctx.li(TEXT.noAddRight));
    return;
  }
  openForm({ type: 'add', ms });
}

/** The cycles of the selected system once loaded (the layer item loads them on the timeline). */
function loadedCycles(ctx: HostContext) {
  const ms = ctx.msObj?.id;
  return ms ? cyclesEntry(ctx, ms)?.data ?? null : null;
}

const CYCLE_ICON = 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4';
const CERT_ICON = 'M12 3l2.4 2.1 3.1-.4.9 3 2.7 1.6-1.1 2.9 1.1 2.9-2.7 1.6-.9 3-3.1-.4L12 21l-2.4-2.1-3.1.4-.9-3-2.7-1.6 1.1-2.9-1.1-2.9 2.7-1.6.9-3 3.1.4zM9 12l2 2 4-4';

export const extraPageActions: ExtraPageAction[] = [
  {
    screen: 'timeline',
    id: 'timeline.startCycle',
    label: [TEXT.startCycle[0], TEXT.startCycle[1]],
    icon: CYCLE_ICON,
    visible: (ctx) => {
      if (!ctx.msObj || !mayManageEvents(ctx, ctx.msObj.id)) return false;
      const cycles = loadedCycles(ctx);
      return Boolean(cycles) && cycleMayStart(cycles!);
    },
    run: (ctx) => {
      if (ctx.msObj) openForm({ type: 'start', ms: ctx.msObj.id });
    },
  },
  {
    screen: 'timeline',
    id: 'timeline.recordCertificate',
    label: [TEXT.recordCertificate[0], TEXT.recordCertificate[1]],
    icon: CERT_ICON,
    visible: (ctx) => {
      if (!ctx.msObj || !mayMoveCycle(ctx, ctx.msObj.id)) return false;
      const cycles = loadedCycles(ctx);
      return Boolean(cycles && activeCycle(cycles));
    },
    run: (ctx) => {
      if (ctx.msObj) openForm({ type: 'certificate', ms: ctx.msObj.id });
    },
  },
];

export const claims: ScreenActions['claims'] = {
  'timeline.addEvent': (ctx, args) => addEvent(ctx, args),
};

export const detailExtensions: ScreenActions['detailExtensions'] = [
  { id: 'timeline-edit.event', kind: 'event', order: 10, Component: EventExtension, visible: (_ctx, props) => Boolean(props.record) },
  { id: 'timeline-edit.prep', kind: 'prep', order: 10, Component: ItemExtension, visible: (ctx, props) => itemVisible(ctx, props) },
  { id: 'timeline-edit.cycle', kind: 'cycle', order: 10, Component: ItemExtension, visible: (ctx, props) => itemVisible(ctx, props) },
];

export const layerItems: ScreenActions['layerItems'] = [{ id: 'timeline-edit.forms', order: 50, Component: TimelineLayer, visible: (ctx) => Boolean(ctx.D) }];
