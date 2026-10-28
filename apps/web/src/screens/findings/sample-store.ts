// Sample state of the audit register screens (MILESTONE-2 M2-14, C.6): the findings, corrective actions,
// self-assessment, certification cycles, internal audits and their activities of each sample organisation, built once
// per organisation from the sample snapshot (the certification findings of `PAST`, the open and major counts of
// `MS.findings`, the audit events of `EVENTS`, the requirements of the bundles) and a few sample rows the snapshot
// does not hold (corrective actions, assessments, internal audits). Changes stay for the browser session, per
// organisation. Imported only by the sample adapters (`findings/sample.ts`, `internal-audit/sample.ts`), which the
// sample build loads through a dynamic import, so the api build holds none of it (R-13).
import type { ControllerData, MsId } from '../../data/types';
import type { ActionModel, Classification, FindingModel, SelfRow, TargetOption } from './model';

/** A certification cycle of the sample (the api's `ms.cycles.list`). */
export interface SampleCycle {
  id: string;
  ms: MsId;
  status: 'planned' | 'active' | 'certified';
  cycleStart: string;
  cycleEnd: string;
}

/** An audit event of the sample: the internal audits of this package and the certification audits of `EVENTS`. */
export interface SampleEvent {
  id: string;
  ms: MsId;
  cycleId: string | null;
  eventType: string;
  nameEn: string;
  nameId: string;
  shortLabel: string;
  scheduledAt: string;
  auditDays: number | null;
  leadAuditor: string | null;
  scopeText: string | null;
  reportDocumentId: string | null;
  outcomeSummary: string | null;
}

export interface SampleActivity {
  id: string;
  ms: MsId;
  eventId: string;
  templateCode: string | null;
  title: string;
  clauseRef: string | null;
  keyQuestions: string | null;
  evidenceToRequest: string | null;
  auditee: string | null;
  auditor: string | null;
  targetCode: string | null;
  scheduledAt: string | null;
  status: 'planned' | 'done' | 'cancelled';
  note: string | null;
}

/** A registered document of type record that can be an audit report. */
export interface SampleRecord {
  id: string;
  ms: MsId;
  code: string;
  title: string;
}

export interface SampleFinding extends FindingModel {
  ms: MsId;
  closeNote: string | null;
}

export interface SampleAction extends ActionModel {
  ms: MsId;
}

export interface SampleSelf extends SelfRow {
  ms: MsId;
}

export interface OrgState {
  cycles: SampleCycle[];
  events: SampleEvent[];
  activities: SampleActivity[];
  records: SampleRecord[];
  findings: SampleFinding[];
  actions: SampleAction[];
  self: SampleSelf[];
}

const STATES = new Map<string, OrgState>();
let sequence = 0;

/** Forgets every organisation's changes (tests). */
export function resetSampleAudit(): void {
  STATES.clear();
  sequence = 0;
}

/** A new sample id. */
export function nextSampleId(kind: string): string {
  sequence += 1;
  return `sample-${kind}-${sequence}`;
}

/** The sample organisation: its id, else the systems of the snapshot (each organisation runs its own list). */
export function sampleOrgKey(D: ControllerData | null, orgId?: string | null): string {
  return orgId || (D?.MS ?? []).map((m) => m.id).sort().join(',');
}

/** The state of the organisation, built from the snapshot on first use. */
export function orgState(D: ControllerData | null, orgId?: string | null): OrgState {
  const key = sampleOrgKey(D, orgId);
  let state = STATES.get(key);
  if (!state) {
    state = seed(D);
    STATES.set(key, state);
  }
  return state;
}

// ---------------------------------------------------------------------------------------------------------------
// Clauses, controls and templates of the sample
// ---------------------------------------------------------------------------------------------------------------

