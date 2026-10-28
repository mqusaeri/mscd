// DNS TXT lookups of the email domain verification (Milestone 2 K.6, M2-S11): `node:dns` with the resolvers of
// `network.dns_resolvers` (the system resolvers when the list is empty). A new resolver per lookup, so no answer is
// kept between two checks.
import { Resolver } from 'node:dns/promises';
import { Injectable, Logger } from '@nestjs/common';
import { MscdConfig } from '../../../config/mscd-config';
import { recordsHoldToken, txtNameOf } from './domain-names';

/** Time each resolver gets for one try, and the tries per lookup. */
const TIMEOUT_MS = 3_000;
const TRIES = 2;

/**
 * The result of one check: the record with the token is `found`; `missing` when the name has no TXT record
 * (`no_record`) or none holds the token (`no_match`); `unreachable` when no resolver gave an answer (time-out,
 * SERVFAIL, refused): nothing is known about the record then.
 */
export type TxtCheck =
  | { kind: 'found' }
  | { kind: 'missing'; detail: 'no_record' | 'no_match' }
  | { kind: 'unreachable'; code: string };

/** Answers of `resolveTxt` that say the record does not exist. */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

@Injectable()
export class DnsTxtChecker {
  private readonly logger = new Logger('DnsTxtChecker');

  constructor(private readonly config: MscdConfig) {}

  /** Looks up `_mscd-verify.<domain>` and compares its values with the stored token hash. */
  async check(domain: string, storedHash: Buffer): Promise<TxtCheck> {
    const name = txtNameOf(domain);
    const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: TRIES });
    const servers = this.config.profile.network.dns_resolvers;
    if (servers.length > 0) resolver.setServers([...servers]);
    try {
      const records = await resolver.resolveTxt(name);
      return recordsHoldToken(records, storedHash) ? { kind: 'found' } : { kind: 'missing', detail: 'no_match' };
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'EUNKNOWN';
      if (NO_RECORD.has(code)) return { kind: 'missing', detail: 'no_record' };
      this.logger.warn({ domain, code }, `The TXT record of ${domain} could not be looked up (${code})`);
      return { kind: 'unreachable', code };
    } finally {
      resolver.cancel();
    }
  }
}
