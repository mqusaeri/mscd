// Required documented information (MILESTONE-2 M2-12): per clause 4 to 10 the documents to maintain and the records to
// retain that the standard asks for (`documented-info.list`, D.1), with the document or evidence of this system that
// covers each one and its state, the filter "Missing only", "Register from template" (New document prefilled with the
// template's code, title and type) and "Link existing document" (`documented-info.link`, BR-40), so a customer that
// keeps its own codes completes the activities that expect the pack code. A record to retain shows its evidence and,
// when it has a template code, the document that stands for that code, with the same actions, since activities may
// expect the code (PRC-04 of ISO/IEC 27001, for example). The scope panel shows the scope text of the system next to
// the approved scope statement document (H.9: both are kept, the document is the controlled version).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Illustration } from '../../illustrations';
import type { MsId } from '../../data/types';
import { useMutation } from '../api';
import { asApi, docKey, docOf, docTypeOfTemplate, holdsInFull, personName, showDay } from '../docs-edit/model';
import type { DocRecord, VersionRow } from '../docs-edit/model';
import { useDocsAdapter } from '../docs-edit/adapter';
import { openForm } from '../docs-edit/store';
import type { HostContext, ScreenProps, TextPair } from '../types';
import {
  Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, Facts, Field, Modal, RecordPicker, Table, UI_TEXT,
} from '../ui';
import type { Column } from '../ui';
import { adapterFor } from './adapter';
import { badgeKey, setBadgeCount } from './badge';
import {
  CLAUSE_GROUPS, STATE_TONES, cannotVerify, codeDocumentOf, groupRows, inForce, missingCount, packCodeOf, rowActions, scopeRow, standingDocument,
} from './model';
import type { DiAdapter, DiRow, DiState } from './model';
import { TEXT } from './text';
import './documented-info.css';

export const STATE_TEXT: Readonly<Record<DiState, TextPair>> = {
  missing: TEXT.stMissing,
  draft: TEXT.stDraft,
  in_review: TEXT.stInReview,
  approved: TEXT.stApproved,
  review_overdue: TEXT.stOverdue,
  fresh: TEXT.stFresh,
  out_of_date: TEXT.stOutOfDate,
};

/** What the screen shows: a load in progress, the rows, or the error of the last load. */
export type LoadState = { loading: boolean; rows: DiRow[] | null; error: TextPair | null };

/** The title of a row in the language of the session (the English title when the source has no Indonesian one). */
export function rowTitle(ctx: Pick<HostContext, 'li'>, row: Pick<DiRow, 'title' | 'titleId'>): string {
  return ctx.li([row.title, row.titleId || row.title]);
}

/** The version label of the snapshot (`4.0` or `v1`) as `v4.0` or `v1`; `-` without one. */
export function versionText(ver: string | null | undefined): string {
  if (!ver || ver === '-') return '-';
  return ver.startsWith('v') ? ver : `v${ver}`;
}

/** Opens the detail of a document in Document register (the drawer, or the inline row of that pattern). */
export function openDocument(ctx: HostContext, ms: MsId, code: string): void {
  const key = docKey(ms, code);
  ctx.go('docs', { ms, sel: key, expanded: { [key]: true } });
}

/** Opens New document prefilled with the template of a row (code, title and type). */
export function registerFromTemplate(ms: MsId, row: Pick<DiRow, 'templateCode' | 'title'>): void {
  if (!row.templateCode) return;
  openForm({ type: 'new', ms, prefill: { docCode: row.templateCode, title: row.title, docType: docTypeOfTemplate(row.templateCode) } });
}

/**
 * The scope panel (H.9): the scope text of the system next to the approved scope statement document, which is the
 * document with the scope statement's template code or the document linked to that code. An implementing document of
 * clause 4.3 (a policy, say) is not a scope statement, so the panel then offers "Register from template" and "Link
 * existing document" to someone who manages documents.
 */
