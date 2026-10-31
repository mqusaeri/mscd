// Operator console, Accounts (MILESTONE-2 M2-19): every account of the service (`ops.accounts.list`) with search by
// name or email, filters by organisation, account status and kind, and paging; "Manage" opens the account drawer
// (AccountDrawer.tsx) with the detail and the actions. Below it, the platform operators with Add and Remove
// (OperatorsCard.tsx). The organisation filter lists the organisations of a service with several of them; on an
// installation with one organisation (409 `single_tenancy` of the list) it is left out.
import { useCallback, useEffect, useState } from 'react';
import type { HostContext } from '../types';
import { Badge, Button, Card, EmptyState, Field, Pager, Select, Table, TextInput } from '../ui';
import type { Column } from '../ui';
import { AccountBadges, AccountDrawer } from './AccountDrawer';
import { ACCOUNT_KINDS, ACCOUNT_PAGE_SIZE, ACCOUNT_STATUSES, KIND_LABEL, STATUS_LABEL, STATUS_TONE, rolesText } from './account-model';
import type { AccountItem, AccountKind, AccountPage, AccountStatus } from './account-model';
import { ACCOUNT_TEXT } from './account-text';
import { LoadState, useLoad } from './Health';
import type { OpsAdapter } from './model';
import { OperatorsCard, useOperators } from './OperatorsCard';
import { whenText } from './org-model';

export function AccountsTable({ ctx, accounts, onOpen }: { ctx: HostContext; accounts: AccountItem[]; onOpen(account: AccountItem): void }) {
  const columns: Column<AccountItem>[] = [
    {
      key: 'account',
      label: ACCOUNT_TEXT.colAccount,
      render: (a) => (
        <>
          <div style={{ fontWeight: 600 }}>{a.displayName}</div>
          <div className="mx-small" style={{ overflowWrap: 'anywhere' }}>{a.email}</div>
        </>
      ),
    },
    { key: 'status', label: ACCOUNT_TEXT.colStatus, render: (a) => <AccountBadges ctx={ctx} account={a} /> },
    { key: 'factor', label: ACCOUNT_TEXT.colFactor, render: (a) => (a.kind === 'person' ? ctx.li(a.mfaEnrolled ? ACCOUNT_TEXT.factorOn : ACCOUNT_TEXT.factorOff) : <span className="mx-muted">-</span>) },
    {
      key: 'orgs',
      label: ACCOUNT_TEXT.colOrgs,
      render: (a) => (a.memberships.length ? (
        <span className="mx-stack" style={{ gap: 4 }}>
          {a.memberships.map((m) => (
            <span key={m.org}>
              <span className="mx-mono">{m.org}</span>
              {m.status !== 'active' ? <> <Badge tone={STATUS_TONE[m.status]}>{ctx.li(STATUS_LABEL[m.status])}</Badge></> : null}
              {m.adminRoles.length ? <span className="mx-small"> {rolesText(ctx, m.adminRoles)}</span> : null}
            </span>
          ))}
        </span>
      ) : <span className="mx-muted">{ctx.li(ACCOUNT_TEXT.noOrgs)}</span>),
    },
    { key: 'last', label: ACCOUNT_TEXT.colLastSignIn, render: (a) => (a.lastSignInAt ? <span style={{ whiteSpace: 'nowrap' }}>{whenText(ctx, a.lastSignInAt)}</span> : ctx.li(ACCOUNT_TEXT.never)) },
    {
      key: 'actions',
      label: ACCOUNT_TEXT.colActions,
      render: (a) => <Button title={ctx.fill(ACCOUNT_TEXT.manageTitle, { name: a.displayName })} onClick={() => onOpen(a)}>{ctx.li(ACCOUNT_TEXT.manage)}</Button>,
    },
  ];
  return <Table columns={columns} rows={accounts} rowKey={(a) => a.id} />;
}

