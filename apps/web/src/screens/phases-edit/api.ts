// API adapter of the activity forms (MILESTONE-2 M2-11): the activity transition of D.2 through the host's client
// (R-17), with the activity's uuid from the snapshot refs and its ETag as `If-Match` (D.1).
import type { CommandResult } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import { outcomeOf, refusal } from '../controls-edit/common';
import { blockBody, startBody } from './model';
import type { ActivityAdapter, ActivityRef, ActivityTransitionRequest } from './model';
import { ROUTES } from './routes';
import { TEXT } from './text';

export function createApiAdapter(client: ApiClient | null): ActivityAdapter {
  const send = async (activity: ActivityRef, body: ActivityTransitionRequest) => {
    if (!activity.uuid) return refusal(404, TEXT.notFound);
    return outcomeOf(await call<CommandResult>(client, ROUTES.transition, { params: { ms: activity.ms, id: activity.uuid }, body, ifMatch: activity.etag }));
  };
  return {
    start: (activity) => send(activity, startBody()),
    block: (activity, gateItemRef, reason) => send(activity, blockBody(gateItemRef, reason)),
  };
}
