// Entitlements tab of the organisation drawer (MILESTONE-2 M2-S12, the console part of M2-S10): the current plan and
// limits with their use, and the change: a preset of `license.plans` (`ops.plans.list`) or custom limits with the
// first and last day; a preset picked in place of custom limits starts today. The change is sent with `If-Match` (the
// entitlement's ETag, `*` for an organisation without one); a 412 shows the conflict and loads the latest values, and
// the warnings of a limit below the current use are shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Card, Checkbox, DateInput, EmptyState, Facts, Field, Select, TextInput, UI_TEXT } from '../ui';
import { LoadState, asApi, useLoad } from './Health';
import type { OpsAdapter } from './model';
import {
  ADAPTER_TEXT, FEATURE_NAMES, FEATURE_TEXT, KNOWN_FRAMEWORKS, OFFERED_ADAPTERS, SOURCE_TEXT, dayText, entitlementBody, entitlementErrors,
  entitlementForm, isOpenEnded, planPicked, presetUntil, refusalText, todayOf, toggled, whenText,
} from './org-model';
import type { Entitlement, EntitlementForm, EntitlementInput, EntitlementRead, EntitlementSaved, OrgDetail, PlanPreset, StorageAdapterName } from './org-model';
import { DaysLeft, UsersOf } from './org-parts';
import { ORG_TEXT } from './org-text';

const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 } as const;

const adapterName = (ctx: HostContext, a: string) => (a in ADAPTER_TEXT ? ctx.li(ADAPTER_TEXT[a as StorageAdapterName]) : a);
const featureName = (ctx: HostContext, f: string) => ((FEATURE_NAMES as readonly string[]).includes(f) ? ctx.li(FEATURE_TEXT[f as (typeof FEATURE_NAMES)[number]]) : f);

/** The plan, its limits with their use, the dates and the version of an entitlement. */
export function EntitlementSummary({ ctx, e }: { ctx: HostContext; e: Entitlement }) {
  const rate = (v: number | null) => (v === null ? ctx.li(ORG_TEXT.defaultRate) : String(v));
  return (
    <div className="mx-stack" data-entitlement-version={e.version}>
      <Facts
        items={[
          { label: ORG_TEXT.factPlan, value: e.plan ?? '-' },
          { label: ORG_TEXT.factSource, value: ctx.li(SOURCE_TEXT[e.source]) },
          { label: ORG_TEXT.factUsersLimit, value: <UsersOf ctx={ctx} used={e.usage.users} limit={e.maxUsers} /> },
          { label: ORG_TEXT.factSystemsLimit, value: <UsersOf ctx={ctx} used={e.usage.managementSystems} limit={e.maxManagementSystems} /> },
          {
            label: ORG_TEXT.factValid,
            value: (
              <>
                <div>{isOpenEnded(e.validUntil) ? ctx.fill(ORG_TEXT.validFromOpen, { from: dayText(ctx, e.validFrom) }) : ctx.fill(ORG_TEXT.validFromUntil, { from: dayText(ctx, e.validFrom), until: dayText(ctx, e.validUntil) })}</div>
                {isOpenEnded(e.validUntil) ? null : <div style={{ marginTop: 4 }}><DaysLeft ctx={ctx} validUntil={e.validUntil!} /></div>}
              </>
            ),
          },
          { label: ORG_TEXT.factGrace, value: e.graceDays },
          { label: ORG_TEXT.rateUser, value: rate(e.rateUserPerMinute) },
          { label: ORG_TEXT.rateOrg, value: rate(e.rateOrgPerMinute) },
          { label: ORG_TEXT.frameworks, value: e.frameworks.length ? e.frameworks.join(', ') : ctx.li(ORG_TEXT.everyStandard) },
          { label: ORG_TEXT.storage, value: e.storageAdapters.length ? e.storageAdapters.map((a) => adapterName(ctx, a)).join(', ') : ctx.li(UI_TEXT.none) },
          { label: ORG_TEXT.features, value: e.features.length ? e.features.map((f) => featureName(ctx, f)).join(', ') : ctx.li(UI_TEXT.none) },
        ]}
      />
      <span className="mx-small">{ctx.fill(ORG_TEXT.version, { n: e.version, when: whenText(ctx, e.updatedAt) })}</span>
    </div>
  );
}