/** The clause rows 4 to 10 of ISO/IEC 27001:2022 (the sample bundle lists the Annex A controls only). */
export const ISMS_CLAUSES: readonly [string, string][] = [
  ['4.1', 'Understanding the organization and its context'], ['4.2', 'Needs and expectations of interested parties'], ['4.3', 'Scope of the management system'],
  ['4.4', 'Management system and its processes'], ['5.1', 'Leadership and commitment'], ['5.2', 'Policy'], ['5.3', 'Roles, responsibilities and authorities'],
  ['6.1', 'Actions to address risks and opportunities'], ['6.1.1', 'Actions to address risks and opportunities: general'], ['6.1.2', 'Information security risk assessment'],
  ['6.1.3', 'Information security risk treatment'], ['6.2', 'Objectives and planning to achieve them'], ['6.3', 'Planning of changes'], ['7.1', 'Resources'],
  ['7.2', 'Competence'], ['7.3', 'Awareness'], ['7.4', 'Communication'], ['7.5', 'Documented information'], ['7.5.1', 'Documented information: general'],
  ['7.5.2', 'Creating and updating documented information'], ['7.5.3', 'Control of documented information'], ['8.1', 'Operational planning and control'],
  ['8.2', 'Information security risk assessment'], ['8.3', 'Information security risk treatment'], ['9.1', 'Monitoring, measurement, analysis and evaluation'],
  ['9.2', 'Internal audit'], ['9.2.1', 'Internal audit: general'], ['9.2.2', 'Internal audit programme'], ['9.3', 'Management review'], ['9.3.1', 'Management review: general'],
  ['9.3.2', 'Management review inputs'], ['9.3.3', 'Management review results'], ['10.1', 'Continual improvement'], ['10.2', 'Nonconformity and corrective action'],
];

/** The clause and control targets of a system: the clause rows and every control of the edition. */
export function sampleTargets(D: ControllerData | null, ms: MsId): TargetOption[] {
  const reqs = D?.bundles?.[ms]?.reqs ?? [];
  const clauses: TargetOption[] = ms === 'isms'
    ? ISMS_CLAUSES.map(([code, title]) => ({ code, title, kind: 'requirement' }))
    : reqs.filter((r) => /^Cl\./.test(r.id)).map((r) => ({ code: r.id.replace(/^Cl\.\s*/, ''), title: r.title, kind: 'requirement' }));
  const controls: TargetOption[] = reqs.filter((r) => !/^Cl\./.test(r.id)).map((r) => ({ code: r.id, title: r.title, kind: 'catalogue_item' }));
  return [...clauses, ...controls];
}

/** Applicable controls of a system (an entry that is not marked not applicable). */
export function applicableControls(D: ControllerData | null, ms: MsId): TargetOption[] {
  return (D?.bundles?.[ms]?.reqs ?? []).filter((r) => !/^Cl\./.test(r.id) && r.st !== 'na').map((r) => ({ code: r.id, title: r.title, kind: 'catalogue_item' }));
}