export function ScopePanel({ ctx, ms, rows, canManage, onLink }: {
  ctx: HostContext; ms: MsId; rows: DiRow[]; canManage: boolean; onLink?: ((row: DiRow) => void) | null;
}) {
  const scopeText = ctx.D?.MS?.find((m) => m.id === ms)?.scope ?? ctx.msObj?.scope ?? '';
  const row = scopeRow(rows);
  const doc = row ? standingDocument(row) : null;
  const record: DocRecord | null = doc ? docOf(ctx.D, ms, doc.code) : null;
  const approved = Boolean(row && doc && inForce(row.state));
  // The label and date of the approved version come from its version history (the snapshot's `ver` is the label of the
  // stored file, `v1` for a Managed Vault upload); the snapshot fills in until the history is read.
  const versions = useDocsAdapter(ctx);
  const [version, setVersion] = useState<VersionRow | null>(null);
  const docCode = doc?.code ?? null;
  const approvedOn = record?.appr ?? null;
  useEffect(() => {
    if (!approved || !docCode) return undefined;
    let live = true;
    void versions.versions(ms, docCode).then((res) => {
      if (live) setVersion(res.ok ? res.data.find((v) => v.status === 'approved') ?? null : null);
    });
    return () => {
      live = false;
    };
  }, [versions, ms, docCode, approved, approvedOn]);
  let statement;
  if (row && doc && approved) {
    statement = (
      <div className="mx-di-col" data-scope="approved">
        <div className="mx-di-doc">
          <span className="mx-row"><span className="mx-di-code">{doc.code}</span><Badge tone={STATE_TONES[row.state]}>{ctx.li(STATE_TEXT[row.state])}</Badge></span>
          <span className="mx-di-doc-title">{doc.title}</span>
        </div>
        <Facts
          items={[
            { label: TEXT.version, value: version ? `v${version.label}` : versionText(record?.ver), mono: true },
            { label: TEXT.approvedOn, value: showDay(ctx, version?.approvedAt ?? (record?.appr || null)) },
            { label: TEXT.nextReview, value: showDay(ctx, doc.nextReviewAt) },
          ]}
        />
        <div><Button variant="link" onClick={() => openDocument(ctx, ms, doc.code)}>{ctx.li(TEXT.openDocument)}</Button></div>
      </div>
    );
  } else {
    statement = (
      <div className="mx-di-col" data-scope="none">
        <Alert tone="warn" title={TEXT.noScope}>
          {!row ? ctx.li(TEXT.noScopeRow) : doc ? ctx.fill(TEXT.scopeState, { code: doc.code, state: ctx.li(STATE_TEXT[row.state]).toLowerCase() }) : ctx.li(TEXT.noScopeText)}
        </Alert>
        <div className="mx-btn-group">
          {row && !doc && row.templateCode && canManage ? (
            <Button variant="primary" onClick={() => registerFromTemplate(ms, row)}>{ctx.li(TEXT.registerTemplate)}</Button>
          ) : null}
          {row && !doc && canManage && onLink ? <Button onClick={() => onLink(row)}>{ctx.li(TEXT.linkExisting)}</Button> : null}
          {doc ? <Button onClick={() => openDocument(ctx, ms, doc.code)}>{ctx.li(TEXT.openDocument)}</Button> : null}
        </div>
      </div>
    );
  }
  return (
    <Card title={TEXT.scope} sub={TEXT.scopeSub}>
      <div className="mx-di-scope">
        <div className="mx-di-col">
          <h3 className="mx-di-label">{ctx.li(TEXT.scopeText)}</h3>
          <p className="mx-di-scopetext" data-scope-text="">{scopeText || '-'}</p>
          <span className="mx-small">{ctx.li(TEXT.scopeTextHint)}</span>
        </div>
        <div className="mx-di-col">
          <h3 className="mx-di-label">{ctx.li(TEXT.scopeStatement)}</h3>
          {statement}
        </div>
      </div>
    </Card>
  );
}

