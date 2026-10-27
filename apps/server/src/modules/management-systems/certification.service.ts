// Certification cycles and the certificate record of a system (Milestone 2 D.1, D.4, J.8, M2-05):
// - `GET /ms/{ms}/certification-cycles`: the cycles, newest first, with dates, certificate, audit events and items;
// - `POST /ms/{ms}/certification-cycles`: start a cycle with its cycle items, or activate the planned one;
// - `POST /ms/{ms}/certification`: record the certificate after a stage2 or recertification audit that recommended
//   certification; the cycle and the system move to `certified`, a previous certified cycle to `closed`;
// - `POST /ms/{ms}/certification-cycles/{id}/transitions`: the manual moves of the certification body's decisions
//   (suspend, reinstate, withdraw) and closing an active cycle, each with a reason; `If-Match` with the cycle's ETag
//   from the list (R-18).
// The certificate label of the read model follows the newest cycle that holds a certificate (`refreshCertificateLabel`).
import { Inject, Injectable } from '@nestjs/common';
import {
  transitionsVia,
  type CertificationCycleCreate,
  type CertificationCycleItem,
  type CertificationRecord,
  type CommandResult,
  type CycleTransitionRequest,
  type RecordRef,
} from '@mscd/shared';
import { sql } from 'kysely';
import { Clock } from '../../common/clock';
import { assertIfMatch, etagOf } from '../../common/etag';
import { ConflictError, NotFoundError, ProblemError, TransitionNotAllowedError, ValidationError } from '../../common/problems';
import { AUDIT_WRITER, RECORD_RESOLVER, type AuditWriter, type MsRef, type Principal, type RecordResolver, type Trx } from '../../common/tokens';
import { TenantScope, tenantContextOf } from '../tenancy/tenant-scope';
import {
  RECOMMENDED_OUTCOMES, cycleOf, openCycleOf, refreshCertificateLabel, setCycle, startCycle, threeYearsAfter, type CycleRow, type CycleSystem,
} from './certification.cycles';

const CYCLE = 'certification_cycle.status' as const;

/** A record ref of a certification cycle (module `audit`, code `<start>/<end>`). */
export function cycleRef(cycle: Pick<CycleRow, 'id' | 'cycle_start' | 'cycle_end'>, updatedAt: Date): RecordRef {
  return { module: 'audit', entityType: 'certification_cycle', id: cycle.id, code: `${cycle.cycle_start}/${cycle.cycle_end}`, etag: etagOf(updatedAt) };
}

function result(slug: string, ref: RecordRef, message?: [string, string], data?: unknown): CommandResult {
  return { ok: true, changed: [slug], ...(message ? { message } : {}), ref, ...(data !== undefined ? { data } : {}) };
}

function unprocessable(messageKey: string, en: string, id: string): ProblemError {
  return new ProblemError('business-rule', { messageKey, messages: { en, id }, detail: en });
}

