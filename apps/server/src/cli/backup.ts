import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/**
 * `backup` commands (Milestone 2 D.3, K.6): registered by M2-02 with stub actions that exit 2. M2-S07 fills `backup
 * verify`, which checks the database, the gateway, the tenant data keys, a sample of vault objects and the head of
 * the audit chain against the newest signed anchor.
 */
export function register(program: Command): void {
  const backup = program.command('backup').description('Backup checks of the SaaS track (Milestone 2 M2-S07)');
  backup
    .command('verify')
    .description('Check that a restored installation is complete and readable; prints a JSON summary, exit 1 on any failure')
    .option('--sample <n>', 'vault objects to open per organisation')
    .option('--write-probe', 'write small probe objects (only with MSCD_SAAS_TEST=1)')
    .action(notImplemented('backup verify', 'M2-S07'));
}
