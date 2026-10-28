// Domain names and TXT tokens of the email domain verification (Milestone 2 K.6, M2-S11): pure functions, no database.
import { describe, expect, it } from 'vitest';
import {
  FREE_MAIL_DOMAINS, isFreeMailDomain, newToken, normaliseDomainName, pendingExpired, pendingUntil, recordsHoldToken, tokenHash, txtNameOf, txtValueOf,
} from '../../../src/modules/ops/domains/domain-names';

describe('email domain names and TXT tokens', () => {
  it('normalises a typed domain: trimmed, lower case, no trailing dot, the part after @, IDN in punycode', () => {
    expect(normaliseDomainName(' Nusantara-Digital.CO.ID. ')).toEqual({ ok: true, domain: 'nusantara-digital.co.id' });
    expect(normaliseDomainName('rina@nusantaradigital.co.id')).toEqual({ ok: true, domain: 'nusantaradigital.co.id' });
    expect(normaliseDomainName('Bücher.example')).toEqual({ ok: true, domain: 'xn--bcher-kva.example' });
    for (const bad of ['', 'localhost', 'a..b.example', '-x.example', 'x.1234', 'http://x.example', 'a b.example', `${'a'.repeat(64)}.example`]) {
      expect(normaliseDomainName(bad), bad).toEqual({ ok: false, problem: 'invalid' });
    }
  });

  it('refuses free mail domains and names under them', () => {
    for (const free of ['gmail.com', 'yahoo.com', 'yahoo.co.id', 'outlook.com', 'hotmail.com']) {
      expect(FREE_MAIL_DOMAINS).toContain(free);
      expect(normaliseDomainName(free.toUpperCase())).toEqual({ ok: false, problem: 'free_mail' });
    }
    expect(isFreeMailDomain('mail.gmail.com')).toBe(true);
    expect(isFreeMailDomain('notgmail.com')).toBe(false);
  });

  it('makes 32-byte tokens, the record name and value, and finds the token in TXT records by its hash only', () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(token);
    expect(txtNameOf('ndt.co.id')).toBe('_mscd-verify.ndt.co.id');
    expect(txtValueOf(token)).toBe(`mscd-verify=${token}`);
    const hash = tokenHash(token);
    expect(hash).toHaveLength(32);
    expect(recordsHoldToken([['v=spf1 -all'], [`mscd-verify=${token}`]], hash)).toBe(true);
    // A long value split into character strings, with white space around it.
    expect(recordsHoldToken([[' mscd-verify=', `${token} `]], hash)).toBe(true);
    expect(recordsHoldToken([['mscd-verify=other']], hash)).toBe(false);
    expect(recordsHoldToken([[token]], hash)).toBe(false);
    expect(recordsHoldToken([], hash)).toBe(false);
  });

  it('ends the hourly checks 7 days after the domain was added', () => {
    const added = new Date('2026-10-20T03:00:00Z');
    expect(pendingUntil(added).toISOString()).toBe('2026-10-27T03:00:00.000Z');
    expect(pendingExpired(added, new Date('2026-10-27T02:59:59Z'))).toBe(false);
    expect(pendingExpired(added, new Date('2026-10-27T03:00:00Z'))).toBe(true);
    expect(pendingExpired(null, new Date())).toBe(false);
  });
});
