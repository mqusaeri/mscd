// The view model of the Management systems screen and the edition transition drawer (MILESTONE-2 M2-09), the
// interfaces their adapters implement, and the form helpers that build `ManagementSystemCreate` and
// `ManagementSystemPatch` (D.2, D-30) with the checks of the shared schema shown next to each field.
import type { ManagementSystemCreate, ManagementSystemPatch, MsTransitionRequest } from '@mscd/shared';
import type { ManagementSystem } from '../../data/types';
import type { TextPair } from '../types';
import { FRAMEWORK_NAMES } from '../license/model';
import type { Result } from '../storage-admin/model';
import { PALETTE, TEXT } from './text';

export type { Result };

export type MsStatusCode = 'setup' | 'implementing' | 'certified' | 'transitioning' | 'archived';

/** A management system (`ManagementSystemView` of D.2) with its primary MS Manager. */
export interface SystemModel {
  id: string;
  slug: string;
  code: string;
  name: string | TextPair;
  frameworkCode: string;
  frameworkName: string;
  edition: string;
  packId: string;
  packVersion: string;
  transitionTargetEdition: string | null;
  status: MsStatusCode;
  scopeStatement: string;
  certificationBody: string | null;
  color: string;
  defaultRepository: string;
  /** Display name of the primary MS Manager; null when none is granted; undefined when it could not be read. */
  primaryManager?: string | null;
}

/** An installed pack (`PackSummary` of D.2). */
export interface PackChoice {
  packId: string;
  version: string;
  frameworkCode: string;
  edition: string;
  status: 'validating' | 'installed' | 'failed' | 'superseded';
  preRelease: boolean;
}

export interface RepoRef {
  slug: string;
  name: string;
}

export interface SystemsData {
  systems: SystemModel[];
  packs: PackChoice[];
  repos: RepoRef[];
  sample?: boolean;
}

export interface SystemsAdapter {
  load(): Promise<Result<SystemsData>>;
  /** `POST /admin/management-systems` with an `Idempotency-Key`. */
  create(body: ManagementSystemCreate, idempotencyKey: string): Promise<Result<SystemModel>>;
  /** `PATCH /admin/management-systems/{id}`. */
  update(id: string, body: ManagementSystemPatch): Promise<Result<SystemModel>>;
}

export interface TransitionAdapter {
  /** `GET /admin/packs`: the installed editions. */
  packs(): Promise<Result<PackChoice[]>>;
  /** The status of each system by slug (`admin.ms.list`, with `ms.admin`); null when the session cannot read it. */
  statuses(): Promise<Record<string, MsStatusCode> | null>;
  /** `POST /ms/{ms}/transitions`. */
  transition(ms: string, body: MsTransitionRequest): Promise<Result<{ changed: string[] }>>;
}

export const STATUS_LABELS: Readonly<Record<MsStatusCode, { label: TextPair; tone: 'ok' | 'warn' | 'info' | 'acc' | 'mute' }>> = {
  setup: { label: TEXT.statusSetup, tone: 'mute' },
  implementing: { label: TEXT.statusImplementing, tone: 'acc' },
  certified: { label: TEXT.statusCertified, tone: 'ok' },
  transitioning: { label: TEXT.statusTransitioning, tone: 'info' },
  archived: { label: TEXT.statusArchived, tone: 'mute' },
};

/** The display name of a framework code (`ISO27001` is ISO/IEC 27001). */
export function frameworkName(code: string, fallback?: string): string {
  return FRAMEWORK_NAMES[code] ?? fallback ?? code;
}

/** The packs a new system may use: one installed version per pack id, sorted by framework and edition. */
export function installablePacks(packs: PackChoice[]): PackChoice[] {
  const byId = new Map<string, PackChoice>();
  for (const p of packs) if (p.status === 'installed') byId.set(p.packId, p);
  return [...byId.values()].sort((a, b) => a.frameworkCode.localeCompare(b.frameworkCode) || a.edition.localeCompare(b.edition));
}

// ---------------------------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------------------------

export interface SystemForm {
  code: string;
  slug: string;
  name: string;
  packId: string;
  scopeStatement: string;
  certificationBody: string;
  color: string;
  defaultRepository: string;
}

export type FormErrors = Partial<Record<keyof SystemForm, TextPair | string>>;

export const SLUG = /^[a-z][a-z0-9-]{1,19}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function emptySystem(data: SystemsData): SystemForm {
  const used = new Set(data.systems.map((s) => s.color.toLowerCase()));
  const colour = PALETTE.find((p) => !used.has(p.value))?.value ?? PALETTE[0].value;
  const vault = data.repos.find((r) => r.slug === 'vault') ?? data.repos[0];
  return { code: '', slug: '', name: '', packId: installablePacks(data.packs)[0]?.packId ?? '', scopeStatement: '', certificationBody: '', color: colour, defaultRepository: vault?.slug ?? '' };
}

export function formOfSystem(system: SystemModel): SystemForm {
  return {
    code: system.code,
    slug: system.slug,
    name: typeof system.name === 'string' ? system.name : system.name[0],
    packId: system.packId,
    scopeStatement: system.scopeStatement,
    certificationBody: system.certificationBody ?? '',
    color: system.color,
    defaultRepository: system.defaultRepository,
  };
}

/** A short id from a code: lower case letters, digits and hyphens. */
export function slugOfCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 20);
}

