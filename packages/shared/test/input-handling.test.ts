// Input handling that code scanning checks (M2-S13 security clean-up): the problem `type` pattern names exactly the
// host of PROBLEM_TYPE_BASE, and the server version check runs in linear time on any input.
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_PROBLEM_SLUGS, PROBLEM_SLUGS, PROBLEM_TYPE_BASE, PROBLEM_TYPE_RE, Problem, engineVersionSatisfies, problemType,
} from '../src/index.js';

const problem = (type: string) => ({ type, title: 'Invalid request', status: 400, requestId: 'req-12345678' });

describe('PROBLEM_TYPE_RE (D.1)', () => {
  it('is PROBLEM_TYPE_BASE with every special character escaped, followed by a slug', () => {
    const escaped = PROBLEM_TYPE_BASE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    expect(PROBLEM_TYPE_RE.source).toBe(`^${escaped}[a-z][a-z-]*$`);
    expect(PROBLEM_TYPE_RE.flags).toBe('');
  });

  it('accepts the type of every problem slug of the api and the gateway', () => {
    for (const slug of [...PROBLEM_SLUGS, ...GATEWAY_PROBLEM_SLUGS]) {
      expect(PROBLEM_TYPE_RE.test(problemType(slug)), slug).toBe(true);
      expect(Problem.safeParse(problem(problemType(slug))).success, slug).toBe(true);
    }
  });

  it('refuses a type on another host, even one that differs only where the base has a dot', () => {
    for (const type of [
      'https://mscdXcyberlentera.com/problems/validation',
      'https://mscd.cyberlenteraXcom/problems/validation',
      'https://mscd.cyberlentera.com.example.com/problems/validation',
      'https://evil.example/https://mscd.cyberlentera.com/problems/validation',
      'http://mscd.cyberlentera.com/problems/validation',
      `${PROBLEM_TYPE_BASE}Validation`,
      `${PROBLEM_TYPE_BASE}`,
    ]) {
      expect(PROBLEM_TYPE_RE.test(type), type).toBe(false);
      expect(Problem.safeParse(problem(type)).success, type).toBe(false);
    }
  });
});

describe('engineVersionSatisfies on long input (E.8 step 3)', () => {
  it('ignores build metadata after the first plus sign', () => {
    expect(engineVersionSatisfies('1.1.0+a+b+c', '1.1.0')).toBe(true);
    expect(engineVersionSatisfies('1.0.0+a+b+c', '1.1.0')).toBe(false);
    expect(engineVersionSatisfies('1.1.0-rc.1+build', '1.1.0')).toBe(true);
  });

  it('answers at once for a version of 100,000 plus signs or hyphens', () => {
    const started = performance.now();
    expect(engineVersionSatisfies('+'.repeat(100_000), '1.1.0')).toBe(true);
    expect(engineVersionSatisfies(`${'+'.repeat(100_000)}\n`, '1.1.0')).toBe(true);
    expect(engineVersionSatisfies(`1.0.0${'+'.repeat(100_000)}`, '1.1.0')).toBe(false);
    expect(engineVersionSatisfies(`1.1.0-${'-'.repeat(100_000)}`, '1.1.0')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
