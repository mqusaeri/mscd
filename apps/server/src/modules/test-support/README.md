# test-support module

Test-only routes of build plan D.3 "Test support" (WP-27), used by the API end-to-end suite (J.6):

- `POST /api/v1/test/reset`: holds new requests and waits for running ones (`request-gate.ts`). When the write
  tracker (`write-tracker.ts`, M2-21) saw a write since the last reset, it closes the pack installer pool, drops the
  api's database and creates it again from `test.template_database` through the administrator URL of
  `test.admin_database_url_file` (`database-reset.ts`, grants of the template included, `STRATEGY FILE_COPY` on
  PostgreSQL 15 and later) and checks the app pool. When nothing wrote, it only deletes the sessions that
  `POST /test/session` minted since the last reset, over an administrator connection it keeps open between such
  resets (closed before a drop and when the api stops). Either way it resets the mock providers
  (`POST /_admin/reset`) while the database is put back, and then clears the organisation, OIDC discovery and licence
  caches.
- `POST /api/v1/test/session {handle, org?}`: an active session (`auth_method = 'test'`, no second factor) for an
  active person, in the given organisation or the user's default one; answers `Me` and sets the session cookie.

A write is a request other than GET, HEAD or OPTIONS (the test routes excepted), a GET of a sign-in start or callback
or of the storage consent callback, an audit entry, or a job run in the api process. Rows changed directly in the
database are not seen: a test changes data through the api. The first reset after the api starts always recreates the
database, and `MSCD_TEST_RESET_ALWAYS=1` makes every reset recreate it. The integration test `test/int/test-support`
depends on that first-reset rule: it changes rows with direct SQL before its first real reset.

Both routes answer 404 unless the profile has `demo.enabled: true` and `test.endpoints_enabled: true` (`test-mode.ts`);
the release flavour refuses every `test.*` key at start-up. Without both flags the request gate and the write tracker
install nothing. Every call is logged at `warn` by the authorisation guard.
