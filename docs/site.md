# MSCD marketing site

The public landing page of MSCD, in English (`apps/site/index.html`) and Indonesian (`apps/site/id/index.html`). It explains the product to a visitor who owns ISO certification at an organisation: one traceability chain from risk to evidence, the four standards (ISO/IEC 27001, ISO 9001, ISO 22301, ISO 37001), files kept in the customer's own repository, SaaS or on-premise, and MFA for every user. It is built from the design in `project/MSCD Landing.dc.html` and the facts of `project/MSCD Technical Proposal.dc.html`, corrected to what the platform does today: no LDAP sign-in, no SMB or S3 repositories and no direct upload from the browser to the repository are promised (Milestone 2 plan, section B).

The site is plain static files. There is no build step and no package of its own, so the root lockfile never changes because of it.

## What is in the folder

| Path | What it is |
|---|---|
| `apps/site/index.html` | English page |
| `apps/site/id/index.html` | Indonesian page, same structure and the same assets |
| `apps/site/assets/site.css` | Styles. Colours follow `apps/web/src/styles.css`: accent `#e8731a` on dark, `#ad4f0b` on light |
| `apps/site/assets/site.js` | Menu, scroll reveals, film playback rules and the chain glow. The pages are complete without it |
| `apps/site/assets/fonts/` | IBM Plex Sans (300 to 600) and IBM Plex Mono (400, 500), latin WOFF2 files copied from `@fontsource`, with the SIL Open Font License in `OFL-IBM-Plex.txt` |
| `apps/site/assets/media/` | The hero film (`thread.mp4`, H.264, and `thread.webm`, VP9) and its poster (`thread-poster.jpg`) |
| `apps/site/assets/img/` | CyberLentera logo and favicon (from `project/assets/cyberlentera-logo.png`) and a small grain texture |
| `apps/site/site.config.mjs` | The two values to set before going live: the app address and the demo request address |
| `apps/site/apply-config.mjs` | Writes those two values into both pages |
| `apps/site/check.mjs` | The quality check (see below) |
| `apps/site/media-src/` | The source of the hero film: a shader page (`thread.html`) and the script that renders and encodes it (`render.mjs`) |

## How the page works

The hero is a dark stage with a film behind the headline: one amber thread of three braided strands that drifts through a dark space, with a light pulse that travels along it once every 12 seconds. Under the headline, the six links of the chain (Issue, Risk, Control, Document, Evidence, Finding) sit on a hairline. When the pulse in the film passes above a link, that link glows. On phones the links wrap into two rows and glow one after another.

The same rules as the rest of the motion track apply (Milestone 2 plan, section L):

- Nothing is loaded from another site. Fonts, script, film and images are all in `apps/site/assets`.
- With reduced motion turned on in the operating system, the film is not played (the poster shows), the entrance and the scroll reveals do not run, and no loop runs. Without JavaScript every text is visible as well.
- The film plays only while it is on screen and the tab is visible. The small looping details of the diagrams pause in the same cases.
- All text is 12px or larger and meets WCAG AA contrast in the light and the dark theme, measured over the film.

The page follows the visitor's light or dark setting. The film stage stays dark in both themes.

## Preview

Any static file server works. For example:

```bash
python3 -m http.server --directory apps/site 8080
# then open http://localhost:8080/ and http://localhost:8080/id/
```

To see the page in both themes and at phone size, run the check and open its screenshots (next section).

## The check

```bash
node apps/site/check.mjs                 # both languages
node apps/site/check.mjs --only en       # one language
node apps/site/check.mjs --out /tmp/shots
```

The script serves `apps/site` on a free local port and opens both pages at 1440x900 and 390x844, in light and in dark, with the Chromium of Playwright (`@playwright/test` from the root `node_modules`, browsers from `/opt/pw-browsers` when that folder exists). It saves full-page and first-screen screenshots in the output folder (by default `mscd-site-check` in the system temporary folder) and fails on:

