# MOT-01 handoff: marketing landing site

## What was built

| Area | Files | Content |
|---|---|---|
| Pages | `apps/site/index.html`, `apps/site/id/index.html` | The public landing page in English and Indonesian, same structure and the same assets. Sections: hero, traceability test (`#product`), Harmonized Structure (`#frameworks`), three working areas (`#modules`), deployment and data (`#deployment`), security (`#security`), closing band, footer. Each page has a `<title>`, a meta description, `lang`, a favicon, a skip link and a language switch. No inline script and no inline style |
| Styles | `apps/site/assets/site.css` | Tokens of `apps/web/src/styles.css` (accent `#e8731a` dark, `#ad4f0b` light; inks, lines and status colours of the app), light and dark through `prefers-color-scheme`. The film stage stays dark in both themes, inset 12px (8px on phones) with a 28px radius. Self-hosted IBM Plex Sans 300 to 600 and IBM Plex Mono 400 and 500. Entrance (blur rise, 0.15 s to 2.4 s), scroll reveals, diagram details and every transition switch off with reduced motion |
| Behaviour | `apps/site/assets/site.js` | Small-screen menu (`aria-expanded`, Esc, outside tap, resize), paper style of the navigation below the hero, scroll reveals, film playback only while on screen, tab visible and motion allowed, diagram loops only while on screen, and the chain glow (below). Without the file the pages are complete |
| Hero film | `apps/site/assets/media/{thread.mp4,thread.webm,thread-poster.jpg}`, source in `apps/site/media-src/{thread.html,render.mjs}` | A 12 s, 1920x1080, 24 fps loop rendered for this site from a WebGL shader: one amber thread of three braided strands, dust and a few out-of-focus discs on `#0e0d0b`, with one light pulse travelling the thread per loop. Every motion term is periodic in the loop, so it loops without a seam. MP4 (H.264, 0.86 MB), WebM (VP9, 0.28 MB) and a JPEG poster (64 KB) of the frame at 5.5 s, where playback starts (`data-start`) |
| Signature | pages, `site.js` | The golden thread: the film behind the headline, and under it the six links Issue, Risk, Control, Document, Evidence, Finding on a hairline that draws itself on load. While the film plays, the link under the travelling pulse glows (`--g` per link, computed from `currentTime`, object position and the rendered width); on phones, where the links wrap into two rows, they glow one after another. The loop runs only while the film plays and resets on pause |
| Configuration | `apps/site/site.config.mjs`, `apps/site/apply-config.mjs` | `APP_URL` (every "Sign in" link, default `https://app.example.com/`) and `DEMO_EMAIL` (every "Request a demo" `mailto:` link and the address shown as text, default `sales@example.com`). `apply-config.mjs` writes them into the marked elements of both pages (`data-app-link`, `data-demo-link`, `data-demo-email`); `--check` reports a page that differs |
| Check | `apps/site/check.mjs` | See Tests |
| Assets | `apps/site/assets/fonts/*` (with `OFL-IBM-Plex.txt`), `apps/site/assets/img/{cyberlentera-logo.png,favicon.png,grain.png}` | Fonts copied from `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` 5.3.0 (latin WOFF2, SIL OFL 1.1). Logo resized from `project/assets/cyberlentera-logo.png`, shown on a cream chip as in the app; the favicon is its lock mark |
| Guide | `docs/site.md` | What the site is, folder layout, preview, the check, setting the two addresses, changing text, swapping or re-rendering the film, and how it will be served (Caddy sketch for M2-S02) |

Total size of `apps/site`: 1.6 MB. No npm dependency was added and the root lockfile is unchanged; `apps/site` has no `package.json`, so it is not a workspace.

## How the skill workflow was followed

- Decide: visitor is the person who owns ISO certification; mood "calm, precise, nocturnal"; signature the golden thread; output static HTML; scope a full landing page.
- Examples studied: `intelligence-layer` (single-file dark video page, precise units, eased scrims), `securify-hero` (data security SaaS, restraint), `ai-runtime` (static HTML and vanilla JS structure, entrance timing).
- Media: the shelf host (`d8j0ntlcm91z4.cloudfront.net`) is refused by this session's network policy (proxy answered 403), so the film was generated instead (the skill's second media option) with `media-src/render.mjs`. No MotionSites file, link or credit is in the repository.
- Spec written from `references/spec-template.md` (working file, not committed), recipes used: background video layer and framing, edge scrims, staggered blur rise, fail-safe rest state, viewport reveals, floating pill navigation, mobile menu, in-page product mockup.
- Look and fix, scored with `references/review.md` from screenshots at 1440x900 and 390x844, light and dark:

