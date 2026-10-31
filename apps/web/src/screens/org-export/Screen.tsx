// Organisation export (MILESTONE-3 M3-09, D.4, `/admin/org-export`, group Administration, scope org,
// `org.export.manage`): the exports of the organisation with status, requester, approver, size, parts and expiry;
// "Export all data" (also the page action) with what the archive holds and who is told; "Approve" and "Reject" by
// another Tenant Admin (closed to the requester, H.2); the drawer of an export with each part and the manifest, their
// SHA-256 and "How to check"; and, during the read-only period after a contract ends, its end and the planned deletion
// date. The list reads itself again while an export is queued or being built.
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, Button, Card, Alert } from '../ui';
import type { ScreenProps } from '../types';
import { adapterFor } from './adapter';
import { POLL_MS, anyBuilding, errorText, selfHandle, settled } from './model';
import type { Created, Decided, Lifecycle, OrgExport, Result } from './model';
import { ApproveDialog, ExportDrawer, ExportTable, ReadOnlyNote, RejectDialog, RequestDialog } from './parts';
import { noteLifecycle } from './store';
import { TEXT } from './text';
import './org-export.css';

export default function OrgExportScreen({ ctx }: ScreenProps) {
  const adapter = adapterFor(ctx);
  const self = selfHandle(ctx);
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [result, setResult] = useState<Result<OrgExport[]> | null>(null);
  const [rows, setRows] = useState<OrgExport[] | null>(null);
  const [tick, setTick] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [approving, setApproving] = useState<OrgExport | null>(null);
  const [rejecting, setRejecting] = useState<OrgExport | null>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // The admin count and the read-only period, shared with the banner of the host layer.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    let live = true;
    void settled(adapter.lifecycle()).then((res) => {
      if (!live || !res.ok) return;
      setLifecycle(res.data);
      noteLifecycle(ctxRef.current, res.data);
    });
    return () => { live = false; };
  }, [adapter, ctx.org?.id]);
  useEffect(() => {
    let live = true;
    void settled(adapter.list()).then((res) => {
      if (!live) return;
      setResult(res);
      if (res.ok) setRows(res.data);
    });
    return () => { live = false; };
  }, [adapter, tick, ctx.org?.id]);
  // While an export is queued or being built, the list reads itself again.
  const building = rows ? anyBuilding(rows) : false;
  useEffect(() => {
    if (!building) return undefined;
    const t = setTimeout(reload, POLL_MS);
    return () => clearTimeout(t);
  }, [building, rows, reload]);
  // The page action "Export all data" sends a new `request` value each time (index.tsx).
  const request = ctx.params.request;
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (!request || handled.current === request) return;
    handled.current = request;
    setRequesting(true);
  }, [request]);
  const created = (c: Created) => {
    setRequesting(false);
    ctx.toast(c.message ? ctx.li(c.message) : ctx.li(c.status === 'requested' ? TEXT.requestedToast : TEXT.queuedToast));
    reload();
  };
  const decided = (d: Decided) => {
    setApproving(null);
    setRejecting(null);
    ctx.toast(d.message ? ctx.li(d.message) : ctx.li(d.status === 'queued' ? TEXT.approvedToast : TEXT.rejectedToast));
    reload();
  };
  let body;
  if (!rows) {
    body = !result
      ? <div style={{ padding: 'var(--pad)' }}><div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div></div>
      : (
        <div style={{ padding: 'var(--pad)' }}>
          <Alert tone="bad" title={TEXT.loadFailed}>
            <div>{result.ok ? null : errorText(ctx, result.error)}</div>
            <div style={{ marginTop: 8 }}><Button onClick={reload}>{ctx.li(TEXT.tryAgain)}</Button></div>
          </Alert>
        </div>
      );
  } else if (!rows.length) {
    body = <EmptyState title={TEXT.empty} text={TEXT.emptyText} action={<Button variant="primary" onClick={() => setRequesting(true)}>{ctx.li(TEXT.exportAll)}</Button>} />;
  } else {
    body = <ExportTable ctx={ctx} exports={rows} self={self} onOpen={(e) => setOpened(e.id)} onApprove={setApproving} onReject={setRejecting} />;
  }
  const openedRow = rows?.find((e) => e.id === opened) ?? null;
  return (
    <div className="mx-stack" data-org-export>
      <ReadOnlyNote ctx={ctx} lifecycle={lifecycle} />
      {building ? <Alert tone="info">{ctx.li(TEXT.inFlight)}</Alert> : null}
      <Card
        title={TEXT.listTitle}
        sub={TEXT.listSub}
        flush
        actions={(
          <>
            <Button onClick={reload}>{ctx.li(TEXT.refresh)}</Button>
            <Button variant="primary" onClick={() => setRequesting(true)}>{ctx.li(TEXT.exportAll)}</Button>
          </>
        )}
      >
        {body}
      </Card>
      <RequestDialog ctx={ctx} adapter={adapter} lifecycle={lifecycle} open={requesting} onClose={() => setRequesting(false)} onCreated={created} />
      <ApproveDialog ctx={ctx} adapter={adapter} target={approving} onClose={() => setApproving(null)} onDecided={decided} />
      <RejectDialog ctx={ctx} adapter={adapter} target={rejecting} onClose={() => setRejecting(null)} onDecided={decided} />
      {opened ? (
        <ExportDrawer
          key={opened}
          ctx={ctx}
          adapter={adapter}
          id={opened}
          version={openedRow ? `${openedRow.status}:${openedRow.downloadCount}` : ''}
          self={self}
          onClose={() => setOpened(null)}
          onApprove={setApproving}
          onReject={setRejecting}
        />
      ) : null}
    </div>
  );
}
