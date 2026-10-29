// Claims and the detail extension of the document control forms (MILESTONE-2 C.5, M2-12):
// - `docs.new` (page action "New document" of Document register) opens the New document form for someone who manages
//   documents in the system;
// - `docs.openReview` and `docs.continueDraft` (document detail) and `mytasks.openDoc` (My Tasks) open the review panel
//   of the document: Approve and Return to draft for a document in review, the next version for a draft;
// - the detail extension of `doc`: Edit, Change owner or approver, Reassign, Attach first version, Upload new version
//   and the Versions tab;
// - the layer item that renders the open form in the host layer.
// Each claim opens its form in both builds, in place of the Milestone 1 toast of its action.
import type { MsId } from '../../data/types';
import type { ActionArgs, HostContext, ScreenActions } from '../types';
import { DocExtension, DocsLayer } from './extension';
import { codeOfKey, docOf, holdsInFull } from './model';
import type { DocRecord } from './model';
import { openForm } from './store';

const NO_PERMISSION: readonly [string, string] = [
  'Only the Management System Manager of this system registers documents.',
  'Hanya Management System Manager sistem ini yang mendaftarkan dokumen.',
];

/** The system and document a row action names: its record, else its key. */
export function docArgs(ctx: HostContext, args: ActionArgs): { ms: MsId; code: string; doc: DocRecord | null } | null {
  const record = (args.record ?? null) as DocRecord | null;
  const ms = typeof args.ms === 'string' ? args.ms : record?.ms ?? ctx.msObj?.id;
  const code = record?.id ?? codeOfKey(typeof args.key === 'string' ? args.key : null);
  if (!ms || !code) return null;
  return { ms, code, doc: docOf(ctx.D, ms, code) ?? record };
}

/** "New document" of Document register. */
export function newDocument(ctx: HostContext, args: ActionArgs): void {
  const ms = typeof args.ms === 'string' ? args.ms : ctx.msObj?.id;
  if (!ms) return;
  if (!holdsInFull(ctx, ms, 'document.manage')) {
    ctx.toast(ctx.li(NO_PERMISSION));
    return;
  }
  openForm({ type: 'new', ms });
}

/** "Open review", "Continue draft" and "Open document" of My Tasks: the review panel of the document. */
export function openReviewPanel(ctx: HostContext, args: ActionArgs): void {
  const found = docArgs(ctx, args);
  if (!found) return;
  openForm({ type: 'review', ms: found.ms, code: found.code });
}

export const claims: ScreenActions['claims'] = {
  'docs.new': (ctx, args) => newDocument(ctx, args),
  'docs.openReview': (ctx, args) => openReviewPanel(ctx, args),
  'docs.continueDraft': (ctx, args) => openReviewPanel(ctx, args),
  'mytasks.openDoc': (ctx, args) => openReviewPanel(ctx, args),
};

export const detailExtensions: ScreenActions['detailExtensions'] = [
  { id: 'docs-edit.doc', kind: 'doc', order: 10, Component: DocExtension, visible: (_ctx, props) => Boolean(props.record) },
];

export const layerItems: ScreenActions['layerItems'] = [{ id: 'docs-edit.forms', order: 40, Component: DocsLayer, visible: (ctx) => Boolean(ctx.D) }];