@Injectable()
export class CertificationService {
  constructor(
    private readonly tenancy: TenantScope,
    private readonly clock: Clock,
    @Inject(RECORD_RESOLVER) private readonly records: RecordResolver,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  private today(principal: Principal): string {
    if (!principal.org) throw new NotFoundError('No organisation is selected');
    return this.clock.todayIn(principal.org.timeZone);
  }

  /** The path system with its edition, locked for update when a command changes it. */
  private async system(trx: Trx, ms: string, forUpdate = false): Promise<CycleSystem & { status: string; scope: string; certificationBody: string | null }> {
    const ref: MsRef = await this.records.resolveMs(trx, ms);
    const { rows } = await sql<{ framework_version_id: string; status: string; scope_statement: string; certification_body: string | null }>`
      select framework_version_id, status, scope_statement, certification_body from management_system
       where id = ${ref.id} ${forUpdate ? sql`for update` : sql``}`.execute(trx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Unknown management system');
    return {
      id: ref.id, slug: ref.slug, frameworkVersionId: row.framework_version_id, status: row.status, scope: row.scope_statement, certificationBody: row.certification_body,
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // GET /ms/{ms}/certification-cycles
  // -------------------------------------------------------------------------------------------------------------

  list(principal: Principal, ms: string): Promise<CertificationCycleItem[]> {
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.records.resolveMs(trx, ms);
      // Events carry the scope and the report id of an internal audit (D.2); the report's code and title stay out, since
      // the scope policy decides who sees that document.
      const { rows } = await sql<CycleRow & {
        events: {
          id: string; event_type: CertificationCycleItem['events'][number]['eventType']; short_label: string; scheduled_at: string; outcome: string | null;
          scope_text: string | null; report_document_id: string | null;
        }[] | null;
        total: number;
        done: number;
      }>`
        select c.id, c.status, c.cycle_start, c.cycle_end, c.certified_at, c.certificate_no, c.certificate_expires_at, c.certification_body,
               c.certified_scope, c.created_at, c.updated_at,
               (select json_agg(json_build_object('id', e.id, 'event_type', e.event_type, 'short_label', e.short_label,
                                                  'scheduled_at', e.scheduled_at, 'outcome', e.outcome, 'scope_text', e.scope_text,
                                                  'report_document_id', e.report_document_id) order by e.scheduled_at, e.id)
                  from audit_event e where e.certification_cycle_id = c.id and e.deleted_at is null) as events,
               (select count(*)::int from cycle_requirement_status s where s.certification_cycle_id = c.id and s.deleted_at is null) as total,
               (select count(*)::int from cycle_requirement_status s where s.certification_cycle_id = c.id and s.deleted_at is null and s.status = 'done') as done
          from certification_cycle c
         where c.management_system_id = ${system.id} and c.deleted_at is null
         order by c.cycle_start desc, c.created_at desc`.execute(trx);
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        cycleStart: r.cycle_start,
        cycleEnd: r.cycle_end,
        certificateNo: r.certificate_no,
        certifiedAt: r.certified_at,
        certificateExpiresAt: r.certificate_expires_at,
        certificationBody: r.certification_body,
        certifiedScope: r.certified_scope,
        events: (r.events ?? []).map((e) => ({
          id: e.id,
          eventType: e.event_type,
          shortLabel: e.short_label,
          scheduledAt: e.scheduled_at,
          outcome: (e.outcome ?? null) as CertificationCycleItem['events'][number]['outcome'],
          scopeText: e.scope_text ?? null,
          reportDocumentId: e.report_document_id ?? null,
        })),
        items: { total: r.total, done: r.done },
        etag: etagOf(r.updated_at),
      }));
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/certification-cycles
  // -------------------------------------------------------------------------------------------------------------

  create(principal: Principal, ms: string, body: CertificationCycleCreate): Promise<CommandResult> {
    const actor = principal.user.id;
    const today = this.today(principal);
    const cycleEnd = body.cycleEnd ?? threeYearsAfter(body.cycleStart);
    if (cycleEnd <= body.cycleStart) throw new ValidationError([{ path: 'body.cycleEnd', message: 'The cycle must end after it starts' }]);
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms, true);
      if (system.status === 'archived') {
        throw new ConflictError('An archived system starts no certification cycle', { messageKey: 'certification.system_archived' });
      }
      const started = await startCycle(trx, this.audit, {
        system, cycleStart: body.cycleStart, cycleEnd, keepPlannedDates: false, today, actor, trigger: { kind: 'route' },
      });
      const message: [string, string] = started.activated
        ? [`Certification cycle started (the planned cycle), ${started.items.length} cycle items added`, `Siklus sertifikasi dimulai (siklus yang direncanakan), ${started.items.length} butir siklus ditambahkan`]
        : [`Certification cycle started, ${started.items.length} cycle items added`, `Siklus sertifikasi dimulai, ${started.items.length} butir siklus ditambahkan`];
      return {
        ...result(system.slug, cycleRef({ id: started.cycleId, cycle_start: started.cycleStart, cycle_end: started.cycleEnd }, started.updatedAt), message, {
          activated: started.activated, items: started.items, linkedEvents: started.linkedEvents,
        }),
        count: started.items.length,
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/certification
  // -------------------------------------------------------------------------------------------------------------

  certify(principal: Principal, ms: string, body: CertificationRecord): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms, true);
      // D.4: the first certificate (implementing) or a recertification (certified); other statuses do not take one.
      if (system.status !== 'implementing' && system.status !== 'certified') throw new TransitionNotAllowedError(system.status, 'certified');
      const cycle = await openCycleOf(trx, system.id, true);
      if (!cycle || cycle.status !== 'active') {
        throw new ConflictError('The system has no active certification cycle to certify', { messageKey: 'certification.no_active_cycle' });
      }
      if (transitionsVia(CYCLE, cycle.status, 'certified', 'ms.certification').length === 0) throw new TransitionNotAllowedError(cycle.status, 'certified');
      const { rows: events } = await sql<{ id: string; short_label: string; event_type: string; outcome: string | null }>`
        select id, short_label, event_type, outcome from audit_event
         where certification_cycle_id = ${cycle.id} and deleted_at is null and event_type in ('stage2', 'recertification')
         order by scheduled_at desc, id`.execute(trx);
      const recommending = events.find((e) => e.outcome !== null && RECOMMENDED_OUTCOMES.has(e.outcome));
      if (!recommending) {
        throw unprocessable(
          'certification.no_recommendation',
          'A certificate needs a Stage 2 or recertification audit of this cycle with outcome recommended or recommended with conditions',
          'Sertifikat memerlukan audit Tahap 2 atau resertifikasi pada siklus ini dengan hasil direkomendasikan atau direkomendasikan dengan syarat',
        );
      }
      const scope = body.certifiedScope ?? system.scope;
      const updatedAt = await setCycle(trx, cycle.id, {
        status: 'certified', certificate_no: body.certificateNo, certified_at: body.issuedAt, certificate_expires_at: body.expiresAt,
        certification_body: body.certificationBody, certified_scope: scope,
      }, actor);

      // The previous certificate ends when the next cycle is certified (D.4 recertification).
      const { rows: previous } = await sql<{ id: string; cycle_start: string; cycle_end: string; certificate_no: string | null }>`
        select id, cycle_start, cycle_end, certificate_no from certification_cycle
         where management_system_id = ${system.id} and deleted_at is null and status = 'certified' and id <> ${cycle.id}
         for update`.execute(trx);
      for (const old of previous) {
        await setCycle(trx, old.id, { status: 'closed' }, actor);
        await this.audit.record(trx, {
          action: 'certification_cycle.closed',
          msId: system.id,
          entityType: 'certification_cycle',
          entityId: old.id,
          entityCode: `${old.cycle_start}/${old.cycle_end}`,
          before: { status: 'certified' },
          after: { status: 'closed', reason: 'next_cycle_certified', next_cycle: cycle.id, ...(old.certificate_no ? { certificate_no: old.certificate_no } : {}) },
        });
      }

      const before: Record<string, unknown> = { status: system.status, cycle_status: 'active' };
      const after: Record<string, unknown> = {
        status: 'certified', cycle_status: 'certified', cycle_id: cycle.id, certificate_no: body.certificateNo, issued_at: body.issuedAt,
        expires_at: body.expiresAt, certification_body: body.certificationBody, certified_scope: scope, audit_event: recommending.short_label,
        outcome: recommending.outcome,
      };
      const systemSet: Record<string, unknown> = {};
      if (system.status !== 'certified') systemSet.status = 'certified';
      if (system.certificationBody !== body.certificationBody) {
        systemSet.certification_body = body.certificationBody;
        before.certification_body = system.certificationBody;
      }
      if (Object.keys(systemSet).length > 0) {
        await trx.updateTable('management_system').set({ ...systemSet, updated_by: actor, updated_at: sql<Date>`greatest(clock_timestamp(), updated_at + interval '1 millisecond')` }).where('id', '=', system.id).execute();
      }
      const label = await refreshCertificateLabel(trx, system.id);
      if (label) after.certificate_label = label[0];
      await this.audit.record(trx, {
        action: 'ms.certified', msId: system.id, entityType: 'management_system', entityId: system.id, entityCode: system.slug, before, after,
      });
      return result(
        system.slug,
        cycleRef(cycle, updatedAt),
        [`Certificate ${body.certificateNo} recorded; the system is certified`, `Sertifikat ${body.certificateNo} dicatat; sistem tersertifikasi`],
        { closedCycles: previous.map((p) => p.id) },
      );
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // POST /ms/{ms}/certification-cycles/{id}/transitions
  // -------------------------------------------------------------------------------------------------------------

  transition(principal: Principal, ms: string, id: string, body: CycleTransitionRequest, ifMatch?: string): Promise<CommandResult> {
    const actor = principal.user.id;
    return this.tenancy.withTenant(tenantContextOf(principal), async (trx) => {
      const system = await this.system(trx, ms, true);
      const cycle = await cycleOf(trx, system.id, id, true);
      if (!cycle) throw new NotFoundError('Unknown certification cycle');
      assertIfMatch(ifMatch, cycle.updated_at, cycleRef(cycle, cycle.updated_at));
      // Only the rows of this route (J.8): certified to suspended, suspended to certified or withdrawn, active to closed.
      if (transitionsVia(CYCLE, cycle.status, body.to, 'ms.cycles.transition').length === 0) throw new TransitionNotAllowedError(cycle.status, body.to);
      if (body.to === 'certified') {
        // A reinstatement never gives a system two certified cycles (a newer certificate replaced this one).
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from certification_cycle
           where management_system_id = ${system.id} and deleted_at is null and status = 'certified' and id <> ${cycle.id}`.execute(trx);
        if ((rows[0]?.n ?? 0) > 0) {
          throw new ConflictError('A newer certificate of this system is in force, so this one cannot be reinstated', { messageKey: 'certification.newer_certificate' });
        }
      }
      const updatedAt = await setCycle(trx, cycle.id, { status: body.to }, actor);
      const label = await refreshCertificateLabel(trx, system.id);
      await this.audit.record(trx, {
        action: 'certification_cycle.transitioned',
        msId: system.id,
        entityType: 'certification_cycle',
        entityId: cycle.id,
        entityCode: `${cycle.cycle_start}/${cycle.cycle_end}`,
        before: { status: cycle.status },
        after: { status: body.to, reason: body.reason, ...(cycle.certificate_no ? { certificate_no: cycle.certificate_no } : {}), ...(label ? { certificate_label: label[0] } : {}) },
      });
      const messages: Record<CycleTransitionRequest['to'], [string, string]> = {
        suspended: ['Certificate suspended', 'Sertifikat dibekukan'],
        certified: ['Certificate reinstated', 'Sertifikat dipulihkan'],
        withdrawn: ['Certificate withdrawn', 'Sertifikat dicabut'],
        closed: ['Certification cycle closed', 'Siklus sertifikasi ditutup'],
      };
      return result(system.slug, cycleRef(cycle, updatedAt), messages[body.to]);
    });
  }
}
