// Sample adapter of the activity forms (MILESTONE-2 M2-11, C.6). The sample data source keeps the status of activities
// as the sample has it: `recordBlocker` only acknowledges a blocker (Milestone 1), and there is no sample command that
// starts an activity, so Start answers that the sample keeps the status. Loaded with a dynamic import in the sample
// branch only (adapter.ts), so an API build holds none of it (R-13).
import type { DataSource } from '../../data/types';
import { refusal } from '../controls-edit/common';
import type { ActivityAdapter } from './model';
import { TEXT } from './text';

export function createSampleAdapter(ds: Pick<DataSource, 'recordBlocker'> | null): ActivityAdapter {
  return {
    async start() {
      return refusal(422, TEXT.sampleStart);
    },
    async block(activity, gateItemRef, reason) {
      if (!ds) return refusal(0, TEXT.notFound);
      const res = await ds.recordBlocker(activity.key, gateItemRef, reason);
      if (!res.ok) return { ok: false, error: { status: res.error?.status ?? 422, message: res.error?.message ?? [TEXT.notFound[0], TEXT.notFound[1]] } };
      return { ok: true, data: { changed: res.changed, warnings: [] } };
    },
  };
}
