// Claims and detail extensions of the controls and requirements forms (MILESTONE-2 C.5, M2-11):
// - `controls.add` (page action "Add control" of Controls & requirements) opens "Add control or requirement" for an
//   MS Manager (`applicability.manage`). The sample build keeps the Milestone 1 toast of that action, which
//   `e2e/shell.spec.js` pins (R-15), as the repository claims of M2-09 do;
// - the detail extension of `req` (the entry panel: badges, Edit entry, Reject, Mark not applicable, Delete entry).
import type { ActionArgs, HostContext, ScreenActions } from '../types';
import { holdsInFull } from './common';
import { ControlsLayer, EntryExtension } from './extension';
import { requestControls } from './store';
import { TEXT } from './text';

const NO_PERMISSION: readonly [string, string] = [
  'Only the MS Manager of this system adds controls and requirements.',
  'Hanya MS Manager sistem ini yang menambahkan kontrol dan persyaratan.',
];

/** "Add control" of Controls & requirements: the Add form in API builds, the Milestone 1 toast in the sample build. */
export function addControl(ctx: HostContext, args: ActionArgs): void {
  if (ctx.mode !== 'api') {
    ctx.toast(ctx.li(TEXT.sampleAddToast));
    return;
  }
  const ms = typeof args.ms === 'string' ? args.ms : ctx.msObj?.id;
  if (!ms) return;
  if (!holdsInFull(ctx, ms, 'applicability.manage')) {
    ctx.toast(ctx.li(NO_PERMISSION));
    return;
  }
  requestControls({ kind: 'add', ms, at: Date.now() });
}

export const claims: ScreenActions['claims'] = {
  'controls.add': (ctx, args) => addControl(ctx, args),
};

export const detailExtensions: ScreenActions['detailExtensions'] = [
  { id: 'controls-edit.entry', kind: 'req', order: 10, Component: EntryExtension },
];

export const layerItems: ScreenActions['layerItems'] = [{ id: 'controls-edit.forms', order: 30, Component: ControlsLayer }];
