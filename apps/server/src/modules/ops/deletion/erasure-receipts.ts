// The erasure receipts of the worker (Milestone 3 D.6.5, M3-13 after ISO M4). An erasure writes its receipt into its
// request (`privacy_request.erasure_receipt`, privacy/erasure-receipt.ts) in the api; the api cannot read the audit
// anchor key, so the worker signs the receipt with it (as it signs the deletion certificate) and emails the signed file
// to every platform operator and every active Tenant Admin of the organisation (`erasure_receipt`, attached).
//
// When it runs, in single and in multi tenancy (an on-premise install has no hourly `org.lifecycle` schedule):
//   - the erasure queues an `org.lifecycle` run when it commits (privacy-erasure.service.ts), whose handler runs this
//     step first in both modes, so the receipt goes out within minutes;
//   - the daily `privacy.deadlines` run of each organisation runs it for that organisation (both modes);
//   - in multi tenancy the hourly `org.lifecycle` schedule runs it as well.
//
// A receipt is signed once (the signature and key id are stored) and marked sent when at least one recipient got it,
// or when the organisation has no recipient at all; when every send fails it is tried again in the next run (within
// the hour in multi tenancy, the next day in single tenancy). A failed send never fails the job. Without an anchor key
// nothing is signed and the job logs a warning each run.
//
// These runs can overlap (the worker works both queues at the same time), and a receipt is marked sent only after its
// emails went out. So one run at a time works the receipts of an organisation: a run holds a session advisory lock per
// organisation (class 7005, the key from its id) on one pinned connection, from the selection of the receipts until
// they are marked sent. A run that finds the lock held leaves that organisation to the run that holds it (`busy`). The
// lock ends with the connection if the process dies, and the receipts it had not marked sent go out in the next run.
// Operators without email fetch the signed receipts with `mscd-server tenant erasure --print-receipts <slug>`.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Clock } from '../../../common/clock';
import { localDate } from '../../../common/dates';
import { MscdConfig } from '../../../config/mscd-config';
import { DATABASE, type AppDatabase } from '../../../db/database.module';
import { inPlatformScope } from '../../identity/platform-scope';
import { loadAnchorSigningKey, type AnchorSigningKey } from '../../jobs/audit-verify-chain.job';
import { receiptFileName, receiptFileText, signReceipt, type ErasureReceipt } from '../../privacy/erasure-receipt';
import { TenantScope, systemContextOf } from '../../tenancy/tenant-scope';
import { DeletionMailer } from './deletion-mailer';
import { platformOperators, tenantAdminsOf } from './deletion-records';

/** What one run did (counts only). */
export interface ReceiptRunResult {
  signed: number;
  sent: number;
  /** Receipts whose every send failed (tried again next run). */
  failed: number;
  /** Receipts left unsigned because this process has no anchor key. */
  unsigned: number;
  /** Organisations left to another run that was sending their receipts at the same time. */
  busy: number;
}

/**
 * Class of the session advisory lock that lets one run at a time work the receipts of an organisation; the key is
 * `hashtext` of the organisation id. `org.purge` uses class 7003, the organisation export builds 7004.
 */
export const RECEIPT_LOCK_CLASS = 7005;

interface ReceiptOrg {
  id: string;
  slug: string;
  name: string;
  schema_name: string;
  time_zone: string;
}

interface PendingReceipt {
  id: string;
  request_no: string;
  erasure_receipt: ErasureReceipt;
  erasure_receipt_signature: string | null;
  erasure_receipt_key_id: string | null;
}

@Injectable()
export class ErasureReceiptSender {
  private readonly logger = new Logger('erasure-receipts');
  private key?: AnchorSigningKey | null;

  constructor(
    private readonly scope: TenantScope,
    private readonly config: MscdConfig,
    private readonly clock: Clock,
    private readonly mailer: DeletionMailer,
    @Inject(DATABASE) private readonly db: AppDatabase,
  ) {}

  /**
   * Signs and sends the receipts that are not sent yet, in every organisation that is not deleted, or only in the
   * organisation `orgId` (the daily `privacy.deadlines` run of that organisation).
   */
  async run(requestId?: string, orgId?: string): Promise<ReceiptRunResult> {
    const result: ReceiptRunResult = { signed: 0, sent: 0, failed: 0, unsigned: 0, busy: 0 };
    const orgs = await this.scope.withPlatform(
      async (trx) => {
        const only = orgId ? sql`and o.id = ${orgId}::uuid` : sql``;
        const { rows } = await sql<ReceiptOrg>`
          select o.id, o.slug, o.name, o.schema_name, o.time_zone from platform.organization o
           where o.deleted_at is null and o.status <> 'deleted' and to_regnamespace(o.schema_name) is not null ${only}
           order by o.position, o.slug`.execute(trx);
        return rows;
      },
      { scope: 'job', requestId },
    );
    for (const org of orgs) {
      try {
        await this.runOrg(org, result, requestId);
      } catch (error) {
        this.logger.error({ orgId: org.id }, `The erasure receipts of ${org.slug} could not be sent: ${(error as Error).message}`);
      }
    }
    if (result.unsigned > 0) {
      this.logger.warn(`${result.unsigned} erasure receipt(s) wait for a signature: this worker cannot read audit.anchor_key_file`);
    }
    return result;
  }

