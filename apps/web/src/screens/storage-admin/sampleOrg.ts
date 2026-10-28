// The organisation key of the sample adapters (MILESTONE-2 M2-09). The sample source gives each organisation its own
// systems, and the repositories and routing rules of those systems (SampleDataSource `#snapshot`), so the sample
// adapters of Management systems, Repository administration and Routing rules keep the changes of a browser session
// per organisation. A snapshot lists every organisation but does not name the selected one; its systems do, and they
// always match the lists the adapters read.
import type { ControllerData } from '../../data/types';

/** The key of a sample adapter's session state: the ids of the snapshot's systems, sorted. */
export function sampleOrgKey(D: ControllerData | null): string {
  return (D?.MS ?? []).map((m) => m.id).sort().join(',');
}
