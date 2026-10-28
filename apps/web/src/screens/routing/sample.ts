// Sample adapter of the Routing rules screen (MILESTONE-2 M2-09): the default rules of the sample organisation
// (`ROUTING` of the sample snapshot) plus two changes waiting for approval, and the sample evidence files as stored
// files. Changes stay for the browser session, kept per organisation so the organisation switcher shows each
// organisation's own rules. A rule that sends restricted files into the Managed Vault of the provider cloud asks for
// the BR-38 confirmation and then waits for a second Tenant Admin, as the api does on SaaS.
import type { RoutingRulePatch, RoutingRuleRequest } from '@mscd/shared';
import type { ControllerData } from '../../data/types';
import type { AdapterCode, LinkStatusCode, ModeCode } from '../storage-admin/labels';
import { sampleOrgKey } from '../storage-admin/sampleOrg';
import type { ObjectModel, RepoChoice, Result, RoutingAdapter, RoutingData, RuleModel, RuleOutcome } from './model';

const MODE_OF_LABEL: Readonly<Record<string, ModeCode>> = { Link: 'link', 'Pass-through': 'pass_through', 'Zero-transit': 'zero_transit', Upload: 'stored' };

const SAMPLE_ROOTS: Readonly<Record<string, Record<string, string>>> = {
  sp: { isms: 'Compliance/ISMS' },
  gd: { bcms: 'Compliance BCMS' },
};

const HASH_OF: Readonly<Record<string, ObjectModel['hashAlgorithm']>> = { quickXorHash: 'quickxor', 'SHA-256': 'sha256', sha256: 'sha256', none: 'none' };
const STATUS_OF_INTEG: Readonly<Record<string, LinkStatusCode>> = {
  ok: 'intact', changed: 'version_changed', moved: 'moved', missing: 'missing', revoked: 'access_denied', pending: 'verification_pending', nohash: 'intact',
};

export function sampleRepos(D: ControllerData | null): RepoChoice[] {
  return (D?.REPOS ?? []).map((r) => {
    const adapter: AdapterCode = r.adapter ?? (r.id === 'vault' ? 'managed_vault' : 'm365');
    const text = Array.isArray(r.modes) ? r.modes[0] : r.modes;
    const modes = adapter === 'managed_vault' ? (['stored'] as ModeCode[]) : String(text).split(',').map((s) => MODE_OF_LABEL[s.trim()]).filter((m): m is ModeCode => Boolean(m));
    return { slug: r.id, name: r.name, adapter, modes, readOnly: false, roots: { ...(SAMPLE_ROOTS[r.id] ?? {}) } };
  });
}

/** The rules of the sample snapshot: one default rule per system, and two pending changes. */
export function sampleRules(D: ControllerData | null): RuleModel[] {
  const repos = sampleRepos(D);
  const systems = D?.MS ?? [];
  const rules: RuleModel[] = (D?.ROUTING ?? []).map((row, i) => {
    const [short, repoName, modeLabel, note] = row;
    const system = systems.find((m) => m.short === short);
    const repo = repos.find((r) => r.name === repoName);
    return {
      id: `sample-rule-${i + 1}`,
      ms: system?.id ?? null,
      classification: null,
      objectKind: null,
      repository: repo?.slug ?? 'vault',
      mode: MODE_OF_LABEL[modeLabel] ?? 'stored',
      priority: 100,
      note: note === '-' ? null : Array.isArray(note) ? [note[0], note[1]] : String(note),
      approvalStatus: 'active',
      requestedBy: system?.mgr ?? null,
      approvedBy: null,
      createdAt: '2026-02-02T03:00:00Z',
    };
  });
  const has = (id: string) => systems.some((m) => m.id === id);
  if (has('bcms')) {
    rules.push({
      id: 'sample-rule-pending-bcms', ms: 'bcms', classification: 'restricted', objectKind: 'evidence', repository: 'vault', mode: 'stored', priority: 40,
      note: ['Restricted BCMS evidence to the vault', 'Bukti BCMS terbatas ke vault'], approvalStatus: 'pending_approval', requestedBy: 'tono', approvedBy: null, createdAt: '2026-09-27T03:00:00Z',
    });
  }
  if (has('isms')) {
    rules.push({
      id: 'sample-rule-pending-isms', ms: 'isms', classification: 'confidential', objectKind: 'document', repository: 'sp', mode: 'pass_through', priority: 60,
      note: ['Confidential ISMS documents pass through', 'Dokumen ISMS rahasia diteruskan'], approvalStatus: 'pending_approval', requestedBy: 'rina', approvedBy: null, createdAt: '2026-09-28T03:00:00Z',
    });
  }
  return rules;
}

