// "Freshness limits" (MILESTONE-2 M2-11, page action of Evidence freshness): the limits in force per evidence frequency
// of the system (`freshness.thresholds.get`), marked default or set for the system, with Save per frequency and
// "Reset to default" (`freshness.thresholds.put`, nulls). Only an MS Manager (`applicability.manage`) changes them.
// The server works out the freshness bands when the system is read, so every change loads the system again and
// Evidence freshness behind the form shows the new bands.
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { MsId } from '../../data/types';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Field, Modal, TextInput, UI_TEXT } from '../ui';
import { holdsInFull, periodOf, reloadChanged } from '../controls-edit/common';
import type { Outcome, Result } from '../controls-edit/common';
import { placeErrors, useAdapterOf } from '../controls-edit/parts';
import { adapterFor } from './adapter';
import { thresholdBodyOf, thresholdValuesOf } from './model';
import type { EvidenceAdapter, FreshnessThresholdSet, Threshold, ThresholdValues } from './model';
import { TEXT } from './text';

/**
 * Sets the limits of a frequency (nulls reset them to the default), then loads the systems the write changed (the
 * form's system when the answer names none), so the built-in screens show the bands under the new limits. A failed
 * load leaves the saved limits in place: the next load of the system shows them.
 */
export async function putLimits(
  ctx: Pick<HostContext, 'track' | 'reload' | 'msObj'>,
  adapter: Pick<EvidenceAdapter, 'setThreshold'>,
  ms: MsId,
  frequencyCode: string,
  body: FreshnessThresholdSet,
): Promise<Result<Outcome>> {
  const res = await ctx.track(adapter.setThreshold(ms, frequencyCode, body));
  if (res.ok) await reloadChanged(ctx, res.data.changed, ms).catch(() => undefined);
  return res;
}

const PATHS = { graceDays: 'graceDays', agingFactor: 'agingFactor', expiredFactor: 'expiredFactor' } as const;

function frequencyLabel(ctx: HostContext, code: string): string {
  const f = (ctx.D?.FREQ as Record<string, [string, string, number]> | undefined)?.[code];
  return f ? ctx.li([f[0], f[1]]) : code;
}

