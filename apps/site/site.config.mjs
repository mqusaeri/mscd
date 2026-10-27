// The two values the owner sets before the site goes live.
// After a change, run `node apps/site/apply-config.mjs` to write them into both pages,
// then `node apps/site/check.mjs`, which fails when a page still carries an old value.

/** Address of the MSCD web app. Every "Sign in" link points here (the app host's root). */
export const APP_URL = 'https://app.example.com/';

/** Address that receives demo requests. Shown as text and used by every "Request a demo" link. */
export const DEMO_EMAIL = 'sales@example.com';
