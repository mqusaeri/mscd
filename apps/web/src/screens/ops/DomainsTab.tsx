// Domains tab of the organisation drawer (MILESTONE-2 M2-S12, the console part of M2-S11): the email domains with
// their state, method and checks, "Add domain" (the TXT record shown once, with "Copy", and dropped from the page when
// the dialog closes, GL-50), "Verify now" (whether the record was found; 503 says DNS did not answer) and "Remove"
// with a confirmation. Refusals (`domain_taken`, `domain_not_allowed`, `domain_already_verified`, `domain_not_dns`,
// `organization_archived`) show the server's message, or the console's text where the answer has none.
import { useCallback, useEffect, useState } from 'react';
import { useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, ConfirmDialog, Field, Modal, TextInput, UI_TEXT } from '../ui';
import type { Tone } from '../ui';
import { copyText } from '../organization/InstallationPanel';
import { LoadState, asApi, useLoad } from './Health';
import type { OpsAdapter } from './model';
import { DOMAIN_LABEL, DOMAIN_TONE, checkOutcome, domainInputError, refusalText, whenText } from './org-model';
import type { Domain, DomainAdded, OrgDetail } from './org-model';
import { DomainName } from './org-parts';
import { ORG_TEXT } from './org-text';

const METHOD_TEXT: Readonly<Record<Domain['method'], TextPair>> = { dns: ORG_TEXT.methodDns, manual: ORG_TEXT.methodManual };

/** The record name or value with its "Copy" button. */
function RecordLine({ ctx, label, value, copied }: { ctx: HostContext; label: TextPair; value: string; copied: TextPair }) {
  const copy = () => {
    void copyText(value).then((ok) => ctx.toast(ctx.li(ok ? copied : ORG_TEXT.copyFailed)));
  };
  return (
    <div className="mx-field">
      <div className="mx-label">{ctx.li(label)}</div>
      <div className="mx-row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <code className="mx-mono" style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', color: 'var(--tx)', userSelect: 'all', padding: '8px 10px', background: 'var(--sur2)', border: '1px solid var(--bd)', borderRadius: 8 }}>{value}</code>
        <Button onClick={copy}>{ctx.li(ORG_TEXT.copy)}</Button>
      </div>
    </div>
  );
}

