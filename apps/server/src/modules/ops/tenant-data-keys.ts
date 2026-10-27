// The data key source of organisations created by the platform operator (`ops.organizations.create`, M2-06): the
// storage gateway of the profile (`POST /v1/keys/data-key`, D.5), as for `mscd-server tenant create`. A class of its own
// so a test application replaces the gateway with a local issuer.
import { Injectable } from '@nestjs/common';
import { MscdConfig } from '../../config/mscd-config';
import { GatewayDataKeyIssuer, gatewayDataKeyIssuer, type DataKeyIssuer } from '../../db/tenant-provisioner';

export interface OpenDataKeyIssuer {
  issuer: DataKeyIssuer;
  close(): Promise<void>;
}

@Injectable()
export class TenantDataKeys {
  constructor(private readonly config: MscdConfig) {}

  /** An issuer for one provisioning; the caller closes it. */
  open(): OpenDataKeyIssuer {
    const issuer = gatewayDataKeyIssuer(this.config);
    return { issuer, close: async () => (issuer instanceof GatewayDataKeyIssuer ? issuer.close() : undefined) };
  }
}