/** "Link existing document": a document of the system chosen in a picker stands for the pack code of a row. */
export function LinkDialog({ ctx, ms, row, adapter, onClose, onLinked }: {
  ctx: HostContext; ms: MsId; row: DiRow; adapter: DiAdapter; onClose(): void; onLinked(code: string, changed: MsId[]): void;
}) {
  const code = packCodeOf(row);
  const docs = (ctx.D?.bundles?.[ms]?.docs ?? []) as DocRecord[];
  const standing = codeDocumentOf(row);
  const [chosen, setChosen] = useState(standing?.linked ? standing.code : '');
  const [own, setOwn] = useState<TextPair | null>(null);
  const mutation = useMutation((docCode: string) => {
    const id = adapter.documentId(ms, docCode);
    if (!id) return Promise.resolve({ ok: false as const, status: 404, error: { status: 404, message: [TEXT.noDocs[0], TEXT.noDocs[1]] as [string, string] } });
    return asApi(adapter.link(ms, code, id));
  });
  const submit = () => {
    if (!chosen) return setOwn(TEXT.linkChoose);
    setOwn(null);
    void ctx.track(mutation.submit(chosen)).then((res) => {
      if (res.ok) onLinked(chosen, res.data.changed);
    });
  };
  const status = (d: DocRecord) => ctx.li(d.st === 'approved' ? TEXT.stApproved : d.st === 'review' ? TEXT.stInReview : d.st === 'draft' ? TEXT.stDraft : TEXT.stOverdue);
  return (
    <Modal
      open
      title={ctx.fill(TEXT.linkTitle, { code })}
      sub={ctx.fill(TEXT.linkSub, { title: rowTitle(ctx, row), code })}
      onClose={onClose}
      footer={docs.length ? (
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.linkButton)}</Button>
        </>
      ) : <Button onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>}
    >
      {docs.length ? (
        <>
          {mutation.error ? <Alert tone="bad">{ctx.li(mutation.error.message)}</Alert> : null}
          <Field label={TEXT.linkField} hint={TEXT.linkHint} required error={own}>
            <RecordPicker value={chosen} onChange={(v) => { setChosen(v); setOwn(null); }} records={docs.map((d) => ({ id: d.id, title: d.title, note: status(d) }))} />
          </Field>
        </>
      ) : (
        <EmptyState
          title={TEXT.noDocs}
          text={TEXT.noDocsText}
          illustration={<Illustration scene="no-documents" size="sm" decorative />}
          action={holdsInFull(ctx, ms, 'document.manage') ? <Button variant="primary" onClick={() => { onClose(); openForm({ type: 'new', ms }); }}>{ctx.li(TEXT.newDocument)}</Button> : null}
        />
      )}
    </Modal>
  );
}

/** A document with its code (opens it), the pack code it is linked to, and a second line. */
function DocLine({ ctx, ms, code, linkedTo, note }: { ctx: HostContext; ms: MsId; code: string; linkedTo: string | null; note: string }) {
  return (
    <div className="mx-di-doc">
      <span className="mx-row">
        <Button variant="link" onClick={() => openDocument(ctx, ms, code)}>{code}</Button>
        {linkedTo ? <Badge tone="info">{ctx.fill(TEXT.linkedTag, { code: linkedTo })}</Badge> : null}
      </span>
      {note ? <span className="mx-small">{note}</span> : null}
    </div>
  );
}

/**
 * The cell of what covers a row: its document (with the pack code it is linked to), or the evidence of a record to
 * retain with, under it, the document that stands for the record's template code. An evidence item whose pinned file
 * was changed, moved, lost or made unreadable shows "File cannot be verified" (the integrity of the snapshot), while
 * the state of the row stays as the api gives it (product decision 8).
 */
function LinkedCell({ ctx, ms, row }: { ctx: HostContext; ms: MsId; row: DiRow }) {
  if (row.kind === 'retain') {
    const template = row.templateCode ? row.templateDocument ?? null : null;
    const evs = ctx.D?.bundles?.[ms]?.evs ?? [];
    return (
      <>
        {row.evidence.length ? (
          <ul className="mx-di-evidence">
            {row.evidence.map((e) => (
              <li key={e.code}>
                <Button variant="link" onClick={() => ctx.go('fresh', { ms, sel: `${ms}:ev:${e.code}`, expanded: { [`${ms}:ev:${e.code}`]: true } })}>{e.code}</Button>
                <span className="mx-small">{e.title}</span>
                {cannotVerify(evs.find((x) => x.code === e.code)?.integ) ? <span data-integrity="cannot"><Badge tone="bad">{ctx.li(TEXT.cannotVerify)}</Badge></span> : null}
              </li>
            ))}
          </ul>
        ) : <span className="mx-small">{ctx.li(TEXT.noEvidence)}</span>}
        {template ? (
          <div className="mx-di-template" data-template-doc={template.code}>
            <DocLine ctx={ctx} ms={ms} code={template.code} linkedTo={template.linked ? row.templateCode : null} note={template.title} />
          </div>
        ) : null}
      </>
    );
  }
  const doc = row.document;
  if (!doc) return <span className="mx-small">{ctx.li(TEXT.noDocument)}</span>;
  const note = `${doc.title}${doc.owner && doc.owner !== 'none' ? `, ${personName(ctx.D, doc.owner)}` : ''}`;
  return <DocLine ctx={ctx} ms={ms} code={doc.code} linkedTo={doc.linked ? packCodeOf(row) : null} note={note} />;
}

