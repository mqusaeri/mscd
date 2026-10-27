// Organisation-wide maps of the organisation snapshot (G.5 `EXAMPLES`, `CLAUSE_AT_RISK`): each system keeps its own
// entries under its slug, so rows or stages of two systems with the same key never share one (M2-04).
import { describe, expect, it } from 'vitest';
import { clausesAtRisk, evidenceExamples, exampleKeysByMs, systemKey } from '../../../src/modules/read-model/build/organisation';
import type { StageDef } from '../../../src/modules/read-model/derive/inputs';

const SYSTEMS: { slug: string; examples: Record<string, string> }[] = [
  { slug: 'isms', examples: { '7.2': 'Visitor log of the secure area', 'cl-7.2': 'Competence records of the ISMS roles' } },
  { slug: 'qms', examples: { '7.2': 'Training record with competence evaluation', '4.1': 'Context review minutes' } },
  { slug: 'abms', examples: { '4.1': 'Bribery context assessment' } },
];

describe('EXAMPLES per system (G.5, M2-04)', () => {
  it('keys every example by its system and the key of its row', () => {
    expect(systemKey('qms', '7.2')).toBe('qms:7.2');
    expect(evidenceExamples(SYSTEMS)).toEqual({
      'isms:7.2': 'Visitor log of the secure area',
      'isms:cl-7.2': 'Competence records of the ISMS roles',
      'qms:7.2': 'Training record with competence evaluation',
      'qms:4.1': 'Context review minutes',
      'abms:4.1': 'Bribery context assessment',
    });
  });

  it('keeps the example of a later system whose row has the number of an earlier system’s row', () => {
    const examples = evidenceExamples(SYSTEMS);
    // QMS 7.2 Competence and Annex A 7.2 Physical entry; ABMS 4.1 after QMS 4.1.
    expect(examples['qms:7.2']).toBe('Training record with competence evaluation');
    expect(examples['isms:7.2']).toBe('Visitor log of the secure area');
    expect(examples['abms:4.1']).toBe('Bribery context assessment');
    expect(examples).not.toHaveProperty('7.2');
  });

  it('gives the scope policy the keys of each system as EXAMPLES lists them', () => {
    const keys = exampleKeysByMs(SYSTEMS);
    expect(keys).toEqual({ isms: ['isms:7.2', 'isms:cl-7.2'], qms: ['qms:7.2', 'qms:4.1'], abms: ['abms:4.1'] });
    const examples = evidenceExamples(SYSTEMS);
    for (const list of Object.values(keys)) for (const key of list) expect(examples).toHaveProperty([key]);
  });
});

function stage(key: string, clauseAtRisk: string | null): StageDef {
  return { key, position: 0, labelEn: key, labelId: key, questionEn: '', source: 'entity', entityType: null, riskProfileCode: null, clauseAtRisk, overviewClause: 8, gateTypeLabel: null };
}

describe('CLAUSE_AT_RISK per system (G.5, M2-04)', () => {
  it('keys the clause of every stage by its system, so the ABMS control stage keeps 8.1 after the ISMS one', () => {
    const systems = [
      { slug: 'isms', stages: [stage('risk', '6.1.2'), stage('control', '6.1.3 d)')] },
      { slug: 'abms', stages: [stage('brisk', '4.5'), stage('control', '8.1'), stage('associate', null)] },
    ];
    expect(clausesAtRisk(systems)).toEqual({ 'isms:risk': '6.1.2', 'isms:control': '6.1.3 d)', 'abms:brisk': '4.5', 'abms:control': '8.1' });
  });
});
