// The one switch of the test support module (build plan D.3 "Test support"): its routes, the request gate and the
// write tracker work only in demo mode with `test.endpoints_enabled`, which release builds refuse at start-up.
import type { MscdConfig } from '../../config/mscd-config';

/** True when the profile mounts the test routes (D.3): demo mode and `test.endpoints_enabled`. */
export function testEndpointsEnabled(config: MscdConfig): boolean {
  return config.profile.demo.enabled && config.profile.test?.endpoints_enabled === true;
}
