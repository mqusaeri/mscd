// The personal data checks of a system (Milestone 3 D.1, D.6.4), for its Management System Managers
// (`privacy_request.assist`): the checks of the system with the request type, the person, the due time and the status
// (open requests first; checks of a request closed before they were done are left out); the records of the system that
// name the person (mention search, at most 500); and the check marked done with a note, which completes the manager's
// stored task (audited `privacy_check.done`).
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, PrivacyCheckDone, PrivacyCheckItem, PrivacyMentions } from '@mscd/shared';
import { sql } from 'kysely';
import { NotFoundError } from '../../common/problems';
import { AUDIT_WRITER, RECORD_RESOLVER, type AuditWriter, type Principal, type RecordResolver, type Trx } from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { erasedJoin, shownHandle } from './pseudonym';
import { searchMentions } from './mention-search';
import { checkRef, conflict, isOpen, isUuid, orgOf } from './privacy-model';
import { REFUSALS } from './privacy-text';

interface CheckRow {
  id: string;
  status: 'open' | 'done';
  done_at: Date | null;
  request_id: string;
  request_no: string;
  request_type: PrivacyCheckItem['type'];
  request_status: 'received' | 'in_progress' | 'completed' | 'refused' | 'withdrawn';
  subject_kind: 'member' | 'other';
  subject_user_id: string | null;
  subject_name: string | null;
  subject_email: string | null;
  subject_handle: string | null;
  account_handle: string | null;
  due_at: Date;
}

@Injectable()
export class PrivacyChecksService {
  constructor(
    private readonly tenancy: TenantScope,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `GET /ms/{ms}/privacy-checks`. */
  async list(principal: Principal, ms: string): Promise<PrivacyCheckItem[]> {
    orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const rows = (await checkRows(trx, system.id, null)).filter((r) => isOpen(r.request_status) || r.status === 'done');
      rows.sort((a, b) => {
        const open = Number(b.status === 'open') - Number(a.status === 'open');
        if (open !== 0) return open;
        if (a.status === 'open') return new Date(a.due_at).getTime() - new Date(b.due_at).getTime() || a.request_no.localeCompare(b.request_no);
        return new Date(b.done_at ?? 0).getTime() - new Date(a.done_at ?? 0).getTime() || b.request_no.localeCompare(a.request_no);
      });
      return rows.map((r) => ({
        id: r.id,
        requestNo: r.request_no,
        type: r.request_type,
        subject: { name: r.subject_name ?? r.subject_handle ?? '', handle: r.subject_kind === 'member' ? r.subject_handle : null },
        dueAt: new Date(r.due_at).toISOString(),
        status: r.status,
        doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
      }));
    });
  }

  /** `GET /ms/{ms}/privacy-checks/{id}/mentions`: the records of the system that name the person of the check. */
  async mentions(principal: Principal, ms: string, id: string): Promise<PrivacyMentions> {
    orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      const row = await this.checkIn(trx, system.id, id);
      // The person's name and email as the request keeps them, and the handle of their account (not a pseudonym).
      return searchMentions(trx, system.id, [row.subject_name, row.subject_email, row.account_handle]);
    });
  }

  /** `POST /ms/{ms}/privacy-checks/{id}/done`. */
  async done(principal: Principal, ms: string, id: string, body: PrivacyCheckDone): Promise<CommandResult> {
    orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      if (isUuid(id)) await sql`select id from privacy_check where id = ${id}::uuid for update`.execute(trx);
      const row = await this.checkIn(trx, system.id, id);
      if (!isOpen(row.request_status)) throw conflict(REFUSALS.checkClosed);
      if (row.status === 'done') throw conflict(REFUSALS.checkDone);
      await trx
        .updateTable('privacy_check')
        .set({ status: 'done', done_by: actor, done_at: sql<Date>`now()`, note: body.note, updated_by: actor })
        .where('id', '=', row.id)
        .execute();
      await trx
        .updateTable('task')
        .set({ status: 'done', closed_by: actor, closed_at: sql<Date>`now()`, updated_by: actor })
        .where('source_rule', '=', 'privacy_check')
        .where('entity_type', '=', 'privacy_check')
        .where('entity_id', '=', row.id)
        .where('status', '=', 'open')
        .where('deleted_at', 'is', null)
        .execute();
      await this.audit.record(trx, {
        action: 'privacy_check.done',
        msId: system.id,
        entityType: 'privacy_check',
        entityId: row.id,
        entityCode: row.request_no,
        before: { status: 'open' },
        after: { status: 'done', note: body.note, request: row.request_no },
      });
      return {
        ok: true,
        changed: [system.slug],
        ref: checkRef(row.id, row.request_no),
        message: [`Check of ${row.request_no} marked done`, `Pemeriksaan ${row.request_no} ditandai selesai`],
      };
    });
  }

  /** The check `id` of the system; 404 when the system has none with that id. */
  private async checkIn(trx: Trx, msId: string, id: string): Promise<CheckRow> {
    if (!isUuid(id)) throw new NotFoundError();
    const [row] = await checkRows(trx, msId, id);
    if (!row) throw new NotFoundError('No such personal data check in this system');
    return row;
  }
}

/** The checks of a system (or one of them) with their request. */
async function checkRows(trx: Trx, msId: string, id: string | null): Promise<CheckRow[]> {
  const { rows } = await sql<CheckRow>`
    select c.id, c.status, c.done_at, r.id as request_id, r.request_no, r.request_type, r.status as request_status, r.subject_kind,
           r.subject_user_id, r.subject_name, r.subject_email, ${shownHandle('u', 'e')} as subject_handle,
           u.handle as account_handle,
           r.due_at
      from privacy_check c
      join privacy_request r on r.id = c.privacy_request_id and r.deleted_at is null
      left join platform.app_user u on u.id = r.subject_user_id
      ${erasedJoin('e', 'r.subject_user_id')}
     where c.management_system_id = ${msId}::uuid and c.deleted_at is null
       and (${id}::uuid is null or c.id = ${id}::uuid)
     order by r.due_at, r.request_no`.execute(trx);
  return rows;
}
