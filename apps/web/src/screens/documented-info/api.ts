// API adapter of Required documented information (MILESTONE-2 M2-12): `documented-info.list` and `documented-info.link`
// (D.1, built by M2-07) through the host's client (R-17). A document of the snapshot is named by its code; the link
// sends its uuid from the snapshot refs (`<ms>:doc:<code>`, G.5).
//
// The api lists a record to retain with its evidence only (`document` stays empty), while its template code may be a
// pack code that activities expect (BR-40). The adapter therefore adds the document that stands for the template code
// of such a row from the list and the snapshot: the document with the code, a document to maintain with the same pack
// code, else the document the activities that expect the code resolve to. A record whose template code no activity
// expects and no row to maintain names offers no link actions, since a link of it could not be read back.
import type { CommandResult as WireResult, DocumentedInfoItem } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import type { ControllerData, MsId } from '../../data/types';
import { call } from '../api';
import { docKey, outcomeOf, refFor } from '../docs-edit/model';
import { withTemplateDocuments } from './model';
import type { CodeSources, DiAdapter, DiRow } from './model';
import { ROUTES } from './routes';

/** What the snapshot shows about the documents of a system that stand for pack codes. */
export function codeSourcesOf(D: ControllerData | null, ms: MsId): CodeSources {
  const bundle = D?.bundles?.[ms];
  const docs = (bundle?.docs ?? []).map((d) => ({ code: d.id, title: d.title }));
  const acts = (bundle?.phases ?? []).flatMap((p) => p.acts ?? []).map((a) => ({ out: a.out ?? null, doc: a.doc?.id ?? a.docId ?? null }));
  return { docs, acts };
}

/** The screen's row of the api's DocumentedInfoItem. */
export function fromItem(item: DocumentedInfoItem): DiRow {
  return {
    code: item.code,
    requirementCode: item.requirementCode,
    kind: item.kind,
    title: item.title,
    templateCode: item.templateCode,
    state: item.state,
    document: item.document
      ? {
          id: item.document.id,
          code: item.document.code,
          title: item.document.title,
          status: item.document.status,
          nextReviewAt: item.document.nextReviewAt,
          owner: item.document.owner,
          linked: item.document.linked,
        }
      : null,
    evidence: item.evidence.map((e) => ({ code: e.code, title: e.title, fresh: e.fresh })),
  };
}

export function createApiAdapter(client: ApiClient | null, getD: () => ControllerData | null): DiAdapter {
  return {
    async list(ms) {
      const res = await call<DocumentedInfoItem[]>(client, ROUTES.list, { params: { ms } });
      return res.ok ? { ok: true, data: withTemplateDocuments(res.data.map(fromItem), codeSourcesOf(getD(), ms)) } : { ok: false, error: res.error };
    },
    async link(ms, packCode, documentId) {
      return outcomeOf(await call<WireResult>(client, ROUTES.link, { params: { ms, code: packCode }, body: { documentId } }));
    },
    documentId: (ms, code) => refFor(getD(), docKey(ms, code))?.id ?? null,
  };
}
