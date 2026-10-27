// Management system card and header fields (build plan G.5 `MS[]`, G.4 stored display values, TS 9.4, UI 1.2).
// Milestone 2 (D.3, D.4, D.6, M2-05): a clause readiness value is null until `readiness.recompute` computes it (the
// web shows "Not computed yet"), and a system with computed rows carries their four dimensions (`readiness`); seeded
// and manual rows (the demo) give the Milestone 1 fields unchanged. The certificate label comes from the newest cycle
// that holds a certificate: from the cycles the loader passes in, with a certificate past its expiry date shown as
// expired before `certificate.expiry` moves it; without them, from the stored display value that the certification
// commands and `certificate.expiry` keep in step with that cycle. A system that never held a certificate shows its
// stored label, else "Not yet certified".
import type { AlertTone, ClauseReadiness, ManagementSystem, MsAlertKind, Pair, StorageAdapter, StorageMode, Text } from '@mscd/shared';
import { fmtDay } from '../../../common/dates';
import { routingModeLabel } from '../../storage';
import type { AuditEventRow } from './audit';
import { hasStoredDimensions, storedReadiness, type ReadinessValue } from './overview';
import { NONE } from './text';

/** A framework version a system uses (`ref.framework_version` with its framework). */
export interface VersionInfo {
  id: string;
  frameworkCode: string;
  frameworkName: string;
  edition: string;
  packId: string;
  packVersion: string;
  status: 'current' | 'transition' | 'withdrawn';
  preRelease: boolean;
  applicabilityTarget: 'catalogue_item' | 'requirement';
  installedAt: Date;
}

/** Pack labels of a version by key, as `[en, id]` (the Indonesian text falls back to the English one). */
export type PackLabels = Readonly<Record<string, Pair | undefined>>;

/** An open `ms_alert` row. */
export interface AlertRow {
  kind: MsAlertKind;
  tone: AlertTone;
  textEn: string;
  textId: string;
  raisedAt: Date;
}

export interface MsFieldsInput {
  slug: string;
  /** `management_system.code` (`ISMS`). */
  code: string;
  scope: string;
  certificationBody: string | null;
  color: string;
  /** `management_system.display` (G.4). */
  display: Readonly<Record<string, unknown>>;
  active: VersionInfo;
  target: VersionInfo | null;
  labels: PackLabels;
  /** Handle of the primary MS Manager (active grant), null when there is none. */
  primaryManager: string | null;
  nextEvent: AuditEventRow | null;
  /**
   * Readiness per clause group 4 to 10 (`clause_readiness`): the percentage (null until computed), or the stored row
   * with its four dimensions and `computedAt` (Milestone 2 D.6).
   */
  readiness: ReadonlyMap<number, ReadinessValue>;
  findings: { open: number; major: number };
  alerts: readonly AlertRow[];
  defaultRepository: { slug: string; adapter: StorageAdapter };
  /** Mode of the system's active default routing rule (classification and object kind empty). */
  defaultRoutingMode: StorageMode | null;
  /** Approver of the system's own documents (the controller's per-system approver literal, UI 2.14). */
  approver: string | null;
  /** Certification cycles with their certificate, newest first (Milestone 2 D.4); the stored label is used without them. */
  cycles?: readonly CertificateCycle[];
  /** The organisation's date: a certified cycle past its expiry date shows as expired (D.4). */
  today?: string;
}

/** What the certificate label reads of a certification cycle (Milestone 2 D.4). */
export interface CertificateCycle {
  status: 'planned' | 'active' | 'certified' | 'suspended' | 'withdrawn' | 'expired' | 'closed';
  cycleStart: string;
  cycleEnd: string;
  certifiedAt: string | null;
  certificateExpiresAt: string | null;
}

/** Statuses of a cycle that holds a certificate (D.4); a closed cycle was replaced by the next one. */
const CERTIFICATE_STATUSES: ReadonlySet<string> = new Set(['certified', 'suspended', 'withdrawn', 'expired']);

