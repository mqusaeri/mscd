import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { CertificateExpiryJob } from '../notifications/certificate-expiry.job';
import { CertificationController } from './certification.controller';
import { CertificateExpiryService } from './certification.expiry';
import { CertificationService } from './certification.service';

/**
 * Certification cycles, the certificate record and the `certificate.expiry` job (Milestone 2 D.4, M2-05), a sub-module
 * of `ManagementSystemsModule` (D.3). Cycle creation by the first opening audit event uses the plain steps of
 * `certification.cycles.ts` from the audit event commands.
 */
@Module({
  imports: [JobsModule],
  controllers: [CertificationController],
  providers: [CertificationService, CertificateExpiryService, CertificateExpiryJob],
  exports: [CertificationService, CertificateExpiryService],
})
export class CertificationModule {}