/** The organisations for the filter: those of the organisation list, or none on an installation with one organisation. */
function useOrgOptions(adapter: OpsAdapter): { value: string; label: string }[] {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let live = true;
    void adapter.organizationNames().then((res) => {
      if (live && res.ok) setOptions(res.data.map((o) => ({ value: o.slug, label: `${o.name} (${o.slug})` })));
    }, () => undefined);
    return () => { live = false; };
  }, [adapter]);
  return options;
}

export function AccountsTab({ ctx, adapter }: { ctx: HostContext; adapter: OpsAdapter }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [org, setOrg] = useState('');
  const [status, setStatus] = useState<AccountStatus | ''>('');
  const [kind, setKind] = useState<AccountKind | ''>('');
  const [page, setPage] = useState(1);
  const [opened, setOpened] = useState<AccountItem | null>(null);
  const orgs = useOrgOptions(adapter);
  const operators = useOperators(adapter);
  const load = useCallback(
    () => adapter.accounts({ page, pageSize: ACCOUNT_PAGE_SIZE, ...(query ? { q: query } : {}), ...(org ? { org } : {}), ...(status ? { status } : {}), ...(kind ? { kind } : {}) }),
    [adapter, page, query, org, status, kind],
  );
  const { result, reload } = useLoad<AccountPage>(load);
  // The rows stay on screen while the list is read again after a change in the drawer.
  const [rows, setRows] = useState<AccountPage | null>(null);
  useEffect(() => {
    if (result && result.ok) setRows(result.data);
    else if (result) setRows(null);
  }, [result]);
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const filtered = Boolean(query || org || status || kind);
  let body;
  if (!rows) body = <div style={{ padding: 'var(--pad)' }}><LoadState ctx={ctx} result={result} failed={ACCOUNT_TEXT.accountsFailed} retry={reload} /></div>;
  else if (!rows.items.length) {
    body = filtered
      ? <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(ACCOUNT_TEXT.noMatch)}</span></div>
      : <EmptyState title={ACCOUNT_TEXT.noAccounts} />;
  } else {
    body = (
      <>
        <AccountsTable ctx={ctx} accounts={rows.items} onOpen={setOpened} />
        <Pager page={page} pages={Math.max(1, Math.ceil(rows.total / rows.pageSize))} onPage={setPage} />
      </>
    );
  }
  const statusOptions = [{ value: '', label: ACCOUNT_TEXT.allStatuses }, ...ACCOUNT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))];
  const kindOptions = [{ value: '', label: ACCOUNT_TEXT.allKinds }, ...ACCOUNT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))];
  const changed = () => {
    reload();
    operators.reload();
  };
  return (
    <>
      <Card title={ACCOUNT_TEXT.accounts} sub={ACCOUNT_TEXT.accountsSub} flush>
        <div style={{ padding: '12px var(--pad)', borderBottom: '1px solid var(--bd)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }} data-account-filters="">
          <Field label={ACCOUNT_TEXT.search}>
            <TextInput type="search" value={q} onChange={setQ} autoComplete="off" maxLength={100} />
          </Field>
          {orgs.length ? (
            <Field label={ACCOUNT_TEXT.orgFilter}>
              <Select value={org} onChange={(v) => { setOrg(v); setPage(1); }} options={[{ value: '', label: ACCOUNT_TEXT.allOrgs }, ...orgs]} />
            </Field>
          ) : null}
          <Field label={ACCOUNT_TEXT.statusFilter}>
            <Select value={status} onChange={(v) => { setStatus(v as AccountStatus | ''); setPage(1); }} options={statusOptions} />
          </Field>
          <Field label={ACCOUNT_TEXT.kindFilter}>
            <Select value={kind} onChange={(v) => { setKind(v as AccountKind | ''); setPage(1); }} options={kindOptions} />
          </Field>
        </div>
        <div data-ops-accounts="">{body}</div>
      </Card>
      <OperatorsCard ctx={ctx} adapter={adapter} result={operators.result} reload={operators.reload} />
      {opened ? <AccountDrawer key={opened.id} ctx={ctx} adapter={adapter} account={opened} selfId={operators.selfId} onClose={() => setOpened(null)} onChanged={changed} /> : null}
    </>
  );
}
