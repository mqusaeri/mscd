# access-reviews module
Periodic access review (Milestone 3 D.9, M3-07): every 3 months by default (H.9) the daily `access-review.open` job opens
a review with a snapshot of every right in force. The Tenant Admins review the organisation part (memberships, admin
roles, linked company sign-in); the Management System Managers and Programme Owners of each system review its part
(business roles, guest auditor grants). Nobody decides on their own access. Decided revocations are applied through the
existing services by people who hold those rights, and the completed review is filed as evidence (for ISO/IEC 27001,
control A.5.18 access rights). Owner: M3-07.

| File | Content |
|---|---|
| `access-reviews.controller.ts`, `ms-access-reviews.controller.ts` | The fifteen routes of `packages/shared/src/api/access-reviews.ts` |
| `access-reviews.service.ts` | Settings with `If-Match`, the list and one review, decisions with REVIEW-OWN-ACCESS, sign-off with the A.5.18 evidence proposal, completion (report in the vault, each system's rows filed as evidence), cancel, the report CSV |
| `access-review-apply.service.ts` | Applying a decided revocation through the role, membership, linked sign-in and guest grant services, "Mark as applied" and "Not applied" |
| `access-review-open.service.ts`, `access-review-open.job.ts` | Opening a review (number, parts, snapshot, tasks, notices, next due date) and the daily run with its reminders |
| `access-review-snapshot.ts` | The items each review takes, by kind |
| `access-review-data.ts` | Reads and API views (with the requester and approver of a business role), the reviewers of each part, the "needs a second reviewer" rule (REVIEW-SINGLE-ADMIN) and a part nobody may review (`noReviewer`) |
| `access-review-text.ts` | Notices, the task title, refusals and the report columns in English and Indonesian |

The linked company sign-in of a member is removed by `admin-users/identities.service.ts` (`admin.users.identities.remove`).
