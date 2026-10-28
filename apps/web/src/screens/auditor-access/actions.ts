// The claim of "Auditor access" on Audit readiness (MILESTONE-2 C.5, M2-15): an override of the Milestone 1 command,
// which asked for the email with a browser prompt and granted a fixed 14 days. In API builds it opens "Grant auditor
// access" (email and 1 to 30 days) for the MS Manager and tells anyone else who grants access. The sample build keeps
// the Milestone 1 toast, which `e2e/audit.spec.js` and `e2e/shell.spec.js` pin (R-15); there the form opens from the
// Auditor access screen.
import type { ActionArgs, HostContext, ScreenActions } from '../types';
import { GrantLayer } from './layer';
import { mayGrant } from './model';
import { openGrant } from './store';
import { TEXT } from './text';

export function auditorAccess(ctx: HostContext, args: ActionArgs): void {
  if (ctx.mode !== 'api') {
    ctx.toast(ctx.li(TEXT.sampleToast));
    return;
  }
  const ms = typeof args.ms === 'string' ? args.ms : ctx.msObj?.id;
  if (!ms) return;
  if (!mayGrant(ctx, ms)) {
    ctx.toast(ctx.li(TEXT.noGrantRight));
    return;
  }
  openGrant(ms);
}

export const claims: ScreenActions['claims'] = {
  'audit.auditorAccess': (ctx, args) => auditorAccess(ctx, args),
};

export const layerItems: ScreenActions['layerItems'] = [{ id: 'auditor-access.grant', order: 52, Component: GrantLayer, visible: (ctx) => Boolean(ctx.D) }];
