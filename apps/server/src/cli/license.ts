import type { Command } from 'commander';
import { sql } from 'kysely';
import { ConfigError, type MscdConfig } from '../config/mscd-config';
import { exitOnConfigError, loadConfigOrExit } from '../config/run-context';
import { createKysely } from '../db/kysely';
import type { DB } from '../db/types';

/**
 * `license` commands (Milestone 2 D.3): `license show-id` prints the installation id that a licence of kind
 * `installation` binds to (M2-06), so the operator can ask for a licence before the web app is used. M2-S10 adds
 * `license entitlements show` and `set`.
 */
export function register(program: Command): void {
  const license = program.command('license').description('Licence of the installation and entitlements of organisations');
  license
    .command('show-id')
    .description('Print the installation id that a licence binds to')
    .action(async () => {
      const config = loadConfigOrExit('cli');
      try {
        process.stdout.write(`${await licenseShowId(config)}\n`);
      } catch (error) {
        if (error instanceof ConfigError) exitOnConfigError(error);
        process.stderr.write(`license show-id failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

/**
 * The installation id (`platform.installation.id`, written once by the first platform migration). Read with the
 * application role, which may read the table; the migrator role when only it is configured.
 */
export async function licenseShowId(config: MscdConfig): Promise<string> {
  let url: string;
  try {
    url = config.databaseUrl('app');
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    url = config.databaseUrl('migrator');
  }
  // A short-lived connection of this command (no injected pool exists in a CLI process); the table is not tenant data.
  const connection = createKysely<DB>({ connectionString: url, max: 1, applicationName: 'mscd-license-show-id' });
  try {
    const { rows } = await sql<{ id: string }>`select id from platform.installation limit 1`.execute(connection);
    const id = rows[0]?.id;
    if (!id) throw new Error('The platform tables have no installation row; run "mscd-server migrate" first');
    return id;
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') throw new Error('The platform tables do not exist yet; run "mscd-server migrate" first', { cause: error });
    throw error;
  } finally {
    await connection.destroy();
  }
}
