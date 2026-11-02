// Preload entry of OpenTelemetry tracing with automatic instrumentation (see telemetry.ts):
//
//   NODE_OPTIONS="--require /app/dist/modules/observability/otel-preload.js" node /app/dist/main.js api
//
// It reads the same profile as the process (MSCD_PROFILE_FILE and MSCD__ overrides) and starts the SDK only when
// `telemetry.enabled` is true, synchronously, so the instrumentations are in place before the server loads its
// modules. Any problem is reported on stderr and the process starts without tracing: tracing never stops the
// service.
import { getNodeAutoInstrumentations, type InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK, resources } from '@opentelemetry/sdk-node';
import { loadProfile } from '../../config/load-profile';
import { BUILD_FLAVOR, VERSION } from '../../generated/build-info';
import { REDACTED_QUERY_PARAMETERS } from '../platform/logging';
import { markPreloaded, pathOnly, preloadedSdk, serviceName, tracesUrl } from './telemetry';

const RUN_MODES = new Set(['api', 'worker', 'storage-gateway']);
const QUIET_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/** The run mode named on the command line (`main.js api`), or null for admin commands. */
export function runModeOf(argv: readonly string[]): string | null {
  const mode = argv.slice(2).find((arg) => !arg.startsWith('-'));
  return mode !== undefined && RUN_MODES.has(mode) ? mode : null;
}

/**
 * Settings of the automatic instrumentations. File system, DNS and net spans are left out (noise, and file spans
 * would name secret files); query values of the F.12 parameters are redacted.
 *
 * The NestJS instrumentation is off as well: its release in auto-instrumentations-node 0.80.0 (0.68.0) patches
 * `@nestjs/core` below 12 only and would skip NestJS 12 without a word (M3-M02). Traces keep the HTTP server span of
 * each request and lack the NestJS request and handler spans. Turn it on again when a release supports the installed
 * `@nestjs/core`; test/unit/observability/otel-preload.test.ts fails at that point as a reminder.
 */
export function autoInstrumentationConfig(): InstrumentationConfigMap {
  return {
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-nestjs-core': { enabled: false },
    '@opentelemetry/instrumentation-http': {
      redactedQueryParams: [...REDACTED_QUERY_PARAMETERS, 'sig', 'signature', 'X-Amz-Signature', 'X-Amz-Credential'],
      redactedQueryParamsServer: [...REDACTED_QUERY_PARAMETERS],
      ignoreIncomingRequestHook: (request) => QUIET_PATHS.has(pathOnly(request.url ?? '/')),
    },
  };
}

/** Starts the OpenTelemetry Node SDK with the automatic instrumentations of `autoInstrumentationConfig`. */
export function startPreloadSdk(options: { endpoint: string; runMode: string }): NodeSDK {
  const sdk = new NodeSDK({
    resource: resources.resourceFromAttributes({ 'service.name': serviceName(options.runMode), 'service.version': VERSION }),
    traceExporter: new OTLPTraceExporter({ url: tracesUrl(options.endpoint) }),
    instrumentations: [getNodeAutoInstrumentations(autoInstrumentationConfig())],
  });
  sdk.start();
  markPreloaded(sdk);
  return sdk;
}

function preload(): void {
  const runMode = runModeOf(process.argv);
  if (runMode === null || preloadedSdk()) return;
  const { profile } = loadProfile({ env: process.env, flavor: BUILD_FLAVOR });
  if (!profile.telemetry.enabled || profile.telemetry.otlp_endpoint === null) return;
  startPreloadSdk({ endpoint: profile.telemetry.otlp_endpoint, runMode });
}

try {
  preload();
} catch (error) {
  process.stderr.write(`mscd-server: OpenTelemetry preload skipped: ${error instanceof Error ? error.message : String(error)}\n`);
}
