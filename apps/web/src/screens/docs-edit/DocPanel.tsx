// The detail extension of a document (MILESTONE-2 M2-12, C.5): below the generated document detail, the actions of
// document control for the people who hold their permissions (F.6; hidden otherwise, as Verify is) and the Versions tab
// (`documents.versions.list`, D.1) with the change summary, rejection note and "Open file" of each version. Nothing is
// read from the api until the Versions tab is opened, so opening a document costs no request.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Illustration } from '../../illustrations';
import type { MsId } from '../../data/types';
import type { DetailProps, HostContext, TextPair } from '../types';
import { Alert, Badge, Button, EmptyState, Tabs } from '../ui';
import type { Tone } from '../ui';
import { useDocsAdapter } from './adapter';
import { hasVersion, holdsInFull, mayActOn, personName, showDay } from './model';
import type { DocRecord, DocsAdapter, VersionRow, VersionStatus } from './model';
import { openForm } from './store';
import { TEXT } from './text';

export type PanelAction = 'edit' | 'owner' | 'reassign' | 'upload';

/** The actions of document control the session may use on a document, with the label of each. */
export function panelActions(ctx: HostContext, ms: MsId, doc: DocRecord): { id: PanelAction; label: TextPair }[] {
  const out: { id: PanelAction; label: TextPair }[] = [];
  if (holdsInFull(ctx, ms, 'document.manage')) {
    out.push({ id: 'edit', label: TEXT.edit }, { id: 'owner', label: TEXT.changeOwner });
  }
  if (doc.st === 'review' && holdsInFull(ctx, ms, 'record.assign')) out.push({ id: 'reassign', label: TEXT.reassign });
  if (doc.st !== 'review' && mayActOn(ctx, ms, 'document.version.create', doc.owner)) {
    // Approved documents keep the generated "Upload new version" (no change summary) in the detail's own actions.
    const label = doc.st === 'draft' && !hasVersion(doc) ? TEXT.attachFirst : doc.st === 'approved' ? TEXT.uploadWithSummary : TEXT.uploadNew;
    out.push({ id: 'upload', label });
  }
  return out;
}

/** The sentence that says where a document stands and what comes next. */
export function stateHint(doc: Pick<DocRecord, 'st' | 'ver'>): TextPair {
  if (doc.st === 'draft') return hasVersion(doc) ? TEXT.hintDraft : TEXT.hintDraftEmpty;
  if (doc.st === 'review') return TEXT.hintReview;
  if (doc.st === 'expired') return TEXT.hintExpired;
  return TEXT.hintApproved;
}

export const VERSION_STATUS: Readonly<Record<VersionStatus, { tone: Tone; label: TextPair }>> = {
  draft: { tone: 'info', label: TEXT.vDraft },
  in_review: { tone: 'warn', label: TEXT.vInReview },
  approved: { tone: 'ok', label: TEXT.vApproved },
  rejected: { tone: 'bad', label: TEXT.vRejected },
  superseded: { tone: 'mute', label: TEXT.vSuperseded },
};

/**
 * Opens a stored file in a new tab through `storage.objects.open`. The tab is opened during the click (so a popup
 * blocker lets it through) and sent to the short-lived address once it is known; a refusal closes it again.
 */
export function openStoredFile(ctx: HostContext, adapter: DocsAdapter, ms: MsId, storageObjectId: string): void {
  const tab = ctx.mode === 'api' && typeof window !== 'undefined' ? window.open('', '_blank') : null;
  void ctx.track(adapter.openFile(ms, storageObjectId)).then((res) => {
    if (res.ok) {
      if (tab) {
        tab.opener = null;
        tab.location.replace(res.data.url);
      } else if (typeof window !== 'undefined') window.open(res.data.url, '_blank', 'noopener');
      return;
    }
    tab?.close();
    ctx.toast(ctx.li(res.error.message));
  });
}

/** One version: label, status, who submitted and approved it when, its change summary and rejection note. */
export function VersionItem({ ctx, version, onOpen }: { ctx: HostContext; version: VersionRow; onOpen?: (() => void) | null }) {
  const status = VERSION_STATUS[version.status] ?? VERSION_STATUS.draft;
  const name = (h: string | null) => personName(ctx.D, h);
  return (
    <li className="mx-de-version" data-version={version.label}>
      <div className="mx-de-version-head">
        <span className="mx-row">
          <span className="mx-de-version-label">v{version.label}</span>
          <Badge tone={status.tone}>{ctx.li(status.label)}</Badge>
        </span>
        {onOpen && version.storageObjectId ? <Button onClick={onOpen}>{ctx.li(TEXT.openFile)}</Button> : null}
      </div>
      {version.submittedAt || version.submittedBy ? (
        <p className="mx-de-meta">
          {version.submittedBy
            ? ctx.fill(TEXT.submittedBy, { name: name(version.submittedBy), date: showDay(ctx, version.submittedAt) })
            : ctx.fill(TEXT.submittedOn, { date: showDay(ctx, version.submittedAt) })}
        </p>
      ) : null}
      {version.approvedAt ? (
        <p className="mx-de-meta">
          {version.approvedBy
            ? ctx.fill(TEXT.approvedBy, { name: name(version.approvedBy), date: showDay(ctx, version.approvedAt) })
            : ctx.fill(TEXT.approvedOn, { date: showDay(ctx, version.approvedAt) })}
        </p>
      ) : null}
      {version.changeSummary ? (
        <>
          <p className="mx-de-meta">{ctx.li(TEXT.changeSummary)}</p>
          <p className="mx-de-quote">{version.changeSummary}</p>
        </>
      ) : null}
      {version.rejectionNote ? (
        <>
          <p className="mx-de-meta">{ctx.li(TEXT.rejectionNote)}</p>
          <p className="mx-de-quote">{version.rejectionNote}</p>
        </>
      ) : null}
    </li>
  );
}

