import { Controller } from '@nestjs/common';
import { systemProfileRoute, type SystemProfile } from '@mscd/shared';
import { ApiRoute } from '../../common/api-route';
import { MscdConfig } from '../../config/mscd-config';
import { buildSystemProfile } from './system-profile';

/**
 * `GET /api/v1/system/profile` (public), mounted from the shared route definition in run mode `api` only (D.1).
 * Milestone 2 D.2 (M2-S11): `legal` holds the public links of the privacy notice and the terms (profile keys
 * `legal.privacy_url` and `legal.terms_url`) for the footer of the sign-in page; a link that is not set is null and
 * the page hides it.
 */
@Controller()
export class SystemProfileController {
  constructor(private readonly config: MscdConfig) {}

  @ApiRoute(systemProfileRoute)
  profile(): SystemProfile {
    const legal = this.config.profile.legal;
    return { ...buildSystemProfile(this.config), legal: { privacyUrl: legal.privacy_url, termsUrl: legal.terms_url } };
  }
}