/** A group of checkboxes; values outside `offered` that the row holds stay listed, so a save keeps them. */
function CheckGroup({ ctx, legend, hint, offered, values, label, onChange }: {
  ctx: HostContext;
  legend: TextPair;
  hint?: TextPair;
  offered: readonly string[];
  values: string[];
  label(value: string): string;
  onChange(values: string[]): void;
}) {
  const all = [...offered, ...values.filter((v) => !offered.includes(v))];
  return (
    <fieldset className="mx-radios">
      <legend className="mx-label">{ctx.li(legend)}</legend>
      {all.map((v) => <Checkbox key={v} label={label(v)} checked={values.includes(v)} onChange={(on) => onChange(toggled(values, v, on))} />)}
      {hint ? <span className="mx-hint">{ctx.li(hint)}</span> : null}
    </fieldset>
  );
}

export function EntitlementFields({ ctx, form, presets, errors, onChange }: {
  ctx: HostContext;
  form: EntitlementForm;
  presets: readonly PlanPreset[];
  errors: Record<string, TextLikeError>;
  onChange(patch: Partial<EntitlementForm>): void;
}) {
  const err = (path: string) => errors[path] ?? null;
  const preset = presets.find((p) => p.name === form.preset) ?? null;
  const options = [
    { value: '', label: ORG_TEXT.customLimits },
    ...presets.map((p) => ({ value: p.name, label: ctx.fill(ORG_TEXT.presetSummary, { name: p.name, users: p.maxUsers, systems: p.maxManagementSystems, days: p.validDays }) })),
  ];
  let fields: ReactNode;
  if (preset) {
    fields = (
      <>
        <Field label={ORG_TEXT.validFrom} error={err('validFrom')} required>
          <DateInput value={form.validFrom} onChange={(v) => onChange({ validFrom: v })} />
        </Field>
        {/^\d{4}-\d{2}-\d{2}$/.test(form.validFrom) ? <span data-preset-until>{ctx.fill(ORG_TEXT.presetUntil, { date: dayText(ctx, presetUntil(preset, form.validFrom)) })}</span> : null}
        <Facts
          items={[
            { label: ORG_TEXT.maxUsers, value: preset.maxUsers },
            { label: ORG_TEXT.maxSystems, value: preset.maxManagementSystems },
            { label: ORG_TEXT.presetDays, value: preset.validDays },
            { label: ORG_TEXT.factGrace, value: preset.graceDays },
            { label: ORG_TEXT.frameworks, value: preset.frameworks.length ? preset.frameworks.join(', ') : ctx.li(ORG_TEXT.everyStandard) },
            { label: ORG_TEXT.storage, value: preset.storageAdapters.map((a) => adapterName(ctx, a)).join(', ') || ctx.li(UI_TEXT.none) },
            { label: ORG_TEXT.features, value: preset.features.map((f) => featureName(ctx, f)).join(', ') || ctx.li(UI_TEXT.none) },
          ]}
        />
      </>
    );
  } else {
    fields = (
      <>
        <Field label={ORG_TEXT.planName} hint={ORG_TEXT.planNameHint} error={err('plan')}>
          <TextInput value={form.plan} onChange={(v) => onChange({ plan: v })} maxLength={40} autoComplete="off" />
        </Field>
        <div style={GRID}>
          <Field label={ORG_TEXT.maxUsers} hint={ORG_TEXT.maxUsersHint} error={err('maxUsers')} required>
            <TextInput type="number" value={form.maxUsers} onChange={(v) => onChange({ maxUsers: v })} />
          </Field>
          <Field label={ORG_TEXT.maxSystems} hint={ORG_TEXT.maxSystemsHint} error={err('maxManagementSystems')} required>
            <TextInput type="number" value={form.maxSystems} onChange={(v) => onChange({ maxSystems: v })} />
          </Field>
        </div>
        <div style={GRID}>
          <Field label={ORG_TEXT.validFrom} error={err('validFrom')} required>
            <DateInput value={form.validFrom} onChange={(v) => onChange({ validFrom: v })} />
          </Field>
          <Field label={ORG_TEXT.validUntil} error={err('validUntil')} required={!form.noEnd}>
            <DateInput value={form.validUntil} onChange={(v) => onChange({ validUntil: v })} disabled={form.noEnd} min={form.validFrom || undefined} />
          </Field>
        </div>
        <Checkbox label={ORG_TEXT.noEndDate} checked={form.noEnd} onChange={(on) => onChange({ noEnd: on })} />
        <Field label={ORG_TEXT.graceDays} hint={ORG_TEXT.graceDaysHint} error={err('graceDays')} required>
          <TextInput type="number" value={form.graceDays} onChange={(v) => onChange({ graceDays: v })} />
        </Field>
        <div style={GRID}>
          <Field label={ORG_TEXT.rateUser} hint={ORG_TEXT.rateHint} error={err('rateUserPerMinute')}>
            <TextInput type="number" value={form.rateUser} onChange={(v) => onChange({ rateUser: v })} />
          </Field>
          <Field label={ORG_TEXT.rateOrg} hint={ORG_TEXT.rateHint} error={err('rateOrgPerMinute')}>
            <TextInput type="number" value={form.rateOrg} onChange={(v) => onChange({ rateOrg: v })} />
          </Field>
        </div>
        <CheckGroup ctx={ctx} legend={ORG_TEXT.frameworks} hint={ORG_TEXT.frameworksHint} offered={KNOWN_FRAMEWORKS} values={form.frameworks} label={(v) => v} onChange={(v) => onChange({ frameworks: v })} />
        <CheckGroup ctx={ctx} legend={ORG_TEXT.storage} offered={OFFERED_ADAPTERS} values={form.storageAdapters} label={(v) => adapterName(ctx, v)} onChange={(v) => onChange({ storageAdapters: v })} />
        <CheckGroup ctx={ctx} legend={ORG_TEXT.features} offered={FEATURE_NAMES} values={form.features} label={(v) => featureName(ctx, v)} onChange={(v) => onChange({ features: v })} />
      </>
    );
  }
  return (
    <div className="mx-stack">
      <Field label={ORG_TEXT.presetField} hint={ORG_TEXT.presetHint}>
        <Select value={form.preset} onChange={(v) => onChange({ preset: v })} options={options} />
      </Field>
      {fields}
    </div>
  );
}

