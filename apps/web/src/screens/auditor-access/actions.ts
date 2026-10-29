// The claim of "Auditor access" on Audit readiness (MILESTONE-2 C.5, M2-15): an override of the Milestone 1 command,
// which asked for the email with a browser prompt and granted a fixed 14 days. In both builds it opens "Grant auditor
// access" (email and 1 to 30 days) for the MS Manager and tells anyone else who grants access; the sample adapter keeps
// the grants for the browser session, as on the Auditor access screen.
import type { ActionArgs, HostContext, ScreenActions } from '../types';
import { GrantLayer } from './layer';
import { mayGrant } from './model';
import { openGrant } from './store';
import { TEXT } from './text';

export function auditorAccess(ctx: HostContext, args: ActionArgs): void {
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
