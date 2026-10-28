// API adapter of the Management review screen (MILESTONE-2 M2-14): the reviews linked to the system with their inputs,
// planning a review, the PATCH of M2-07 (title, planned date, owner, linked systems; `If-Match`), the input of the path
// system, and the moves to held and closed (BR-13, BR-14), through the host's client (R-17).
import type { CommandResult, ManagementReviewItem } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import { outcomeOf } from '../findings/shared';
import type { ReviewAdapter, ReviewModel } from './model';
import { ROUTES } from './routes';

export function fromReviewItem(item: ManagementReviewItem): ReviewModel {
  return {
    id: item.ref.id,
    code: item.code,
    title: item.title,
    owner: item.owner,
    plannedAt: item.plannedAt,
    heldAt: item.heldAt,
    status: item.status,
    decisionsRecorded: item.decisionsRecorded,
    decisionsText: item.decisionsText,
    linkedMs: [...item.linkedMs],
    inputs: item.inputs.map((i) => ({ ...i })),
    etag: item.ref.etag ?? null,
  };
}

export function createApiAdapter(client: ApiClient | null): ReviewAdapter {
  return {
    sample: false,
    async list(ms) {
      const res = await call<ManagementReviewItem[]>(client, ROUTES.list, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.map(fromReviewItem) } : { ok: false, error: res.error };
    },
    async create(ms, body, idempotencyKey) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.create, { params: { ms }, body, idempotencyKey }));
    },
    async update(ms, review, patch) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.update, { params: { ms, id: review.id }, body: patch, ifMatch: review.etag }));
    },
    async putInput(ms, review, defCode, content) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.input, { params: { ms, id: review.id, defCode }, body: { content } }));
    },
    async move(ms, review, body) {
      return outcomeOf(await call<CommandResult>(client, ROUTES.transition, { params: { ms, id: review.id }, body }));
    },
  };
}
