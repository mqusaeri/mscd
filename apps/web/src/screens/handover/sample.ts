// Sample adapter of the Handover screen (MILESTONE-2 M2-10): the open items a person holds in a sample system, read
// from the sample snapshot (requirement owners, documents to own and approve, evidence, phase activities, the chain
// items of the registers, audit preparation and certification cycle items). A move keeps the new holders for the
// browser session and changes the owners of requirements, documents and evidence in the sample data source, so the
// built-in screens show them too. A document shared with other systems (BR-22) asks for the confirmation first, as the
// api does, and then moves in every system that uses it.
import type { HoldingsReassign } from '@mscd/shared';
import type { ControllerData, DataSource } from '../../data/types';
import type { HandoverAdapter, HeldItem, HoldingKind, HoldingsModel, MoveWarning, Result } from './model';
import { KIND_ORDER, sortedItems } from './model';

/** Chain item lists of the sample (`X[ms]`) and the holding kind of each. */
const X_KINDS: Readonly<Record<string, HoldingKind | null>> = {
  risk: 'risk', drisk: 'risk', treatment: 'risk_treatment', action: 'corrective_action', soa: null,
  context: 'register_row', metric: 'register_row', objective: 'register_row', product: 'register_row', bia: 'register_row', exercise: 'register_row',
};

/** A held item with the record it moves in the sample data source (`kind` of `mutate` and the owner fields). */
interface SampleItem extends HeldItem {
  key: string;
  mutate?: { kind: 'req' | 'doc' | 'ev'; id: string; field: 'owner' | 'approver' };
  /** A document shared with other management systems (BR-22). */
  shared?: boolean;
}

const text = (v: unknown) => (Array.isArray(v) ? String(v[0]) : String(v ?? ''));

/** Every open item of the snapshot in a system, with its holder. */
function allItems(D: ControllerData | null, ms: string): { holder: string; item: SampleItem }[] {
  const out: { holder: string; item: SampleItem }[] = [];
  if (!D) return out;
  const b = D.bundles?.[ms];
  const add = (holder: string | null | undefined, item: SampleItem) => {
    if (holder && holder !== 'none') out.push({ holder, item });
  };
  for (const r of b?.reqs ?? []) {
    if (r.st === 'na') continue;
    add(r.owner, { key: `req:${r.id}`, kind: 'applicability_entry', code: r.id, title: r.title, dueAt: null, mutate: { kind: 'req', id: r.id, field: 'owner' } });
  }
  for (const d of b?.docs ?? []) {
    const shared = Boolean(d.shared);
    add(d.owner, { key: `doc-owner:${d.id}`, kind: 'document_owner', code: d.id, title: d.title, dueAt: d.rev ?? null, mutate: { kind: 'doc', id: d.id, field: 'owner' }, shared });
    if (d.st === 'review') add(d.approver, { key: `doc-approver:${d.id}`, kind: 'document_approver', code: d.id, title: d.title, dueAt: null, mutate: { kind: 'doc', id: d.id, field: 'approver' }, shared });
  }
  for (const e of b?.evs ?? []) {
    add(e.owner, { key: `ev:${e.code}`, kind: 'evidence', code: e.code, title: e.title, dueAt: e.next ?? null, mutate: { kind: 'ev', id: e.code, field: 'owner' } });
  }
  for (const p of b?.phases ?? []) {
    for (const a of p.acts ?? []) {
      if (a.st !== 'verified') add(a.owner, { key: `act:${a.no}`, kind: 'activity', code: a.no, title: a.title, dueAt: a.date ?? null });
    }
  }
  for (const [list, rows] of Object.entries(D.X?.[ms] ?? {})) {
    const kind = X_KINDS[list];
    if (!kind) continue;
    for (const x of rows as { id: string; t: unknown; h?: string; due?: string | null }[]) {
      add(x.h, { key: `x:${list}:${x.id}`, kind, code: x.id, title: text(x.t), dueAt: x.due ?? null });
    }
  }
  (D.PREP?.[ms] ?? []).forEach((row, i) => {
    if (row[3] !== 'done') add(row[1], { key: `prep:${i}`, kind: 'prep_task', code: `PREP-${String(i + 1).padStart(2, '0')}`, title: text(row[0]), dueAt: row[2] ?? null });
  });
  (D.CYCLE_ITEMS?.[ms] ?? []).forEach((row, i) => {
    if (row[4] !== 'done') add(row[2], { key: `cycle:${i}`, kind: 'cycle_item', code: String(row[0]), title: text(row[1]), dueAt: row[3] ?? null });
  });
  return out;
}

// Items moved in this browser session: `<ms>:<item key>` to the new holder.
let moved: Record<string, string> = {};

/** Forgets the moves of this session (unit tests). */
export function resetSampleHandover(): void {
  moved = {};
}

