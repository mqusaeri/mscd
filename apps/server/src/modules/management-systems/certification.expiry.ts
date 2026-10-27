// `certificate.expiry` (Milestone 2 J.3, D.4): daily per organisation. A certified cycle whose certificate expires in
// 90, 30 or 7 days gets one `certificate_expiring` notification per tier for each MS Manager and Programme Owner of
// the system (a run that missed a day sends the tier the date now falls in, once); a certified cycle whose
// certificate expiry date has passed moves to `expired` (audited `certification_cycle.expired`, actor system) and the
// system shows "Certificate expired". Idempotent: a second run on the same day changes nothing.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { diffDays, fmtDay } from '../../common/dates';
import { AUDIT_WRITER, NOTIFICATION_WRITER, SYSTEM_USER_ID, type AuditWriter, type NotificationWriter, type Trx } from '../../common/tokens';
import { EXPIRY_NOTICE_DAYS, refreshCertificateLabel, setCycle } from './certification.cycles';

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, kind: 'system' as const };

export interface CertificateExpiryResult {
  today: string;
  /** Notifications written by this run, with the tier of each cycle that got any. */
  notified: number;
  notices: { cycleId: string; msId: string; tier: number; days: number; recipients: number }[];
  /** Cycles moved to `expired` by this run. */
  expired: { cycleId: string; msId: string }[];
}

/** The notice title of one tier: names the system code and the tier, so one notice exists per cycle, person and tier. */
export function expiryNoticeTitle(systemCode: string, tier: number): { en: string; id: string } {
  return { en: `${systemCode} certificate expires within ${tier} days`, id: `Sertifikat ${systemCode} berakhir dalam ${tier} hari` };
}

/** The tier of a certificate that expires in `days` days: the smallest of 90, 30 and 7 that is not below it, else null. */
export function expiryTier(days: number): number | null {
  if (days < 0) return null;
  const tiers = [...EXPIRY_NOTICE_DAYS].sort((a, b) => a - b);
  return tiers.find((t) => days <= t) ?? null;
}

interface CertifiedRow {
  id: string;
  management_system_id: string;
  code: string;
  slug: string;
  certificate_no: string | null;
  certification_body: string | null;
  certificate_expires_at: string;
  cycle_start: string;
  cycle_end: string;
}

@Injectable()
export class CertificateExpiryService {
  private readonly logger = new Logger('certificate.expiry');

  constructor(
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(NOTIFICATION_WRITER) private readonly notifications: NotificationWriter,
  ) {}

  /** One run in the organisation's transaction (as the system user) for the organisation's local date `today`. */
  async run(trx: Trx, today: string): Promise<CertificateExpiryResult> {
    const { rows } = await sql<CertifiedRow>`
      select c.id, c.management_system_id, m.code, m.slug, c.certificate_no, c.certification_body, c.certificate_expires_at::text,
             c.cycle_start, c.cycle_end
        from certification_cycle c
        join management_system m on m.id = c.management_system_id and m.deleted_at is null
       where c.deleted_at is null and c.status = 'certified' and c.certificate_expires_at is not null
       order by m.position, m.slug, c.cycle_start
       for update of c`.execute(trx);
    const result: CertificateExpiryResult = { today, notified: 0, notices: [], expired: [] };
    for (const cycle of rows) {
      const days = diffDays(today, cycle.certificate_expires_at);
      if (days < 0) {
        await setCycle(trx, cycle.id, { status: 'expired' }, SYSTEM_USER_ID);
        await this.audit.record(trx, {
          action: 'certification_cycle.expired',
          actor: SYSTEM_ACTOR,
          msId: cycle.management_system_id,
          entityType: 'certification_cycle',
          entityId: cycle.id,
          entityCode: `${cycle.cycle_start}/${cycle.cycle_end}`,
          before: { status: 'certified' },
          after: { status: 'expired', certificate_expires_at: cycle.certificate_expires_at, ...(cycle.certificate_no ? { certificate_no: cycle.certificate_no } : {}) },
        });
        await refreshCertificateLabel(trx, cycle.management_system_id);
        result.expired.push({ cycleId: cycle.id, msId: cycle.management_system_id });
        continue;
      }
      const tier = expiryTier(days);
      if (tier === null) continue;
      const recipients = await this.recipients(trx, cycle.management_system_id);
      const title = expiryNoticeTitle(cycle.code, tier);
      const no = cycle.certificate_no ? ` ${cycle.certificate_no}` : '';
      const body = {
        en: `Certificate${no} of ${cycle.code} expires on ${fmtDay(cycle.certificate_expires_at, 'en')}, in ${days} days. Hold the recertification audit before that date.`,
        id: `Sertifikat${no} untuk ${cycle.code} berakhir pada ${fmtDay(cycle.certificate_expires_at, 'id')}, dalam ${days} hari. Lakukan audit resertifikasi sebelum tanggal tersebut.`,
      };
      let sent = 0;
      for (const userId of recipients) {
        const { rows: existing } = await sql<{ id: string }>`
          select id from notification
           where kind = 'certificate_expiring' and recipient_user_id = ${userId} and entity_ref ->> 'id' = ${cycle.id} and title_en = ${title.en}
           limit 1`.execute(trx);
        if (existing.length > 0) continue;
        const created = await this.notifications.create(trx, {
          recipientUserId: userId,
          kind: 'certificate_expiring',
          msId: cycle.management_system_id,
          title,
          body,
          ref: { module: 'audit', entityType: 'certification_cycle', id: cycle.id, code: `${cycle.cycle_start}/${cycle.cycle_end}` },
          createdBy: SYSTEM_USER_ID,
        });
        if (created) sent += 1;
      }
      result.notified += sent;
      if (sent > 0) result.notices.push({ cycleId: cycle.id, msId: cycle.management_system_id, tier, days, recipients: sent });
    }
    this.logger.log({ today, notified: result.notified, expired: result.expired.length }, 'certificate.expiry done');
    return result;
  }

  /** Active MS Managers and Programme Owners of a system (D.4). */
  private async recipients(trx: Trx, msId: string): Promise<string[]> {
    const { rows } = await sql<{ user_id: string }>`
      select distinct user_id from user_ms_role
       where management_system_id = ${msId} and role in ('ms_manager', 'programme_owner') and approval_status = 'active'
         and deleted_at is null and (valid_until is null or valid_until > now())
       order by user_id`.execute(trx);
    return rows.map((r) => r.user_id);
  }
}
