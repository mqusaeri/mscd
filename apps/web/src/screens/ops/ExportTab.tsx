// Export tab of the organisation drawer (MILESTONE-3 M3-09, D.4): the exports of the organisation with their status,
// who asked, the dates, parts, size and downloads (`ops.exports.list`), and "Start export" with a reason
// (`ops.exports.create`, `ops.tenants.manage`), which queues an export for the organisation's Tenant Admins. The
// operator never downloads an export: operators never read customer data (M2 K.8), so the tab has no download.
// Refusals (409 `export_in_progress`, `export_too_large`, `export_not_available`) show the server's message.
import { useCallback, useEffect, useState } from 'react';
import { newIdempotencyKey, useMutation } from '../api';
import { sizeText } from '../org-export/model';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, Field, Modal, Table, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { LoadState, asApi, useLoad } from './Health';
import { EXPORTABLE, EXPORT_SOURCE_TEXT, EXPORT_STATUS_TEXT, EXPORT_STATUS_TONE, exportInFlight, reasonError } from './lifecycle-model';
import type { ExportQueued, OpsExport } from './lifecycle-model';
import { LIFE_TEXT } from './lifecycle-text';
import type { OpsAdapter } from './model';
import type { OrgDetail } from './org-model';
import { whenText } from './org-model';
import { TEXT } from './text';

/** The exports of an organisation as the operator sees them: no content and no download. */
export function ExportList({ ctx, exports }: { ctx: HostContext; exports: OpsExport[] }) {
  const columns: Column<OpsExport>[] = [
    { key: 'requested', label: LIFE_TEXT.colRequested, render: (e) => <span style={{ whiteSpace: 'nowrap' }}>{whenText(ctx, e.requestedAt)}</span> },
    { key: 'source', label: LIFE_TEXT.colSource, render: (e) => ctx.li(EXPORT_SOURCE_TEXT[e.requestedVia]) },
    {
      key: 'status',
      label: LIFE_TEXT.colExportStatus,
      render: (e) => (
        <span className="mx-row" style={{ gap: 6, flexWrap: 'wrap' }} data-export-status={e.status}>
          <Badge tone={EXPORT_STATUS_TONE[e.status]}>{ctx.li(EXPORT_STATUS_TEXT[e.status])}</Badge>
          {e.isFinal ? <Badge tone="acc">{ctx.li(LIFE_TEXT.final)}</Badge> : null}
        </span>
      ),
    },
    { key: 'ready', label: LIFE_TEXT.colReady, render: (e) => (e.completedAt ? whenText(ctx, e.completedAt) : '-') },
    {
      key: 'expires',
      label: LIFE_TEXT.colExpires,
      render: (e) => (e.expiresAt ? whenText(ctx, e.expiresAt) : e.isFinal && e.status === 'ready' ? ctx.li(LIFE_TEXT.keptUntilClose) : '-'),
    },
    { key: 'parts', label: LIFE_TEXT.colParts, align: 'right', render: (e) => (e.partCount === null ? '-' : e.partCount) },
    { key: 'size', label: LIFE_TEXT.colSize, align: 'right', render: (e) => <span style={{ whiteSpace: 'nowrap' }}>{sizeText(e.sizeBytes, ctx.lang)}</span> },
    { key: 'downloads', label: LIFE_TEXT.colDownloads, align: 'right', render: (e) => e.downloadCount },
  ];
  return <Table columns={columns} rows={exports} rowKey={(e) => e.id} />;
}

