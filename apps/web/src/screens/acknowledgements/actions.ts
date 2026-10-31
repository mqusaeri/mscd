// The extension points of read confirmation (MILESTONE-3 M3-05, C.1, C.5):
// - the page action "Read confirmations" of the Document register (`docs`), in API builds only (C.1: `e2e/shell.spec.js`
//   checks the exact page actions of the generated views in the sample build, which opens the screen from the sidebar);
// - the section "Read confirmation" of a document's detail: the settings for whoever manages documents in the system,
//   and the confirmed count of the latest request for whoever sees the register's totals.
import type { DetailProps, ExtraPageAction, HostContext, ScreenActions } from '../types';
import { AcknowledgementDocExtension } from './extension';
import { DOCUMENT_PERM, ICON, SCREEN_ID, SCREEN_PERMS } from './model';
import { TEXT } from './text';

/** Whether the session may open the register of the selected system from the Document register (API builds only). */
export function mayOpenRegister(ctx: HostContext): boolean {
  return ctx.mode === 'api' && Boolean(ctx.msObj) && ctx.can(ctx.msObj!.id, [...SCREEN_PERMS]);
}

export const extraPageActions: ExtraPageAction[] = [
  {
    screen: 'docs',
    id: 'docs.readConfirmations',
    label: [TEXT.pageAction[0], TEXT.pageAction[1]],
    icon: ICON,
    visible: mayOpenRegister,
    run: (ctx) => ctx.go(SCREEN_ID),
  },
];

/** The section shows for a document of the drawer to those who manage documents or see the register. */
export function sectionVisible(ctx: HostContext, props: Omit<DetailProps, 'ctx'>): boolean {
  if (!props.record || !props.ms) return false;
  return ctx.can(props.ms, [DOCUMENT_PERM, ...SCREEN_PERMS]);
}

export const detailExtensions: ScreenActions['detailExtensions'] = [
  { id: 'acknowledgements.doc', kind: 'doc', order: 30, Component: AcknowledgementDocExtension, visible: sectionVisible },
];
