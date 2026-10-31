import { Module } from '@nestjs/common';
import { TestRequestGate } from './request-gate';
import { TestSupportController } from './test-support.controller';
import { TestSupportService } from './test-support.service';
import { TestWriteTracker } from './write-tracker';

/**
 * Test-only reset and session endpoints (D.3 Test support, J.6, WP-27): `POST /test/reset` recreates the database from
 * the template database, resets the mock providers and clears in-memory caches; `POST /test/session` mints an active
 * session for a user. They answer only with `demo.enabled` and `test.endpoints_enabled` (the guard answers 404
 * otherwise, and release builds refuse both keys). The request gate that lets a reset drain running requests, and the
 * write tracker that lets a reset skip the database when nothing wrote since the last one (M2-21), work only when the
 * endpoints are enabled.
 */
@Module({
  controllers: [TestSupportController],
  providers: [TestWriteTracker, TestRequestGate, TestSupportService],
})
export class TestSupportModule {}