/**
 * The certificate label (G.5 `MS.cert`) of a cycle that holds a certificate: "Certified <issue date>, cycle <issue
 * year>–<expiry year>", or the state of a suspended, withdrawn or expired certificate (D.4); null for any other cycle.
 * A certified cycle whose expiry date is before `today` is shown as expired.
 */
export function certificateLabelOf(cycle: CertificateCycle, today?: string): Pair | null {
  const expired = cycle.status === 'expired' || (cycle.status === 'certified' && !!today && !!cycle.certificateExpiresAt && cycle.certificateExpiresAt < today);
  if (expired) return ['Certificate expired', 'Sertifikat kedaluwarsa'];
  switch (cycle.status) {
    case 'certified': {
      const issued = cycle.certifiedAt ?? cycle.cycleStart;
      const from = issued.slice(0, 4);
      const to = (cycle.certificateExpiresAt ?? cycle.cycleEnd).slice(0, 4);
      return [`Certified ${fmtDay(issued, 'en')}, cycle ${from}\u2013${to}`, `Tersertifikasi ${fmtDay(issued, 'id')}, siklus ${from}\u2013${to}`];
    }
    case 'suspended':
      return ['Certificate suspended', 'Sertifikat dibekukan'];
    case 'withdrawn':
      return ['Certificate withdrawn', 'Sertifikat dicabut'];
    default:
      return null;
  }
}

/** The newest cycle of a list that holds a certificate (by issue date, then cycle start), or undefined. */
export function newestCertificate<C extends CertificateCycle>(cycles: readonly C[]): C | undefined {
  return [...cycles]
    .filter((c) => CERTIFICATE_STATUSES.has(c.status))
    .sort((a, b) => (b.certifiedAt ?? b.cycleStart).localeCompare(a.certifiedAt ?? a.cycleStart) || b.cycleStart.localeCompare(a.cycleStart))[0];
}

/** `MS.cert`: the label of the newest certificate when the cycles are given, else the stored label, else not certified. */
function certText(input: Pick<MsFieldsInput, 'cycles' | 'today' | 'display'>): Text {
  const newest = input.cycles ? newestCertificate(input.cycles) : undefined;
  const label = newest ? certificateLabelOf(newest, input.today) : null;
  if (label) return label;
  return isText(input.display.certLabel) ? input.display.certLabel : NOT_CERTIFIED;
}

function isPair(value: unknown): value is Pair {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string');
}

function isText(value: unknown): value is Text {
  return typeof value === 'string' || isPair(value);
}

function label(labels: PackLabels, key: string): Pair | null {
  const value = labels[key];
  return value ? [value[0], value[1]] : null;
}

/** G.5 `ed`: the active edition, or `<active> to <target>` during a transition. */
export function editionText(active: Pick<VersionInfo, 'edition'>, target: Pick<VersionInfo, 'edition'> | null): string {
  return target ? `${active.edition} to ${target.edition}` : active.edition;
}

/** G.5 `locMode`: `Managed Vault` for a vault default, else `Customer Repository, ` plus the default rule's mode label. */
export function locModeText(adapter: StorageAdapter, defaultRoutingMode: StorageMode | null): string {
  if (adapter === 'managed_vault') return 'Managed Vault';
  return `Customer Repository, ${routingModeLabel(defaultRoutingMode ?? 'link')}`;
}

/** G.5 `theme` of a catalogue system: `{5: <label of catalogue.theme.5>, ...}` in English. */
export function themeLabels(labels: PackLabels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    const match = /^catalogue\.theme\.(\d+)$/.exec(key);
    if (match && value) out[match[1]!] = value[0];
  }
  return out;
}

/** G.5 `banner`: the newest open alert. */
export function bannerOf(alerts: readonly AlertRow[]): ManagementSystem['banner'] {
  const newest = [...alerts].sort((a, b) => b.raisedAt.getTime() - a.raisedAt.getTime())[0];
  return newest ? { tone: newest.tone, text: [newest.textEn, newest.textId], kind: newest.kind } : undefined;
}

