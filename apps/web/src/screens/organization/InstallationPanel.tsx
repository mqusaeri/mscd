// The installation id panel (MILESTONE-2 M2-16): the id of `platform.installation` with "Copy", for licence requests.
// The Organisation screen and the Licence screen show it. With multi tenancy the service provider installs licences,
// so the text says to quote the id to them.
import type { HostContext } from '../types';
import { Button, Card } from '../ui';
import { TEXT } from './text';

/** Copies a text with the Clipboard API; false when the browser refuses or has none. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function InstallationPanel({ ctx, installationId, tenancyMode }: { ctx: HostContext; installationId: string; tenancyMode: 'single' | 'multi' }) {
  const copy = () => {
    void copyText(installationId).then((ok) => ctx.toast(ctx.li(ok ? TEXT.copied : TEXT.copyFailed)));
  };
  return (
    <Card title={TEXT.installation} sub={tenancyMode === 'multi' ? TEXT.installationMulti : TEXT.installationSub}>
      <div className="mx-row" data-installation-id={installationId}>
        <code className="mx-mono" style={{ fontSize: 14, color: 'var(--tx)', overflowWrap: 'anywhere', userSelect: 'all' }}>{installationId}</code>
        <Button onClick={copy}>{ctx.li(TEXT.copy)}</Button>
      </div>
    </Card>
  );
}
