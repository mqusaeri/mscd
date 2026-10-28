// API adapter of the Registers screen (MILESTONE-2 M2-13): the register, metric value, treatment, residual acceptance
// and entity link routes of the risk-registers area through the host's client (R-17).
//
// The api has no list of a risk's treatments. They are chain records of the risk: the stage whose records are
// `risk_treatment` rows (its key differs per standard: `treatment` in ISO/IEC 27001, `action` in ISO 9001) is read
// with `readmodel.audit.stage-records`, and its records whose upstream names the risk are the treatments. Their
// pending action tells the open status (model.ts `statusFromAction`); a move made on screen is kept in this module per
// organisation, system and treatment (by the action text it expects), so the list shows the status the move gave until
// the record changes again. The stage key found for a system is kept per organisation and system: slugs are chosen per
// organisation, and switching organisation reloads the snapshot without a page reload.
import type {
  ApplicabilityTargetItem, CommandResult, Page, PendingRecord, RegisterItem, TreatmentStatus,
} from '@mscd/shared';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import type { ControllerData, MsId } from '../../data/types';
import { call, newIdempotencyKey } from '../api';
import type { PickedFile } from '../types';
import {
  KIND_DEFS, SEARCH_MAX, TREATMENT_ACTIONS, outcomeOf, proofHoldersOf, statusFromAction,
} from './model';
import type { MoveTarget, Outcome, ProofHolder, RegistersAdapter, Result, RowModel, TargetOption, TreatmentModel } from './model';
import { ROUTES } from './routes';

/** A row of `registers.list` as the screen keeps it. */
export function rowOf(item: RegisterItem): RowModel {
  const { ref, ...rest } = item;
  return { ...rest, id: ref.id, etag: ref.etag ?? null };
}

function command(res: ApiResult<CommandResult>): Result<Outcome> {
  return res.ok ? { ok: true, data: outcomeOf(res.data) } : { ok: false, error: res.error };
}

/** A move made on screen: the status it gave and who made it, kept while the record shows the expected action. */
interface Moved {
  status: TreatmentStatus;
  action: string | null;
  implementedBy: string | null;
}

/** Moves made on screen, by organisation, system and treatment (`scopeKey` and the treatment id). */
const MOVED = new Map<string, Moved>();
/** Integrity states of a pinned file that can still be verified (ApiDataSource `VERIFIABLE`). */
const VERIFIABLE: ReadonlySet<string> = new Set(['ok', 'nohash', 'pending']);
/** The key of the treatment stage, by organisation and system (`scopeKey`). */
const STAGE_OF = new Map<string, string>();

/** The key of a system in the module's maps: the same slug can name another system in another organisation. */
export function scopeKey(org: string, ms: MsId): string {
  return `${org}:${ms}`;
}

/** Forgets the moves and stage keys kept by the module (tests). */
export function resetApiRegisters(): void {
  MOVED.clear();
  STAGE_OF.clear();
}

/** A treatment of the stage records, with the status of a move made on screen in this organisation when the record still agrees. */
export function treatmentOf(org: string, ms: MsId, record: PendingRecord): TreatmentModel {
  const moved = MOVED.get(`${scopeKey(org, ms)}:${record.ref.id}`);
  const fresh = moved && moved.action === (record.action ?? null) ? moved : null;
  return {
    id: record.ref.id,
    code: record.ref.code,
    title: record.title,
    owner: record.holder?.handle ?? 'none',
    due: record.dueAt,
    target: record.downstream[0]?.id ?? null,
    status: fresh ? fresh.status : statusFromAction(record.action),
    etag: record.ref.etag ?? null,
    implementedBy: fresh ? fresh.implementedBy : null,
  };
}

export interface ApiScope {
  /** The controller's data of the latest render (stages, chain records and their refs, the evidence of each system). */
  getD(): ControllerData | null;
  /** The handle of the session person. */
  me(): string;
  /** The id of the current organisation (`ctx.org`); the module's maps are kept per organisation. */
  org(): string;
}

type Refs = Record<string, { entityType?: string; id?: string } | undefined>;