/** Clause groups of `MS.clauses` (4 to 10). */
const CLAUSE_GROUPS = [4, 5, 6, 7, 8, 9, 10] as const;

/** The certificate label of a system that never held a certificate and has no stored label (D.4). */
export const NOT_CERTIFIED: Pair = ['Not yet certified', 'Belum tersertifikasi'];

/** A readiness percentage 0 to 100 of one group, or null while it is not computed (D.6). */
function readinessPct(value: ReadinessValue | undefined): number | null {
  const pct = storedReadiness(value).readiness;
  if (pct === null || !Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * `MS.readiness` (D.3, D.6): the stored dimensions of groups 4 to 10 and the newest `computedAt`, only when at least
 * one row was written by `readiness.recompute`; undefined for seeded and manual rows, so the demo stays as it was.
 */
export function clauseReadiness(values: ReadonlyMap<number, ReadinessValue>): ClauseReadiness | undefined {
  const rows = CLAUSE_GROUPS.map((c) => storedReadiness(values.get(c)));
  if (!rows.some(hasStoredDimensions)) return undefined;
  const times = rows.map((r) => (r.computedAt ? new Date(r.computedAt).getTime() : null)).filter((t): t is number => t !== null && Number.isFinite(t));
  const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.max(0, Math.min(100, Math.round(v))));
  return {
    computedAt: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
    groups: rows.map((r) => ({ documented: pct(r.documented), implemented: pct(r.implemented), evidenced: pct(r.evidenced), measured: pct(r.measured) })),
  };
}

/** One `MS[]` entry (G.5). */
export function deriveManagementSystem(input: MsFieldsInput): ManagementSystem {
  const { display, labels, nextEvent } = input;
  const longName = label(labels, 'ms.long_name') ?? [input.code, input.code];
  const unit = input.active.applicabilityTarget === 'catalogue_item' ? 'ctrl' : 'req';
  const lead: Text = nextEvent?.leadAuditorName ?? (isText(display.lead) ? display.lead : '-');
  const ms: ManagementSystem = {
    id: input.slug,
    code: input.active.frameworkName,
    ed: editionText(input.active, input.target),
    short: input.code,
    name: longName,
    mgr: input.primaryManager ?? NONE,
    mgrRole: label(labels, 'ms.manager_role')?.[0] ?? '',
    color: input.color,
    scope: input.scope,
    certifier: input.certificationBody ?? '',
    lead,
    cert: certText(input),
    stage: isPair(display.stage) ? display.stage : ['-', '-'],
    audit: nextEvent
      ? { name: [nextEvent.nameEn, nextEvent.nameId], date: nextEvent.scheduledAt, days: nextEvent.auditDays, prepWindowDays: nextEvent.prepWindowDays }
      : null,
    clauses: CLAUSE_GROUPS.map((c) => readinessPct(input.readiness.get(c))),
    findings: { ...input.findings },
    loc: input.defaultRepository.slug,
    locMode: locModeText(input.defaultRepository.adapter, input.defaultRoutingMode),
    pack: typeof display.packLabel === 'string' ? display.packLabel : `${input.active.packId} v${input.active.packVersion}`,
    phase: isPair(display.phase) ? display.phase : ['-', '-'],
    unit,
  };
  const readiness = clauseReadiness(input.readiness);
  if (readiness) ms.readiness = readiness;
  const banner = bannerOf(input.alerts);
  if (banner) ms.banner = banner;
  if (unit === 'ctrl') ms.theme = themeLabels(labels);
  const gateName = label(labels, 'gate.name');
  if (gateName) ms.gateName = gateName;
  if (Array.isArray(display.gtSuggestions)) ms.gtSuggestions = display.gtSuggestions.filter((s): s is string => typeof s === 'string');
  if (input.approver) ms.approver = input.approver;
  return ms;
}
