// Parts of Organisation export (MILESTONE-3 M3-09, D.4): the table of exports, the request with what the archive holds
// and who is told, the approval and the rejection by another Tenant Admin (the requester sees "You requested this
// export", H.2), the drawer of one export with its files, their SHA-256 and "How to check", and the note of the
// read-only period after a contract ends (D.2, D.5.1).
import { useCallback, useEffect, useId, useState } from 'react';
import { newIdempotencyKey, useMutation } from '../api';
import { saveFile } from '../auditor-access/shared';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, ConfirmDialog, Drawer, Facts, Field, Modal, Table, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import {
  EXPORT_STATUS_TEXT, EXPORT_STATUS_TONE, NOTE_MAX, approvalText, dayOf, errorText, isMine, manifestName, noteError, partsText, rejectError, requesterText,
  settled, sizeText, whenOf,
} from './model';
import type { Created, Decided, ExportPart, Lifecycle, OrgExport, OrgExportAdapter, OrgExportDetail, Result } from './model';
import { TEXT } from './text';

const asApi = <T,>(r: Result<T>) => (r.ok ? { ok: true as const, status: 200, data: r.data } : { ok: false as const, status: r.error.status, error: r.error });

/** The status of an export with the badge of the final export. */
export function StatusCell({ ctx, e }: { ctx: HostContext; e: Pick<OrgExport, 'status' | 'isFinal'> }) {
  return (
    <span className="mx-row" style={{ gap: 6, flexWrap: 'wrap' }} data-export-status={e.status}>
      <Badge tone={EXPORT_STATUS_TONE[e.status]}>{ctx.li(EXPORT_STATUS_TEXT[e.status])}</Badge>
      {e.isFinal ? <Badge tone="acc">{ctx.li(TEXT.final)}</Badge> : null}
    </span>
  );
}

/** When an export can be downloaded until: its expiry, "until the organisation closes" for a ready final export, or `-`. */
function expiryText(ctx: HostContext, e: Pick<OrgExport, 'expiresAt' | 'isFinal' | 'status'>): string {
  if (e.expiresAt) return whenOf(ctx, e.expiresAt);
  return e.isFinal && e.status === 'ready' ? ctx.li(TEXT.keptUntilClose) : '-';
}

/** Approve and Reject of an export that waits for approval; the requester sees why both are closed to them. */
export function DecisionButtons({ ctx, e, self, onApprove, onReject }: { ctx: HostContext; e: OrgExport; self: string; onApprove(): void; onReject(): void }) {
  const reasonId = useId();
  if (e.status !== 'requested') return null;
  if (isMine(e, self)) {
    // Both decisions are closed to the requester (H.2) and share one reason, shown once and read with each button.
    return (
      <span className="mx-btn-group" data-own-request={e.id}>
        <button type="button" className="mx-btn" disabled aria-describedby={reasonId}>{ctx.li(TEXT.approve)}</button>
        <button type="button" className="mx-btn" disabled aria-describedby={reasonId}>{ctx.li(TEXT.reject)}</button>
        <span id={reasonId} className="mx-reason">{ctx.li(TEXT.youRequested)}</span>
      </span>
    );
  }
  return (
    <span className="mx-btn-group">
      <Button variant="primary" onClick={onApprove}>{ctx.li(TEXT.approve)}</Button>
      <Button onClick={onReject}>{ctx.li(TEXT.reject)}</Button>
    </span>
  );
}

export function ExportTable({ ctx, exports, self, onOpen, onApprove, onReject }: {
  ctx: HostContext;
  exports: OrgExport[];
  self: string;
  onOpen(e: OrgExport): void;
  onApprove(e: OrgExport): void;
  onReject(e: OrgExport): void;
}) {
  const columns: Column<OrgExport>[] = [
    {
      key: 'requested',
      label: TEXT.colRequested,
      render: (e) => (
        <>
          <div style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{whenOf(ctx, e.requestedAt)}</div>
          <div className="mx-small">{ctx.fill(TEXT.byWhom, { name: requesterText(ctx, e) })}</div>
        </>
      ),
    },
    { key: 'status', label: TEXT.colStatus, render: (e) => <StatusCell ctx={ctx} e={e} /> },
    { key: 'approval', label: TEXT.colApproval, render: (e) => <span>{approvalText(ctx, e)}</span> },
    {
      key: 'size',
      label: TEXT.colSize,
      render: (e) => (
        <>
          <div style={{ whiteSpace: 'nowrap' }}>{sizeText(e.sizeBytes, ctx.lang)}</div>
          {e.partCount !== null ? <div className="mx-small">{partsText(ctx, e.partCount)}</div> : null}
        </>
      ),
    },
    { key: 'ready', label: TEXT.colReady, render: (e) => <span style={{ whiteSpace: 'nowrap' }}>{e.completedAt ? whenOf(ctx, e.completedAt) : '-'}</span> },
    { key: 'expires', label: TEXT.colExpires, render: (e) => <span>{expiryText(ctx, e)}</span> },
    {
      key: 'actions',
      label: TEXT.colActions,
      render: (e) => (
        <span className="mx-btn-group" data-export-actions={e.id}>
          <Button title={ctx.fill(TEXT.openTitle, { when: whenOf(ctx, e.requestedAt) })} onClick={() => onOpen(e)}>{ctx.li(TEXT.open)}</Button>
          <DecisionButtons ctx={ctx} e={e} self={self} onApprove={() => onApprove(e)} onReject={() => onReject(e)} />
        </span>
      ),
    },
  ];
  return <Table columns={columns} rows={exports} rowKey={(e) => e.id} />;
}