type TextLikeError = TextPair | string;

/** The body paths the form shows next to their field; a refusal of any other path shows below the form. */
const FORM_PATHS = ['plan', 'maxUsers', 'maxManagementSystems', 'graceDays', 'rateUserPerMinute', 'rateOrgPerMinute', 'validFrom', 'validUntil'];

export function EntitlementsTab({ ctx, adapter, detail, onChanged }: { ctx: HostContext; adapter: OpsAdapter; detail: OrgDetail; onChanged(): void }) {
  const slug = detail.slug;
  const today = todayOf(ctx);
  const loadRead = useCallback(() => adapter.entitlement(slug), [adapter, slug]);
  const { result: read, reload } = useLoad<EntitlementRead>(loadRead);
  const loadPlans = useCallback(() => adapter.plans(), [adapter]);
  const { result: plans } = useLoad<PlanPreset[]>(loadPlans);
  const presets = plans && plans.ok ? plans.data : [];
  const [current, setCurrent] = useState<EntitlementRead | null>(null);
  const [form, setForm] = useState<EntitlementForm | null>(null);
  const [shown, setShown] = useState<Record<string, TextPair>>({});
  const [warnings, setWarnings] = useState<TextPair[]>([]);
  const touched = useRef(false);
  const run = useCallback((input: { body: EntitlementInput; etag: string }) => adapter.setEntitlement(slug, input.body, input.etag).then(asApi), [adapter, slug]);
  const mutation = useMutation<{ body: EntitlementInput; etag: string }, EntitlementSaved>(run);
  // Each read (the first one, and the one after a conflict) shows its values in the form.
  useEffect(() => {
    if (!read || !read.ok) return;
    setCurrent(read.data);
    setForm(entitlementForm(read.data.entitlement, today, presets));
    setShown({});
    touched.current = false;
  }, [read]);
  // An organisation without an entitlement starts on the first preset once the presets are read.
  useEffect(() => {
    if (!presets.length || touched.current || !current || current.entitlement) return;
    setForm((f) => (f && !f.preset ? { ...f, preset: presets[0].name } : f));
  }, [plans, current]);
  const canManage = ctx.platformCan('ops.entitlements.manage');
  const update = (change: Partial<EntitlementForm>) => {
    // A preset picked in place of custom limits starts today; back to custom limits, the row's first day returns.
    const patch: Partial<EntitlementForm> = form && change.preset !== undefined && Object.keys(change).length === 1
      ? planPicked(form, change.preset, today, entitlementForm(current?.entitlement ?? null, today).validFrom)
      : change;
    touched.current = true;
    setForm((f) => (f ? { ...f, ...patch } : f));
    setShown((s) => {
      const next = { ...s };
      for (const key of Object.keys(patch)) {
        const path = key === 'maxSystems' ? 'maxManagementSystems' : key === 'rateUser' ? 'rateUserPerMinute' : key === 'rateOrg' ? 'rateOrgPerMinute' : key;
        delete next[path];
      }
      return next;
    });
  };
  const save = () => {
    if (!form || !current) return;
    const errors = entitlementErrors(form);
    setShown(errors);
    if (Object.keys(errors).length) return;
    setWarnings([]);
    void ctx.track(mutation.submit({ body: entitlementBody(form), etag: current.etag })).then((res) => {
      if (!res.ok) {
        // Someone changed it meanwhile: the latest values replace the form (the conflict text says so).
        if (res.error.status === 412) reload();
        return;
      }
      setCurrent({ entitlement: res.data.entitlement, etag: res.data.etag });
      setForm(entitlementForm(res.data.entitlement, today, presets));
      touched.current = false;
      setWarnings(res.data.warnings);
      ctx.toast(ctx.fill(ORG_TEXT.saved, { org: detail.name }));
      onChanged();
    }, () => undefined);
  };
  const error = mutation.error;
  const serverFields = mutation.fields;
  const errors: Record<string, TextLikeError> = { ...serverFields, ...shown };
  const general = error && !FORM_PATHS.some((k) => serverFields[k]) ? refusalText(error) : null;
  if (!current) {
    return <Card title={ORG_TEXT.entitlement}><LoadState ctx={ctx} result={read} failed={ORG_TEXT.entitlementFailed} retry={reload} /></Card>;
  }
  return (
    <>
      {warnings.length ? (
        <Alert tone="warn" title={ORG_TEXT.warningsTitle}>
          {warnings.map((w) => <div key={w[0]}>{ctx.li(w)}</div>)}
        </Alert>
      ) : null}
      <Card title={ORG_TEXT.current}>
        {current.entitlement ? <EntitlementSummary ctx={ctx} e={current.entitlement} /> : <EmptyState title={ORG_TEXT.noEntitlementTitle} text={ORG_TEXT.noEntitlementText} />}
      </Card>
      <Card title={ORG_TEXT.change} sub={ORG_TEXT.entitlementSub}>
        {!canManage ? <span className="mx-muted">{ctx.li(ORG_TEXT.noRightEntitlements)}</span> : form ? (
          <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); save(); }} noValidate data-entitlement-form>
            {plans && !plans.ok ? <Alert tone="info">{ctx.li(ORG_TEXT.plansFailed)}</Alert> : null}
            <EntitlementFields ctx={ctx} form={form} presets={presets} errors={errors} onChange={update} />
            {general ? <Alert tone="bad">{ctx.li(general)}</Alert> : null}
            <div><Button type="submit" variant="primary" busy={mutation.busy}>{ctx.li(ORG_TEXT.save)}</Button></div>
          </form>
        ) : null}
      </Card>
    </>
  );
}