/** Internal audit activity templates of the sample: one activity per clause group, as a pack would list them. */
export function internalAuditTemplates(ms: MsId): { code: string; clauseRef: string; title: string; keyQuestions: string; evidenceToRequest: string }[] {
  const ncClause = ms === 'bcms' ? '10.1' : '10.2';
  return [
    { code: 'IA-01', clauseRef: '4.3', title: 'Check the scope and the context', keyQuestions: 'Are the scope, its boundaries and the issues of the context documented and current?', evidenceToRequest: 'Scope statement; register of context issues and interested parties' },
    { code: 'IA-02', clauseRef: '5.2', title: 'Review the policy and leadership commitment', keyQuestions: 'Is the policy approved, communicated and understood by the people interviewed?', evidenceToRequest: 'Approved policy; communication records' },
    { code: 'IA-03', clauseRef: '6.1', title: 'Review risks and opportunities', keyQuestions: 'Is the risk method followed, and do the treatment decisions trace to the risks?', evidenceToRequest: 'Risk method; risk register; treatment plan' },
    { code: 'IA-04', clauseRef: '7.5', title: 'Sample documented information', keyQuestions: 'Are the sampled documents approved, current and available where they are used?', evidenceToRequest: 'Document register; three sampled documents with their approval' },
    { code: 'IA-05', clauseRef: '8.1', title: 'Sample operational controls', keyQuestions: 'Do the sampled operations run as planned, with records that show it?', evidenceToRequest: 'Operating records of the sampled processes' },
    { code: 'IA-06', clauseRef: '9.1', title: 'Review monitoring and measurement', keyQuestions: 'Are the metrics measured on time and evaluated against their targets?', evidenceToRequest: 'Measurement report of the last period' },
    { code: 'IA-07', clauseRef: '9.3', title: 'Check the last management review', keyQuestions: 'Did the last review cover every mandatory input and record its decisions?', evidenceToRequest: 'Minutes of the last management review' },
    { code: 'IA-08', clauseRef: ncClause, title: 'Check nonconformities and corrective actions', keyQuestions: 'Are root causes analysed, and was the effectiveness of closed actions checked?', evidenceToRequest: 'Corrective action records with their effectiveness checks' },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// The seed of an organisation
// ---------------------------------------------------------------------------------------------------------------

const CLASS_OF_LABEL: Readonly<Record<string, Classification>> = { Major: 'major', Minor: 'minor', OFI: 'ofi' };

/** Internal audit findings that bring the open and major counts to the sample's `MS.findings`, as the demo seed does. */
const INTERNAL_FINDINGS: readonly { title: string; clause: Record<string, string> }[] = [
  { title: 'Risk treatment plan not approved by every risk owner', clause: { isms: '6.1.3', qms: '6.1', bcms: '8.2.3', abms: '4.5' } },
  { title: 'Access review records incomplete for two in-scope systems', clause: { isms: 'A.5.18', qms: '7.5', bcms: '7.5', abms: '7.5' } },
  { title: 'Competence records missing for new hires', clause: { isms: '7.2', qms: '7.2', bcms: '7.2', abms: '7.2' } },
  { title: 'Monitoring results not analysed this quarter', clause: { isms: '9.1', qms: '9.1', bcms: '9.1', abms: '9.1' } },
];

/** Internal audits of the sample systems with the cycle they belong to. */
const CYCLES: Readonly<Record<string, Omit<SampleCycle, 'ms' | 'id'>>> = {
  isms: { status: 'certified', cycleStart: '2025-03-14', cycleEnd: '2028-03-13' },
  qms: { status: 'certified', cycleStart: '2023-06-22', cycleEnd: '2026-12-31' },
  bcms: { status: 'planned', cycleStart: '2026-07-01', cycleEnd: '2029-06-30' },
};

interface AuditSeed {
  key: string;
  nameEn: string;
  nameId: string;
  shortLabel: string;
  scheduledAt: string;
  auditDays: number;
  scopeText: string;
  report: { code: string; title: string } | null;
  outcomeSummary: string | null;
  /** Activities done or planned: template code, target, auditor, auditee, status. */
  activities: [string, string | null, string | null, string | null, 'planned' | 'done'][];
}

const AUDITS: Readonly<Record<string, AuditSeed[]>> = {
  isms: [
    {
      key: 'ia-2025', nameEn: 'Internal audit 2025', nameId: 'Audit internal 2025', shortLabel: 'IA 2025', scheduledAt: '2025-11-10', auditDays: 2,
      scopeText: 'Clauses 4 to 10 and Annex A themes 5 and 8, Jakarta office', report: { code: 'REC-IA-2025', title: 'Internal audit report 2025' },
      outcomeSummary: 'Two minor nonconformities, both closed with checked corrective actions; one opportunity for improvement.',
      activities: [['IA-01', '4.3', 'maya', 'rina', 'done'], ['IA-03', '6.1.2', 'maya', 'rina', 'done'], ['IA-04', '7.5.3', 'maya', 'rina', 'done'], ['IA-06', '9.1', 'maya', 'rina', 'done'], ['IA-05', 'A.8.13', 'maya', 'bagus', 'done']],
    },
    {
      key: 'ia-2026', nameEn: 'Internal audit 2026', nameId: 'Audit internal 2026', shortLabel: 'IA 2026', scheduledAt: '2026-09-14', auditDays: 2,
      scopeText: 'Clauses 4 to 10 and Annex A themes 5 to 8, Jakarta and Surabaya', report: null, outcomeSummary: null,
      activities: [['IA-01', '4.3', 'maya', 'rina', 'done'], ['IA-02', '5.2', 'maya', 'hendra', 'done'], ['IA-03', '6.1.3', 'maya', 'rina', 'done'], ['IA-04', 'A.5.18', 'maya', 'bagus', 'done'], ['IA-07', '9.3', 'maya', 'hendra', 'planned'], ['IA-08', '10.2', null, 'rina', 'planned']],
    },
  ],
  qms: [
    {
      key: 'ia-2025', nameEn: 'Internal audit 2025', nameId: 'Audit internal 2025', shortLabel: 'IA 2025', scheduledAt: '2025-05-20', auditDays: 2,
      scopeText: 'All QMS processes of software development and support', report: { code: 'REC-Q-IA-2025', title: 'QMS internal audit report 2025' },
      outcomeSummary: 'One minor nonconformity on supplier re-evaluation.',
      activities: [['IA-01', '4.3', 'maya', 'sari', 'done'], ['IA-05', '8.4', 'maya', 'andi', 'done'], ['IA-08', '10.2', 'maya', 'sari', 'done']],
    },
    {
      key: 'ia-2026', nameEn: 'Internal audit against the 2026 edition', nameId: 'Audit internal terhadap edisi 2026', shortLabel: 'IA 2026', scheduledAt: '2026-11-14', auditDays: 2,
      scopeText: 'The QMS against the requirements of ISO 9001:2026', report: null, outcomeSummary: null, activities: [],
    },
  ],
  bcms: [
    {
      key: 'ia-2027', nameEn: 'Internal audit of the BCMS', nameId: 'Audit internal SMKB', shortLabel: 'IA BCMS', scheduledAt: '2027-01-25', auditDays: 1,
      scopeText: 'BCMS clauses 4 to 10 before the Stage 1 audit', report: null, outcomeSummary: null, activities: [],
    },
  ],
};

/** Corrective actions of the sample findings: finding code, action and its state. */
const ACTIONS: Readonly<Record<string, (Omit<SampleAction, 'id' | 'ms' | 'findings' | 'etag'> & { finding: string })[]>> = {
  isms: [
    {
      finding: 'NC-2025-01', code: 'CA-2025-01', title: 'Remove obsolete procedure versions from the intranet', status: 'closed', owner: 'rina', dueAt: '2025-08-31',
      correctionText: 'Withdrew the obsolete version from the intranet', rcaText: 'Publishing a new version did not archive the old one', systemicCheckText: 'Checked every procedure page on the intranet', actionText: 'Publishing now archives the previous version automatically',
      implementedAt: '2025-07-30', implementedBy: 'rina', verifiedAt: '2025-08-12', verifiedBy: 'maya', effective: true,
    },
    {
      finding: 'NC-2025-02', code: 'CA-2025-02', title: 'Automate critical patch deployment', status: 'effectiveness_verification', owner: 'bagus', dueAt: '2026-10-20',
      correctionText: 'Patched the three hosts', rcaText: 'Patches were scheduled by hand and missed the SLA window', systemicCheckText: 'Reviewed every hypervisor and server group for the same gap', actionText: 'Weekly automated patch window with an SLA report',
      implementedAt: '2026-08-30', implementedBy: 'bagus', verifiedAt: null, verifiedBy: null, effective: null,
    },
  ],
  qms: [
    {
      finding: 'NC-2025-03', code: 'CA-2025-03', title: 'Plan supplier re-evaluations in the procurement calendar', status: 'rca', owner: 'andi', dueAt: '2026-11-01',
      correctionText: 'Re-evaluated the two suppliers', rcaText: null, systemicCheckText: null, actionText: null,
      implementedAt: null, implementedBy: null, verifiedAt: null, verifiedBy: null, effective: null,
    },
  ],
};

/** Root cause texts of the sample findings that have them. */
const FINDING_TEXTS: Readonly<Record<string, { rcaText: string; systemicCheckText: string }>> = {
  'NC-2025-01': { rcaText: 'Publishing a new version did not archive the old one', systemicCheckText: 'Checked every procedure page on the intranet' },
  'NC-2025-02': { rcaText: 'Patches were scheduled by hand and missed the SLA window', systemicCheckText: 'Reviewed every hypervisor and server group for the same gap' },
};

/** Finding conditions of ISO/IEC 27001:2022 with the sample's assessments. */
const CONDITIONS: readonly [string, Classification, string, string, SelfRow['status'], string | null, string | null, string | null, string[]][] = [
  ['FC-01', 'major', '8.2', 'No information security risk assessment performed for the scope', 'conforming', null, null, 'Risk assessment 2026 approved', []],
  ['FC-02', 'major', '9.2', 'Internal audit programme not carried out within the cycle', 'conforming', null, null, 'Internal audits 2025 and 2026 held', []],
  ['FC-03', 'minor', '6.1', 'Control decision in the Statement of Applicability without a risk-based justification', 'not_assessed', null, null, null, []],
  ['FC-04', 'minor', '7.5', 'Controlled document used after its review date', 'gap', 'bagus', '2026-10-31', 'PRC-07 and REG-03 are past their review date', []],
  ['FC-05', 'minor', '10.2', 'Corrective action closed without an effectiveness check', 'not_assessed', null, null, null, []],
  ['FC-06', 'ofi', '9.1', 'Performance metrics without target values', 'conforming', null, null, 'Targets added in measurement plan v2', []],
];

/** The target code of a free-text clause reference: the last part that is a clause or control of the system. */
function targetOfClause(targets: readonly TargetOption[], clause: string): string | null {
  const parts = clause.split('/').map((p) => p.trim()).reverse();
  return parts.find((p) => targets.some((t) => t.code === p)) ?? null;
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function seed(D: ControllerData | null): OrgState {
  const state: OrgState = { cycles: [], events: [], activities: [], records: [], findings: [], actions: [], self: [] };
  const today = D?.TODAY_S ?? new Date().toISOString().slice(0, 10);
  let internalNumber = 0;
  for (const ms of D?.MS ?? []) {
    const cycleDef = CYCLES[ms.id];
    const cycle: SampleCycle | null = cycleDef ? { id: `cycle-${ms.id}`, ms: ms.id, ...cycleDef } : null;
    if (cycle) state.cycles.push(cycle);

    // The certification audit events of the snapshot, so a finding can name one.
    (D?.EVENTS?.[ms.id] ?? []).forEach((e, i) => {
      const name = Array.isArray(e.t) ? e.t : [String(e.t), String(e.t)];
      const short = e.short ? (Array.isArray(e.short) ? e.short[0] : String(e.short)) : name[0];
      state.events.push({
        id: `event-${ms.id}-${i + 1}`, ms: ms.id, cycleId: cycle && e.d >= cycle.cycleStart && e.d <= cycle.cycleEnd ? cycle.id : null, eventType: 'certification',
        nameEn: name[0], nameId: name[1], shortLabel: short, scheduledAt: e.d, auditDays: e.days ?? null, leadAuditor: null, scopeText: null,
        reportDocumentId: null, outcomeSummary: e.result ? (Array.isArray(e.result) ? e.result[0] : String(e.result)) : null,
      });
    });

    // Internal audits, their activities and reports.
    const templates = internalAuditTemplates(ms.id);
    for (const audit of AUDITS[ms.id] ?? []) {
      const eventId = `ia-${ms.id}-${audit.key}`;
      let reportId: string | null = null;
      if (audit.report) {
        reportId = `record-${ms.id}-${audit.report.code}`;
        state.records.push({ id: reportId, ms: ms.id, code: audit.report.code, title: audit.report.title });
      }
      state.events.push({
        id: eventId, ms: ms.id, cycleId: cycle?.id ?? null, eventType: 'internal_audit', nameEn: audit.nameEn, nameId: audit.nameId, shortLabel: audit.shortLabel,
        scheduledAt: audit.scheduledAt, auditDays: audit.auditDays, leadAuditor: D?.PEOPLE?.maya?.[0] ?? 'Maya Putri', scopeText: audit.scopeText,
        reportDocumentId: reportId, outcomeSummary: audit.outcomeSummary,
      });
      audit.activities.forEach(([code, target, auditor, auditee, status], i) => {
        const t = templates.find((x) => x.code === code)!;
        state.activities.push({
          id: `${eventId}-${code}`, ms: ms.id, eventId, templateCode: t.code, title: t.title, clauseRef: t.clauseRef, keyQuestions: t.keyQuestions,
          evidenceToRequest: t.evidenceToRequest, auditee, auditor, targetCode: target, scheduledAt: status === 'done' ? addDays(audit.scheduledAt, i < 3 ? 0 : 1) : addDays(audit.scheduledAt, 1),
          status, note: null,
        });
      });
    }

    // Certification findings of PAST, then internal audit findings up to the sample's open and major counts.
    const targets = sampleTargets(D, ms.id);
    const pastEvents = state.events.filter((e) => e.ms === ms.id && e.eventType === 'certification' && e.scheduledAt < today).sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
    const latest = pastEvents[0] ?? null;
    const owner = ms.mgr;
    for (const [code, label, clause, title, st, note] of D?.PAST?.[ms.id] ?? []) {
      const classification = CLASS_OF_LABEL[label] ?? 'minor';
      const raisedAt = latest?.scheduledAt ?? today;
      state.findings.push({
        id: `finding-${ms.id}-${code}`, ms: ms.id, code, title, classification, source: 'certification_audit', clauseRef: clause,
        targetCode: targetOfClause(targets, clause), status: st === 'closed' ? 'closed' : 'open', owner, raisedAt, dueAt: st === 'closed' ? null : addDays(today, 21),
        auditEvent: latest ? { id: latest.id, shortLabel: latest.shortLabel } : null, actions: [], etag: null,
        rcaText: FINDING_TEXTS[code]?.rcaText ?? null, systemicCheckText: FINDING_TEXTS[code]?.systemicCheckText ?? null, statusNote: note || null,
        closeNote: st === 'closed' ? note || null : null,
      });
    }
    const openPast = state.findings.filter((f) => f.ms === ms.id && f.status !== 'closed');
    const needMajor = Math.max(0, ms.findings.major - openPast.filter((f) => f.classification === 'major').length);
    const needOpen = Math.max(0, ms.findings.open - openPast.length);
    const heldAudit = state.events.find((e) => e.ms === ms.id && e.eventType === 'internal_audit' && e.scheduledAt < today && e.scheduledAt >= addDays(today, -30)) ?? null;
    for (let i = 0; i < needOpen; i++) {
      internalNumber += 1;
      const text = INTERNAL_FINDINGS[(internalNumber - 1) % INTERNAL_FINDINGS.length];
      const clause = text.clause[ms.id] ?? null;
      state.findings.push({
        id: `finding-${ms.id}-ia-${internalNumber}`, ms: ms.id, code: `IA-2026-${String(internalNumber).padStart(2, '0')}`, title: text.title,
        classification: i < needMajor ? 'major' : 'minor', source: 'internal_audit', clauseRef: clause, targetCode: clause ? targetOfClause(targets, clause) : null,
        status: 'open', owner, raisedAt: addDays(today, -14), dueAt: addDays(today, 45), auditEvent: heldAudit ? { id: heldAudit.id, shortLabel: heldAudit.shortLabel } : null,
        actions: [], etag: null, rcaText: null, systemicCheckText: null, statusNote: null, closeNote: null,
      });
    }

    for (const a of ACTIONS[ms.id] ?? []) {
      const finding = state.findings.find((f) => f.ms === ms.id && f.code === a.finding);
      if (!finding) continue;
      const { finding: _code, ...rest } = a;
      const action: SampleAction = { ...rest, id: `action-${ms.id}-${a.code}`, ms: ms.id, findings: [{ id: finding.id, code: finding.code }], etag: null };
      state.actions.push(action);
    }

    if (ms.id === 'isms') {
      for (const [code, classification, req, text, status, saOwner, target, note, evidence] of CONDITIONS) {
        state.self.push({
          id: status === 'not_assessed' ? null : `self-${ms.id}-${code}`, ms: ms.id, conditionCode: code, classification, requirementCode: req, text, status,
          owner: saOwner, targetFixAt: target, note, assessedAt: status === 'not_assessed' ? null : addDays(today, -20), evidence, findingCode: null,
        });
      }
    }
  }
  return state;
}

/** The findings of a system with the corrective actions that name them (computed, so a change shows everywhere). */
export function findingsOf(state: OrgState, ms: MsId): SampleFinding[] {
  return state.findings
    .filter((f) => f.ms === ms)
    .map((f) => ({ ...f, actions: state.actions.filter((a) => a.findings.some((x) => x.id === f.id)).map((a) => ({ id: a.id, code: a.code, status: a.status })) }));
}