export function systemErrors(form: SystemForm, mode: 'create' | 'edit'): FormErrors {
  const out: FormErrors = {};
  if (mode === 'create') {
    if (!form.code.trim()) out.code = TEXT.required;
    else if (form.code.trim().length > 20) out.code = TEXT.tooLong;
    if (!form.slug) out.slug = TEXT.required;
    else if (!SLUG.test(form.slug)) out.slug = TEXT.badSlug;
    if (!form.name.trim()) out.name = TEXT.required;
    else if (form.name.trim().length > 150) out.name = TEXT.tooLong;
    if (!form.packId) out.packId = TEXT.required;
  }
  if (!form.scopeStatement.trim()) out.scopeStatement = TEXT.required;
  else if (form.scopeStatement.trim().length > 4000) out.scopeStatement = TEXT.tooLong;
  if (form.certificationBody.trim().length > 150) out.certificationBody = TEXT.tooLong;
  if (!COLOR.test(form.color)) out.color = TEXT.required;
  if (!form.defaultRepository) out.defaultRepository = TEXT.required;
  return out;
}

/** `ManagementSystemCreate` of a form (D.2): the edition is the chosen pack's. */
export function createBody(form: SystemForm, packs: PackChoice[]): ManagementSystemCreate {
  const pack = packs.find((p) => p.packId === form.packId);
  return {
    slug: form.slug,
    code: form.code.trim(),
    name: form.name.trim(),
    packId: form.packId,
    edition: pack?.edition ?? '',
    scopeStatement: form.scopeStatement.trim(),
    defaultRepository: form.defaultRepository,
    ...(form.certificationBody.trim() ? { certificationBody: form.certificationBody.trim() } : {}),
    color: form.color,
  };
}

/** `ManagementSystemPatch` of the edit form: the changed fields only; null when nothing changed. */
export function patchBody(form: SystemForm, system: SystemModel): ManagementSystemPatch | null {
  const patch: Record<string, unknown> = {};
  if (form.scopeStatement.trim() !== system.scopeStatement) patch.scopeStatement = form.scopeStatement.trim();
  const body = form.certificationBody.trim() || null;
  if (body !== (system.certificationBody ?? null)) patch.certificationBody = body;
  if (form.color.toLowerCase() !== system.color.toLowerCase()) patch.color = form.color;
  if (form.defaultRepository !== system.defaultRepository) patch.defaultRepository = form.defaultRepository;
  return Object.keys(patch).length ? (patch as ManagementSystemPatch) : null;
}

/** The primary MS Manager per system slug from the members list (`UserView.roles`). */
export function primaryManagers(users: { displayName: string; roles: { ms: string; role: string; isPrimary: boolean; approvalStatus: string }[] }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const user of users) {
    for (const grant of user.roles) {
      if (grant.role === 'ms_manager' && grant.isPrimary && grant.approvalStatus === 'active' && !out.has(grant.ms)) out.set(grant.ms, user.displayName);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Edition transition
// ---------------------------------------------------------------------------------------------------------------

/** One system in the edition transition drawer. */
export interface TransitionRow {
  ms: string;
  code: string;
  name: string | TextPair;
  framework: string;
  edition: string;
  /** The edition the system is moving to; null when it is not in transition. */
  target: string | null;
  /** Newer installed editions it may move to. */
  newer: string[];
  /** The system status when the session may read it (`ms.admin`); null otherwise. */
  status: MsStatusCode | null;
}

const digits = (s: string) => s.replace(/[^0-9]/g, '');

/** Editions compare as numbers when both are years, else as text. */
export function newerEdition(candidate: string, current: string): boolean {
  const a = Number(candidate);
  const b = Number(current);
  if (Number.isFinite(a) && Number.isFinite(b) && /^\d+$/.test(candidate) && /^\d+$/.test(current)) return a > b;
  return candidate.localeCompare(current) > 0;
}

/**
 * The systems with a newer edition installed, or already in transition, among those the session may transition
 * (`ms.transition`). The snapshot shows the edition as `2015`, or `2015 to 2026` while a target edition is set (G.5
 * `MS.ed`), and the framework by name (`ISO 9001`), which matches a pack's framework code by its number. When the
 * statuses are known (`admin.ms.list`), a system is in transition only with the status `transitioning`; a certified
 * system whose target edition is set but not started yet is offered the start.
 */
export function transitionRows(
  systems: readonly ManagementSystem[],
  packs: PackChoice[],
  may: (ms: string) => boolean,
  statuses: Readonly<Record<string, MsStatusCode>> | null = null,
): TransitionRow[] {
  const rows: TransitionRow[] = [];
  for (const m of systems) {
    if (!may(m.id)) continue;
    const [edition, shown = null] = String(m.ed).split(' to ').map((s) => s.trim());
    const status = statuses?.[m.id] ?? null;
    const target = status === null || status === 'transitioning' ? shown : null;
    const number = digits(m.code);
    const newer = [...new Set(packs
      .filter((p) => p.status === 'installed' && number && digits(p.frameworkCode) === number && p.edition !== edition && newerEdition(p.edition, edition))
      .map((p) => p.edition))].sort();
    if (!target && !newer.length) continue;
    rows.push({ ms: m.id, code: m.short, name: m.name, framework: m.code, edition, target, newer, status });
  }
  return rows;
}
