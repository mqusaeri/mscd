// The view model of the Routing rules screen (MILESTONE-2 M2-09) and the interface both adapters implement (api.ts in
// API builds, sample.ts in the sample build, chosen by the build in adapter.ts). The form helpers turn the rule form
// into `RoutingRuleRequest` and `RoutingRulePatch` (D.2, BR-38, A-37) and decide who may decide on a pending rule.
import type { RoutingRulePatch, RoutingRuleRequest } from '@mscd/shared';
import type { HostContext, TextPair } from '../types';
import type { AdapterCode, ClassificationCode, LinkStatusCode, ModeCode, ObjectKindCode } from '../storage-admin/labels';
import type { Result, SystemRef } from '../storage-admin/model';
import { TEXT } from './text';

export type { Result, SystemRef };

export type ApprovalCode = 'active' | 'pending_approval' | 'rejected' | 'superseded';

/** A routing rule (`RoutingRuleView` of D.2). */
export interface RuleModel {
  id: string;
  /** System slug; null for an organisation-wide rule. */
  ms: string | null;
  classification: ClassificationCode | null;
  objectKind: ObjectKindCode | null;
  /** Repository slug. */
  repository: string;
  mode: ModeCode;
  priority: number;
  note: string | TextPair | null;
  approvalStatus: ApprovalCode;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
}

/** A repository a rule may name. */
export interface RepoChoice {
  slug: string;
  name: string;
  adapter: AdapterCode;
  modes: ModeCode[];
  readOnly: boolean;
  /** Folder path per system slug (`config.roots`), to tell the system of a stored file. */
  roots: Record<string, string>;
}

export interface RoutingData {
  rules: RuleModel[];
  repos: RepoChoice[];
  systems: SystemRef[];
  sample?: boolean;
}

/** Storage object metadata (`StorageObjectMeta` of D.2): no content and no link to it. */
export interface ObjectModel {
  id: string;
  repository: string;
  displayName: string | null;
  folderPath: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  hashAlgorithm: 'sha256' | 'sha1' | 'md5' | 'quickxor' | 'none';
  hashSource: 'computed' | 'provider' | 'none';
  linkStatus: LinkStatusCode;
  lastVerifiedAt: string | null;
  /** System code when the source knows it (sample); the API source leaves it to `systemOfObject`. */
  system?: string;
}

