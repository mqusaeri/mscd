// A person's own requests, profile corrections and data export (Milestone 3 D.1, D.6.1, D.6.6, H.6). The routes need an
// active session only; every action works on the caller's own account in the current organisation:
// - `me.privacy-requests.list`: the caller's requests here, with status and due time;
// - `me.privacy-requests.create`: ask for a correction, a restriction or an erasure (channel `self_service`); the Tenant
//   Admins get `privacy_request_received`, and an erasure opens the system checks as any erasure does (D.6.4);
// - `me.profile`: correct one's own display name and job title, also on an account shared with other organisations
//   (audited `user.updated`);
// - `exports.me.create` and `exports.person.create`: queue a personal data export (see person-export.service.ts).
import { Inject, Injectable } from '@nestjs/common';
import type { CommandResult, MyPrivacyRequestCreate, MyPrivacyRequestItem, MyProfilePatch } from '@mscd/shared';
import { Clock } from '../../common/clock';
import { AUDIT_WRITER, type AuditWriter, type Principal } from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import { conflict, isOpen, myRequestItem, orgOf, refusal, requestRef, requestRows } from './privacy-model';
import { memberFacts, PrivacyRequestsService } from './privacy-requests.service';
import { REFUSALS } from './privacy-text';

@Injectable()
export class MePrivacyService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    private readonly requests: PrivacyRequestsService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /** `GET /me/privacy-requests`. */
  async list(principal: Principal): Promise<MyPrivacyRequestItem[]> {
    orgOf(principal);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => (await requestRows(trx, { subjectUserId: principal.user.id })).map(myRequestItem));
  }

  /** `POST /me/privacy-requests` (201). */
  async create(principal: Principal, body: MyPrivacyRequestCreate): Promise<CommandResult> {
    const org = orgOf(principal);
    const userId = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const member = await memberFacts(trx, org.id, userId);
      if (!member || member.membershipStatus !== 'active') throw refusal(REFUSALS.notMemberSelf);
      const open = (await requestRows(trx, { subjectUserId: userId })).some((r) => r.request_type === body.type && isOpen(r.status));
      if (open) throw conflict(REFUSALS.openRequest);
      const opened = await this.requests.openRequest(trx, org, {
        type: body.type,
        subject: { kind: 'member', userId, name: member.name, email: member.email },
        channel: 'self_service',
        receivedAt: this.clock.now(),
        note: body.note ?? null,
        actorId: userId,
      });
      return {
        ok: true,
        changed: [],
        ref: requestRef(opened.id, opened.requestNo),
        data: { id: opened.id, requestNo: opened.requestNo, dueAt: opened.dueAt.toISOString() },
        message: [
          `Request ${opened.requestNo} sent. The organisation answers it by the due time.`,
          `Permintaan ${opened.requestNo} terkirim. Organisasi akan menjawabnya sebelum batas waktu.`,
        ],
      };
    });
  }

  /** `PATCH /me/profile` (204): the caller's own display name and job title. */
  async profile(principal: Principal, body: MyProfilePatch): Promise<void> {
    const org = orgOf(principal);
    const userId = principal.user.id;
    await this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const user = await trx.selectFrom('platform.app_user').select(['handle', 'display_name', 'job_title']).where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
      const changes: { display_name?: string; job_title?: string | null } = {};
      if (body.displayName !== undefined && body.displayName !== user.display_name) changes.display_name = body.displayName;
      if (body.jobTitle !== undefined && (body.jobTitle || null) !== user.job_title) changes.job_title = body.jobTitle || null;
      if (Object.keys(changes).length === 0) return;
      await trx.updateTable('platform.app_user').set({ ...changes, updated_by: userId }).where('id', '=', userId).execute();
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (changes.display_name !== undefined) [before.displayName, after.displayName] = [user.display_name, changes.display_name];
      if (changes.job_title !== undefined) [before.jobTitle, after.jobTitle] = [user.job_title, changes.job_title];
      await this.audit.record(trx, {
        action: 'user.updated',
        organizationId: org.id,
        entityType: 'user',
        entityId: userId,
        entityCode: user.handle,
        before,
        after: { ...after, source: 'my_account' },
      });
    });
  }
}