/** "Start export": what the export holds and who downloads it, then the reason. */
export function StartExportDialog({ ctx, adapter, detail, open, onClose, onStarted }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  detail: OrgDetail;
  open: boolean;
  onClose(): void;
  onStarted(done: ExportQueued): void;
}) {
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());
  const run = useCallback((input: { reason: string; key: string }) => adapter.startExport(detail.slug, input.reason, input.key).then(asApi), [adapter, detail.slug]);
  const mutation = useMutation<{ reason: string; key: string }, ExportQueued>(run);
  const { reset } = mutation;
  useEffect(() => {
    if (open) return;
    setReason('');
    setShown(null);
    setKey(newIdempotencyKey());
    reset();
  }, [open]);
  const submit = () => {
    const error = reasonError(reason);
    setShown(error);
    if (error) return;
    void ctx.track(mutation.submit({ reason: reason.trim(), key })).then((res) => {
      if (res.ok) onStarted(res.data);
    }, () => undefined);
  };
  const fieldError = shown ?? mutation.fields.reason ?? null;
  const general = mutation.error && !mutation.fields.reason ? mutation.error.message : null;
  return (
    <Modal
      open={open}
      title={ctx.fill(LIFE_TEXT.startTitle, { org: detail.name })}
      sub={LIFE_TEXT.startSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(LIFE_TEXT.startExport)}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-start-export={detail.slug}>
        <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--tx)' }}>
          {[LIFE_TEXT.start1, LIFE_TEXT.start2, LIFE_TEXT.start3].map((t) => <li key={t[0]} style={{ marginTop: 4 }}>{ctx.li(t)}</li>)}
        </ul>
        <Field label={LIFE_TEXT.reason} hint={LIFE_TEXT.reasonHint} error={fieldError} required>
          <Textarea value={reason} onChange={(v) => { setReason(v); setShown(null); setKey(newIdempotencyKey()); mutation.reset(); }} rows={3} maxLength={500} />
        </Field>
        {general ? <Alert tone="bad">{ctx.li(general)}</Alert> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

export function ExportTab({ ctx, adapter, detail, onChanged }: { ctx: HostContext; adapter: OpsAdapter; detail: OrgDetail; onChanged(): void }) {
  const [starting, setStarting] = useState(false);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => adapter.exports(detail.slug), [adapter, detail.slug, tick]);
  const { result, reload } = useLoad<OpsExport[]>(load);
  // The rows stay on screen while the list is read again.
  const [rows, setRows] = useState<OpsExport[] | null>(null);
  useEffect(() => {
    if (result && result.ok) setRows(result.data);
  }, [result]);
  const canManage = ctx.platformCan('ops.tenants.manage');
  const busy = rows ? exportInFlight(rows) : false;
  const exportable = EXPORTABLE.includes(detail.status);
  let reason: TextPair | null = null;
  if (!exportable) reason = LIFE_TEXT.exportNotHere;
  else if (busy) reason = LIFE_TEXT.exportBusy;
  const started = (done: ExportQueued) => {
    setStarting(false);
    ctx.toast(done.message ? ctx.li(done.message) : ctx.fill(LIFE_TEXT.exportQueued, { org: detail.name }));
    setTick((t) => t + 1);
    onChanged();
  };
  let body;
  if (!rows) body = <div style={{ padding: 'var(--pad)' }}><LoadState ctx={ctx} result={result} failed={LIFE_TEXT.exportsFailed} retry={reload} /></div>;
  else if (!rows.length) body = <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(LIFE_TEXT.noExports)}</span></div>;
  else body = <ExportList ctx={ctx} exports={rows} />;
  // Refresh reads the exports again, and the detail and the list too, so the last export shows the same state.
  const refresh = () => {
    setTick((t) => t + 1);
    onChanged();
  };
  const actions = canManage
    ? (
      <>
        <Button onClick={refresh}>{ctx.li(TEXT.refresh)}</Button>
        <Button variant="primary" disabledReason={reason} onClick={() => setStarting(true)}>{ctx.li(LIFE_TEXT.startExport)}</Button>
      </>
    )
    : <Button onClick={refresh}>{ctx.li(TEXT.refresh)}</Button>;
  return (
    <>
      <Card title={LIFE_TEXT.exports} sub={LIFE_TEXT.exportsSub} flush actions={actions}>
        <div data-org-exports={detail.slug}>{body}</div>
      </Card>
      {!canManage ? <Alert tone="info">{ctx.li(LIFE_TEXT.noRightExport)}</Alert> : null}
      <StartExportDialog ctx={ctx} adapter={adapter} detail={detail} open={starting} onClose={() => setStarting(false)} onStarted={started} />
    </>
  );
}