/** "Export all data": what the export holds, how the approval works, who is told, then an optional note. */
export function RequestDialog({ ctx, adapter, lifecycle, open, onClose, onCreated }: {
  ctx: HostContext;
  adapter: OrgExportAdapter;
  lifecycle: Lifecycle | null;
  open: boolean;
  onClose(): void;
  onCreated(created: Created): void;
}) {
  const [note, setNote] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());
  const run = useCallback((input: { note: string | null; key: string }) => settled(adapter.create(input.note, input.key)).then(asApi), [adapter]);
  const mutation = useMutation<{ note: string | null; key: string }, Created>(run);
  const { reset } = mutation;
  useEffect(() => {
    if (open) return;
    setNote('');
    setShown(null);
    setKey(newIdempotencyKey());
    reset();
  }, [open]);
  const submit = () => {
    const error = noteError(note);
    setShown(error);
    if (error) return;
    void ctx.track(mutation.submit({ note: note.trim() || null, key })).then((res) => {
      if (res.ok) onCreated(res.data);
    }, () => undefined);
  };
  const single = lifecycle ? lifecycle.activeAdminCount <= 1 : false;
  const approval = !lifecycle ? TEXT.approvalUnknown : single ? TEXT.approvalSingle : TEXT.approvalOther;
  const general = mutation.error && !mutation.fields.note ? errorText(ctx, mutation.error) : null;
  return (
    <Modal
      open={open}
      title={TEXT.requestTitle}
      sub={TEXT.requestSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.exportAll)}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-export-request>
        <div>
          <div className="mx-label">{ctx.li(TEXT.whatTitle)}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--tx)' }}>
            {[TEXT.what1, TEXT.what2, TEXT.what3, TEXT.what4].map((t) => <li key={t[0]} style={{ marginTop: 4 }}>{ctx.li(t)}</li>)}
          </ul>
        </div>
        <div>
          <div className="mx-label">{ctx.li(TEXT.howTitle)}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--tx)' }}>
            {[approval, TEXT.told, TEXT.keep].map((t) => <li key={t[0]} style={{ marginTop: 4 }} data-approval={t === approval ? (single ? 'single' : lifecycle ? 'other' : 'unknown') : undefined}>{ctx.li(t)}</li>)}
          </ul>
        </div>
        <Field label={single ? TEXT.noteSingle : TEXT.note} hint={TEXT.noteHint} error={shown ?? mutation.fields.note ?? null}>
          <Textarea value={note} onChange={(v) => { setNote(v); setShown(null); setKey(newIdempotencyKey()); mutation.reset(); }} rows={3} maxLength={NOTE_MAX} />
        </Field>
        {general ? <Alert tone="bad">{general}</Alert> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** "Approve": a confirmation, then the decision. */
export function ApproveDialog({ ctx, adapter, target, onClose, onDecided }: {
  ctx: HostContext;
  adapter: OrgExportAdapter;
  target: OrgExport | null;
  onClose(): void;
  onDecided(decided: Decided): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [target?.id]);
  const confirm = () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    void ctx.track(settled(adapter.decide(target.id, true, null))).then((res) => {
      setBusy(false);
      if (res.ok) onDecided(res.data);
      else setError(errorText(ctx, res.error));
    });
  };
  return (
    <ConfirmDialog
      open={Boolean(target)}
      title={TEXT.approveTitle}
      body={ctx.li(TEXT.approveBody)}
      confirmLabel={TEXT.approve}
      busy={busy}
      error={error}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

/** "Reject": the reason, which the requester and the other Tenant Admins see. */
export function RejectDialog({ ctx, adapter, target, onClose, onDecided }: {
  ctx: HostContext;
  adapter: OrgExportAdapter;
  target: OrgExport | null;
  onClose(): void;
  onDecided(decided: Decided): void;
}) {
  const [note, setNote] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const run = useCallback((input: { id: string; note: string }) => settled(adapter.decide(input.id, false, input.note)).then(asApi), [adapter]);
  const mutation = useMutation<{ id: string; note: string }, Decided>(run);
  const { reset } = mutation;
  useEffect(() => {
    setNote('');
    setShown(null);
    reset();
  }, [target?.id]);
  if (!target) return null;
  const submit = () => {
    const error = rejectError(note);
    setShown(error);
    if (error) return;
    void ctx.track(mutation.submit({ id: target.id, note: note.trim() })).then((res) => {
      if (res.ok) onDecided(res.data);
    }, () => undefined);
  };
  const general = mutation.error && !mutation.fields.note ? errorText(ctx, mutation.error) : null;
  return (
    <Modal
      open
      title={TEXT.rejectTitle}
      sub={TEXT.rejectSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="danger" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.reject)}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-export-reject={target.id}>
        <Field label={TEXT.rejectNote} hint={TEXT.rejectHint} error={shown ?? mutation.fields.note ?? null} required>
          <Textarea value={note} onChange={(v) => { setNote(v); setShown(null); mutation.reset(); }} rows={3} maxLength={NOTE_MAX} />
        </Field>
        {general ? <Alert tone="bad">{general}</Alert> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** The SHA-256 of a file, wrapped anywhere so it never widens the page. */
function Sha({ value }: { value: string | null }) {
  if (!value) return <span className="mx-muted">-</span>;
  return <code className="mx-mono mx-oe-sha" data-sha256={value}>{value}</code>;
}

/** The parts of a ready export and its manifest, each with its SHA-256 and a download. */
export function FilesTable({ ctx, detail, onPart, onManifest }: { ctx: HostContext; detail: OrgExportDetail; onPart(p: ExportPart): void; onManifest(): void }) {
  type Row = { key: string; part: string; name: string; size: string; sha: string | null; download(): void; title: string };
  const rows: Row[] = [
    ...detail.parts.map((p): Row => ({
      key: `part-${p.part}`, part: String(p.part), name: p.name, size: sizeText(p.sizeBytes, ctx.lang), sha: p.sha256, download: () => onPart(p),
      title: ctx.fill(TEXT.downloadTitle, { file: p.name }),
    })),
    {
      key: 'manifest', part: ctx.li(TEXT.manifest), name: manifestName(detail), size: '-', sha: detail.manifestSha256, download: onManifest,
      title: ctx.fill(TEXT.downloadTitle, { file: manifestName(detail) }),
    },
  ];
  const columns: Column<Row>[] = [
    { key: 'part', label: TEXT.colPart, render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{r.part}</span> },
    {
      key: 'file',
      label: TEXT.colFile,
      render: (r) => (
        <>
          <div className="mx-mono" style={{ overflowWrap: 'anywhere' }}>{r.name}</div>
          <div className="mx-small">{r.key === 'manifest' ? ctx.li(TEXT.manifestFile) : r.size}</div>
        </>
      ),
    },
    { key: 'sha', label: TEXT.colSha, render: (r) => <Sha value={r.sha} /> },
    { key: 'download', label: TEXT.colActions, render: (r) => <Button title={r.title} onClick={r.download}>{ctx.li(TEXT.download)}</Button> },
  ];
  return <Table columns={columns} rows={rows} rowKey={(r) => r.key} />;
}

/** How to check a downloaded file against its SHA-256 on Linux, macOS and Windows. */
export function HowToCheck({ ctx, sample }: { ctx: HostContext; sample: string }) {
  const lines: [TextPair, string][] = [
    [TEXT.checkLinux, `sha256sum ${sample}`],
    [TEXT.checkMac, `shasum -a 256 ${sample}`],
    [TEXT.checkWindows, `Get-FileHash ${sample} -Algorithm SHA256`],
  ];
  return (
    <Card title={TEXT.checkTitle}>
      <div className="mx-stack" data-how-to-check>
        <span>{ctx.li(TEXT.check1)}</span>
        <dl className="mx-facts">
          {lines.map(([label, command]) => (
            <div key={label[0]} style={{ display: 'contents' }}>
              <dt>{ctx.li(label)}</dt>
              <dd><code className="mx-mono mx-oe-command">{command}</code></dd>
            </div>
          ))}
        </dl>
        <span className="mx-muted">{ctx.li(TEXT.check2)}</span>
      </div>
    </Card>
  );
}

/** The text in place of the files of an export that has none to download. */
function noFilesText(status: OrgExport['status']): TextPair {
  if (status === 'expired') return TEXT.noFilesExpired;
  if (status === 'rejected') return TEXT.noFilesRejected;
  if (status === 'failed') return TEXT.noFilesFailed;
  return TEXT.noFilesYet;
}

/** One export: its facts, its files with their SHA-256, how to check them, and the decision while it waits. */
export function ExportDrawer({ ctx, adapter, id, version, self, onClose, onApprove, onReject }: {
  ctx: HostContext;
  adapter: OrgExportAdapter;
  id: string;
  /** Changes when the list shows the export in another state: the drawer reads it again. */
  version: string;
  self: string;
  onClose(): void;
  onApprove(e: OrgExport): void;
  onReject(e: OrgExport): void;
}) {
  const [result, setResult] = useState<Result<OrgExportDetail> | null>(null);
  const [tick, setTick] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void settled(adapter.get(id)).then((res) => { if (live) setResult(res); });
    return () => { live = false; };
  }, [adapter, id, version, tick]);
  const detail = result && result.ok ? result.data : null;
  const save = (load: Promise<Result<{ href: string; fileName: string; release?: () => void }>>) => {
    setFailure(null);
    void settled(load).then((res) => {
      if (res.ok) saveFile(res.data);
      else setFailure(errorText(ctx, res.error));
    });
  };
  let body;
  if (!result) body = <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  else if (!detail) {
    body = (
      <Alert tone="bad" title={TEXT.detailFailed}>
        <div>{result.ok ? null : errorText(ctx, result.error)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={() => setTick((t) => t + 1)}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else {
    const ready = detail.status === 'ready';
    body = (
      <>
        <Card>
          <Facts
            items={[
              { label: TEXT.factStatus, value: <StatusCell ctx={ctx} e={detail} /> },
              { label: TEXT.factRequested, value: whenOf(ctx, detail.requestedAt) },
              { label: TEXT.factRequestedBy, value: requesterText(ctx, detail) },
              { label: TEXT.factDecision, value: approvalText(ctx, detail) },
              ...(detail.decisionNote ? [{ label: TEXT.factNote, value: <span style={{ overflowWrap: 'anywhere' }}>{detail.decisionNote}</span> }] : []),
              { label: TEXT.factReady, value: detail.completedAt ? whenOf(ctx, detail.completedAt) : '-' },
              { label: TEXT.factExpires, value: expiryText(ctx, detail) },
              { label: TEXT.factFiles, value: detail.fileCount ?? '-' },
              { label: TEXT.factSize, value: detail.sizeBytes === null ? '-' : `${sizeText(detail.sizeBytes, ctx.lang)}, ${partsText(ctx, detail.partCount)}` },
              { label: TEXT.factDownloads, value: detail.downloadCount },
              ...(detail.error ? [{ label: TEXT.factError, value: <span style={{ overflowWrap: 'anywhere' }}>{detail.error}</span> }] : []),
            ]}
          />
        </Card>
        <Card title={TEXT.filesTitle} sub={ready ? TEXT.filesSub : undefined} flush>
          {ready
            ? <FilesTable ctx={ctx} detail={detail} onPart={(p) => save(adapter.partFile(detail, p))} onManifest={() => save(adapter.manifestFile(detail))} />
            : <div style={{ padding: 'var(--pad)' }} data-no-files={detail.status}><span className="mx-muted">{ctx.li(noFilesText(detail.status))}</span></div>}
        </Card>
        {failure ? <Alert tone="bad">{failure}</Alert> : null}
        {ready ? <HowToCheck ctx={ctx} sample={detail.parts[0]?.name ?? 'part-1.tar.gz'} /> : null}
      </>
    );
  }
  const footer = detail && detail.status === 'requested'
    ? <DecisionButtons ctx={ctx} e={detail} self={self} onApprove={() => onApprove(detail)} onReject={() => onReject(detail)} />
    : null;
  return (
    <Drawer open title={ctx.fill(TEXT.drawerTitle, { when: dayOf(ctx, detail?.requestedAt ?? null) })} crumb={TEXT.crumb} onClose={onClose} footer={footer}>
      <div className="mx-stack" data-export-drawer={id}>{body}</div>
    </Drawer>
  );
}

/** The read-only period after a contract ends: its end, and the planned deletion date (D.2, D.5.1). */
export function ReadOnlyNote({ ctx, lifecycle }: { ctx: HostContext; lifecycle: Lifecycle | null }) {
  if (!lifecycle?.offboardingEndsAt) return null;
  return (
    <Alert tone="warn" title={ctx.fill(TEXT.bannerTitle, { date: dayOf(ctx, lifecycle.offboardingEndsAt) })}>
      <div data-read-only-note>
        {ctx.li(TEXT.bannerText)}
        {' '}
        {lifecycle.deletionScheduledFor ? ctx.fill(TEXT.bannerDeletion, { date: dayOf(ctx, lifecycle.deletionScheduledFor) }) : ctx.li(TEXT.bannerNoDate)}
      </div>
    </Alert>
  );
}