/** The sample evidence files as stored files (metadata only). */
export function sampleObjects(D: ControllerData | null): ObjectModel[] {
  const out: ObjectModel[] = [];
  for (const m of D?.MS ?? []) {
    for (const e of D?.bundles?.[m.id]?.evs ?? []) {
      out.push({
        id: `${m.id}:${e.code}`,
        repository: e.loc,
        displayName: `${e.code} ${e.title}`,
        folderPath: e.path ?? null,
        sizeBytes: null,
        mimeType: null,
        hashAlgorithm: HASH_OF[e.hashAlg] ?? (e.integ === 'nohash' ? 'none' : 'sha256'),
        hashSource: e.loc === 'vault' ? 'computed' : e.hashAlg === 'none' || e.integ === 'nohash' ? 'none' : 'provider',
        linkStatus: STATUS_OF_INTEG[e.integ] ?? 'intact',
        lastVerifiedAt: null,
        system: m.short,
      });
    }
  }
  return out;
}

// The rules of this session per organisation (`sampleOrgKey`), with the changes made to them; `added` numbers the new
// rules of every organisation.
const sessions = new Map<string, RuleModel[]>();
let added = 0;

/** Forgets the changes of this session (unit tests). */
export function resetSampleRouting(): void {
  sessions.clear();
  added = 0;
}

/** The session's rules of the snapshot's organisation, made from the snapshot on first use. */
function rulesOf(D: ControllerData | null): RuleModel[] {
  const key = sampleOrgKey(D);
  let rules = sessions.get(key);
  if (!rules) {
    rules = sampleRules(D);
    sessions.set(key, rules);
  }
  return rules;
}

const SAME_PERSON: [string, string] = ['The person who asked for this routing change cannot decide on it', 'Orang yang meminta perubahan routing ini tidak dapat memutuskannya'];
const BR38: [string, string] = ["Restricted files will be stored in the provider's cloud. This change needs a second approval.", 'File terbatas akan disimpan di cloud penyedia. Perubahan ini memerlukan persetujuan kedua.'];