/** The items a person holds in a system, after the moves of this session. */
function heldBy(D: ControllerData | null, ms: string, handle: string): SampleItem[] {
  return allItems(D, ms)
    .filter(({ holder, item }) => (moved[`${ms}:${item.key}`] ?? holder) === handle)
    .map(({ item }) => item);
}

/** Open items and counts per kind of a person in a sample system (also read by the People and roles sample). */
export function sampleHoldings(D: ControllerData | null, ms: string, handle: string): HoldingsModel {
  const items = sortedItems(heldBy(D, ms, handle)).map(({ kind, code, title, dueAt }) => ({ kind, code, title, dueAt }));
  const counts: Partial<Record<HoldingKind, number>> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return { handle, ms, items, counts };
}

const SAME_PERSON: [string, string] = ['Choose a successor other than the person who holds the items', 'Pilih penerus selain orang yang memegang item tersebut'];

/** The other systems of the snapshot that use a shared document (BR-22). */
function sharedIn(D: ControllerData, ms: string, item: SampleItem): string[] {
  if (!item.shared || item.mutate?.kind !== 'doc') return [];
  const id = item.mutate.id;
  return D.MS.filter((m) => m.id !== ms && (D.bundles?.[m.id]?.docs ?? []).some((d) => d.id === id && d.shared)).map((m) => m.id);
}

/** The BR-22 question of the api: the systems where the change applies too, by their short names. */
function sharedQuestion(D: ControllerData, others: readonly string[]): [string, string] {
  const codes = others.map((id) => D.MS.find((m) => m.id === id)?.short ?? id.toUpperCase()).sort((a, b) => a.localeCompare(b)).join(', ');
  return [`This change also applies to: ${codes}. Continue?`, `Perubahan ini juga berlaku untuk: ${codes}. Lanjutkan?`];
}

export function createSampleAdapter(getD: () => ControllerData | null, getDs: () => DataSource | null): HandoverAdapter {
  return {
    async holdings(ms, handle): Promise<Result<HoldingsModel>> {
      const D = getD();
      if (!D?.PEOPLE?.[handle]) return { ok: false, error: { status: 404, message: [`${handle} is not a member of this organisation`, `${handle} bukan anggota organisasi ini`] } };
      return { ok: true, data: sampleHoldings(D, ms, handle) };
    },
    async reassign(ms, handle, body: HoldingsReassign) {
      const D = getD();
      if (body.successor === handle) return { ok: false, error: { status: 422, slug: 'business-rule', message: SAME_PERSON, messageKey: 'holdings.same_person' } };
      if (!D?.PEOPLE?.[body.successor]) return { ok: false, error: { status: 400, slug: 'validation', message: ['Validation failed', 'Validasi gagal'], errors: [{ path: 'body.successor', message: 'Name a member' }] } };
      const kinds = body.kinds ?? KIND_ORDER;
      const items = heldBy(D, ms, handle).filter((i) => kinds.includes(i.kind));
      // BR-22 as the api answers it: records shared with other systems change there too, so the caller confirms first.
      const others = [...new Set(items.flatMap((i) => sharedIn(D, ms, i)))];
      if (others.length && body.confirm !== true) {
        const question = sharedQuestion(D, others);
        return { ok: false, error: { status: 409, slug: 'confirmation-required', rule: 'BR-22', message: question, detail: question[0] } };
      }
      const ds = getDs();
      const warnings: MoveWarning[] = [];
      const auditDay = D.MS.find((m) => m.id === ms)?.audit?.date ?? null;
      for (const item of items) {
        for (const system of [ms, ...sharedIn(D, ms, item)]) {
          moved[`${system}:${item.key}`] = body.successor;
          if (item.mutate && ds?.mutate) await ds.mutate(system, item.mutate.kind, item.mutate.id, { [item.mutate.field]: body.successor }).catch(() => undefined);
        }
        // BR-41 as the api answers it: a due date after the next audit stays, with a warning that names the record.
        if (item.dueAt && auditDay && item.dueAt > auditDay && item.kind !== 'activity') {
          warnings.push({ rule: 'BR-41', text: [`${item.code}: due after the next audit on ${auditDay}`, `${item.code}: jatuh tempo setelah audit berikutnya pada ${auditDay}`] });
        }
      }
      const name = (h: string) => D.PEOPLE[h]?.[0] ?? h;
      return {
        ok: true,
        data: {
          count: items.length,
          message: [`${items.length} items moved from ${name(handle)} to ${name(body.successor)}`, `${items.length} item dipindahkan dari ${name(handle)} ke ${name(body.successor)}`],
          warnings,
          changed: [ms, ...D.MS.map((m) => m.id).filter((id) => others.includes(id))],
        },
      };
    },
  };
}
