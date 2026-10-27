# MOT-01 handoff: marketing landing site

## What was built

| Area | Files | Content |
|---|---|---|
| Pages | `apps/site/index.html`, `apps/site/id/index.html` | The public landing page in English and Indonesian, same structure and the same assets. Sections: hero, traceability test (`#product`), named accountability (`#accountability`), Harmonized Structure (`#frameworks`), three working areas (`#modules`), deployment and data (`#deployment`), security (`#security`), closing band, footer. Each page has a `<title>`, a meta description, `lang`, a favicon, a skip link and a language switch. No inline script and no inline style |
| Styles | `apps/site/assets/site.css` | Tokens of `apps/web/src/styles.css` (accent `#e8731a` dark, `#ad4f0b` light; inks, lines and status colours of the app), light and dark through `prefers-color-scheme`. The film stage stays dark in both themes, inset 12px (8px on phones) with a 28px radius. Self-hosted IBM Plex Sans 300 to 600 and IBM Plex Mono 400 and 500. Entrance (blur rise, 0.15 s to 2.4 s), scroll reveals, diagram details and every transition switch off with reduced motion |
| Behaviour | `apps/site/assets/site.js` | Small-screen menu (`aria-expanded`, Esc, outside tap, resize), paper style of the navigation below the hero, scroll reveals, film playback only while on screen, tab visible and motion allowed, diagram loops only while on screen, and the chain glow (below). Without the file the pages are complete |
| Hero film | `apps/site/assets/media/{thread.mp4,thread.webm,thread-poster.jpg}`, source in `apps/site/media-src/{thread.html,render.mjs}` | A 12 s, 1920x1080, 24 fps loop rendered for this site from a WebGL shader: one amber thread of three braided strands, dust and a few out-of-focus discs on `#0e0d0b`, with one light pulse travelling the thread per loop. Every motion term is periodic in the loop, so it loops without a seam. MP4 (H.264, 0.86 MB), WebM (VP9, 0.28 MB) and a JPEG poster (64 KB) of the frame at 5.5 s, where playback starts (`data-start`) |
| Signature | pages, `site.js` | The golden thread: the film behind the headline, and under it the six links Issue, Risk, Control, Document, Evidence, Finding on a hairline that draws itself on load. While the film plays, the link under the travelling pulse glows (`--g` per link, computed from `currentTime`, object position and the rendered width); at 760px and narrower, where the links wrap into rows (three per row, two per row at 380px and narrower), they glow one after another. The loop runs only while the film plays and resets on pause |
| Configuration | `apps/site/site.config.mjs`, `apps/site/apply-config.mjs` | `APP_URL` (every "Sign in" link, default `https://app.example.com/`) and `DEMO_EMAIL` (every "Request a demo" `mailto:` link and the address shown as text, default `sales@example.com`). `apply-config.mjs` writes them into the marked elements of both pages (`data-app-link`, `data-demo-link`, `data-demo-email`); `--check` reports a page that differs |
| Check | `apps/site/check.mjs` | See Tests |
| Assets | `apps/site/assets/fonts/*` (with `OFL-IBM-Plex.txt`), `apps/site/assets/img/{cyberlentera-logo.png,favicon.png,grain.png}` | Fonts copied from `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` 5.3.0 (latin WOFF2, SIL OFL 1.1). Logo resized from `project/assets/cyberlentera-logo.png`, shown on a cream chip as in the app; the favicon is its lock mark |
| Guide | `docs/site.md` | What the site is, folder layout, preview, the check, setting the two addresses, changing text, swapping or re-rendering the film, and how it will be served (Caddy sketch for M2-S02) |

Total size of `apps/site`: 1.6 MB. No npm dependency was added and the root lockfile is unchanged; `apps/site` has no `package.json`, so it is not a workspace.

## How the skill workflow was followed