  /**
   * Works the receipts of one organisation while holding its receipt lock, so a receipt is never selected by two runs
   * before it is marked sent. A run that finds the lock held counts the organisation as `busy` and changes nothing.
   */
  private async runOrg(org: ReceiptOrg, result: ReceiptRunResult, requestId?: string): Promise<void> {
    // The session lock needs one pinned connection until the receipts are marked sent. The connection reads no table:
    // every query goes through withTenant or withPlatform (F.10).
    // eslint-disable-next-line no-restricted-syntax
    await this.db.connection().execute(async (conn) => {
      const { rows } = await sql<{ ok: boolean }>`select pg_try_advisory_lock(${RECEIPT_LOCK_CLASS}, hashtext(${org.id})) as ok`.execute(conn);
      if (!rows[0]?.ok) {
        result.busy += 1;
        this.logger.debug({ orgId: org.id }, `Another run sends the erasure receipts of ${org.slug}`);
        return;
      }
      try {
        await this.sendOrg(org, result, requestId);
      } finally {
        await sql`select pg_advisory_unlock(${RECEIPT_LOCK_CLASS}, hashtext(${org.id}))`.execute(conn).catch(() => undefined);
      }
    });
  }

  private async sendOrg(org: ReceiptOrg, result: ReceiptRunResult, requestId?: string): Promise<void> {
    const context = systemContextOf({ id: org.id, schema: org.schema_name }, requestId);
    const pending = await this.scope.withTenant(context, async (trx) => {
      const { rows } = await sql<PendingReceipt>`
        select id, request_no, erasure_receipt, erasure_receipt_signature, erasure_receipt_key_id from privacy_request
         where erasure_receipt is not null and erasure_receipt_sent_at is null and deleted_at is null
         order by created_at, id
         for update skip locked`.execute(trx);
      const key = rows.some((r) => !r.erasure_receipt_signature) ? this.signingKey() : null;
      for (const row of rows) {
        if (row.erasure_receipt_signature) continue;
        if (!key) {
          result.unsigned += 1;
          continue;
        }
        const signed = signReceipt(row.erasure_receipt, key);
        await trx
          .updateTable('privacy_request')
          .set({ erasure_receipt_signature: signed.signature, erasure_receipt_key_id: signed.keyId })
          .where('id', '=', row.id)
          .execute();
        row.erasure_receipt_signature = signed.signature;
        row.erasure_receipt_key_id = signed.keyId;
        result.signed += 1;
      }
      if (!rows.some((r) => r.erasure_receipt_signature)) return { rows: [], recipients: [] };
      const recipients = await inPlatformScope(trx, async () => [
        ...new Set([...(await platformOperators(trx)), ...(await tenantAdminsOf(trx, org.id))].map((r) => r.email)),
      ]);
      return { rows: rows.filter((r) => r.erasure_receipt_signature), recipients };
    });
    for (const row of pending.rows) {
      const receipt = row.erasure_receipt;
      const fileName = receiptFileName(receipt);
      const content = receiptFileText(receipt, row.erasure_receipt_signature!, row.erasure_receipt_key_id!);
      let sent = 0;
      for (const to of pending.recipients) {
        const ok = await this.mailer.send({
          to,
          template: {
            name: 'erasure_receipt',
            organisation: org.name,
            requestNo: row.request_no,
            erasedOn: localDate(new Date(receipt.erasedAt), org.time_zone),
            fileName,
          },
          attachment: { fileName, content, contentType: 'application/json' },
        });
        if (ok) sent += 1;
      }
      if (pending.recipients.length > 0 && sent === 0) {
        result.failed += 1;
        continue;
      }
      if (pending.recipients.length === 0) {
        this.logger.warn({ orgId: org.id }, `The erasure receipt of ${row.request_no} in ${org.slug} has no recipient: no platform operator and no active Tenant Admin`);
      }
      await this.scope.withTenant(context, (trx) =>
        trx.updateTable('privacy_request').set({ erasure_receipt_sent_at: this.clock.now() }).where('id', '=', row.id).execute());
      result.sent += 1;
    }
  }

  private signingKey(): AnchorSigningKey | null {
    if (this.key === undefined) {
      try {
        this.key = loadAnchorSigningKey(this.config);
      } catch (error) {
        this.logger.error(`The audit anchor key cannot be read: ${(error as Error).message}`);
        this.key = null;
      }
    }
    return this.key;
  }
}
