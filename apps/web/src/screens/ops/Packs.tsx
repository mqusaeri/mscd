// Operator console, Framework packs (MILESTONE-2 M2-16): the installed packs (`admin.packs.list`) and "Install pack":
// a signed `.bundle` upload to `admin.packs.import`, whose installation is followed in the installed list until the
// worker finishes it. Signature and engine version errors show next to the field. On a multi tenancy service the
// platform operator installs packs, so every organisation gets new pack versions without the command line (E.3).
import { useCallback, useEffect, useRef, useState } from 'react';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, Field, FileInput, Table } from '../ui';
import type { Column, Tone } from '../ui';
import { LoadState, asApi, useLoad } from './Health';
import { MAX_BUNDLE_BYTES, PACK_POLLS, PACK_POLL_MS, PACK_TEXT, multiTenancy, packRows } from './model';
import type { OpsAdapter, PackImported, PackItem } from './model';
import { TEXT } from './text';

const PACK_TONE: Readonly<Record<PackItem['status'], Tone>> = { installed: 'ok', validating: 'info', failed: 'bad', superseded: 'mute' };

export type Progress = { state: 'queued' | 'done' | 'failed' | 'slow' | 'unchanged'; packId: string; version: string; message: TextPair | null };

export function progressText(p: Progress): { tone: Tone; text: TextPair } {
  if (p.state === 'unchanged' && p.message) return { tone: 'info', text: p.message };
  if (p.state === 'done' || p.state === 'unchanged') return { tone: 'ok', text: TEXT.progressDone };
  if (p.state === 'failed') return { tone: 'bad', text: TEXT.progressFailed };
  if (p.state === 'slow') return { tone: 'warn', text: TEXT.progressSlow };
  return { tone: 'info', text: TEXT.progressQueued };
}

/**
 * Follows an imported pack in the installed list until its row is installed or failed, at most `polls` reads.
 * `before` is the number of rows of that pack version before the import: the server writes the row of an installation
 * only when it ends, and an earlier failed installation of the same version stays in the list, so only a row beyond
 * those is the result of this import. `onRead` gets each list; resolves with the final state.
 */
export async function followInstall(
  adapter: OpsAdapter,
  imported: { packId: string; version: string },
  options: { before?: number; polls?: number; waitMs?: number; sleep?: (ms: number) => Promise<void>; onRead?: (list: PackItem[]) => void; alive?: () => boolean } = {},
): Promise<'done' | 'failed' | 'slow'> {
  const polls = options.polls ?? PACK_POLLS;
  const before = options.before ?? 0;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < polls; i++) {
    await sleep(options.waitMs ?? PACK_POLL_MS);
    if (options.alive && !options.alive()) return 'slow';
    const res = await adapter.packs();
    if (!res.ok) continue;
    options.onRead?.(res.data);
    const rows = packRows(res.data, imported.packId, imported.version);
    if (rows.length <= before) continue;
    const row = rows[0];
    if (row.status === 'installed' || row.status === 'superseded') return 'done';
    if (row.status === 'failed') return 'failed';
  }
  return 'slow';
}

/** The installed list just before an import (the shown list when that read fails), for `followInstall`'s `before`. */
export async function listBefore(adapter: OpsAdapter, shown: PackItem[] | null): Promise<PackItem[] | null> {
  const read = await adapter.packs().catch(() => null);
  return read && read.ok ? read.data : shown;
}

export function PacksTable({ ctx, packs }: { ctx: HostContext; packs: PackItem[] }) {
  const day = (iso: string | null) => (iso ? (ctx.D ? ctx.D.fmt(iso.slice(0, 10), ctx.lang) : iso.slice(0, 10)) : '-');
  const columns: Column<PackItem>[] = [
    { key: 'pack', label: TEXT.colPack, render: (p) => <span className="mx-mono" style={{ fontWeight: 600 }}>{p.packId}</span> },
    { key: 'version', label: TEXT.colVersion, render: (p) => <span className="mx-mono">{p.version}</span> },
    { key: 'edition', label: TEXT.colEdition, render: (p) => `${p.frameworkCode} ${p.edition}` },
    {
      key: 'status',
      label: TEXT.colStatus,
      render: (p) => (
        <span className="mx-row">
          <Badge tone={PACK_TONE[p.status]}>{ctx.li(PACK_TEXT[p.status])}</Badge>
          {p.preRelease ? <Badge tone="warn">{ctx.li(TEXT.preRelease)}</Badge> : null}
        </span>
      ),
    },
    { key: 'installed', label: TEXT.colInstalled, render: (p) => day(p.installedAt) },
  ];
  if (!packs.length) return <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(TEXT.noPacks)}</span></div>;
  return <Table columns={columns} rows={packs} rowKey={(p) => `${p.packId}@${p.version}@${p.installedAt ?? ''}@${p.status}`} />;
}

