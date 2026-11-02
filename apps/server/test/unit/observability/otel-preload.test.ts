import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { autoInstrumentationConfig } from '../../../src/modules/observability/otel-preload';

// M3-M02: the NestJS instrumentation of auto-instrumentations-node 0.80.0 patches @nestjs/core below 12 only, so the
// preload turns it off (see autoInstrumentationConfig). The preload loads it through auto-instrumentations-node, and
// so does this test.
const fromServer = createRequire(__filename);
const fromAutoInstrumentations = createRequire(fromServer.resolve('@opentelemetry/auto-instrumentations-node'));

interface ModuleDefinition {
  name: string;
  supportedVersions: string[];
}
type NestInstrumentationClass = new (config: { enabled: boolean }) => { getModuleDefinitions(): ModuleDefinition[] };

/** Whether a range such as '>=4.0.0 <12' accepts the given major (the lower bound is far below every NestJS in use). */
function acceptsMajor(range: string, major: number): boolean {
  const bound = /<(=?)\s*(\d+)/.exec(range);
  if (bound === null) return true;
  const limit = Number(bound[2]);
  return bound[1] === '=' ? major <= limit : major < limit;
}

describe('OpenTelemetry preload settings', () => {
  it('leaves the file system, DNS, net and NestJS instrumentations off', () => {
    const config = autoInstrumentationConfig();
    expect(config['@opentelemetry/instrumentation-fs']).toEqual({ enabled: false });
    expect(config['@opentelemetry/instrumentation-dns']).toEqual({ enabled: false });
    expect(config['@opentelemetry/instrumentation-net']).toEqual({ enabled: false });
    expect(config['@opentelemetry/instrumentation-nestjs-core']).toEqual({ enabled: false });
    expect(config['@opentelemetry/instrumentation-http']?.enabled).not.toBe(false);
  });

  it('keeps the NestJS instrumentation off only while it does not support the installed NestJS', () => {
    const { version } = fromServer('@nestjs/core/package.json') as { version: string };
    const major = Number(version.split('.')[0]);
    const { NestInstrumentation } = fromAutoInstrumentations('@opentelemetry/instrumentation-nestjs-core') as {
      NestInstrumentation: NestInstrumentationClass;
    };
    const ranges = new NestInstrumentation({ enabled: false })
      .getModuleDefinitions()
      .filter((definition) => definition.name === '@nestjs/core')
      .flatMap((definition) => definition.supportedVersions);
    expect(ranges.length).toBeGreaterThan(0);
    const supported = ranges.some((range) => acceptsMajor(range, major));
    expect(
      supported,
      `the NestJS instrumentation now supports @nestjs/core ${version} (${ranges.join(', ')}): turn it on again in otel-preload.ts`,
    ).toBe(false);
  });
});
