# admin-users module

Members of the organisation and the Tenant Admin limits of F.6 (`GET`, `POST`, `PATCH /admin/users`, MFA reset, identity pre-registration), the organisation settings (`GET` and `PATCH /admin/organization`: local sign-in policy, name, time zone, number of sites; the slug is permanent; the GET sends the ETag of the organisation row and the PATCH takes it as `If-Match`, 412 when stale), the onboarding checklist (`GET /admin/onboarding`, sub-module `onboarding.module.ts`), and role grants with the four-eyes approval flow of C.13 (`/admin/management-systems/{id}/roles`).

An invitation of an existing active account sends the account email `membership_invited` and writes the notification `membership_invited` in the organisation the account signs in to (Milestone 2 D.2); the admin gets the same 202 as for a new email.

Owner: WP-39; Milestone 2 changes by M2-06.