export function InstallPackCard({ ctx, adapter, list, onList }: { ctx: HostContext; adapter: OpsAdapter; list?: PackItem[] | null; onList(list: PackItem[]): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [shown, setShown] = useState<TextPair | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const shownList = useRef<PackItem[] | null>(list ?? null);
  shownList.current = list ?? null;
  // The installed list read just before the import: its rows of the imported version are not the result of the import.
  const prior = useRef<PackItem[] | null>(null);
  const run = useCallback(async (input: { file: File; key: string }) => {
    prior.current = await listBefore(adapter, shownList.current);
    return asApi(await adapter.importPack(input.file, input.file.name, input.key));
  }, [adapter]);
  const mutation = useMutation<{ file: File; key: string }, PackImported>(run);
  const submit = () => {
    if (!file) return setShown(TEXT.bundleMissing);
    if (file.size > MAX_BUNDLE_BYTES) return setShown(TEXT.bundleTooLarge);
    setShown(null);
    setProgress(null);
    void ctx.track(mutation.submit({ file, key: newIdempotencyKey() })).then(async (res) => {
      if (!res.ok || !alive.current) return;
      const imported = res.data;
      setFile(null);
      setInputKey((k) => k + 1);
      if (imported.status === 'unchanged') {
        setProgress({ state: 'unchanged', packId: imported.packId, version: imported.version, message: imported.message });
        return;
      }
      setProgress({ state: 'queued', packId: imported.packId, version: imported.version, message: imported.message });
      const before = prior.current ? packRows(prior.current, imported.packId, imported.version).length : 0;
      const state = await followInstall(adapter, imported, { before, onRead: (read) => { if (alive.current) onList(read); }, alive: () => alive.current });
      if (alive.current) setProgress({ state, packId: imported.packId, version: imported.version, message: null });
    }, () => undefined);
  };
  const error = mutation.error;
  const detail = error && !error.rule ? Object.values(mutation.fields)[0] ?? null : null;
  const message = shown ? ctx.li(shown) : error ? ctx.li(error.message) + (detail && detail !== ctx.li(error.message) ? ` (${detail})` : '') : null;
  const shownProgress = progress ? progressText(progress) : null;
  return (
    <Card title={TEXT.installPack} sub={TEXT.installPackSub}>
      <div className="mx-stack" style={{ maxWidth: 560 }}>
        <Field label={TEXT.bundle} error={message} required>
          <FileInput key={inputKey} accept=".bundle,.pack,application/octet-stream,application/gzip" onFile={(f) => { setFile(f); setShown(null); mutation.reset(); }} />
        </Field>
        {shownProgress && progress ? (
          <Alert tone={shownProgress.tone} role="status">{ctx.fill(shownProgress.text, { pack: progress.packId, version: progress.version })}</Alert>
        ) : null}
        <div><Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.install)}</Button></div>
      </div>
    </Card>
  );
}

export function PacksTab({ ctx, adapter }: { ctx: HostContext; adapter: OpsAdapter }) {
  const multi = multiTenancy(ctx);
  const load = useCallback(() => adapter.packs(), [adapter]);
  if (!multi) {
    return (
      <Card title={TEXT.packs}>
        <Alert tone="info">{ctx.li(TEXT.packsSingle)}</Alert>
      </Card>
    );
  }
  return <PacksList ctx={ctx} adapter={adapter} load={load} />;
}

function PacksList({ ctx, adapter, load }: { ctx: HostContext; adapter: OpsAdapter; load: () => ReturnType<OpsAdapter['packs']> }) {
  const { result, reload } = useLoad(load);
  const [list, setList] = useState<PackItem[] | null>(null);
  useEffect(() => {
    if (result && result.ok) setList(result.data);
  }, [result]);
  const canInstall = ctx.platformCan('pack.install');
  return (
    <>
      <Card title={TEXT.packs} sub={TEXT.packsSub} flush actions={<Button onClick={reload}>{ctx.li(TEXT.refresh)}</Button>}>
        {list ? <PacksTable ctx={ctx} packs={list} /> : <div style={{ padding: 'var(--pad)' }}><LoadState ctx={ctx} result={result} failed={TEXT.packsFailed} retry={reload} /></div>}
      </Card>
      {canInstall ? <InstallPackCard ctx={ctx} adapter={adapter} list={list} onList={setList} /> : null}
    </>
  );
}
