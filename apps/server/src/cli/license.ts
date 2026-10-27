import type { Command } from 'commander';
import { notImplemented } from './not-implemented';

/**
 * `license` commands (Milestone 2 D.3): registered by M2-02 with stub actions that exit 2. M2-06 fills `license
 * show-id` (the installation id for licence binding) and M2-S10 adds `license entitlements show` and `set`.
 */
export function register(program: Command): void {
  const license = program.command('license').description('Licence of the installation and entitlements of organisations');
  license
    .command('show-id')
    .description('Print the installation id that a licence binds to')
    .action(notImplemented('license show-id', 'M2-06'));
}
