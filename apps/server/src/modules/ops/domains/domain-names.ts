// Email domain names and DNS TXT tokens of the domain verification (Milestone 2 K.6, M2-S11). Pure functions, no I/O.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { DomainName } from '@mscd/shared';

/** The label in front of the domain that holds the TXT record. */
export const TXT_LABEL = '_mscd-verify';
/** The prefix of the TXT value; the token follows it. */
export const TXT_PREFIX = 'mscd-verify=';
/** Hourly checks of a pending domain stop this long after it was added (then it is `failed`). */
export const PENDING_DAYS = 7;
/** Verified domains with a DNS record are checked again after this many days (monthly). */
export const RECHECK_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Free mail providers, whose addresses anyone can get: a customer organisation cannot own one of these domains or a
 * domain under them (422 `domain_not_allowed`).
 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.id', 'yahoo.co.uk', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'outlook.co.id', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io',
  'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru',
  'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com', 'rediffmail.com',
];

/** Why a typed domain cannot be used. */
export type DomainNameProblem = 'invalid' | 'free_mail';

export type NormalisedDomain = { ok: true; domain: string } | { ok: false; problem: DomainNameProblem };

/**
 * The domain as `platform.verified_domain` stores it: trimmed, without a trailing dot, an address's part after `@`
 * when a whole address was typed, lower case, IDN labels in punycode (`Bücher.example` becomes
 * `xn--bcher-kva.example`), and checked against `DomainName` of the contract (the column's CHECK). Free mail
 * domains are refused.
 */
export function normaliseDomainName(input: string): NormalisedDomain {
  let value = input.trim();
  const at = value.lastIndexOf('@');
  if (at >= 0) value = value.slice(at + 1);
  value = value.replace(/\.$/, '');
  if (value === '' || /[\s/:?#\\]/.test(value)) return { ok: false, problem: 'invalid' };
  const ascii = domainToASCII(value.toLowerCase());
  if (!ascii || !DomainName.safeParse(ascii).success) return { ok: false, problem: 'invalid' };
  if (isFreeMailDomain(ascii)) return { ok: false, problem: 'free_mail' };
  return { ok: true, domain: ascii };
}

/** True for a free mail domain or a name under one. */
export function isFreeMailDomain(domain: string): boolean {
  const name = domain.toLowerCase();
  return FREE_MAIL_DOMAINS.some((free) => name === free || name.endsWith(`.${free}`));
}

/** The name of the TXT record of a domain. */
export function txtNameOf(domain: string): string {
  return `${TXT_LABEL}.${domain}`;
}

/** A new token: 32 random bytes, base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The SHA-256 of a token, the only form that is stored (`txt_token_hash`). */
export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** The TXT value the customer adds to DNS for a token. */
export function txtValueOf(token: string): string {
  return `${TXT_PREFIX}${token}`;
}

/**
 * Whether one of the TXT records (each the character strings `resolveTxt` returns for one record) holds the value of
 * the token whose hash is stored. Records are compared in constant time per record; white space around a value is
 * ignored, as DNS consoles sometimes add it.
 */
export function recordsHoldToken(records: readonly (readonly string[])[], storedHash: Buffer): boolean {
  let found = false;
  for (const chunks of records) {
    const value = chunks.join('').trim();
    if (!value.startsWith(TXT_PREFIX)) continue;
    const hash = tokenHash(value.slice(TXT_PREFIX.length).trim());
    if (hash.length === storedHash.length && timingSafeEqual(hash, storedHash)) found = true;
  }
  return found;
}

/** The end of the hourly checks of a domain added at `requestedAt`. */
export function pendingUntil(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + PENDING_DAYS * DAY_MS);
}

/** True when a pending domain added at `requestedAt` is past its checks at `now`. */
export function pendingExpired(requestedAt: Date | null, now: Date): boolean {
  return requestedAt !== null && pendingUntil(requestedAt).getTime() <= now.getTime();
}

/** The instant before which a verified domain's last check is due again. */
export function recheckBefore(now: Date): Date {
  return new Date(now.getTime() - RECHECK_DAYS * DAY_MS);
}