- Decide: visitor is the person who owns ISO certification; mood "calm, precise, nocturnal"; signature the golden thread; output static HTML; scope a full landing page.
- Examples studied: `intelligence-layer` (single-file dark video page, precise units, eased scrims), `securify-hero` (data security SaaS, restraint), `ai-runtime` (static HTML and vanilla JS structure, entrance timing).
- Media: the skill's media host is refused by this session's network policy (proxy answered 403), so the film was generated instead (the skill's second media option) with `media-src/render.mjs`. No file, link or credit from the skill's media library is in the repository.
- Spec written from `references/spec-template.md` (working file, not committed), recipes used: background video layer and framing, edge scrims, staggered blur rise, fail-safe rest state, viewport reveals, floating pill navigation, mobile menu, in-page product mockup.
- Look and fix, scored with `references/review.md` from screenshots at 1440x900 and 390x844, light and dark:

| Round | First glance | Signature | Type | Composition | Colour | Media | Motion | Mobile | Copy | Polish | Fixes after the round |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 8 | 7 | 8 | 7 | 8 | 8 | 7 | 6 | 8 | 6 | Phone hero: film becomes a band above the chain; figure margins; viewer bar and query wrapping; closing eyebrow size; node icon centring; chain glows with the film pulse |
| 2 | 8.5 | 8 | 8.5 | 8 | 8.5 | 8 | 8 | 7 | 8 | 7.5 | Closing band framing (film still masked off the text side); feathered film band on phones; phone navigation alignment; Indonesian headline size on phones |
| 3 | 8.5 | 8 | 8.5 | 8 | 8.5 | 8.5 | 8 | 8 | 8 | 8 | Phone closing band as a film band under the text; links glow in order on phones; inline styles moved to CSS; print style |

Average after round 3: 8.2, nothing under 7.

After the review, a fourth look at 320, 360, 390 and 1440 px wide (light and dark, both languages) covered the new accountability section and the narrow phone layout; the scores held (Mobile 8, Composition 8, average 8.2).

## Deviations

1. Media generated instead of taken from the shelf, because the shelf host is blocked here (above). Rule L-1 holds: everything is served from the site. The film has no third-party licence; `docs/site.md` explains how to re-render or replace it.
2. No product screenshots. `project/screenshots/*.png` show the demo organisation, people and certification bodies, which the brief does not allow ("invent no customer names, numbers or certifications") and which are demo material. The traceability section uses an in-page mockup of the Golden Thread Viewer, labelled "Sample records", with generic records (risk R-014, control A.5.15 Access control, procedure PRC-07, evidence EV-0280; the codes come from the technical proposal).
3. Facts corrected against the built platform and section B of the plan: repositories are SharePoint Online, OneDrive for Business, Google Drive or the managed vault (no SMB or S3), company sign-in is SAML 2.0 or OpenID Connect (no LDAP), and the zero-transit route is not shown. The design's closing headline "Zero Major NC at the first certification audit" reads as a promise and the floating card "16 items due after the audit" is a number, so both were replaced ("Walk into the certification audit already prepared", from the proposal). Editions shown are the ones a management system can be created on with the packs in `packs/sources`: ISO/IEC 27001:2022, ISO 9001:2015 and 2026, ISO 22301:2019 and ISO 37001:2025, marked "in beta" ("versi beta") because that pack is a pre-release. This matches the design ("ISO 9001 2015 to 2026", "ISO 37001 2025"). ISO 37001:2016 is not listed although its pack ships: the pack is marked withdrawn and the platform refuses to create a system on a withdrawn edition (`management-systems.service.ts`, `ms.edition_withdrawn`), so listing it would promise something the product does not do. The note under the panel says new editions install side by side. The traceability viewer mockup ends at Evidence: the Golden Thread Viewer has no finding node yet (section B defers it to a later milestone; ui-contract 2.10 resolves no finding node), so the mockup shows no Finding link. The hero chain keeps Finding, as in the design.
4. The link constant lives in `site.config.mjs`, and `apply-config.mjs` writes it into the pages. The links stay plain HTML and work without JavaScript; `check.mjs` fails when a page differs from the constant.
5. `check.mjs` checks more than the brief lists: three more sizes (740x360, a phone held sideways; 360x800, the most common Android width; 320x640, the WCAG reflow width), labels of the chain rows set closer than the space inside one label (at the five sizes and at every width from 320 to 1440px), text cut off by a clipping box or the page edge, text running into other text, the MP4 file on disk (Playwright's Chromium cannot decode H.264, see Tests), links against the constant, `html lang`, fonts loaded, elements sticking out of the viewport (the page itself clips horizontal overflow), contrast of the navigation over the page and of the open phone menu, film paused off screen and in a hidden tab, looping animations stopped in a hidden tab, no animation frames requested with reduced motion, and text visible without JavaScript.
6. The lint configuration (`eslint.config.mjs`, not owned) lints `*.js` and `*.mjs` with Node globals only, so the three files that run code in a browser declare the browser globals they use with a `/* global */` comment.

## Follow-ups

- M2-S02: serve `apps/site` on the bare domain and the app on `app.<domain>` (decision D-S3). Publish only `index.html`, `id/` and `assets/`; `docs/site.md` has a Caddy sketch with a strict Content-Security-Policy, which the pages meet without exceptions (no inline script or style, no other origin).
- Owner: set `APP_URL` and `DEMO_EMAIL` in `apps/site/site.config.mjs` and run `node apps/site/apply-config.mjs`.
- Owner and M2-S04: add links to the privacy notice and the terms of service in both footers once the legal documents exist (K.2), and decide whether a "Security" page is wanted.
- When the public domain is known: add `<link rel="alternate" hreflang>` pairs, a canonical URL and Open Graph tags with an absolute image URL (they need absolute URLs, so none are in the pages now).
- Release packaging (M2-S01 or M2-18) decides whether `apps/site` goes into a release artefact. The site holds no demo data and no keys.

## Tests

`apps/site/check.mjs` serves the folder on a free port (range requests supported, so the film can seek) and runs, for each language: ten normal runs (1440x900, 740x360, 390x844, 360x800 and 320x640, light and dark), five reduced-motion runs, one width sweep and one run without JavaScript. Contrast is measured for every visible text run against a screenshot with all text hidden, as the 2nd percentile of the samples in its boxes; text over the hero is measured over eight frames of the film (0 to 10.5 s), down to the bottom of the hero even when it is taller than the viewport. Text is reported when a box that hides its overflow (or the page edge) cuts it off, unless that box ends it with an ellipsis on purpose, and when it runs into other text. In the two rows of short labels (the hero chain and the Harmonized Structure chain), the space between two labels in a row must be at least 1.5 times the largest space inside either label (8px between "04" and "Document") and at least 12px; the sweep resizes one page from 320 to 1440px in steps of 4px and reports each failing pair with the width ranges where it fails. Screenshots go to the system temporary folder (`mscd-site-check`) or `--out`.

Playwright's Chromium has no H.264 decoder (`canPlayType('video/mp4; codecs="avc1.640028"')` is empty), so the browser runs only ever play the WebM. Before the browser runs, the script reads every film file the pages reference: the MP4 must start with `ftyp`, keep `moov` before the media data and hold an `avc1` track; with `ffprobe` and `ffmpeg` installed (they are here), it also checks the codecs (H.264 yuv420p, VP9) and decodes every frame of both files. A truncated MP4 and an MP4 with `moov` at the end were both reported when tried on a copy of the site.

## Fixes after the review

| Finding | Fix |
|---|---|
| The design's "Named accountability" section was missing | New section `#accountability` in both languages, after the traceability test, with the three facts of the design: a named person on every pending item, reminders sent and logged by the platform (single and to every holder, email and in-app, WP-35), and the after-audit flag recalculated when the audit date moves (BR-42). Card on the left and text on the right on desktop, as in the design; one column below 1081px |
| Text cut off at 360 and 320px | The viewer bar wraps (`flex-wrap`) and the tag never shrinks; on phones the decorative window dots are hidden, so the tag fits next to the title at 360px and moves under it at 320px. Hero headline lines may wrap on phones and their size leaves room at 320px (`clamp(32px,10.8vw,56px)`, Indonesian `clamp(28px,9.6vw,52px)`). At 380px and narrower (below 360px in the first fix, see the second review) the chain shows two links per row and the film band moves up by one row, so it stays clear of the labels |
| `check.mjs` missed it | Third size 320x640; text cut off by any clipping box is reported; text running into other text is reported; hero contrast measured to the bottom of the hero. On the previous version of the site the new check reports the three cut-off texts of the review and the chain labels over the film band at 320px |
| Finding node in the viewer mockup | Removed in both languages (see Deviation 3) |
| H.264 file never decoded | MP4 structure check and full decode with ffmpeg (see Tests) |
| Language link name did not contain its visible label | `aria-label="ID, Bahasa Indonesia"` and `aria-label="EN, English"` |
| Handoff named the media host | Removed |

## Fixes after the second review

| Finding | Fix |
|---|---|
| Standards panel showed ISO 9001:2015 and the withdrawn ISO 37001:2016 | Both languages now show ISO 9001:2015 and 2026 and ISO 37001:2025, "in beta" ("versi beta"), as in the design. The 2016 edition is left out because the platform refuses it (Deviation 3 corrected). `docs/site.md` says how editions are chosen. Checked at 1440, 1081, 1080, 390 and 320px: every edition fits on one line |
| At 360px the chain still showed three links per row, 5px between "04 Document" and "05 Evidence" against 8px inside one label | Two links per row now apply at 380px and narrower (the film band rule moves with them); the viewer tag rule stays below 360px. Smallest space between labels: 55px at 360px (63px Indonesian), 12px at 381px, 15px at 390px |
| `check.mjs` never opened 360px | New size 360x800, and the label spacing check above at every size. Run on the previous version of the site, it reports "04 Document" and "05 Evidence" 5px apart at 360px |
| Found while fixing: from 641 to about 730px the six labels sat in one row and touched (0px apart), with 7px from 644 to 672px elsewhere in the row | The chain wraps three per row at 760px and narrower (it used to wrap at 640px). The width sweep reported this on the previous version ("0px apart at widths 360 to 376, 644 to 728px") and finds nothing now |
| Found while fixing: from 641 to 760px the thread of the full film crossed the hero text. On the previous version the same check, run once at 641x800, 667x375 and 740x360, reported the subtitle (down to 1.39:1) and "See how it works" (down to 1.43:1) under 4.5:1. Wrapping the chain alone also put its first row on the thread ("01" at 3.39:1) | The phone treatment of the hero now applies at 760px and narrower: the film becomes a band right above the chain and the hero grows with its content. Between 641 and 760px the band sits 20px higher, because the chain has more bottom padding on taller screens. The same check, run once at 641x800, 667x375, 700x900, 740x360, 760x1000 and 761x1000 in both languages, passes. On the previous version (English, dark theme), 800x600, 812x375, 834x1112, 844x390, 900x700, 932x430, 1024x768, 1180x820, 1280x720 and 1366x768 passed already. 740x360 is now one of the check's sizes |

## Acceptance results

Results of the run after the second review fixes. Other packages were changing `apps/web`, `apps/server` and `packs/sources` at the same time; the failures below are in their files, and none of them loads `apps/site` (it is not a workspace).

| Command | Result |
|---|---|
| `node apps/site/check.mjs` | Pass: both film files checked on disk and fully decoded, then 34 runs (2 languages; 5 sizes in 2 themes; reduced motion at each size; one width sweep of 281 widths; no JavaScript), "Site check passed.", about 9.5 minutes |
| `node tools/scripts/check-text.mjs apps/site docs/site.md` | Pass: 12 files with the handoff note, no em dash or centre dot |
| `node apps/site/apply-config.mjs --check` | Pass: pages match `site.config.mjs` |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass (`apps/site` is linted with the root configuration) |
| `npm test` | Fails outside this package: `apps/web` `test/api/controller.test.ts` (1 test, controller code being changed by M2-01) and `packages/pack-tools` (9 tests expect pack version 1.2.0, `packs/sources` now holds 1.2.1). Every other workspace passes |
| `npm run check:text` | Pass: 66 files |
| `MSCD_TEST_CONTAINER_PREFIX=mot-01- npm run test:int -w @mscd/server -- test/int/seed test/int/parity` | Fails outside this package: 44 of 49 tests pass; the 5 failures expect the earlier pack versions (for example `ISO27001-2022 1.2.0`, now 1.2.1). No `mot-01-` container left |
| `CI=1 npm run test:e2e -w @mscd/web` | 284 passed, 1 failed outside this package: `e2e/chain.spec.js` "a due date cannot be cleared" (web app screens being changed by M2-01) |

Probe runs, made once with copies of `check.mjs` and not part of the acceptance: the previous site against the new spacing check (reports the 360px and 644 to 728px problems), and both versions at 641x800, 667x375, 700x900, 740x360, 760x1000 and 761x1000 (the current version passes).