/** One frequency: its three limits and their source, with Save and Reset to default. */
function LimitRow({ ctx, adapter, ms, item, editable, onSaved }: {
  ctx: HostContext;
  adapter: EvidenceAdapter;
  ms: MsId;
  item: Threshold;
  editable: boolean;
  onSaved(next: Threshold, reset: boolean): void;
}) {
  const id = useId();
  const [values, setValues] = useState<ThresholdValues>(thresholdValuesOf(item));
  const [local, setLocal] = useState<Record<string, TextPair>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  useEffect(() => setValues(thresholdValuesOf(item)), [item]);
  const placed = placeErrors(error, ctx.li, PATHS);
  const label = frequencyLabel(ctx, item.frequencyCode);
  const p = periodOf(ctx.D, item.frequencyCode);
  const set = (name: keyof ThresholdValues) => (value: string) => setValues((v) => ({ ...v, [name]: value }));
  const fieldError = (field: string) => (local[field] ? ctx.li(local[field]) : placed.fields[field] || null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = thresholdBodyOf(values);
    if (!body.ok) {
      setLocal(body.fields);
      return;
    }
    setLocal({});
    setBusy('save');
    const res = await putLimits(ctx, adapter, ms, item.frequencyCode, body.body);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    ctx.toast(ctx.fill(TEXT.limitsSaved, { frequency: label }));
    onSaved({ ...item, ...body.body, source: 'set' }, false);
  };
  const reset = async () => {
    setBusy('reset');
    const res = await putLimits(ctx, adapter, ms, item.frequencyCode, { graceDays: null, agingFactor: null, expiredFactor: null });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    ctx.toast(ctx.fill(TEXT.limitsReset, { frequency: label }));
    onSaved(item, true);
  };

  return (
    <form className="mx-m11-row" onSubmit={save} noValidate aria-labelledby={`${id}-title`} data-frequency={item.frequencyCode}>
      <div className="mx-m11-row-head">
        <h3 id={`${id}-title`} className="mx-m11-row-title">{label}</h3>
        <Badge tone={item.source === 'set' ? 'info' : 'mute'}>{ctx.li(item.source === 'set' ? TEXT.sourceSet : TEXT.sourceDefault)}</Badge>
      </div>
      <span className="mx-small">{p ? ctx.fill(TEXT.periodDays, { n: p }) : ctx.li(TEXT.perEvent)}</span>
      {placed.general ? <Alert tone="bad">{ctx.li(placed.general.message)}</Alert> : null}
      <div className="mx-m11-grid">
        <Field label={TEXT.graceDays} error={fieldError('graceDays')}>
          <TextInput name="graceDays" type="number" value={values.graceDays} onChange={set('graceDays')} disabled={!editable} />
        </Field>
        <Field label={TEXT.agingFactor} error={fieldError('agingFactor')}>
          <TextInput name="agingFactor" type="number" value={values.agingFactor} onChange={set('agingFactor')} disabled={!editable} />
        </Field>
        <Field label={TEXT.expiredFactor} error={fieldError('expiredFactor')}>
          <TextInput name="expiredFactor" type="number" value={values.expiredFactor} onChange={set('expiredFactor')} disabled={!editable} />
        </Field>
      </div>
      {editable ? (
        <div className="mx-btn-group">
          <Button type="submit" variant="primary" busy={busy === 'save'} disabled={busy !== null}>{ctx.li(TEXT.saveLimits)}</Button>
          {item.source === 'set' ? <Button onClick={() => void reset()} busy={busy === 'reset'} disabled={busy !== null}>{ctx.li(TEXT.resetDefault)}</Button> : null}
        </div>
      ) : null}
    </form>
  );
}

export function ThresholdsDialog({ ctx, ms, onClose }: { ctx: HostContext; ms: MsId; onClose(): void }) {
  const adapter = useAdapterOf(ctx, adapterFor);
  const [items, setItems] = useState<Threshold[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const editable = holdsInFull(ctx, ms, 'applicability.manage');
  const system = ctx.D?.MS?.find((m) => m.id === ms)?.short ?? ms;
  useEffect(() => {
    let live = true;
    setError(null);
    void adapter.thresholds(ms).then((res) => {
      if (!live) return;
      if (res.ok) setItems(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [adapter, ms, attempt]);
  const saved = (next: Threshold, reset: boolean) => {
    if (reset) {
      // The value in force after a reset is the organisation's or the built-in default: read it again.
      setAttempt((n) => n + 1);
      return;
    }
    setItems((list) => (list ?? []).map((t) => (t.frequencyCode === next.frequencyCode ? next : t)));
  };
  return (
    <Modal
      open
      title={ctx.fill(TEXT.limitsTitle, { system })}
      sub={TEXT.limitsSub}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>}
    >
      <div className="mx-stack">
        {!editable ? <Alert tone="info">{ctx.li(TEXT.limitsReadOnly)}</Alert> : null}
        {error ? (
          <Alert tone="bad">
            {ctx.li(TEXT.limitsFailed)} {ctx.li(error.message)}
            <div className="mx-btn-group" style={{ marginTop: 8 }}><Button onClick={() => setAttempt((n) => n + 1)}>{ctx.li(TEXT.tryAgain)}</Button></div>
          </Alert>
        ) : null}
        {!items && !error ? <div className="mx-small" role="status">{ctx.li(TEXT.limitsLoading)}</div> : null}
        {items ? (
          <div className="mx-m11-rows">
            {items.map((item) => <LimitRow key={`${item.frequencyCode}:${item.source}:${item.graceDays}:${item.agingFactor}:${item.expiredFactor}`} ctx={ctx} adapter={adapter} ms={ms} item={item} editable={editable} onSaved={saved} />)}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
