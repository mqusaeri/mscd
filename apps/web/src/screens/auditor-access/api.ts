// API adapter of the Auditor access screen (MILESTONE-2 M2-15) through the host's client (R-17): the grants of the
// system (`auditor-access.list`), a new grant with its length of 1 to 30 days (`auditor-access.grant`, which emails the
// link and never returns it, F.14), revoking (`auditor-access.revoke`) and the evidence packs (`evidence-packs.list`)
// with their manifests and archive, which the browser saves from the api's download links (the session cookie goes
// with them; the api answers with an attachment and audits `evidence_pack.downloaded`).
import type { AuditorAccessGrantView, AuditorAccessResult, CommandResult, EvidencePackView, Page } from '@mscd/shared';
import type { ApiClient } from '../../data/api/ApiClient';
import { call } from '../api';
import type { AuditorAccessAdapter, GrantModel, PackFile, PackModel } from './model';
import { ROUTES } from './routes';

export function fromGrant(g: AuditorAccessGrantView): GrantModel {
  return {
    id: g.id, email: g.email, createdBy: g.createdBy, createdAt: g.createdAt, expiresAt: g.expiresAt, linkUsedAt: g.linkUsedAt, lastUsedAt: g.lastUsedAt,
    revokedAt: g.revokedAt, revokedBy: g.revokedBy, active: g.active,
  };
}

/** The download link of a file of a pack: the api's manifest and archive links. */
export function packLink(view: Pick<EvidencePackView, 'manifestUrls' | 'archiveUrl'>, file: PackFile): string | null {
  if (file === 'manifest_pdf') return view.manifestUrls.pdf;
  if (file === 'manifest_csv') return view.manifestUrls.csv;
  return view.archiveUrl ?? null;
}

export function fromPack(p: EvidencePackView): PackModel & { links: Partial<Record<PackFile, string>> } {
  const files: PackFile[] = p.status === 'ready' ? ['manifest_pdf', 'manifest_csv', ...(p.archiveUrl ? ['archive' as const] : [])] : [];
  const links: Partial<Record<PackFile, string>> = {};
  for (const f of files) links[f] = packLink(p, f) ?? undefined;
  return { id: p.id, status: p.status, builtAt: p.builtAt, packFolder: p.packFolder, itemCount: p.itemCount, exceptionCount: p.exceptionCount, files, links };
}

const FILE_NAMES: Readonly<Record<PackFile, string>> = { manifest_pdf: 'manifest.pdf', manifest_csv: 'manifest.csv', archive: 'archive.zip' };

export function createApiAdapter(client: ApiClient | null): AuditorAccessAdapter {
  return {
    sample: false,
    async grants(ms) {
      const res = await call<AuditorAccessGrantView[]>(client, ROUTES.grants, { params: { ms } });
      return res.ok ? { ok: true, data: res.data.map(fromGrant) } : { ok: false, error: res.error };
    },
    async grant(ms, body, idempotencyKey) {
      const res = await call<AuditorAccessResult>(client, ROUTES.grant, { params: { ms }, body, idempotencyKey });
      if (!res.ok) return { ok: false, error: res.error };
      const message = res.data.message ? [res.data.message[0], res.data.message[1]] as const : null;
      return { ok: true, data: { grantId: res.data.data?.grantId ?? null, expiresAt: res.data.data?.expiresAt ?? null, message: message ? [message[0], message[1]] : null } };
    },
    async revoke(ms, grant) {
      const res = await call<CommandResult>(client, ROUTES.revoke, { params: { ms, id: grant.id } });
      return res.ok ? { ok: true, data: true } : { ok: false, error: res.error };
    },
    async packs(ms, page, pageSize) {
      const res = await call<Page<EvidencePackView>>(client, ROUTES.packs, { params: { ms }, query: { page, pageSize } });
      return res.ok ? { ok: true, data: { items: res.data.items.map(fromPack), total: res.data.total } } : { ok: false, error: res.error };
    },
    async download(ms, pack, file) {
      const known = (pack as PackModel & { links?: Partial<Record<PackFile, string>> }).links?.[file];
      const href = known ?? `/api/v1/ms/${encodeURIComponent(ms)}/evidence-packs/${encodeURIComponent(pack.id)}/download?file=${file}`;
      return { ok: true, data: { href, fileName: `${ms}-evidence-pack-${pack.id.slice(0, 8)}-${FILE_NAMES[file]}` } };
    },
  };
}
