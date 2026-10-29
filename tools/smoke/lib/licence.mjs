// Signs the journey's licence with the development licence key (MILESTONE-2 M2-18). The development keys are public
// (packages/pack-tools/dev-keys/README.md) and only the demo server image accepts them, so a licence signed here never
// works on a release. The signed file goes to the temporary folder of the run, never into the repository.
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { licenceDocument } from './journey-data.mjs';
import { ROOT } from './stack.mjs';

export const PACK_TOOLS_CLI = path.join(ROOT, 'packages/pack-tools/dist/cli.js');
export const DEV_LICENCE_KEY = path.join(ROOT, 'packages/pack-tools/dev-keys/licence-signing.key');

/** Signs the licence of an organisation into `dir` with `packages/pack-tools/dist/cli.js licence sign`; returns its path. */
export function signLicence(dir, { orgId, orgName, today }) {
  const unsigned = path.join(dir, `licence-${orgId}.unsigned.json`);
  const signed = path.join(dir, `licence-${orgId}.json`);
  writeFileSync(unsigned, `${JSON.stringify(licenceDocument({ orgId, orgName, today }), null, 2)}\n`, { mode: 0o600 });
  try {
    const r = spawnSync(process.execPath, [PACK_TOOLS_CLI, 'licence', 'sign', unsigned, '--key-file', DEV_LICENCE_KEY, '--out', signed], { cwd: ROOT, encoding: 'utf8' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`licence sign failed: ${(r.stderr || r.stdout).trim()}`);
  } finally {
    rmSync(unsigned, { force: true });
  }
  return signed;
}
