// Claims of the repository administration (MILESTONE-2 C.5, M2-09) on the Storage repositories screen:
// `storage.connect` (page action "Connect repository") opens the connection wizard and `storage.settings` (a card's
// "Settings") opens the settings of that repository, both as drawers over the screen (store.ts, layer.tsx).
//
// The sample build keeps the toasts of Milestone 1 on that screen (its specs pin them, R-15), as it does for the other
// repository commands of the card (H.4); there the wizard and the settings open from the Repository administration
// screen (`?screen=storage-admin`). A session without `storage.repository.manage` (an MS Manager reading the
// repositories) is told who connects repositories.
import type { ActionArgs, HostContext, ScreenActions, TextPair } from '../types';
import { StorageLayer } from './layer';
import { requestStorage } from './store';
import { TEXT } from './text';

/** The toasts of the sample build (Milestone 1 texts of the Storage repositories screen). */
export const SAMPLE_TOASTS: Readonly<Record<'connect' | 'settings', TextPair>> = {
  connect: ['Repository connection wizard opened', 'Wizard koneksi repositori dibuka'],
  settings: ['Connector settings opened', 'Pengaturan konektor dibuka'],
};

function allowed(ctx: HostContext, sample: TextPair): boolean {
  if (ctx.mode !== 'api') {
    ctx.toast(ctx.li(sample));
    return false;
  }
  if (!ctx.orgCan('storage.repository.manage')) {
    ctx.toast(ctx.li(TEXT.noPermission));
    return false;
  }
  return true;
}

/** "Connect repository" of the Storage repositories screen. */
export function connectRepository(ctx: HostContext): void {
  if (allowed(ctx, SAMPLE_TOASTS.connect)) requestStorage({ kind: 'connect', at: Date.now() });
}

/** "Settings" of a repository card: `args.repo` is the card (`REPOS[]`), whose `ref` the admin routes take. */
export function repositorySettings(ctx: HostContext, args: ActionArgs): void {
  if (!allowed(ctx, SAMPLE_TOASTS.settings)) return;
  const card = (args.repo ?? {}) as { ref?: unknown; id?: unknown };
  requestStorage({
    kind: 'settings',
    ref: typeof card.ref === 'string' ? card.ref : null,
    slug: typeof card.id === 'string' ? card.id : null,
    at: Date.now(),
  });
}

export const claims: ScreenActions['claims'] = {
  'storage.connect': (ctx) => connectRepository(ctx),
  'storage.settings': (ctx, args) => repositorySettings(ctx, args),
};

export const layerItems: ScreenActions['layerItems'] = [{ id: 'storage-admin-drawers', order: 10, Component: StorageLayer }];
