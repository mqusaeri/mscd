// Sample adapter of the Open work totals screen (MILESTONE-3 M3-08, D.10, C.6): the same totals the api computes,
// from the chain items of the sample snapshot (`bundles[ms].chain.items`) and the business role of each holder in the
// system as the People and roles screen shows it in the sample build (`sampleMembers` of screens/users/sample.ts:
// active grants only, as the server counts them), with the number of holders of each row (M3-14) and the roles with
// fewer than two holders besides the reader (the sample persona) merged as the server merges them (decision 21,
// M3-15). Nothing is written. Loaded only through the dynamic import of adapter.ts, so the api build holds none of it
// (R-13).
import type { ControllerData, MsId } from '../../data/types';
import { sampleMembers } from '../users/sample';
import { aggregateItems } from './model';
import type { PendingTotalsAdapter, Result, TotalsRow } from './model';
import { TEXT } from './text';

/**
 * The totals of a system of the sample snapshot as `reader` (the handle of the sample persona) reads them, or null when
 * the snapshot does not hold the system.
 */
export function sampleTotals(D: ControllerData | null, ms: MsId, reader?: string | null): TotalsRow[] | null {
  const bundle = D?.bundles?.[ms];
  if (!D || !bundle || !(D.MS ?? []).some((m) => m.id === ms)) return null;
  const roles = new Map<string, string[]>();
  for (const member of sampleMembers(D).members) {
    if (member.membershipStatus !== 'active') continue;
    // A guest keeps only the external auditor role, as on the server, so a guest never counts as a person of a row.
    const held = member.roles.filter((r) => r.ms === ms && r.approvalStatus === 'active' && (member.kind !== 'guest' || r.role === 'external_auditor'));
    roles.set(member.handle, held.map((r) => r.role));
  }
  const stageOrder = (D.STAGES?.[ms] ?? []).map((s) => s.id);
  // The people of the system with a role, so the roles with fewer than two holders merge as the api merges them (M3-15).
  const people = [...roles].filter(([, held]) => held.length > 0).map(([handle]) => handle);
  return aggregateItems(bundle.chain.items, (handle) => roles.get(handle) ?? [], stageOrder, people, reader);
}

/** The sample adapter; `getReader` gives the handle of the persona who reads the screen (the rule of decision 21). */
export function createSampleAdapter(getD: () => ControllerData | null, getReader: () => string | null = () => null): PendingTotalsAdapter {
  return {
    sample: true,
    async totals(ms: MsId): Promise<Result<TotalsRow[]>> {
      const rows = sampleTotals(getD(), ms, getReader());
      if (!rows) return { ok: false, error: { status: 404, slug: 'not-found', message: [TEXT.unknownSystem[0], TEXT.unknownSystem[1]] } };
      return { ok: true, data: rows };
    },
  };
}
