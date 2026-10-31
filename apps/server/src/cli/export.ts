import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/**
 * `export` (Milestone 3 D.3, D.4): registered by M3-01 with stub actions that exit 2. M3-02 fills them:
 * - `export organization --out <dir>` builds the parts and the manifest of an organisation export into a folder for the
 *   customer's own IT, in single tenancy only (in multi tenancy it refuses and names the web app, because a server folder
 *   would let the operator read tenant data);
 * - `export verify --dir <dir>` checks every part and entry against the manifest and the audit chain against its anchors.
 */
export function register(program: Command): void {
  const exportCommand = program.command('export').description('Organisation export of single tenancy: build it into a folder, or check one');
  exportCommand
    .command('organization')
    .description('Build the organisation export (parts and manifest) into a folder; single tenancy only')
    .option('--out <dir>', 'folder to write the parts and the manifest to')
    .action(notImplemented('export organization', 'M3-02'));
  exportCommand
    .command('verify')
    .description('Check every part and entry of an organisation export against its manifest, and the audit chain against its anchors')
    .option('--dir <dir>', 'folder that holds the parts and the manifest')
    .action(notImplemented('export verify', 'M3-02'));
}