export function ClauseTable({ ctx, ms, rows, canManage, onLink, onUnlink }: {
  ctx: HostContext; ms: MsId; rows: DiRow[]; canManage: boolean; onLink(row: DiRow): void; onUnlink(row: DiRow): void;
}) {
  const columns: Column<DiRow>[] = [
    { key: 'code', label: TEXT.colCode, width: '9%', render: (r) => <span className="mx-di-code">{r.code}</span> },
    {
      key: 'info', label: TEXT.colInfo, width: '23%', render: (r) => (
        <div className="mx-di-doc"><span className="mx-di-doc-title">{rowTitle(ctx, r)}</span><span className="mx-small">{ctx.fill(TEXT.clause, { code: r.requirementCode })}</span></div>
      ),
    },
    { key: 'kind', label: TEXT.colKind, width: '12%', render: (r) => <span className="mx-small">{ctx.li(r.kind === 'maintain' ? TEXT.maintain : TEXT.retain)}</span> },
    { key: 'template', label: TEXT.colTemplate, width: '10%', render: (r) => (r.templateCode ? <span className="mx-di-code">{r.templateCode}</span> : <span className="mx-small">-</span>) },
    { key: 'linked', label: TEXT.colLinked, width: '20%', render: (r) => <LinkedCell ctx={ctx} ms={ms} row={r} /> },
    { key: 'state', label: TEXT.colState, width: '13%', render: (r) => <Badge tone={STATE_TONES[r.state]}>{ctx.li(STATE_TEXT[r.state])}</Badge> },
  ];
  if (canManage) {
    columns.push({
      key: 'actions', label: TEXT.colActions, width: '13%', render: (r) => {
        const a = rowActions(r);
        if (!a.register && !a.link && !a.relink && !a.unlink) return null;
        return (
          <div className="mx-di-actions">
            {a.register ? <Button variant="link" onClick={() => registerFromTemplate(ms, r)}>{ctx.li(TEXT.registerTemplate)}</Button> : null}
            {a.link ? <Button variant="link" onClick={() => onLink(r)}>{ctx.li(TEXT.linkExisting)}</Button> : null}
            {a.relink ? <Button variant="link" onClick={() => onLink(r)}>{ctx.li(TEXT.changeLink)}</Button> : null}
            {a.unlink ? <Button variant="link" onClick={() => onUnlink(r)}>{ctx.li(TEXT.removeLink)}</Button> : null}
          </div>
        );
      },
    });
  }
  return <Table columns={columns} rows={rows} rowKey={(r) => r.code} />;
}

/** Loads the rows of a system; never rejects (a failed load becomes the error of the state). */
export function loadRows(adapter: DiAdapter, ms: MsId): Promise<LoadState> {
  return adapter.list(ms).then(
    (res): LoadState => (res.ok ? { loading: false, rows: res.data, error: null } : { loading: false, rows: null, error: [res.error.message[0], res.error.message[1]] }),
    (): LoadState => ({ loading: false, rows: null, error: ['Connection lost. Try again.', 'Koneksi terputus. Coba lagi.'] }),
  );
}

