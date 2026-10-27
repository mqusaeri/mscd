import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/**
 * `diagnostics` (Milestone 2 D.3, K.6): registered by M2-02 with a stub action that exits 2. M2-S09 fills it: the
 * redacted archive of `POST /ops/diagnostics`, written without the api running.
 */
export function register(program: Command): void {
  program
    .command('diagnostics')
    .description('Write the redacted diagnostics archive (profile without secrets, versions, migrations, queues, logs) to a file')
    .option('--out <file>', 'archive file to write (.tar.gz)')
    .action(notImplemented('diagnostics', 'M2-S09'));
}
