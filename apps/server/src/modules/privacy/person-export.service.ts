// The export of one person's data (Milestone 3 D.1, D.6.3): `exports.person.create` for the person of an access request
// in progress (a Tenant Admin, `privacy_request.manage`), and `exports.me.create` for the caller themselves. Both queue
// `export.build` for an `export_file` of kind `personal_data` in format `json` (ExportsService.queuePersonalData) and
// answer 202 with the task id; the file is downloaded with `exports.download` by the one who queued it. A person erased
// in this organisation gets no export (409 `privacy.already_erased`).
import { Injectable } from '@nestjs/common';
import type { CommandResult } from '@mscd/shared';
import type { Principal } from '../../common/tokens';
import { ExportsService } from '../exports/exports.service';
import { erasedInOrganisation } from '../exports/personal-data';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { conflict, isOpen, orgOf, refusal, requestRef, requestRow } from './privacy-model';
import { memberFacts } from './privacy-requests.service';
import { REFUSALS } from './privacy-text';

@Injectable()
export class PersonExportService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly exports: ExportsService,
  ) {}

  /** `POST /admin/privacy-requests/{id}/export` (202). */
  async forRequest(principal: Principal, id: string): Promise<CommandResult> {
    orgOf(principal);
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const row = await requestRow(trx, id, { forUpdate: true });
      if (!isOpen(row.status)) throw conflict(REFUSALS.closed);
      if (row.request_type !== 'access') throw conflict(REFUSALS.wrongType);
      if (row.status !== 'in_progress') throw conflict(REFUSALS.startFirst);
      if (row.subject_kind !== 'member' || !row.subject_user_id) throw conflict(REFUSALS.noAccount);
      // A person erased in this organisation (D.6.5) has no data here to copy; `export.build` refuses it too.
      if (await erasedInOrganisation(trx, row.subject_user_id)) throw conflict(REFUSALS.alreadyErased);
      const taskId = await this.exports.queuePersonalData(trx, principal, { subjectUserId: row.subject_user_id, privacyRequestId: row.id, code: row.request_no });
      const result = { ...(row.result ?? {}), exportsQueued: (row.result?.exportsQueued ?? 0) + 1 };
      await trx.updateTable('privacy_request').set({ result: JSON.stringify(result), handled_by: actor, updated_by: actor }).where('id', '=', row.id).execute();
      return {
        ok: true,
        changed: [],
        taskId,
        ref: requestRef(row.id, row.request_no),
        message: [
          `Export of the person's data for ${row.request_no} queued; you will get a link when it is ready`,
          `Ekspor data orang tersebut untuk ${row.request_no} dalam antrean; Anda akan menerima tautan setelah siap`,
        ],
      };
    });
  }

  /** `POST /me/data-export` (202). */
  async forMe(principal: Principal): Promise<CommandResult> {
    const org = orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const member = await memberFacts(trx, org.id, principal.user.id);
      if (!member) throw refusal(REFUSALS.notMemberSelf);
      const taskId = await this.exports.queuePersonalData(trx, principal, { subjectUserId: principal.user.id, privacyRequestId: null, code: member.handle });
      return {
        ok: true,
        changed: [],
        taskId,
        message: ['Export of your data queued; you will get a link when it is ready', 'Ekspor data Anda dalam antrean; Anda akan menerima tautan setelah siap'],
      };
    });
  }
}
