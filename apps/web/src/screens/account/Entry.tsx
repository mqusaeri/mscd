// "My account" in the top bar (MILESTONE-2 M2-16, hostTopbar slot). It opens the `account` screen when the session
// may open it (a role in the selected system, as the screen's `ms.read` asks); a session without a system (an
// administrator without a business role, a platform operator) gets the same page in a drawer.
import { Suspense, lazy, useState } from 'react';
import type { HostContext, ScreenProps } from '../types';
import { Drawer, UI_TEXT } from '../ui';
import '../notifications/topbar.css';
import screen, { ACCOUNT_ICON } from './index';
import { TEXT } from './text';

const Page = lazy(() => import('./Screen').then((m) => ({ default: m.AccountPage })));

/** Whether the session may open the `account` screen: the rule of the host for an `ms` screen (C.2, C.3). */
export function mayOpenScreen(ctx: HostContext): boolean {
  if (ctx.mode === 'sample') return Boolean(ctx.role && screen.roles.includes(ctx.role) && ctx.msObj);
  return Boolean(ctx.msObj) && ctx.can(ctx.msObj!.id, screen.perm);
}

export function AccountEntry({ ctx }: ScreenProps) {
  const [open, setOpen] = useState(false);
  const label = ctx.li(TEXT.entry);
  const go = () => {
    if (mayOpenScreen(ctx)) ctx.go('account');
    else setOpen(true);
  };
  return (
    <>
      <button
        type="button"
        className="mx-topbtn"
        title={label}
        aria-label={label}
        aria-current={ctx.screen === 'account' ? 'page' : undefined}
        aria-expanded={open || undefined}
        data-topbar="account"
        onClick={go}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={ACCOUNT_ICON} />
        </svg>
      </button>
      {open ? (
        <Drawer open title={TEXT.title} onClose={() => setOpen(false)}>
          <Suspense fallback={<div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>}>
            <Page ctx={ctx} />
          </Suspense>
        </Drawer>
      ) : null}
    </>
  );
}
