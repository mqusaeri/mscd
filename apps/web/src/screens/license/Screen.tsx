// Licence screen (MILESTONE-2 M2-01, reference screen of the host): the state of the organisation's licence, its
// dates, the seats and management systems in use against their limits, what it includes, and "Install licence"
// for whoever holds `license.manage` (a Tenant Admin with single tenancy; the platform operator with multi tenancy).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONNECTION_LOST } from '../../data/api/ApiClient';
import type { ApiClient, ApiError } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import type { HostContext, ScreenProps } from '../types';
import { fieldErrors } from '../api';
import { Alert, Badge, Button, Card, EmptyState, Facts, Field, FileInput, Meter, Modal, Textarea, UI_TEXT } from '../ui';
import type { Tone } from '../ui';
import { createApiAdapter } from './api';
import { ADAPTER_NAMES, FEATURE_NAMES, FRAMEWORK_NAMES, isExpired } from './model';
import type { LicenceAdapter, LicenceModel } from './model';
import { TEXT } from './text';

/** An adapter whose module is loaded on first use; a failed load keeps the next call free to try again. */
export function deferredAdapter(load: () => Promise<LicenceAdapter>): LicenceAdapter {
  let pending: Promise<LicenceAdapter> | null = null;
  const get = () => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    load: () => get().then((a) => a.load()),
    install: (document) => get().then((a) => a.install(document)),
  };
}

/**
 * The adapter of the build (C.6): the api's routes when the build's `VITE_DATA_SOURCE` is `api`, the sample licence
 * otherwise. The value is written out in full so Vite replaces it and drops the other branch; the sample adapter
 * comes through a dynamic import, so an api build holds no sample code or data (R-13). Unit tests call
 * `createApiAdapter` and `createSampleAdapter` directly.
 */
export function adapterFor(client: ApiClient | null, getD: () => ControllerData | null): LicenceAdapter {
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(getD)));
}

/** What the screen shows: a load in progress, the licence (null when none is installed) or the error of the last load. */
export type LoadState = { loading: boolean; licence: LicenceModel | null; error: ApiError | null };

/**
 * Loads the licence into the state of the screen. It never rejects: a failed module load of the deferred adapter
 * becomes a connection error, so the screen shows "Try again" and the next call loads the module again.
 */
export function loadLicence(adapter: LicenceAdapter): Promise<LoadState> {
  return adapter.load().then(
    (res): LoadState => (res.ok ? { loading: false, licence: res.licence, error: null } : { loading: false, licence: null, error: res.error }),
    (): LoadState => ({ loading: false, licence: null, error: { status: 0, message: CONNECTION_LOST } }),
  );
}

/** The state badges of a licence: its state, and Expired once the end date has passed. */
export function stateBadges(licence: LicenceModel, today: string | null | undefined): { tone: Tone; label: readonly [string, string] }[] {
  const out: { tone: Tone; label: readonly [string, string] }[] = [];
  if (licence.state === 'valid') out.push({ tone: 'ok', label: TEXT.stateValid });
  if (licence.state === 'grace') out.push({ tone: 'warn', label: TEXT.stateGrace });
  if (licence.state === 'read_only') out.push({ tone: 'bad', label: TEXT.stateReadOnly });
  if (isExpired(licence, today) || licence.state !== 'valid') out.push({ tone: 'bad', label: TEXT.stateExpired });
  return out;
}

/** The page body of a loaded licence. */
export function LicenceView({ ctx, licence }: { ctx: HostContext; licence: LicenceModel }) {
  const D = ctx.D;
  const day = (iso: string | null) => (iso ? (D ? D.fmt(iso, ctx.lang) : iso) : '-');
  const today = D?.TODAY_S ?? null;
  const bind = licence.binding === 'organization' ? TEXT.bindingOrg : licence.binding === 'installation' ? TEXT.bindingInstall : licence.binding === 'trial' ? TEXT.bindingTrial : null;
  const features = licence.features.map((f) => (typeof f === 'string' ? ctx.li(FEATURE_NAMES[f] ?? [f, f]) : ctx.li(f)));
  return (
    <>
      {licence.state === 'grace' ? <Alert tone="warn">{ctx.li(TEXT.graceAlert)}</Alert> : null}
      {licence.state === 'read_only' ? <Alert tone="bad">{ctx.li(TEXT.readOnlyAlert)}</Alert> : null}
      {licence.clockRollback ? <Alert tone="warn">{ctx.li(TEXT.rollbackAlert)}</Alert> : null}
      <Card
        title={TEXT.details}
        actions={stateBadges(licence, today).map((b) => <Badge key={b.label[0]} tone={b.tone}>{ctx.li(b.label)}</Badge>)}
      >
        <Facts
          items={[
            { label: TEXT.licenceId, value: licence.licenseId, mono: true },
            { label: TEXT.organisation, value: licence.organization },
            { label: TEXT.validFrom, value: day(licence.validFrom) },
            { label: TEXT.validUntil, value: day(licence.validUntil) },
            { label: TEXT.graceDays, value: licence.graceDays === null ? '-' : ctx.fill(TEXT.days, { n: licence.graceDays }) },
            ...(bind ? [{ label: TEXT.binding, value: ctx.li(bind) }] : []),
            {
              label: TEXT.signature,
              value: licence.signature
                ? ctx.fill(TEXT.signatureValue, { alg: licence.signature.alg, key: licence.signature.keyId, state: ctx.li(licence.signature.verified ? TEXT.verified : TEXT.notVerified) })
                : '-',
            },
          ]}
        />
      </Card>
      <Card title={TEXT.usage}>
        <Facts
          items={[
            {
              label: TEXT.seats,
              value: licence.users ? (
                <>
                  <span>{ctx.fill(TEXT.seatsValue, { used: licence.users.used, limit: licence.users.limit })}</span>
                  <Meter used={licence.users.used} limit={licence.users.limit} />
                  <span className="mx-small" style={{ display: 'block', marginTop: 4 }}>{ctx.li(TEXT.seatsNote)}</span>
                </>
              ) : '-',
            },
            {
              label: TEXT.systems,
              value: licence.systems ? (
                <>
                  <span>{ctx.fill(TEXT.systemsValue, { used: licence.systems.used, limit: licence.systems.limit })}</span>
                  <Meter used={licence.systems.used} limit={licence.systems.limit} />
                </>
              ) : '-',
            },
          ]}
        />
      </Card>
      <Card title={TEXT.rights}>
        <Facts
          items={[
            { label: TEXT.frameworks, value: licence.frameworks.length ? licence.frameworks.map((f) => FRAMEWORK_NAMES[f] ?? f).join(', ') : '-' },
            { label: TEXT.adapters, value: licence.storageAdapters.length ? licence.storageAdapters.map((a) => ctx.li(ADAPTER_NAMES[a] ?? [a, a])).join(', ') : '-' },
            { label: TEXT.features, value: features.length ? features.join(', ') : '-' },
          ]}
        />
      </Card>
    </>
  );
}

