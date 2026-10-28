// Sample adapter of the Organisation screen: the settings of the sample organisation (name and sites of the sample
// snapshot, Asia/Jakarta, two administrators) and a sample installation id. A saved change stays for the browser
// session; the ETag moves with every save, so a second form with an older ETag gets the 412 the server answers.
import type { Organisation } from '../../data/types';
import type { Loaded, OrgAdapter, OrgSettings } from './model';

/** The installation id of the sample build (no real installation has it). */
export const SAMPLE_INSTALLATION_ID = '5a3e1c9d-7b2f-4c8e-9a1d-3f6b2e8c4d01';

/**
 * The tenancy mode of a sample organisation: a SaaS organisation runs on a service with several organisations. The
 * Licence screen's sample adapter uses the same rule for its installation id panel.
 */
export function sampleTenancyMode(org: Organisation | null | undefined): 'single' | 'multi' {
  return org?.deploy === 'saas' ? 'multi' : 'single';
}

const saved = new Map<string, OrgSettings>();

/** Forgets the changes of the session (unit tests). */
export function resetSampleOrganization(): void {
  saved.clear();
}

function initial(org: Organisation | null): OrgSettings {
  return {
    slug: org?.id ?? 'ndt',
    name: org?.name ?? 'PT Nusantara Digital Teknologi',
    timeZone: 'Asia/Jakarta',
    siteCount: org?.sites ?? 1,
    localLogin: 'allowed',
    installationId: SAMPLE_INSTALLATION_ID,
    tenancyMode: sampleTenancyMode(org),
    activeAdminCount: 2,
    etag: 'W/"1790380800000"',
  };
}

export function createSampleAdapter(getOrg: () => Organisation | null): OrgAdapter {
  const current = () => {
    const org = getOrg();
    const slug = org?.id ?? 'ndt';
    return saved.get(slug) ?? initial(org);
  };
  return {
    async load(): Promise<Loaded> {
      return { ok: true, settings: current() };
    },
    async save(patch, etag): Promise<Loaded> {
      const now = current();
      if (etag !== now.etag) {
        return { ok: false, error: { status: 412, slug: 'precondition-failed', message: ['The record was changed by someone else. Load it again.', 'Data diubah oleh orang lain. Muat ulang.'] } };
      }
      const version = Number(/\d+/.exec(now.etag)?.[0] ?? '0') + 1;
      const next: OrgSettings = { ...now, ...patch, etag: `W/"${version}"` };
      saved.set(next.slug, next);
      return { ok: true, settings: next };
    },
  };
}
