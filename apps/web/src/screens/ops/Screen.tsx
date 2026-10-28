// Operator console (MILESTONE-2 M2-16, `/ops`, group Operations, scope platform, `ops.read`): health (components,
// migrations, licence states, diagnostics), jobs (queue statistics, "Run job"), organisations (list, "Create
// organisation", "Install licence"), framework packs (installed list, "Install pack") and accounts ("Reset sign-in
// factor"). The page action "Create organisation" opens the Organisations section with its dialog.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenProps } from '../types';
import { Tabs } from '../ui';
import type { TabDef } from '../ui';
import { ResetMfaCard } from './Accounts';
import { adapterFor } from './adapter';
import { HealthTab, JobsTab } from './Health';
import { OrganizationsTab } from './Organizations';
import { PacksTab } from './Packs';
import { TEXT } from './text';

export type OpsTab = 'health' | 'jobs' | 'orgs' | 'packs' | 'accounts';

/** The sections of the console the session may use. */
export function tabsOf(canResetMfa: boolean): TabDef[] {
  return [
    { id: 'health', label: TEXT.tabHealth },
    { id: 'jobs', label: TEXT.tabJobs },
    { id: 'orgs', label: TEXT.tabOrgs },
    { id: 'packs', label: TEXT.tabPacks },
    ...(canResetMfa ? [{ id: 'accounts', label: TEXT.tabAccounts }] : []),
  ];
}

export default function OpsScreen({ ctx }: ScreenProps) {
  const data = useRef(ctx.D);
  data.current = ctx.D;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client, () => data.current), [client]);
  const [tab, setTab] = useState<OpsTab>('health');
  const [creating, setCreating] = useState(false);
  // The page action "Create organisation" sends a new `create` value each time (index.tsx).
  const request = ctx.params.create;
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (!request || handled.current === request) return;
    handled.current = request;
    setTab('orgs');
    setCreating(true);
  }, [request]);
  const tabs = tabsOf(ctx.platformCan('ops.users.manage'));
  return (
    <>
      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as OpsTab)} label={TEXT.tabsLabel} />
      <div className="mx-stack" role="tabpanel" data-ops-tab={tab}>
        {tab === 'health' ? <HealthTab ctx={ctx} adapter={adapter} /> : null}
        {tab === 'jobs' ? <JobsTab ctx={ctx} adapter={adapter} /> : null}
        {tab === 'orgs' ? <OrganizationsTab ctx={ctx} adapter={adapter} creating={creating} setCreating={setCreating} /> : null}
        {tab === 'packs' ? <PacksTab ctx={ctx} adapter={adapter} /> : null}
        {tab === 'accounts' ? <ResetMfaCard ctx={ctx} adapter={adapter} /> : null}
      </div>
    </>
  );
}