- a request to another origin;
- horizontal overflow, or an element that sticks out of the viewport;
- text under 12px;
- text with a contrast ratio under 4.5:1. The background is sampled at the position of each text from a screenshot with all text hidden. Text over the hero film is also measured over eight frames of the film. The navigation is measured over the page as well, and the phone menu is measured open;
- a missing `<title>`, a missing meta description or a wrong `lang`;
- console errors, failed requests, broken images, a film that does not load or a poster that does not load;
- Sign in or demo links that differ from `site.config.mjs`;
- a film that keeps playing off screen or in a hidden tab;
- with reduced motion: any running animation, any requested animation frame, a playing film, or text that is hidden at rest;
- without JavaScript: text that is hidden.

It also runs the writing rules: `node tools/scripts/check-text.mjs apps/site docs/site.md`.

## Before going live: the two addresses

Edit `apps/site/site.config.mjs`:

```js
export const APP_URL = 'https://app.example.com/';   // every "Sign in" link
export const DEMO_EMAIL = 'sales@example.com';       // every "Request a demo" link and the address shown as text
```

Then write the values into both pages and check them:

```bash
node apps/site/apply-config.mjs
node apps/site/check.mjs
```

`apply-config.mjs` only changes elements marked for it: links with `data-app-link` or `data-demo-link`, and elements with `data-demo-email`. `node apps/site/apply-config.mjs --check` exits with an error when a page still carries an old value, and `check.mjs` fails in that case too.

## Changing the text

Both pages are hand-written HTML with the same structure. Change the English and the Indonesian page together, and keep the writing rules of `CLAUDE.md`: plain English, no em dash, no centre dot. Only state what the platform does. Customer names, numbers and certifications are not used on the page; the traceability viewer shows sample records and says so.

## Swapping the film

The film was rendered for this site from `apps/site/media-src/thread.html` (a shader, no footage), so there is no licence to track. To render it again, for example after changing colours or speed in the shader:

```bash
node apps/site/media-src/render.mjs --preview 132   # one frame, to look at
node apps/site/media-src/render.mjs                 # all 288 frames, then encodes
```

Rendering takes about ten minutes and needs `ffmpeg`. It writes `thread.mp4`, `thread.webm` and `thread-poster.jpg` into `apps/site/assets/media`.

To use other footage instead:

1. Prepare a loop of 6 to 12 seconds that is calm, dark at its edges and dark in the top left, where the headline sits. Encode it as H.264 MP4 with `-movflags +faststart` and as WebM, each 6 MB at most, plus a poster image of the frame shown first.
2. Replace the three files in `apps/site/assets/media` (or change the `src` and `poster` attributes in both pages).
3. Set `data-start` on the `<video>` to the time of the poster frame, so the switch from poster to playback does not show.
4. The chain glow follows the pulse of the rendered film (`site.js`, the block that starts with "The chain under the hero answers the film"). With other footage, remove `data-chain` from the chain in both pages to switch the glow off, or adjust its formula.
5. Run `node apps/site/check.mjs`. It measures text contrast over eight frames of the new film.

## How it will be served (follow-up for M2-S02)

On SaaS, Caddy serves the site on the bare domain and the app on `app.<domain>` (decision D-S3). Only `index.html`, `id/` and `assets/` are published. The tools in the folder (`*.mjs`, `media-src/`) stay private. A sketch for the Caddy configuration that M2-S02 owns:

```caddy
{$MSCD_SITE_DOMAIN} {
	root * /srv/site
	@tools path *.mjs /media-src/*
	respond @tools 404
	header {
		Content-Security-Policy "default-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
		Referrer-Policy "strict-origin-when-cross-origin"
		X-Content-Type-Options "nosniff"
		Strict-Transport-Security "max-age=31536000"
	}
	@assets path /assets/*
	header @assets Cache-Control "public, max-age=604800"
	encode zstd gzip
	file_server
}
```

The pages carry no inline script and no inline style, so this policy needs no exceptions. The image that runs Caddy copies `apps/site/index.html`, `apps/site/id/` and `apps/site/assets/` into `/srv/site`. Video needs range requests, which `file_server` supports.
