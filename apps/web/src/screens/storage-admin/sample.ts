// Sample adapter of the repository administration (MILESTONE-2 M2-09): the repositories of the sample organisation
// (`REPOS` of the sample snapshot) with sample provider settings, the sample licence's adapters and systems. Changes
// stay for the browser session (until the page is loaded again), kept per organisation so the organisation switcher
// shows each organisation's own repositories; no provider is called, so a connection test answers from the card's state.
import type { ControllerData } from '../../data/types';
import type { AdapterCode, ConnectionCode, ModeCode } from './labels';
import type { AdminData, RepoModel, Result, StorageAdminAdapter, TestOutcome } from './model';
import { sampleOrgKey } from './sampleOrg';

const MODE_OF_LABEL: Readonly<Record<string, ModeCode>> = {
  Link: 'link', 'Pass-through': 'pass_through', 'Zero-transit': 'zero_transit', Upload: 'stored',
};

/** Provider settings of the sample repositories (the snapshot cards carry none). */
const SAMPLE_CONFIG: Readonly<Record<string, Record<string, unknown>>> = {
  sp: {
    siteId: 'nusantaradigital.sharepoint.com,compliance', driveId: 'drive-sp-compliance', rootFolderId: 'demo-sp-compliance',
    roots: { isms: { folderId: 'demo-sp-isms', path: 'Compliance/ISMS' } },
  },
  od: { siteId: 'nusantaradigital-my.sharepoint.com,fnugroho', driveId: 'drive-od-fnugroho', rootFolderId: 'demo-od-personal', roots: {} },
  gd: {
    driveId: 'drive-gd-bcms', rootFolderId: 'demo-gd-compliance-bcms', oauthClientId: 'mscd-demo-bcms.apps.googleusercontent.com',
    roots: { bcms: { folderId: 'demo-gd-compliance-bcms', path: 'Compliance BCMS' } },
  },
  vault: { prefix: 'tenants/ndt/' },
};

const LICENSED_OF_NAME: Readonly<Record<string, AdapterCode>> = {
  'Managed Vault': 'managed_vault', 'Microsoft 365': 'm365', 'Google Workspace': 'google_drive', 'Google Drive': 'google_drive', SMB: 'smb',
};

function connectionOf(status: string, ownership: string, msg: unknown): ConnectionCode {
  if (status === 'bad') return Array.isArray(msg) && /expired|revoked/i.test(String(msg[0])) ? 'revoked' : 'failed';
  if (status === 'warn' && ownership !== 'personal') return 'degraded';
  return 'ok';
}

/** The administration model of a sample repository card; a Managed Vault's prefix names the organisation when known. */
export function fromSampleRepo(r: ControllerData['REPOS'][number], index: number, orgId: string | null = null): RepoModel {
  const modesText = Array.isArray(r.modes) ? r.modes[0] : r.modes;
  const adapter: AdapterCode = r.adapter ?? (r.id === 'vault' ? 'managed_vault' : 'm365');
  const modes = adapter === 'managed_vault' ? (['stored'] as ModeCode[]) : String(modesText).split(',').map((s) => MODE_OF_LABEL[s.trim()]).filter((m): m is ModeCode => Boolean(m));
  const ownership = r.ownershipType ?? 'organizational';
  return {
    ref: `sample-${r.id}-${index}`,
    slug: r.id,
    name: r.name,
    adapter,
    modes,
    ownershipType: ownership,
    connectionStatus: connectionOf(r.status, ownership, r.msg),
    message: r.msg ? [r.msg[0], r.msg[1]] : null,
    summary: Array.isArray(r.tenant) ? [r.tenant[0], r.tenant[1]] : String(r.tenant),
    systems: [...r.ms],
    last: r.last,
    retentionConfirmed: true,
    metadataMinimization: adapter === 'managed_vault',
    readOnly: false,
    credentialSet: adapter !== 'managed_vault',
    credentialExpiresAt: adapter === 'm365' && ownership === 'organizational' ? '2027-06-30T00:00:00Z' : null,
    config: adapter === 'managed_vault' && orgId ? { prefix: `tenants/${orgId}/` } : { ...(SAMPLE_CONFIG[r.id] ?? { roots: {} }) },
    actions: [...(r.actions ?? ['test'])],
  };
}

