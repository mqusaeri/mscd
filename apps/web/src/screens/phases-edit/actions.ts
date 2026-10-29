// Claims and detail extensions of the activity forms (MILESTONE-2 C.5, M2-11):
// - `phases.recordBlocker` (activity detail "Record blocker") opens the Record blocker form in API builds for the
//   activity owner or the MS Manager. The sample build keeps the Milestone 1 toast: its data source only acknowledges
//   a blocker and keeps the status of activities (M2-11 deviation 3), so the form's BR-39 move and BR-46 count
//   would not show there, and `e2e/screens/phases-edit.spec.js` expects the toast;
// - the detail extension of `activity` ("Start").
import type { Activity } from '../../data/types';
import type { ActionArgs, HostContext, ScreenActions } from '../types';
import { mayActOn } from '../controls-edit/common';
import { ActivityExtension, BlockerLayer } from './extension';
import { requestBlocker } from './store';
import { TEXT } from './text';

/** "Record blocker" of an activity: the form in API builds, the Milestone 1 toast in the sample build. */
export function recordBlocker(ctx: HostContext, args: ActionArgs): void {
  if (ctx.mode !== 'api') {
    ctx.toast(ctx.li(TEXT.sampleBlockerToast));
    return;
  }
  const ms = typeof args.ms === 'string' ? args.ms : ctx.msObj?.id;
  const activity = args.record as Activity | undefined;
  if (!ms || !activity || typeof activity.key !== 'string') return;
  if (!mayActOn(ctx, ms, 'activity.transition', activity.owner) && !ctx.can(ms, 'activity.verify')) {
    ctx.toast(ctx.li(TEXT.noPermission));
    return;
  }
  requestBlocker({ ms, activity, at: Date.now() });
}

export const claims: ScreenActions['claims'] = {
  'phases.recordBlocker': (ctx, args) => recordBlocker(ctx, args),
};

export const detailExtensions: ScreenActions['detailExtensions'] = [
  { id: 'phases-edit.activity', kind: 'activity', order: 10, Component: ActivityExtension },
];

export const layerItems: ScreenActions['layerItems'] = [{ id: 'phases-edit.blocker', order: 32, Component: BlockerLayer }];