/** Reads a chosen file as text. */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** The message shown next to the licence field for a refused install: the rule's text, else the field errors. */
export function installError(error: ApiError): { field: readonly [string, string] | string; detail: string | null } {
  const fields = fieldErrors(error);
  const detail = fields[''] ?? Object.values(fields)[0] ?? null;
  return { field: error.message, detail: error.rule ? null : detail };
}

/** The "Install licence" dialog: a .json file or the pasted text, sent as `PUT /admin/license`. */
export function InstallDialog({ ctx, open, adapter, onClose, onInstalled }: {
  ctx: HostContext;
  open: boolean;
  adapter: LicenceAdapter;
  onClose(): void;
  onInstalled(licence: LicenceModel): void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<{ field: readonly [string, string] | string; detail: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setText('');
      setError(null);
      setBusy(false);
    }
  }, [open]);
  const onFile = (file: File | null) => {
    if (!file) return;
    readText(file).then((t) => { setText(t); setError(null); }, () => setError({ field: TEXT.unreadable, detail: null }));
  };
  const submit = () => {
    if (!text.trim()) return setError({ field: TEXT.empty, detail: null });
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return setError({ field: TEXT.notJson, detail: null });
    }
    setBusy(true);
    setError(null);
    ctx.track(adapter.install(doc)).then((res) => {
      setBusy(false);
      if (res.ok) {
        ctx.toast(ctx.li(TEXT.installed));
        onInstalled(res.licence);
        return;
      }
      setError(installError(res.error));
    }, () => setBusy(false));
  };
  const message = error ? ctx.li(error.field) + (error.detail ? ` (${error.detail})` : '') : null;
  return (
    <Modal
      open={open}
      title={TEXT.installTitle}
      sub={TEXT.installSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={submit}>{ctx.li(TEXT.install)}</Button>
        </>
      )}
    >
      <Field label={TEXT.file}>
        <FileInput accept=".json,application/json" onFile={onFile} />
      </Field>
      <Field label={TEXT.paste} hint={TEXT.pasteHint} error={message} required>
        <Textarea value={text} onChange={(v) => { setText(v); setError(null); }} rows={8} mono />
      </Field>
    </Modal>
  );
}

export default function LicenceScreen({ ctx }: ScreenProps) {
  const data = useRef(ctx.D);
  data.current = ctx.D;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client, () => data.current), [client]);
  const [state, setState] = useState<LoadState>({ loading: true, licence: null, error: null });
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    loadLicence(adapter).then(setState);
  }, [adapter]);
  useEffect(() => load(), [load]);
  // The page action "Install licence" opens the dialog through the screen params (index.tsx).
  const request = ctx.params.install;
  useEffect(() => {
    if (request) setOpen(true);
  }, [request]);
  const canInstall = ctx.orgCan('license.manage');
  let body;
  if (state.loading && !state.licence) body = <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>;
  else if (state.error) {
    body = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{ctx.li(state.error.message)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else if (!state.licence) {
    body = (
      <Card>
        <EmptyState
          title={TEXT.none}
          text={canInstall ? TEXT.noneText : [`${TEXT.noneText[0]} ${TEXT.noneAsk[0]}`, `${TEXT.noneText[1]} ${TEXT.noneAsk[1]}`]}
          action={canInstall ? <Button variant="primary" onClick={() => setOpen(true)}>{ctx.li(TEXT.install)}</Button> : null}
        />
      </Card>
    );
  } else body = <LicenceView ctx={ctx} licence={state.licence} />;
  return (
    <>
      {body}
      {canInstall ? (
        <InstallDialog
          ctx={ctx}
          open={open}
          adapter={adapter}
          onClose={() => setOpen(false)}
          onInstalled={(licence) => { setOpen(false); setState({ loading: false, licence, error: null }); }}
        />
      ) : null}
    </>
  );
}
