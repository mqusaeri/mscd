// Sample adapter of the Management systems screen (MILESTONE-2 M2-09): the systems of the sample organisation
// (`MS` of the sample snapshot) with the packs of their editions and the sample repositories. Changes stay for the
// browser session, kept per organisation so the organisation switcher shows each organisation's own systems; a new
// system starts in setup without an MS Manager, so "Start implementation" is refused for it as the api refuses it.
import type { ManagementSystemCreate } from '@mscd/shared';
import type { ControllerData } from '../../data/types';
import { sampleOrgKey } from '../storage-admin/sampleOrg';
import type { MsStatusCode, PackChoice, Result, SystemModel, SystemsAdapter, SystemsData } from './model';

/** The sample's systems and the state the demo shows them in. */
const SAMPLE_STATUS: Readonly<Record<string, MsStatusCode>> = { isms: 'certified', qms: 'transitioning', bcms: 'implementing', abms: 'setup' };

/** Installed packs of the sample installation (the editions of the sample systems). */
export const SAMPLE_PACKS: readonly PackChoice[] = [
  { packId: 'ISO27001-2022', version: '1.3.0', frameworkCode: 'ISO27001', edition: '2022', status: 'installed', preRelease: false },
  { packId: 'ISO9001-2015', version: '1.5.0', frameworkCode: 'ISO9001', edition: '2015', status: 'installed', preRelease: false },
  { packId: 'ISO9001-2026', version: '0.10.0', frameworkCode: 'ISO9001', edition: '2026', status: 'installed', preRelease: true },
  { packId: 'ISO22301-2019', version: '1.1.0', frameworkCode: 'ISO22301', edition: '2019', status: 'installed', preRelease: false },
  { packId: 'ISO37001-2025', version: '0.7.0', frameworkCode: 'ISO37001', edition: '2025', status: 'installed', preRelease: true },
];

/** Entries a new system gets from the pack in the sample (D2-09: 93 controls and 30 clause rows for ISO/IEC 27001). */
const SAMPLE_ENTRIES: Readonly<Record<string, number>> = { ISO27001: 123, ISO9001: 84, ISO22301: 59, ISO37001: 51 };

const FRAMEWORK_OF: Readonly<Record<string, string>> = { 'ISO/IEC 27001': 'ISO27001', 'ISO 9001': 'ISO9001', 'ISO 22301': 'ISO22301', 'ISO 37001': 'ISO37001' };

export function fromSampleSystem(m: ControllerData['MS'][number], D: ControllerData | null): SystemModel {
  const [edition, target = null] = String(m.ed).split(' to ').map((s) => s.trim());
  const frameworkCode = FRAMEWORK_OF[m.code] ?? m.code.replace(/[^A-Z0-9]/g, '');
  const pack = SAMPLE_PACKS.find((p) => p.frameworkCode === frameworkCode && p.edition === edition);
  return {
    id: `sample-${m.id}`,
    slug: m.id,
    code: m.short,
    name: [m.name[0], m.name[1]],
    frameworkCode,
    frameworkName: m.code,
    edition,
    packId: pack?.packId ?? `${frameworkCode}-${edition}`,
    packVersion: pack?.version ?? '-',
    transitionTargetEdition: target,
    status: SAMPLE_STATUS[m.id] ?? 'implementing',
    scopeStatement: m.scope,
    certificationBody: m.certifier || null,
    color: m.color,
    defaultRepository: m.loc,
    primaryManager: m.mgr && m.mgr !== 'none' ? D?.PEOPLE?.[m.mgr]?.[0] ?? m.mgr : null,
  };
}

// The systems of this session per organisation (`sampleOrgKey`), with the changes made to them.
const sessions = new Map<string, SystemModel[]>();

/** Forgets the changes of this session (unit tests). */
export function resetSampleSystems(): void {
  sessions.clear();
}

/** The session's systems of the snapshot's organisation, made from the snapshot on first use. */
function systemsOf(D: ControllerData | null): SystemModel[] {
  const key = sampleOrgKey(D);
  let systems = sessions.get(key);
  if (!systems) {
    systems = (D?.MS ?? []).map((m) => fromSampleSystem(m, D));
    sessions.set(key, systems);
  }
  return systems;
}

