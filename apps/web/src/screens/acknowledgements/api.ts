// API adapter of "Policy read confirmations" (MILESTONE-3 M3-05, D.1, D.7) through the host's client (R-17): the
// requests of a system, one request (the person list comes only with `audit.pending.all`), a request by hand, reminders,
// close and file as evidence, the register CSV as a link the browser saves, and the read confirmation settings of a
// document (`documents.update` with the ETag of the snapshot ref and the BR-22 confirmation of a shared document).
import type {
  AcknowledgementPerson, AcknowledgementRequestDetail, AcknowledgementRequestItem, CommandResult as WireResult, RecordRef,
} from '@mscd/shared';
import type { ApiClient, ApiResult } from '../../data/api/ApiClient';
import type { ControllerData } from '../../data/types';
import { call, newIdempotencyKey } from '../api';
import type { AcknowledgementsAdapter, Outcome, PersonRow, RequestDetail, RequestRow, Result } from './model';
import { DEFAULT_SETTINGS, recordSettings, refusal, settingsBody } from './model';
import { ROUTES, pathOf } from './routes';
import { TEXT } from './text';

/** The row of the api's request item. */
export function fromItem(i: AcknowledgementRequestItem): RequestRow {
  return {
    id: i.id,
    ms: i.ms,
    document: { ...i.document },
    version: { ...i.version },
    status: i.status,
    audienceScope: i.audienceScope,
    audienceRoles: i.audienceRoles ? [...i.audienceRoles] : null,
    dueOn: i.dueOn,
    createdAt: i.createdAt,
    lastRemindedAt: i.lastRemindedAt,
    closedAt: i.closedAt,
    evidenceId: i.evidenceId,
    totals: { ...i.totals },
  };
}

export function fromPerson(p: AcknowledgementPerson): PersonRow {
  return {
    handle: p.person.handle,
    name: p.person.displayName,
    status: p.status,
    openedAt: p.openedAt,
    confirmedAt: p.confirmedAt,
    reminderCount: p.reminderCount,
    excusedReason: p.excusedReason,
    overdue: p.overdue,
  };
}

export function fromDetail(d: AcknowledgementRequestDetail): RequestDetail {
  return { ...fromItem(d), ...(d.people ? { people: d.people.map(fromPerson) } : {}) };
}

/** The outcome of a command: the systems to load again, the count, the message, the warnings and the data. */
export function outcomeOf(res: ApiResult<WireResult>): Result<Outcome> {
  if (!res.ok) return { ok: false, error: res.error };
  const body = (res.data ?? { ok: true, changed: [] }) as Partial<WireResult>;
  return {
    ok: true,
    data: {
      changed: Array.isArray(body.changed) ? [...body.changed] : [],
      ...(typeof body.count === 'number' ? { count: body.count } : {}),
      message: body.message ? [body.message[0], body.message[1]] : null,
      warnings: (body.warnings ?? []).map((w) => [w.messages.en, w.messages.id] as const),
      ...(body.data && typeof body.data === 'object' ? { data: body.data as Record<string, unknown> } : {}),
    },
  };
}

/**
 * Settings saved in this page session, by `<organisation>:<ms>:<code>`, until the snapshot carries them. The organisation
 * is part of the key because switching organisation keeps the page, and pack codes such as `isms:POL-01` repeat across
 * organisations.
 */
const saved = new Map<string, ReturnType<typeof settingsBody>>();

/** Forgets the settings saved in this page session (unit tests). */
export function resetSavedSettings(): void {
  saved.clear();
}

/**
 * The API adapter. `org` names the current organisation (the host context's); without it the snapshot's `me.org` is
 * used. With no organisation known, nothing saved in this page session is shown.
 */
export function createApiAdapter(client: ApiClient | null, getD: () => ControllerData | null, org?: () => string | null): AcknowledgementsAdapter {
  const refs = () => (getD() as unknown as { refs?: Record<string, RecordRef> } | null)?.refs ?? {};
  const ref = (key: string) => refs()[key] ?? null;
  const orgId = () => (org ? org() : null) ?? getD()?.me?.org?.id ?? null;
  const savedKey = (ms: string, code: string) => {
    const id = orgId();
    return id ? `${id}:${ms}:${code}` : null;
  };
  return {
    sample: false,

    async list(ms) {
      const res = await call<AcknowledgementRequestItem[]>(client, ROUTES.list, { params: { ms } });
      if (!res.ok) return { ok: false, error: res.error };
      if (!Array.isArray(res.data)) return refusal(res.status, TEXT.unexpected);
      return { ok: true, data: res.data.map(fromItem) };
    },

    async get(ms, id) {
      const res = await call<AcknowledgementRequestDetail>(client, ROUTES.get, { params: { ms, id } });
      return res.ok ? { ok: true, data: fromDetail(res.data) } : { ok: false, error: res.error };
    },

    async ask(ms, input) {
      const body = {
        documentId: input.documentId,
        audience: input.scope === 'roles' ? { scope: input.scope, roles: [...input.roles] } : { scope: input.scope },
        dueDays: input.dueDays,
      };
      return outcomeOf(await call<WireResult>(client, ROUTES.create, { params: { ms }, body, idempotencyKey: newIdempotencyKey() }));
    },

    async remind(ms, id) {
      return outcomeOf(await call<WireResult>(client, ROUTES.remind, { params: { ms, id } }));
    },

    async close(ms, id, evidenceId) {
      return outcomeOf(await call<WireResult>(client, ROUTES.close, { params: { ms, id }, body: evidenceId ? { evidenceId } : {} }));
    },

    async exportCsv(ms, request) {
      const day = new Date().toISOString().slice(0, 10);
      return { ok: true, data: { href: pathOf(ROUTES.export, { ms, id: request.id }), fileName: `read-confirmations-${request.document.code}-v${request.version.label}-${day}.csv` } };
    },

    async saveSettings(ms, code, settings, confirm) {
      const r = ref(`${ms}:doc:${code}`);
      if (!r) return refusal(404, TEXT.noRecord, { slug: 'not-found' });
      const body: Record<string, unknown> = { acknowledgement: settingsBody(settings) };
      if (confirm) body.confirm = true;
      const res = outcomeOf(await call<WireResult>(client, ROUTES.documentUpdate, { params: { ms, id: r.id }, body, ifMatch: r.etag ?? null }));
      if (res.ok) {
        for (const system of [ms, ...res.data.changed]) {
          const key = savedKey(system, code);
          if (key) saved.set(key, settingsBody(settings));
        }
      }
      return res;
    },

    settingsOf(ms, code, record) {
      const key = savedKey(ms, code);
      // The snapshot carries the `acknowledgement` member of a document whose settings differ from the defaults (M3-04),
      // so a document record without it has the default settings.
      return recordSettings(record) ?? (key ? saved.get(key) : undefined) ?? (record ? { ...DEFAULT_SETTINGS } : null);
    },

    documentId: (ms, code) => ref(`${ms}:doc:${code}`)?.id ?? null,
    evidenceId: (ms, code) => ref(`${ms}:ev:${code}`)?.id ?? null,
  };
}
