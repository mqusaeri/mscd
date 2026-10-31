// The pseudonyms of erased people in the platform audit extract of the organisation export (Milestone 3 D.4), without
// a database: a string that is an identifying value of an erased person as a whole (an email address in any case, a
// handle, a display name) becomes the pseudonym anywhere in a value, and a string that only contains one of them stays
// as stored, so the export never holds text that MSCD did not store.
import { describe, expect, it } from 'vitest';
import { pseudonymise } from '../../../src/modules/org-export/platform-data';

const PSEUDONYM = 'Former user 7F3A';
const VALUES = new Map([
  ['ana.putri@example.test', PSEUDONYM],
  ['ana.putri', PSEUDONYM],
  ['Ana', PSEUDONYM],
]);

describe('pseudonyms of erased people in the export (D.4)', () => {
  it('replaces whole identifying values, an email address in any case', () => {
    expect(pseudonymise('Ana', VALUES)).toBe(PSEUDONYM);
    expect(pseudonymise(' ana.putri ', VALUES)).toBe(PSEUDONYM);
    expect(pseudonymise('Ana.Putri@Example.TEST', VALUES)).toBe(PSEUDONYM);
    expect(pseudonymise({ email: 'ana.putri@example.test', displayName: 'Ana', roles: ['ana.putri', 'auditor'] }, VALUES)).toEqual({
      email: PSEUDONYM,
      displayName: PSEUDONYM,
      roles: [PSEUDONYM, 'auditor'],
    });
  });

  it('keeps text that only contains a short name, and every value that is not a string', () => {
    expect(pseudonymise('Banana supplier review', VALUES)).toBe('Banana supplier review');
    expect(pseudonymise('Anastasia', VALUES)).toBe('Anastasia');
    expect(pseudonymise('ana', VALUES)).toBe('ana');
    expect(pseudonymise('notana.putri@example.test', VALUES)).toBe('notana.putri@example.test');
    expect(pseudonymise({ title: 'Plan for Ana and Budi', count: 3, ok: true, none: null }, VALUES)).toEqual({ title: 'Plan for Ana and Budi', count: 3, ok: true, none: null });
    expect(pseudonymise('Ana', new Map())).toBe('Ana');
  });
});
