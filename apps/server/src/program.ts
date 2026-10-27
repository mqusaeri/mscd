import { Command } from 'commander';
import * as admin from './cli/admin';
import * as api from './cli/api';
import * as backup from './cli/backup';
import * as db from './cli/db';
import * as diagnostics from './cli/diagnostics';
import * as keys from './cli/keys';
import * as license from './cli/license';
import * as migrate from './cli/migrate';
import * as packs from './cli/packs';
import * as seed from './cli/seed';
import * as storageGateway from './cli/storage-gateway';
import * as tenant from './cli/tenant';
import * as worker from './cli/worker';
import { BUILD_FLAVOR, REVISION, VERSION } from './generated/build-info';

/** Every command module of `src/cli` exports `register(program)` (B.4). */
const COMMANDS: readonly { register(program: Command): void }[] = [
  api,
  worker,
  storageGateway,
  migrate,
  db,
  tenant,
  packs,
  keys,
  admin,
  seed,
  // Milestone 2 (D.3): stubs of M2-02, filled by M2-06 and M2-S10 (license), M2-S07 (backup) and M2-S09 (diagnostics).
  license,
  backup,
  diagnostics,
];

/** The `mscd-server` command line: run modes and admin commands of D-01. */
export function buildProgram(): Command {
  const program = new Command('mscd-server')
    .description('MSCD server. Run modes: api, worker, storage-gateway, migrate. The profile comes from MSCD_PROFILE_FILE.')
    .version(`${VERSION} (${BUILD_FLAVOR} build, revision ${REVISION})`, '-V, --version')
    .showHelpAfterError();
  for (const command of COMMANDS) command.register(program);
  return program;
}
