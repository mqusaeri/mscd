// The edition transition drawer (MILESTONE-2 M2-09), opened by the "Edition transition" page action of the Framework
// library: the systems the session manages that have a newer edition installed, with "Start edition transition", and
// the systems in transition, with "Finish transition" (`ms.transition`, C.13). Entries keep pointing at the old
// edition (plan B), and the drawer says so.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext } from '../types';
import { Alert, Badge, Button, Drawer, Facts, Field, Select, UI_TEXT } from '../ui';
import { settled } from '../storage-admin/adapter';
import { DrawerFoot, errorText } from '../storage-admin/panels';
import { createTransitionAdapter } from './api';
import { transitionRows } from './model';
import type { MsStatusCode, PackChoice, TransitionAdapter, TransitionRow } from './model';
import { TEXT } from './text';

export function TransitionList({ ctx, rows, targets, onTarget, onStart, onFinish, busy, errors }: {
  ctx: HostContext;
  rows: TransitionRow[];
  targets: Record<string, string>;
  onTarget(ms: string, edition: string): void;
  onStart(row: TransitionRow): void;
  onFinish(row: TransitionRow): void;
  busy: string | null;
  errors: Record<string, ApiError>;
}) {
  if (!rows.length) return <Alert tone="info">{ctx.li(TEXT.transitionNone)}</Alert>;
  return (
    <div className="mx-stack">
      {rows.map((row) => {
        const target = targets[row.ms] ?? row.newer[row.newer.length - 1] ?? '';
        return (
          <section key={row.ms} className="mx-card" aria-label={row.code}>
            <div className="mx-card-body mx-stack" style={{ gap: 10 }}>
              <div className="mx-row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <h3 className="mx-card-title" style={{ margin: 0, fontSize: '1em' }}>{row.code}</h3>
                  <div className="mx-small">{ctx.li(row.name)}</div>
                </div>
                {row.target ? <Badge tone="info">{ctx.li(TEXT.statusTransitioning)}</Badge> : null}
              </div>
              <Facts
                items={[
                  { label: TEXT.colEdition, value: `${row.framework} ${row.edition}` },
                  ...(row.target ? [{ label: TEXT.transitionTo, value: ctx.fill(TEXT.transitionTarget, { edition: row.target }) }] : []),
                ]}
              />
              {row.target ? (
                <>
                  <div className="mx-btn-group">
                    <Button variant="primary" busy={busy === row.ms} onClick={() => onFinish(row)}>{ctx.li(TEXT.finishTransition)}</Button>
                  </div>
                  <div className="mx-small">{ctx.li(TEXT.finishHint)}</div>
                </>
              ) : (
                <>
                  <Field label={TEXT.transitionTo}>
                    <Select value={target} onChange={(v) => onTarget(row.ms, v)} options={row.newer.map((e) => ({ value: e, label: `${row.framework} ${e}` }))} />
                  </Field>
                  <div className="mx-btn-group">
                    <Button
                      variant="primary"
                      busy={busy === row.ms}
                      disabled={!target}
                      disabledReason={row.status && row.status !== 'certified' ? TEXT.startHint : null}
                      onClick={() => onStart({ ...row, newer: [target] })}
                    >
                      {ctx.li(TEXT.startTransition)}
                    </Button>
                  </div>
                  {!row.status ? <div className="mx-small">{ctx.li(TEXT.startHint)}</div> : null}
                </>
              )}
              {errors[row.ms] ? <Alert tone="bad">{errorText(ctx, errors[row.ms])}</Alert> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default function TransitionDrawer({ ctx, onClose, adapter: given }: { ctx: HostContext; onClose(): void; adapter?: TransitionAdapter }) {
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const admin = ctx.orgCan('ms.admin');
  const adapter = useMemo(() => given ?? createTransitionAdapter(client, { statuses: admin }), [given, client, admin]);
  const [packs, setPacks] = useState<PackChoice[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, MsStatusCode> | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, ApiError>>({});
  const readStatuses = useCallback(() => adapter.statuses().then(setStatuses, () => setStatuses(null)), [adapter]);
  // The rows wait for both reads, so a system is never offered the wrong move while its status is still unknown.
  const load = useCallback(() => {
    setLoadError(null);
    setPacks(null);
    Promise.all([settled(adapter.packs()), readStatuses()]).then(([res]) => {
      if (res.ok) setPacks(res.data);
      else setLoadError(res.error);
    });
  }, [adapter, readStatuses]);
  useEffect(() => load(), [load]);
  const rows = packs ? transitionRows(ctx.D?.MS ?? [], packs, (ms) => ctx.can(ms, 'ms.transition'), statuses) : [];
  const run = (row: TransitionRow, to: 'transitioning' | 'certified') => {
    const clear = (e: Record<string, ApiError>) => {
      const next = { ...e };
      delete next[row.ms];
      return next;
    };
    setBusy(row.ms);
    setErrors(clear);
    const body = to === 'transitioning' ? { to, targetEdition: row.newer[0] } as const : { to } as const;
    settled(adapter.transition(row.ms, body)).then((res) => {
      setBusy(null);
      if (!res.ok) {
        setErrors((e) => ({ ...e, [row.ms]: res.error }));
        return;
      }
      setErrors(clear);
      if (res.message) context.current.toast(context.current.li(res.message));
      void readStatuses();
      context.current.reload(res.data.changed.length ? res.data.changed : [row.ms]).catch(() => undefined);
    });
  };
  return (
    <Drawer open title={TEXT.transitionTitle} crumb={['Framework library', 'Pustaka framework']} onClose={onClose} footer={<DrawerFoot><Button onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button></DrawerFoot>}>
      <div className="mx-small">{ctx.li(TEXT.transitionSub)}</div>
      <Alert tone="info">{ctx.li(TEXT.transitionNote)}</Alert>
      {loadError ? (
        <Alert tone="bad" title={TEXT.packsFailed}>
          <div>{errorText(ctx, loadError)}</div>
          <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
        </Alert>
      ) : !packs ? (
        <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>
      ) : (
        <TransitionList
          ctx={ctx}
          rows={rows}
          targets={targets}
          onTarget={(ms, edition) => setTargets((t) => ({ ...t, [ms]: edition }))}
          onStart={(row) => run(row, 'transitioning')}
          onFinish={(row) => run(row, 'certified')}
          busy={busy}
          errors={errors}
        />
      )}
    </Drawer>
  );
}