| Round | First glance | Signature | Type | Composition | Colour | Media | Motion | Mobile | Copy | Polish | Fixes after the round |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 8 | 7 | 8 | 7 | 8 | 8 | 7 | 6 | 8 | 6 | Phone hero: film becomes a band above the chain; figure margins; viewer bar and query wrapping; closing eyebrow size; node icon centring; chain glows with the film pulse |
| 2 | 8.5 | 8 | 8.5 | 8 | 8.5 | 8 | 8 | 7 | 8 | 7.5 | Closing band framing (film still masked off the text side); feathered film band on phones; phone navigation alignment; Indonesian headline size on phones |
| 3 | 8.5 | 8 | 8.5 | 8 | 8.5 | 8.5 | 8 | 8 | 8 | 8 | Phone closing band as a film band under the text; links glow in order on phones; inline styles moved to CSS; print style |

Average after round 3: 8.2, nothing under 7.

## Deviations

1. Media generated instead of taken from the shelf, because the shelf host is blocked here (above). Rule L-1 holds: everything is served from the site. The film has no third-party licence; `docs/site.md` explains how to re-render or replace it.
2. No product screenshots. `project/screenshots/*.png` show the demo organisation, people and certification bodies, which the brief does not allow ("invent no customer names, numbers or certifications") and which are demo material. The traceability section uses an in-page mockup of the Golden Thread Viewer, labelled "Sample records", with generic records (risk R-014, control A.5.15 Access control, procedure PRC-07, evidence EV-0280; the codes come from the technical proposal).
3. Facts corrected against the built platform and section B of the plan: repositories are SharePoint Online, OneDrive for Business, Google Drive or the managed vault (no SMB or S3), company sign-in is SAML 2.0 or OpenID Connect (no LDAP), and the zero-transit route is not shown. The design's closing headline "Zero Major NC at the first certification audit" reads as a promise and the floating card "16 items due after the audit" is a number, so both were replaced ("Walk into the certification audit already prepared", from the proposal). Editions shown are those of the installed packs (ISO/IEC 27001:2022, ISO 9001:2015, ISO 22301:2019, ISO 37001:2016), with "new editions install side by side" for the newer packs.
4. The link constant lives in `site.config.mjs`, and `apply-config.mjs` writes it into the pages. The links stay plain HTML and work without JavaScript; `check.mjs` fails when a page differs from the constant.
5. `check.mjs` checks more than the brief lists: links against the constant, `html lang`, fonts loaded, elements sticking out of the viewport (the page itself clips horizontal overflow), contrast of the navigation over the page and of the open phone menu, film paused off screen and in a hidden tab, looping animations stopped in a hidden tab, no animation frames requested with reduced motion, and text visible without JavaScript.
6. The lint configuration (`eslint.config.mjs`, not owned) lints `*.js` and `*.mjs` with Node globals only, so the three files that run code in a browser declare the browser globals they use with a `/* global */` comment.

## Follow-ups

- M2-S02: serve `apps/site` on the bare domain and the app on `app.<domain>` (decision D-S3). Publish only `index.html`, `id/` and `assets/`; `docs/site.md` has a Caddy sketch with a strict Content-Security-Policy, which the pages meet without exceptions (no inline script or style, no other origin).
- Owner: set `APP_URL` and `DEMO_EMAIL` in `apps/site/site.config.mjs` and run `node apps/site/apply-config.mjs`.
- Owner and M2-S04: add links to the privacy notice and the terms of service in both footers once the legal documents exist (K.2), and decide whether a "Security" page is wanted.
- When the public domain is known: add `<link rel="alternate" hreflang>` pairs, a canonical URL and Open Graph tags with an absolute image URL (they need absolute URLs, so none are in the pages now).
- Release packaging (M2-S01 or M2-18) decides whether `apps/site` goes into a release artefact. The site holds no demo data and no keys.

## Tests

`apps/site/check.mjs` serves the folder on a free port (range requests supported, so the film can seek) and runs, for each language: four normal runs (1440x900 and 390x844, light and dark), two reduced-motion runs and one run without JavaScript. Contrast is measured for every visible text run against a screenshot with all text hidden, as the 2nd percentile of the samples in its boxes; text over the hero is measured over eight frames of the film (0 to 10.5 s). Screenshots go to the system temporary folder (`mscd-site-check`) or `--out`.

## Acceptance results

| Command | Result |
|---|---|
| `node apps/site/check.mjs` | Pass: 14 runs (2 languages, 2 sizes, 2 themes, reduced motion, no JavaScript), "Site check passed.", about 3 minutes |
| `node tools/scripts/check-text.mjs apps/site docs/site.md` | Pass: 11 files, no em dash or centre dot |
| `node apps/site/apply-config.mjs --check` | Pass: pages match `site.config.mjs` |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass (`apps/site` is linted with the root configuration) |
| `npm test` | Pass, every workspace |
| `npm run check:text` | Pass |
| `MSCD_TEST_CONTAINER_PREFIX=mot-01- npm run test:int -w @mscd/server -- test/int/seed test/int/parity` | Pass: 6 files, 49 tests; no `mot-01-` container left |
| `CI=1 npm run test:e2e -w @mscd/web` | Pass: 268 tests |