// The repositories of this session per organisation (`sampleOrgKey`) by ref, with the changes made to them, and their
// order (the sample snapshot itself stays as it is).
interface RepoSession {
  byRef: Map<string, RepoModel>;
  order: string[];
}
const sessions = new Map<string, RepoSession>();

/** Forgets the changes of this session (unit tests). */
export function resetSampleRepositories(): void {
  sessions.clear();
}

/** The session's repositories of the snapshot's organisation, made from the snapshot on first use. */
function sessionOf(D: ControllerData | null, orgId: string | null): RepoSession {
  const key = sampleOrgKey(D);
  let session = sessions.get(key);
  if (!session) {
    const made: RepoSession = { byRef: new Map(), order: [] };
    (D?.REPOS ?? []).forEach((r, i) => {
      const model = fromSampleRepo(r, i, orgId);
      made.byRef.set(model.ref, model);
      made.order.push(model.ref);
    });
    sessions.set(key, made);
    session = made;
  }
  return session;
}

function listOf(session: RepoSession): RepoModel[] {
  return session.order.map((ref) => session.byRef.get(ref)).filter((r): r is RepoModel => Boolean(r));
}

const notFound = (): Result<never> => ({ ok: false, error: { status: 404, message: ['This repository is no longer there. Reload the page.', 'Repositori ini sudah tidak ada. Muat ulang halaman.'] } });

export function sampleData(D: ControllerData | null, orgId: string | null): AdminData {
  const card = D?.LICENCE;
  const licensed = card ? card.adapters.split(',').map((s) => LICENSED_OF_NAME[s.trim()]).filter((a): a is AdapterCode => Boolean(a)) : null;
  return {
    repos: listOf(sessionOf(D, orgId)),
    licensed,
    systems: (D?.MS ?? []).map((m) => ({ slug: m.id, code: m.short })),
    orgId,
    sample: true,
  };
}