/** "Add domain": the domain, then the TXT record once. The value lives only in this dialog's state. */
export function AddDomainDialog({ ctx, adapter, detail, open, onClose, onAdded }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  detail: OrgDetail;
  open: boolean;
  onClose(): void;
  onAdded(domain: string): void;
}) {
  const [domain, setDomain] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const [record, setRecord] = useState<DomainAdded | null>(null);
  const run = useCallback((input: { slug: string; domain: string }) => adapter.addDomain(input.slug, input.domain).then(asApi), [adapter]);
  const mutation = useMutation<{ slug: string; domain: string }, DomainAdded>(run);
  const { reset } = mutation;
  // Closing forgets the domain and the record, so the value is not kept in the page (GL-50).
  useEffect(() => {
    if (open) return;
    setDomain('');
    setShown(null);
    setRecord(null);
    reset();
  }, [open]);
  const submit = () => {
    const invalid = domainInputError(domain);
    setShown(invalid);
    if (invalid) return;
    void ctx.track(mutation.submit({ slug: detail.slug, domain: domain.trim() })).then((res) => {
      if (!res.ok) return;
      setRecord(res.data);
      ctx.toast(ctx.fill(ORG_TEXT.added, { domain: res.data.domain }));
      onAdded(res.data.domain);
    }, () => undefined);
  };
  const error = mutation.error;
  const message = shown ?? (error ? (error.status === 400 ? ORG_TEXT.domainInvalid : refusalText(error)) : null);
  return (
    <Modal
      open={open}
      title={record ? ctx.fill(ORG_TEXT.recordTitle, { domain: record.domain }) : ctx.fill(ORG_TEXT.addDomainTitle, { org: detail.name })}
      sub={record ? undefined : ORG_TEXT.addDomainSub}
      onClose={onClose}
      footer={record ? <Button variant="primary" onClick={onClose}>{ctx.li(ORG_TEXT.done)}</Button> : (
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(ORG_TEXT.add)}</Button>
        </>
      )}
    >
      {record ? (
        <div className="mx-stack" data-domain-record={record.domain}>
          <Alert tone="warn">{ctx.li(ORG_TEXT.recordOnce)}</Alert>
          <div>{ctx.fill(ORG_TEXT.recordAsk, { domain: record.domain })}</div>
          <div className="mx-field">
            <div className="mx-label">{ctx.li(ORG_TEXT.recordType)}</div>
            <code className="mx-mono" style={{ color: 'var(--tx)' }}>TXT</code>
          </div>
          <RecordLine ctx={ctx} label={ORG_TEXT.recordName} value={record.txtName} copied={ORG_TEXT.copiedName} />
          <RecordLine ctx={ctx} label={ORG_TEXT.recordValue} value={record.txtValue} copied={ORG_TEXT.copiedValue} />
        </div>
      ) : (
        <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <Field label={ORG_TEXT.domain} hint={ORG_TEXT.domainHint} error={message} required>
            <TextInput value={domain} onChange={(v) => { setDomain(v); setShown(null); mutation.reset(); }} maxLength={253} autoComplete="off" />
          </Field>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Modal>
  );
}

/** The checks of a domain: until when a pending one is checked, when it was verified, the last check. */
function checkLines(ctx: HostContext, d: Domain): string[] {
  const lines: string[] = [];
  if (d.status === 'pending' && d.pendingUntil) lines.push(ctx.fill(ORG_TEXT.checkedUntil, { date: whenText(ctx, d.pendingUntil) }));
  if (d.status === 'verified' && d.verifiedAt) lines.push(ctx.fill(ORG_TEXT.verifiedAt, { when: whenText(ctx, d.verifiedAt) }));
  if (d.status === 'failed') lines.push(ctx.li(ORG_TEXT.failedNote));
  if (d.method === 'dns') lines.push(d.lastCheckedAt ? ctx.fill(ORG_TEXT.lastCheck, { when: whenText(ctx, d.lastCheckedAt) }) : ctx.li(ORG_TEXT.notCheckedYet));
  return lines;
}

/** The domains of the organisation, one block each (the drawer is too narrow for a table of five columns). */
export function DomainList({ ctx, domains, canManage, archived, checking, onVerify, onRemove }: {
  ctx: HostContext;
  domains: Domain[];
  canManage: boolean;
  archived: boolean;
  checking: string | null;
  onVerify(d: Domain): void;
  onRemove(d: Domain): void;
}) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={ctx.li(ORG_TEXT.domains)}>
      {domains.map((d, i) => (
        <li key={d.domain} data-domain={d.domain} style={{ padding: '12px var(--pad)', borderTop: i ? '1px solid var(--bd)' : undefined }}>
          <div className="mx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="mx-stack" style={{ gap: 4, flex: '1 1 220px' }}>
              <div className="mx-row">
                <span style={{ fontWeight: 600 }}><DomainName name={d.domain} /></span>
                <Badge tone={DOMAIN_TONE[d.status]}>{ctx.li(DOMAIN_LABEL[d.status])}</Badge>
              </div>
              <span className="mx-small">{ctx.li(METHOD_TEXT[d.method])}</span>
              {checkLines(ctx, d).map((l) => <span key={l} className="mx-small">{l}</span>)}
            </div>
            {canManage ? (
              <span className="mx-btn-group">
                {d.method === 'dns' && !archived ? <Button busy={checking === d.domain} onClick={() => onVerify(d)}>{ctx.li(ORG_TEXT.verifyNow)}</Button> : null}
                <Button variant="danger" onClick={() => onRemove(d)}>{ctx.li(ORG_TEXT.remove)}</Button>
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DomainsTab({ ctx, adapter, detail, onChanged }: { ctx: HostContext; adapter: OpsAdapter; detail: OrgDetail; onChanged(): void }) {
  const slug = detail.slug;
  const load = useCallback(() => adapter.domains(slug), [adapter, slug]);
  const { result, reload } = useLoad<Domain[]>(load);
  const [list, setList] = useState<Domain[] | null>(null);
  useEffect(() => {
    if (result && result.ok) setList(result.data);
  }, [result]);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Domain | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ tone: Tone; text: string } | null>(null);
  const runRemove = useCallback((input: { slug: string; domain: string }) => adapter.removeDomain(input.slug, input.domain).then(asApi), [adapter]);
  const removal = useMutation<{ slug: string; domain: string }, null>(runRemove);
  const canManage = ctx.platformCan('ops.tenants.manage');
  const archived = detail.status === 'archived';
  const verify = (d: Domain) => {
    setChecking(d.domain);
    setOutcome(null);
    void ctx.track(adapter.verifyDomain(slug, d.domain)).then((res) => {
      setChecking(null);
      if (!res.ok) {
        setOutcome({ tone: res.error.status === 503 ? 'warn' : 'bad', text: ctx.li(refusalText(res.error, { dns: true })) });
        return;
      }
      const shown = checkOutcome(d.status, res.data);
      setOutcome({ tone: shown.tone, text: ctx.fill(shown.text, { domain: d.domain, date: whenText(ctx, res.data.pendingUntil ?? d.pendingUntil) }) });
      setList((rows) => (rows ? rows.map((r) => (r.domain === d.domain ? { ...res.data } : r)) : rows));
      if (res.data.status !== d.status) onChanged();
    }, () => setChecking(null));
  };
  const remove = () => {
    if (!removing) return;
    const domain = removing.domain;
    void ctx.track(removal.submit({ slug, domain })).then((res) => {
      if (!res.ok) return;
      setRemoving(null);
      setOutcome(null);
      ctx.toast(ctx.fill(ORG_TEXT.removed, { domain }));
      reload();
      onChanged();
    }, () => undefined);
  };
  let body;
  if (!list) body = <div style={{ padding: 'var(--pad)' }}><LoadState ctx={ctx} result={result} failed={ORG_TEXT.domainsFailed} retry={reload} /></div>;
  else if (!list.length) body = <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(ORG_TEXT.noDomainsYet)}</span></div>;
  else body = <DomainList ctx={ctx} domains={list} canManage={canManage} archived={archived} checking={checking} onVerify={verify} onRemove={(d) => { removal.reset(); setRemoving(d); }} />;
  return (
    <>
      {outcome ? <div data-domain-outcome={outcome.tone}><Alert tone={outcome.tone} role="status">{outcome.text}</Alert></div> : null}
      <Card
        title={ORG_TEXT.domains}
        sub={ORG_TEXT.domainsSub}
        flush
        actions={canManage && !archived ? <Button variant="primary" onClick={() => setAdding(true)}>{ctx.li(ORG_TEXT.addDomain)}</Button> : null}
      >
        {archived ? <div style={{ padding: '12px var(--pad) 0' }}><Alert tone="info">{ctx.li(ORG_TEXT.archivedDomains)}</Alert></div> : null}
        {body}
      </Card>
      <AddDomainDialog ctx={ctx} adapter={adapter} detail={detail} open={adding} onClose={() => setAdding(false)} onAdded={() => { reload(); onChanged(); }} />
      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? ctx.fill(ORG_TEXT.removeTitle, { domain: removing.domain }) : ORG_TEXT.remove}
        body={removing ? ctx.fill(ORG_TEXT.removeBody, { domain: removing.domain, org: detail.name }) : ''}
        confirmLabel={ORG_TEXT.remove}
        tone="bad"
        busy={removal.busy}
        error={removal.error ? refusalText(removal.error) : null}
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