/** The versions of a document, newest first, read when the list is shown and again when `stamp` (the state) changes. */
export function VersionList({ ctx, ms, code, adapter, stamp = '' }: { ctx: HostContext; ms: MsId; code: string; adapter: DocsAdapter; stamp?: string }) {
  const [state, setState] = useState<{ loading: boolean; rows: VersionRow[] | null; error: TextPair | null }>({ loading: true, rows: null, error: null });
  const mounted = useRef(true);
  const load = useCallback(() => {
    setState({ loading: true, rows: null, error: null });
    void adapter.versions(ms, code).then((res) => {
      if (!mounted.current) return;
      setState(res.ok ? { loading: false, rows: res.data, error: null } : { loading: false, rows: null, error: [res.error.message[0], res.error.message[1]] });
    });
    // `stamp` is in the list only to load again after the document changed (a new version, an approval).
  }, [adapter, ms, code, stamp]);
  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  if (state.loading) return <div className="mx-small" role="status">{ctx.li(TEXT.versionsLoading)}</div>;
  if (state.error) {
    return (
      <Alert tone="bad" title={TEXT.versionsFailed}>
        <div>{ctx.li(state.error)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  }
  const rows = state.rows ?? [];
  if (!rows.length) {
    return <EmptyState title={TEXT.noVersions} text={TEXT.noVersionsText} illustration={<Illustration scene="no-documents" size="sm" decorative />} />;
  }
  const canOpen = ctx.can(ms, 'storage.object.read');
  return (
    <ul className="mx-de-versions" data-versions={code}>
      {rows.map((v) => (
        <VersionItem key={v.id} ctx={ctx} version={v} onOpen={canOpen && v.storageObjectId ? () => openStoredFile(ctx, adapter, ms, v.storageObjectId!) : null} />
      ))}
    </ul>
  );
}

/** Asks for a file in the system's repository (the picker, or the upload dialog of the Managed Vault), then the form. */
export function startUpload(ctx: HostContext, adapter: DocsAdapter, ms: MsId, code: string, first: boolean): void {
  const recordId = adapter.recordId(ms, code);
  if (!recordId) {
    ctx.toast(ctx.li(TEXT.noRecordId));
    return;
  }
  void ctx.openPicker({ ms, kind: 'document', recordId }).then(
    (file) => {
      if (file) openForm({ type: 'upload', ms, code, file, first });
    },
    () => undefined,
  );
}

export default function DocPanel({ ctx, ms, record }: DetailProps) {
  const doc = record as DocRecord;
  const adapter = useDocsAdapter(ctx);
  const [tab, setTab] = useState<'actions' | 'versions'>('actions');
  const code = doc.id;
  const actions = panelActions(ctx, ms, doc);
  const run = (id: PanelAction) => {
    if (id === 'upload') startUpload(ctx, adapter, ms, code, doc.st === 'draft' && !hasVersion(doc));
    else openForm({ type: id, ms, code });
  };
  return (
    <section className="mx-de-panel" data-docs-edit={code} aria-label={ctx.li(TEXT.panelTitle)}>
      <div className="mx-de-head">
        <h3 className="mx-de-title">{ctx.li(TEXT.panelTitle)}</h3>
        {doc.origin === 'external' ? <Badge tone="info">{ctx.li(TEXT.external)}</Badge> : null}
      </div>
      <Tabs
        label={TEXT.tabsLabel}
        active={tab}
        onChange={(id) => setTab(id === 'versions' ? 'versions' : 'actions')}
        tabs={[{ id: 'actions', label: TEXT.tabActions }, { id: 'versions', label: TEXT.tabVersions }]}
      />
      {tab === 'actions' ? (
        <div className="mx-de-panel" role="tabpanel">
          <p className="mx-de-text">{ctx.li(stateHint(doc))}</p>
          {doc.changeSummary && hasVersion(doc) ? (
            <>
              <p className="mx-de-meta">{ctx.li(TEXT.currentSummary)}</p>
              <p className="mx-de-quote">{doc.changeSummary}</p>
            </>
          ) : null}
          {actions.length ? (
            <div className="mx-btn-group">
              {actions.map((a) => (
                <Button key={a.id} variant={a.id === 'upload' && doc.st !== 'approved' ? 'primary' : 'default'} onClick={() => run(a.id)}>
                  {ctx.li(a.label)}
                </Button>
              ))}
            </div>
          ) : (
            <p className="mx-de-text">{ctx.li(TEXT.readOnly)}</p>
          )}
        </div>
      ) : (
        <div role="tabpanel">
          <VersionList ctx={ctx} ms={ms} code={code} adapter={adapter} stamp={`${doc.st}:${doc.ver}:${doc.appr}`} />
        </div>
      )}
    </section>
  );
}