export function createSampleAdapter(getD: () => ControllerData | null, orgId: string | null): StorageAdminAdapter {
  const current = () => sessionOf(getD(), orgId);
  return {
    async load() {
      return { ok: true, data: sampleData(getD(), orgId) };
    },
    async create(body) {
      const session = current();
      if (listOf(session).some((r) => r.slug === body.slug)) {
        return { ok: false, error: { status: 409, slug: 'conflict', message: [`A repository with the short id ${body.slug} exists`, `Repositori dengan ID singkat ${body.slug} sudah ada`] } };
      }
      const provider = body.adapter !== 'managed_vault';
      const summary = (body.display?.configSummary as [string, string] | undefined) ?? (provider ? String((body.config as { driveId?: string }).driveId ?? '-') : ['Encryption per tenant', 'Enkripsi per tenant'] as [string, string]);
      const model: RepoModel = {
        ref: `sample-new-${body.slug}`,
        slug: body.slug,
        name: body.name,
        adapter: body.adapter as AdapterCode,
        modes: [...body.modes] as ModeCode[],
        ownershipType: body.ownershipType,
        connectionStatus: provider ? 'failed' : 'ok',
        message: provider ? ['No credential set: set the credential, then test the connection', 'Kredensial belum diatur: atur kredensial, lalu uji koneksi'] : null,
        summary,
        systems: [],
        last: '-',
        retentionConfirmed: body.retentionConfirmed,
        metadataMinimization: body.metadataMinimization,
        readOnly: false,
        credentialSet: false,
        credentialExpiresAt: null,
        config: { ...(body.config as Record<string, unknown>) },
        actions: ['test', ...(body.ownershipType === 'personal' ? ['moveToLibrary'] : [])],
      };
      session.byRef.set(model.ref, model);
      session.order.push(model.ref);
      return { ok: true, data: model };
    },
    async update(ref, body) {
      const session = current();
      const repo = session.byRef.get(ref);
      if (!repo) return notFound();
      const configChanged = body.config !== undefined && JSON.stringify(body.config) !== JSON.stringify(repo.config);
      const next: RepoModel = {
        ...repo,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.modes !== undefined ? { modes: [...body.modes] as ModeCode[] } : {}),
        ...(body.ownershipType !== undefined ? { ownershipType: body.ownershipType } : {}),
        ...(body.retentionConfirmed !== undefined ? { retentionConfirmed: body.retentionConfirmed } : {}),
        ...(body.metadataMinimization !== undefined ? { metadataMinimization: body.metadataMinimization } : {}),
        ...(body.config !== undefined ? { config: { ...(body.config as Record<string, unknown>) } } : {}),
        ...(body.display?.configSummary ? { summary: body.display.configSummary as [string, string] } : {}),
        ...(configChanged && repo.adapter !== 'managed_vault'
          ? { credentialSet: false, credentialExpiresAt: null, connectionStatus: 'failed' as const, message: ['The configuration changed: set the credential again', 'Konfigurasi berubah: atur ulang kredensial'] as [string, string] }
          : {}),
      };
      session.byRef.set(ref, next);
      return { ok: true, data: next };
    },
    async setCredential(ref, body) {
      const session = current();
      const repo = session.byRef.get(ref);
      if (!repo) return notFound();
      const delegated = body.kind === 'oauth_refresh_token';
      session.byRef.set(ref, {
        ...repo,
        credentialSet: true,
        credentialExpiresAt: body.kind === 'm365_certificate' ? '2027-10-28T00:00:00Z' : null,
        message: ['Credential set: test the connection', 'Kredensial diatur: uji koneksi'],
        actions: [...new Set([...repo.actions.filter((a) => a !== 'reauthorise'), ...(delegated ? ['reauthorise'] : [])])],
      });
      return { ok: true, data: null };
    },
    async test(ref) {
      const session = current();
      const repo = session.byRef.get(ref);
      if (!repo) return notFound();
      let outcome: TestOutcome;
      if (repo.adapter !== 'managed_vault' && !repo.credentialSet) {
        outcome = { status: 'failed', permissions: [], references: 0, nextCheckAt: null, message: ['No credential set: set the credential, then test the connection', 'Kredensial belum diatur: atur kredensial, lalu uji koneksi'] };
      } else if (repo.connectionStatus === 'revoked') {
        outcome = { status: 'revoked', permissions: [], references: 0, nextCheckAt: null, message: ['The delegated consent expired: grant consent again', 'Persetujuan delegasi kedaluwarsa: beri persetujuan lagi'] };
      } else {
        const where = repo.adapter === 'managed_vault' ? repo.name : `${repo.name}, ${String((repo.config.roots && Object.values(repo.config.roots as Record<string, { path?: string }>)[0]?.path) || '/')}`;
        outcome = {
          status: 'ok',
          permissions: repo.adapter === 'managed_vault' ? ['read', 'write'] : repo.adapter === 'm365' ? ['Sites.Selected: read', 'Sites.Selected: write'] : ['read', 'write'],
          references: repo.systems.length ? 12 * repo.systems.length : 0,
          nextCheckAt: '2026-09-30T02:30:00Z',
          message: [`Connected to ${where}`, `Terhubung ke ${where}`],
        };
      }
      session.byRef.set(ref, { ...repo, connectionStatus: outcome.status, message: outcome.status === 'ok' ? null : outcome.message, last: '29 Sep 2026 10:15' });
      return { ok: true, data: outcome };
    },
    async consent(ref) {
      const repo = current().byRef.get(ref);
      if (!repo) return notFound();
      if (repo.adapter !== 'google_drive' || typeof repo.config.oauthClientId !== 'string') {
        return { ok: false, error: { status: 409, slug: 'conflict', message: ['The repository uses app-only credentials; there is nothing to authorise', 'Repositori memakai kredensial aplikasi; tidak ada yang perlu diotorisasi'] } };
      }
      return { ok: true, data: { redirectUrl: null }, message: ['Sample build: no consent page opens; the consent is taken as given.', 'Build contoh: halaman persetujuan tidak dibuka; persetujuan dianggap diberikan.'] };
    },
  };
}