export function createApiAdapter(client: ApiClient | null, scope: ApiScope): RegistersAdapter {
  const refsOf = (): Refs => ((scope.getD() as unknown as { refs?: Refs } | null)?.refs ?? {});

  /** Every record of a chain stage, page after page (at most 10 pages of 200). */
  async function stageRecords(ms: MsId, key: string, pageSize = 200, pages = 10): Promise<Result<PendingRecord[]>> {
    const out: PendingRecord[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const res = await call<Page<PendingRecord>>(client, ROUTES.stageRecords, { params: { ms, key }, query: { page, pageSize } });
      if (!res.ok) return { ok: false, error: res.error };
      out.push(...res.data.items);
      if (page * pageSize >= res.data.total) break;
    }
    return { ok: true, data: out };
  }

  /** The key of the stage whose records are treatments: from an open treatment of the snapshot, else by reading each entity stage once. */
  async function treatmentStage(ms: MsId): Promise<Result<string | null>> {
    const key = scopeKey(scope.org(), ms);
    const known = STAGE_OF.get(key);
    if (known) return { ok: true, data: known };
    const D = scope.getD();
    const refs = refsOf();
    for (const [stage, records] of Object.entries(D?.X?.[ms] ?? {})) {
      if ((records ?? []).some((r) => refs[`${ms}:x:${r.id}`]?.entityType === 'risk_treatment')) {
        STAGE_OF.set(key, stage);
        return { ok: true, data: stage };
      }
    }
    for (const stage of D?.STAGES?.[ms] ?? []) {
      if (stage.src) continue;
      const res = await stageRecords(ms, stage.id, 1, 1);
      if (!res.ok) {
        if (res.error.status === 404) continue;
        return { ok: false, error: res.error };
      }
      if (res.data[0]?.ref.entityType === 'risk_treatment') {
        STAGE_OF.set(key, stage.id);
        return { ok: true, data: stage.id };
      }
    }
    return { ok: true, data: null };
  }

  /** Every treatment of the system: the `risk_treatment` records of the treatment stage. */
  async function treatmentRecords(ms: MsId): Promise<Result<PendingRecord[]>> {
    const stage = await treatmentStage(ms);
    if (!stage.ok) return stage;
    if (!stage.data) return { ok: true, data: [] };
    const records = await stageRecords(ms, stage.data);
    if (!records.ok) return records;
    return { ok: true, data: records.data.filter((r) => r.ref.entityType === 'risk_treatment') };
  }

  return {
    sample: false,
    async list(ms, kind, query) {
      const res = await call<Page<RegisterItem>>(client, ROUTES.list, {
        params: { ms, register: kind },
        query: { page: query.page, pageSize: query.pageSize, ...(query.q?.trim() ? { q: query.q.trim().slice(0, SEARCH_MAX) } : {}) },
      });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { items: res.data.items.map(rowOf), page: res.data.page, pageSize: res.data.pageSize, total: res.data.total } };
    },
    async create(ms, kind, body, idempotencyKey) {
      return command(await call<CommandResult>(client, ROUTES.create, { params: { ms, register: kind }, body, idempotencyKey }));
    },
    async update(ms, kind, row, patch) {
      return command(await call<CommandResult>(client, ROUTES.update, { params: { ms, register: kind, id: row.id }, body: patch, ifMatch: row.etag }));
    },
    async recordValue(ms, row, body, idempotencyKey) {
      return command(await call<CommandResult>(client, ROUTES.metricValue, { params: { ms, id: row.id }, body, idempotencyKey }));
    },
    async treatments(ms, risk) {
      const all = await treatmentRecords(ms);
      if (!all.ok) return all;
      return { ok: true, data: all.data.filter((r) => r.upstream.some((u) => u.id === risk.code)).map((r) => treatmentOf(scope.org(), ms, r)) };
    },
    async treatmentCodes(ms) {
      const all = await treatmentRecords(ms);
      return all.ok ? { ok: true, data: all.data.map((r) => r.ref.code) } : all;
    },
    async addTreatment(ms, risk, body, idempotencyKey) {
      const res = command(await call<CommandResult>(client, ROUTES.treatmentCreate, { params: { ms, id: risk.id }, body, idempotencyKey }));
      // The new treatment is open (proposed) and in the snapshot after the reload, which names its stage.
      if (res.ok) STAGE_OF.delete(scopeKey(scope.org(), ms));
      return res;
    },
    async moveTreatment(ms, _risk, treatment, to: MoveTarget) {
      const res = command(await call<CommandResult>(client, ROUTES.treatmentTransition, { params: { ms, id: treatment.id }, body: { to }, ifMatch: treatment.etag }));
      if (res.ok) {
        MOVED.set(`${scopeKey(scope.org(), ms)}:${treatment.id}`, { status: to, action: TREATMENT_ACTIONS[to], implementedBy: to === 'implemented' ? scope.me() : treatment.implementedBy });
      }
      return res;
    },
    async acceptResidual(ms, risk, body, idempotencyKey) {
      const res = command(await call<CommandResult>(client, ROUTES.residualAcceptance, { params: { ms, id: risk.id }, body, idempotencyKey }));
      if (res.ok && body.treatmentId) MOVED.set(`${scopeKey(scope.org(), ms)}:${body.treatmentId}`, { status: 'residual_accepted', action: null, implementedBy: null });
      return res;
    },
    async link(ms, kind, row, target, note) {
      const def = KIND_DEFS[kind];
      if (def.linkByCode) {
        const body = { entityType: def.entity, entityCode: row.code, ...(note.trim() ? { relevanceNote: note.trim() } : {}) };
        return command(await call<CommandResult>(client, ROUTES.entityLinkCreate, { params: { ms: target }, body, idempotencyKey: newIdempotencyKey() }));
      }
      // A competence record has no code to link by; its systems change through `linkedMs` (BR-22 confirmed on screen).
      return command(await call<CommandResult>(client, ROUTES.update, {
        params: { ms, register: kind, id: row.id }, body: { linkedMs: [...row.ms, target], confirm: true }, ifMatch: row.etag,
      }));
    },
    async targets(ms) {
      const res = await call<ApplicabilityTargetItem[]>(client, ROUTES.targets, { params: { ms } });
      if (!res.ok) return { ok: false, error: res.error };
      const list: TargetOption[] = res.data.filter((t) => !t.retired).map((t) => ({ kind: t.kind, code: t.code, title: t.title }));
      return { ok: true, data: list };
    },
    proofHolders(ms): ProofHolder[] {
      const refs = refsOf();
      return proofHoldersOf(scope.getD()?.bundles?.[ms]?.evs ?? [], (code) => refs[`${ms}:ev:${code}`]?.id ?? '');
    },
    async attachProof(ms, holder, file: PickedFile) {
      // A record whose pinned file can no longer be verified takes the new file as a relink (as the evidence drawer does).
      const integ = scope.getD()?.bundles?.[ms]?.evs?.find((e) => e.code === holder.code)?.integ;
      const mode = integ && !VERIFIABLE.has(integ) ? 'relink' : 'submit';
      const body = file.source === 'link'
        ? { source: 'link', repository: file.repository, externalItemId: file.externalItemId, mode }
        : { source: 'upload', uploadIntentId: file.uploadIntentId, mode };
      const res = await call<CommandResult>(client, ROUTES.evidenceFiles, { params: { ms, id: holder.id }, body, idempotencyKey: newIdempotencyKey() });
      if (!res.ok) return { ok: false, error: res.error };
      const data = (res.data.data ?? {}) as { storageObjectId?: string };
      if (!data.storageObjectId) return { ok: false, error: { status: 0, message: ['The file was attached but the server did not name it.', 'Berkas dilampirkan tetapi server tidak menyebutkannya.'] } };
      return { ok: true, data: { storageObjectId: data.storageObjectId, fileName: file.fileName } };
    },
    async openProof(ms, row) {
      if (!row.proofObjectId) return { ok: true, data: null };
      const res = await call<{ url: string }>(client, ROUTES.objectOpen, { params: { id: row.proofObjectId }, query: { ms } });
      return res.ok ? { ok: true, data: res.data.url } : { ok: false, error: res.error };
    },
  };
}