export function sampleSystemsData(D: ControllerData | null): SystemsData {
  return {
    systems: systemsOf(D).map((s) => ({ ...s })),
    packs: SAMPLE_PACKS.map((p) => ({ ...p })),
    repos: (D?.REPOS ?? []).map((r) => ({ slug: r.id, name: r.name })),
    sample: true,
  };
}

const conflict = (en: string, id: string): Result<never> => ({ ok: false, error: { status: 409, slug: 'conflict', message: [en, id] } });

export function createSampleAdapter(getD: () => ControllerData | null): SystemsAdapter {
  const all = () => systemsOf(getD());
  return {
    async load() {
      return { ok: true, data: sampleSystemsData(getD()) };
    },
    async create(body: ManagementSystemCreate) {
      const systems = all();
      if (systems.some((s) => s.slug === body.slug || s.code === body.code)) {
        return conflict(`A management system with the ${systems.some((s) => s.slug === body.slug) ? 'short id' : 'code'} exists`, `Sistem manajemen dengan ${systems.some((s) => s.slug === body.slug) ? 'ID singkat' : 'kode'} tersebut sudah ada`);
      }
      const pack = SAMPLE_PACKS.find((p) => p.packId === body.packId);
      if (!pack) return { ok: false, error: { status: 400, slug: 'validation', message: ['Check the fields', 'Periksa kolom'], errors: [{ path: 'body.edition', message: `Edition ${body.edition} of pack ${body.packId} is not installed` }] } };
      const system: SystemModel = {
        id: `sample-new-${body.slug}`,
        slug: body.slug,
        code: body.code,
        name: body.name,
        frameworkCode: pack.frameworkCode,
        frameworkName: pack.frameworkCode.replace(/^ISO27001$/, 'ISO/IEC 27001').replace(/^ISO(\d+)$/, 'ISO $1'),
        edition: pack.edition,
        packId: pack.packId,
        packVersion: pack.version,
        transitionTargetEdition: null,
        status: 'setup',
        scopeStatement: body.scopeStatement,
        certificationBody: body.certificationBody ?? null,
        color: body.color,
        defaultRepository: body.defaultRepository,
        primaryManager: null,
      };
      systems.push(system);
      return { ok: true, data: { ...system }, message: [`${body.code} created with ${SAMPLE_ENTRIES[pack.frameworkCode] ?? 0} entries`, `${body.code} dibuat dengan ${SAMPLE_ENTRIES[pack.frameworkCode] ?? 0} entri`] };
    },
    async update(id, body) {
      const systems = all();
      const system = systems.find((s) => s.id === id);
      if (!system) return { ok: false, error: { status: 404, slug: 'not-found', message: ['Unknown management system', 'Sistem manajemen tidak dikenal'] } };
      if (system.status === 'archived') return conflict('The management system is archived; its data stays stored but no longer changes', 'Sistem manajemen telah diarsipkan; datanya tetap tersimpan tetapi tidak lagi berubah');
      if (body.status === 'implementing') {
        if (system.status !== 'setup') return conflict(`The system is ${system.status}`, `Sistem berstatus ${system.status}`);
        if (!system.primaryManager) return conflict('Assign at least one MS Manager before the system moves to implementing.', 'Tetapkan minimal satu Manajer SM sebelum sistem berpindah ke tahap implementasi.');
      }
      if (body.status === 'archived' && system.status === 'implementing' && system.slug === 'bcms') {
        return conflict('Close the active certification cycle before archiving the system.', 'Tutup siklus sertifikasi yang aktif sebelum mengarsipkan sistem.');
      }
      Object.assign(system, {
        ...(body.scopeStatement !== undefined ? { scopeStatement: body.scopeStatement } : {}),
        ...(body.certificationBody !== undefined ? { certificationBody: body.certificationBody } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.defaultRepository !== undefined ? { defaultRepository: body.defaultRepository } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      return { ok: true, data: { ...system } };
    },
  };
}