export function createSampleAdapter(getD: () => ControllerData | null, me: () => string): RoutingAdapter {
  const all = () => rulesOf(getD());
  const repoOf = (slug: string) => sampleRepos(getD()).find((r) => r.slug === slug) ?? null;
  const br38 = (repo: RepoChoice | null, classification: string | null) => repo?.adapter === 'managed_vault' && (classification === null || classification === 'restricted');
  const activate = (rule: RuleModel) => {
    for (const r of all()) {
      if (r.id !== rule.id && r.approvalStatus === 'active' && r.ms === rule.ms && r.classification === rule.classification && r.objectKind === rule.objectKind) r.approvalStatus = 'superseded';
    }
    rule.approvalStatus = 'active';
  };
  const outcome = (pending: boolean, ms: string | null): RuleOutcome => ({
    message: pending
      ? ['Routing change waiting for approval by another Tenant Admin', 'Perubahan routing menunggu persetujuan Tenant Admin lain']
      : ['Routing rule saved', 'Aturan routing disimpan'],
    approvalStatus: pending ? 'pending_approval' : 'active',
    changed: pending ? [] : ms ? [ms] : (getD()?.MS ?? []).map((m) => m.id),
  });
  const refuse = (status: number, slug: string, message: [string, string], rule?: string): Result<never> => ({ ok: false, error: { status, slug, message, ...(rule ? { rule } : {}) } });
  const check = (repo: RepoChoice | null, mode: ModeCode): Result<never> | null => {
    if (!repo) return refuse(404, 'not-found', ['No such storage repository', 'Repositori penyimpanan tidak ditemukan']);
    if (!repo.modes.includes(mode)) return refuse(422, 'business-rule', [`The repository ${repo.name} does not offer the mode ${mode}`, `Repositori ${repo.name} tidak menyediakan moda ${mode}`]);
    return null;
  };
  return {
    async load(): Promise<Result<RoutingData>> {
      const D = getD();
      return { ok: true, data: { rules: all().map((r) => ({ ...r })), repos: sampleRepos(D), systems: (D?.MS ?? []).map((m) => ({ slug: m.id, code: m.short })), sample: true } };
    },
    async create(body: RoutingRuleRequest) {
      const repo = repoOf(body.repository);
      const problem = check(repo, body.mode);
      if (problem) return problem;
      const needs38 = br38(repo, body.classification ?? null);
      if (needs38 && !body.confirm) return refuse(409, 'confirmation-required', BR38, 'BR-38');
      added += 1;
      const rule: RuleModel = {
        id: `sample-rule-new-${added}`, ms: body.ms ?? null, classification: body.classification ?? null, objectKind: body.objectKind ?? null,
        repository: body.repository, mode: body.mode, priority: body.priority, note: body.note ?? null, approvalStatus: 'pending_approval',
        requestedBy: me(), approvedBy: null, createdAt: new Date().toISOString(),
      };
      all().push(rule);
      if (!needs38) activate(rule);
      return { ok: true, data: outcome(needs38, rule.ms) };
    },
    async update(id: string, body: RoutingRulePatch) {
      const rule = all().find((r) => r.id === id);
      if (!rule) return refuse(404, 'not-found', ['No such routing rule', 'Aturan routing tidak ditemukan']);
      if (rule.approvalStatus === 'pending_approval' && rule.requestedBy !== me()) {
        return refuse(409, 'conflict', ['This routing change is waiting for approval. Approve or reject it; only the person who asked for it can still edit it.', 'Perubahan routing ini menunggu persetujuan. Setujui atau tolak; hanya orang yang memintanya yang masih dapat mengubahnya.']);
      }
      const next: RuleModel = {
        ...rule,
        ...(body.classification !== undefined ? { classification: body.classification } : {}),
        ...(body.objectKind !== undefined ? { objectKind: body.objectKind } : {}),
        ...(body.repository !== undefined ? { repository: body.repository } : {}),
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      };
      const repo = repoOf(next.repository);
      const problem = check(repo, next.mode);
      if (problem) return problem;
      const needs38 = br38(repo, next.classification);
      if (needs38 && !body.confirm) return refuse(409, 'confirmation-required', BR38, 'BR-38');
      if (needs38) {
        // The active rule keeps routing until a second Tenant Admin approves the replacement.
        added += 1;
        all().push({ ...next, id: `sample-rule-new-${added}`, approvalStatus: 'pending_approval', requestedBy: me(), approvedBy: null });
        if (rule.approvalStatus === 'pending_approval') rule.approvalStatus = 'superseded';
      } else {
        Object.assign(rule, next, { requestedBy: me(), approvedBy: null });
        activate(rule);
      }
      return { ok: true, data: outcome(needs38, rule.ms) };
    },
    async approve(id: string) {
      const rule = all().find((r) => r.id === id);
      if (!rule) return refuse(404, 'not-found', ['No such routing rule', 'Aturan routing tidak ditemukan']);
      if (rule.approvalStatus !== 'pending_approval') return refuse(409, 'conflict', [`The rule is ${rule.approvalStatus}, not waiting for approval`, `Aturan berstatus ${rule.approvalStatus}, tidak menunggu persetujuan`]);
      if (rule.requestedBy === me()) return refuse(422, 'business-rule', SAME_PERSON);
      activate(rule);
      rule.approvedBy = me();
      return { ok: true, data: { message: ['Routing change approved and active', 'Perubahan routing disetujui dan aktif'], approvalStatus: 'active', changed: rule.ms ? [rule.ms] : [] } };
    },
    async reject(id: string) {
      const rule = all().find((r) => r.id === id);
      if (!rule) return refuse(404, 'not-found', ['No such routing rule', 'Aturan routing tidak ditemukan']);
      if (rule.approvalStatus !== 'pending_approval') return refuse(409, 'conflict', [`The rule is ${rule.approvalStatus}, not waiting for approval`, `Aturan berstatus ${rule.approvalStatus}, tidak menunggu persetujuan`]);
      if (rule.requestedBy === me()) return refuse(422, 'business-rule', SAME_PERSON);
      rule.approvalStatus = 'rejected';
      rule.approvedBy = me();
      return { ok: true, data: { message: ['Routing change rejected', 'Perubahan routing ditolak'], approvalStatus: 'rejected', changed: [] } };
    },
    async objects(query) {
      const filtered = sampleObjects(getD()).filter((o) => (!query.repository || o.repository === query.repository) && (!query.status || o.linkStatus === query.status));
      const start = (query.page - 1) * query.pageSize;
      return { ok: true, data: { items: filtered.slice(start, start + query.pageSize), page: query.page, pageSize: query.pageSize, total: filtered.length } };
    },
  };
}
