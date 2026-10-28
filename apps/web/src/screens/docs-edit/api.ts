// API adapter of the document control forms (MILESTONE-2 M2-12): the document routes of D.1 and D.2 through the host's
// client (R-17). A document is named by its code in the snapshot; its uuid and ETag come from the snapshot refs
// (`<ms>:doc:<code>`, G.5), so every write sends `If-Match` where the route takes one.
import type { CommandResult as WireResult, DocumentVersionItem, DocumentedInfoItem } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData, MsId } from '../../data/types';
import { call, newIdempotencyKey } from '../api';
import type { PickedFile } from '../types';
import { TEXT } from './text';
import { createBody, docKey, docTypeOfTemplate, outcomeOf, refFor, refusal, withActivityOutputs } from './model';
import type { DocsAdapter, DocumentChange, TemplateOption, VersionRow } from './model';
import { ROUTES } from './routes';

/** The version row of the api's DocumentVersionItem. */
export function fromVersion(v: DocumentVersionItem): VersionRow {
  return {
    id: v.id,
    label: v.label,
    status: v.status,
    storageObjectId: v.storageObjectId,
    submittedBy: v.submittedBy,
    submittedAt: v.submittedAt,
    approvedBy: v.approvedBy,
    approvedAt: v.approvedAt,
    rejectionNote: v.rejectionNote,
    changeSummary: v.changeSummary,
  };
}

/**
 * The document templates of Required documented information: one per template code, in list order. The adapter adds
 * the output codes of the system's activities that none of them covers (`withActivityOutputs`).
 */
export function templatesOf(items: readonly Pick<DocumentedInfoItem, 'templateCode' | 'title' | 'kind'>[]): TemplateOption[] {
  const out: TemplateOption[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.templateCode || seen.has(item.templateCode)) continue;
    seen.add(item.templateCode);
    out.push({ code: item.templateCode, title: item.title, docType: docTypeOfTemplate(item.templateCode) });
  }
  return out;
}

/** The body of a document change: the members that change, `confirm` after the BR-22 question. */
export function patchBody(change: DocumentChange, confirm: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(change)) if (v !== undefined) body[k] = v;
  if (confirm) body.confirm = true;
  return body;
}

export function createApiAdapter(client: ApiClient | null, getD: () => ControllerData | null): DocsAdapter {
  const ref = (ms: MsId, code: string) => refFor(getD(), docKey(ms, code));
  const missing = (): { ok: false; error: { status: number; message: [string, string] } } => refusal(404, TEXT.noRecordId);
  return {
    async create(ms, input) {
      return outcomeOf(await call<WireResult>(client, ROUTES.create, { params: { ms }, body: createBody(input), idempotencyKey: newIdempotencyKey() }));
    },

    async update(ms, code, change, confirm) {
      const r = ref(ms, code);
      if (!r) return missing();
      return outcomeOf(await call<WireResult>(client, ROUTES.update, { params: { ms, id: r.id }, body: patchBody(change, confirm), ifMatch: r.etag ?? null }));
    },

    async transition(ms, code, to, note) {
      const r = ref(ms, code);
      if (!r) return missing();
      const body: Record<string, unknown> = { to };
      if (note !== undefined && note.trim()) body.note = note.trim();
      return outcomeOf(await call<WireResult>(client, ROUTES.transition, { params: { ms, id: r.id }, body, ifMatch: r.etag ?? null }));
    },

    async assign(ms, code, holder, due) {
      const r = ref(ms, code);
      if (!r) return missing();
      return outcomeOf(await call<WireResult>(client, ROUTES.assign, {
        params: { ms, entityType: 'document', id: r.id },
        body: { kind: 'doc', holder: holder || 'none', dueAt: due || null },
        ifMatch: r.etag ?? null,
      }));
    },

    async addVersion(ms, code, file: PickedFile, changeSummary) {
      const r = ref(ms, code);
      if (!r) return missing();
      const summary = changeSummary?.trim() ? { changeSummary: changeSummary.trim() } : {};
      const body = file.source === 'link'
        ? { source: 'link', repository: file.repository, externalItemId: file.externalItemId, ...summary }
        : { source: 'upload', uploadIntentId: file.uploadIntentId, ...summary };
      return outcomeOf(await call<WireResult>(client, ROUTES.addVersion, { params: { ms, id: r.id }, body, idempotencyKey: newIdempotencyKey() }));
    },

    async versions(ms, code) {
      const r = ref(ms, code);
      if (!r) return missing();
      const res = await call<DocumentVersionItem[]>(client, ROUTES.versions, { params: { ms, id: r.id } });
      return res.ok ? { ok: true, data: res.data.map(fromVersion) } : { ok: false, error: res.error };
    },

    async openFile(ms, storageObjectId) {
      const res = await call<{ url: string }>(client, ROUTES.openFile, { params: { id: storageObjectId }, query: { ms } });
      return res.ok ? { ok: true, data: { url: res.data.url } } : { ok: false, error: res.error };
    },

    async templates(ms) {
      const res = await call<DocumentedInfoItem[]>(client, ROUTES.documentedInfo, { params: { ms } });
      return res.ok ? { ok: true, data: withActivityOutputs(templatesOf(res.data), getD(), ms) } : { ok: false, error: res.error };
    },

    recordId: (ms, code) => ref(ms, code)?.id ?? null,
  };
}
