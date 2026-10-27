// Clause entries of a catalogue system (MILESTONE-2 D2-09): requirement rows with the key cl-<code>, as the read model
// sends them for ISO/IEC 27001 once M2-07 loads them. The sample ISMS holds Annex A controls only, so the unit test of
// the Controls grouping adds these to a sample bundle.
export interface ClauseEntry {
  id: string;
  key: string;
  title: string;
  theme: string;
  st: 'implemented' | 'partial' | 'ns';
  owner: string;
  doc: string;
  freq: 'annual';
  note: string;
  gate: boolean;
  just: string;
  risks: string[];
}

const entry = (id: string, key: string, title: string, st: ClauseEntry['st']): ClauseEntry => ({
  id, key, title, theme: `Clause ${key.slice(3).split('.')[0]}`, st, owner: 'rina', doc: 'POL-01', freq: 'annual', note: '', gate: false, just: 'Always applicable', risks: [],
});

/** Three clause entries: two with the Cl. id of the read model and one whose id is the raw key. */
export function clauseFixture(): ClauseEntry[] {
  return [
    entry('Cl. 4.1', 'cl-4.1', 'Understanding the organisation and its context', 'implemented'),
    entry('Cl. 4.2', 'cl-4.2', 'Needs and expectations of interested parties', 'partial'),
    entry('cl-5.1', 'cl-5.1', 'Leadership and commitment', 'ns'),
  ];
}
