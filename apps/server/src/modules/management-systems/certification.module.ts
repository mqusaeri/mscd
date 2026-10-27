import { Module } from '@nestjs/common';
import { CertificateExpiryJob } from '../notifications/certificate-expiry.job';
import { CertificationController } from './certification.controller';

/**
 * Certification cycles, the certificate record and the `certificate.expiry` job (Milestone 2 D.4), a sub-module of
 * `ManagementSystemsModule` (D.3). Written by M2-02 with the route and job stubs; M2-05 adds its services here and
 * never edits the parent module.
 */
@Module({
  controllers: [CertificationController],
  providers: [CertificateExpiryJob],
})
export class CertificationModule {}