export default function DocumentedInfoScreen({ ctx }: ScreenProps) {
  const latest = useRef(ctx);
  latest.current = ctx;
  const ms = ctx.msObj?.id ?? null;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client, () => latest.current.D), [client]);
  const [state, setState] = useState<LoadState>({ loading: true, rows: null, error: null });
  const [missingOnly, setMissingOnly] = useState(false);
  const [linking, setLinking] = useState<DiRow | null>(null);
  const [unlinking, setUnlinking] = useState<DiRow | null>(null);
  const unlink = useMutation((row: DiRow) => asApi(adapter.link(ms ?? '', packCodeOf(row), null)));
  // The rows are read again whenever the bundle of the system changes (a document registered, approved or linked).
  const bundle = ms ? ctx.D?.bundles?.[ms] : undefined;
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!ms) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    void loadRows(adapter, ms).then((next) => {
      if (mine !== seq.current) return;
      setState(next);
      const key = badgeKey(latest.current);
      if (next.rows && key && setBadgeCount(key, missingCount(next.rows))) latest.current.track(Promise.resolve()).catch(() => undefined);
    });
  }, [adapter, ms]);
  useEffect(() => load(), [load, bundle]);
  if (!ms) return <div className="mx-notice">{ctx.li(TEXT.noSystem)}</div>;
  const canManage = holdsInFull(ctx, ms, 'document.manage');
  const rows = state.rows ?? [];
  const linked = (code: string, changed: MsId[]) => {
    const row = linking;
    setLinking(null);
    if (row) ctx.toast(ctx.fill(TEXT.linked, { doc: code, code: packCodeOf(row) }));
    void ctx.reload(changed.length ? changed : [ms]);
  };
  const confirmUnlink = () => {
    const row = unlinking;
    if (!row) return;
    void ctx.track(unlink.submit(row)).then((res) => {
      if (!res.ok) return;
      setUnlinking(null);
      ctx.toast(ctx.fill(TEXT.unlinked, { code: packCodeOf(row) }));
      void ctx.reload(res.data.changed.length ? res.data.changed : [ms]);
    });
  };
  let body;
  if (state.loading && !state.rows) body = <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  else if (state.error && !state.rows) {
    body = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{ctx.li(state.error)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else if (!rows.length) {
    body = (
      <Card>
        <EmptyState title={TEXT.none} text={TEXT.noneText} illustration={<Illustration scene="no-documents" decorative />} />
      </Card>
    );
  } else {
    const shown = missingOnly ? rows.filter((r) => r.state === 'missing') : rows;
    const groups = groupRows(shown);
    body = (
      <>
        <ScopePanel ctx={ctx} ms={ms} rows={rows} canManage={canManage} onLink={setLinking} />
        <div className="mx-di-tools">
          <Checkbox checked={missingOnly} onChange={setMissingOnly} label={TEXT.missingOnly} />
          <span className="mx-small" role="status">{ctx.fill(TEXT.summary, { total: rows.length, missing: missingCount(rows) })}</span>
        </div>
        {groups.length ? groups.map((g) => {
          const title = CLAUSE_GROUPS.find((c) => c.group === g.group)?.title ?? TEXT.otherClauses;
          return (
            <Card key={g.group || 'other'} title={title} flush>
              <div className="mx-di-table" data-clause={g.group || 'other'}>
                <ClauseTable ctx={ctx} ms={ms} rows={g.rows} canManage={canManage} onLink={setLinking} onUnlink={setUnlinking} />
              </div>
            </Card>
          );
        }) : (
          <Card>
            <EmptyState title={TEXT.nothingMissing} text={TEXT.nothingMissingText} illustration={<Illustration scene="all-done" decorative />} />
          </Card>
        )}
      </>
    );
  }
  return (
    <>
      {body}
      {linking ? <LinkDialog ctx={ctx} ms={ms} row={linking} adapter={adapter} onClose={() => setLinking(null)} onLinked={linked} /> : null}
      <ConfirmDialog
        open={Boolean(unlinking)}
        title={unlinking ? ctx.fill(TEXT.confirmUnlink, { code: packCodeOf(unlinking) }) : ''}
        body={unlinking ? ctx.fill(TEXT.confirmUnlinkBody, { doc: codeDocumentOf(unlinking)?.code ?? '', code: packCodeOf(unlinking) }) : ''}
        confirmLabel={TEXT.removeLink}
        tone="bad"
        busy={unlink.busy}
        error={unlink.error ? unlink.error.message : null}
        onConfirm={confirmUnlink}
        onCancel={() => { setUnlinking(null); unlink.reset(); }}
      />
    </>
  );
}