export interface ObjectPage {
  items: ObjectModel[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ObjectQuery {
  page: number;
  pageSize: number;
  repository?: string;
  status?: LinkStatusCode;
}

/** What a rule command answered: its message and the state of the rule it wrote. */
export interface RuleOutcome {
  message: TextPair | null;
  approvalStatus: ApprovalCode | null;
  /** Systems whose snapshot changed (an active rule). */
  changed: string[];
}

export interface RoutingAdapter {
  load(): Promise<Result<RoutingData>>;
  create(body: RoutingRuleRequest, idempotencyKey: string): Promise<Result<RuleOutcome>>;
  update(id: string, body: RoutingRulePatch): Promise<Result<RuleOutcome>>;
  approve(id: string): Promise<Result<RuleOutcome>>;
  reject(id: string): Promise<Result<RuleOutcome>>;
  objects(query: ObjectQuery): Promise<Result<ObjectPage>>;
}

// ---------------------------------------------------------------------------------------------------------------
// The rule form
// ---------------------------------------------------------------------------------------------------------------

export interface RuleForm {
  ms: string;
  classification: string;
  objectKind: string;
  repository: string;
  mode: string;
  priority: string;
  note: string;
}

export type FormErrors = Partial<Record<keyof RuleForm, TextPair | string>>;

export const MAX_PRIORITY = 32767;

export function emptyRule(repos: RepoChoice[], ms = ''): RuleForm {
  const repo = repos.find((r) => !r.readOnly);
  return { ms, classification: '', objectKind: '', repository: repo?.slug ?? '', mode: repo?.modes[0] ?? '', priority: '100', note: '' };
}

const noteText = (note: RuleModel['note']) => (note === null ? '' : Array.isArray(note) ? note[0] : String(note));

export function formOfRule(rule: RuleModel): RuleForm {
  return {
    ms: rule.ms ?? '',
    classification: rule.classification ?? '',
    objectKind: rule.objectKind ?? '',
    repository: rule.repository,
    mode: rule.mode,
    priority: String(rule.priority),
    note: noteText(rule.note) === '-' ? '' : noteText(rule.note),
  };
}

export function ruleErrors(form: RuleForm, repos: RepoChoice[]): FormErrors {
  const out: FormErrors = {};
  const repo = repos.find((r) => r.slug === form.repository);
  if (!form.repository || !repo) out.repository = TEXT.required;
  if (!form.mode) out.mode = TEXT.required;
  else if (repo && !repo.modes.includes(form.mode as ModeCode)) out.mode = TEXT.badMode;
  const priority = form.priority.trim();
  if (!/^\d+$/.test(priority) || Number(priority) > MAX_PRIORITY) out.priority = TEXT.badPriority;
  if (form.note.trim().length > 500) out.note = TEXT.noteTooLong;
  return out;
}

/** `RoutingRuleRequest` of a form (D.2); `confirm` after a 409 `confirmation-required` of BR-38. */
export function ruleRequest(form: RuleForm, confirm = false): RoutingRuleRequest {
  return {
    ...(form.ms ? { ms: form.ms } : {}),
    ...(form.classification ? { classification: form.classification as ClassificationCode } : {}),
    ...(form.objectKind ? { objectKind: form.objectKind as ObjectKindCode } : {}),
    repository: form.repository,
    mode: form.mode as ModeCode,
    priority: Number(form.priority.trim()),
    ...(form.note.trim() ? { note: form.note.trim() } : {}),
    ...(confirm ? { confirm: true } : {}),
  };
}

/** `RoutingRulePatch` of the changed fields; null when nothing changed. The system of a rule never changes. */
export function rulePatch(form: RuleForm, rule: RuleModel, confirm = false): RoutingRulePatch | null {
  const patch: Record<string, unknown> = {};
  if ((form.classification || null) !== rule.classification) patch.classification = form.classification || null;
  if ((form.objectKind || null) !== rule.objectKind) patch.objectKind = form.objectKind || null;
  if (form.repository !== rule.repository) patch.repository = form.repository;
  if (form.mode !== rule.mode) patch.mode = form.mode;
  if (Number(form.priority.trim()) !== rule.priority) patch.priority = Number(form.priority.trim());
  const note = form.note.trim();
  if (note !== (noteText(rule.note) === '-' ? '' : noteText(rule.note))) patch.note = note || null;
  if (!Object.keys(patch).length) return null;
  return { ...patch, ...(confirm ? { confirm: true } : {}) } as RoutingRulePatch;
}

// ---------------------------------------------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------------------------------------------

/** The handle of the session person (the sample persona's person in the sample build). */
export function meOf(ctx: HostContext): string {
  return ctx.me?.user.handle ?? ctx.person.handle;
}

/** Whether the session holds the Tenant Admin role (the sample manager persona stands for the administrators). */
export function isTenantAdmin(ctx: HostContext): boolean {
  if (ctx.mode !== 'api') return ctx.orgCan('storage.routing.manage');
  return Boolean(ctx.me?.adminRoles?.includes('tenant_admin'));
}

/**
 * Why the session may not decide on a pending rule, or null when it may: the requester never decides (A-50, BR-38),
 * and only a Tenant Admin does.
 */
export function decisionBlock(ctx: HostContext, rule: RuleModel): TextPair | null {
  if (rule.requestedBy && rule.requestedBy === meOf(ctx)) return TEXT.ownRequest;
  if (!isTenantAdmin(ctx)) return TEXT.onlyTenantAdmin;
  return null;
}

/** Whether the session may edit a rule: an active rule, or a pending rule it asked for itself. */
export function canEdit(ctx: HostContext, rule: RuleModel): boolean {
  if (!ctx.orgCan('storage.routing.manage')) return false;
  if (rule.approvalStatus === 'active') return true;
  return rule.approvalStatus === 'pending_approval' && rule.requestedBy === meOf(ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Stored files
// ---------------------------------------------------------------------------------------------------------------

const normalPath = (p: string) => p.split('/').map((s) => s.trim()).filter(Boolean).join('/').toLowerCase();

/** The system code of a stored file: from the source, else the repository folder of a system that holds its path. */
export function systemOfObject(object: ObjectModel, repos: RepoChoice[], systems: SystemRef[]): string | null {
  if (object.system) return object.system;
  const repo = repos.find((r) => r.slug === object.repository);
  if (!repo || !object.folderPath) return null;
  const path = normalPath(object.folderPath);
  for (const [ms, root] of Object.entries(repo.roots)) {
    const base = normalPath(root);
    if (base && (path === base || path.startsWith(`${base}/`))) return systems.find((s) => s.slug === ms)?.code ?? ms.toUpperCase();
  }
  return null;
}

/** A size in bytes as B, KB or MB. */
export function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MIME_NAMES: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/vnd.google-apps.document': 'Google Docs',
  'application/vnd.google-apps.spreadsheet': 'Google Sheets',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
};

/** A short file type: the MIME name, else the extension of the file name, else '-'. */
export function fileType(object: Pick<ObjectModel, 'mimeType' | 'displayName'>): string {
  if (object.mimeType && MIME_NAMES[object.mimeType]) return MIME_NAMES[object.mimeType];
  const ext = /\.([A-Za-z0-9]{1,6})$/.exec(object.displayName ?? '');
  if (ext) return ext[1].toUpperCase();
  return object.mimeType ?? '-';
}

export const HASH_NAMES: Readonly<Record<ObjectModel['hashAlgorithm'], string | null>> = {
  sha256: 'SHA-256', sha1: 'SHA-1', md5: 'MD5', quickxor: 'QuickXorHash', none: null,
};
