# MOT-03 handoff: in-app illustration library

Eight quiet scenes for empty states, Getting started and error states, a typed API to pick one by name, and a gallery screen for review in the sample build only (`?screen=illustrations`).

## What was built

| File | Content |
|---|---|
| `apps/web/src/illustrations/index.ts` | The public API of the library (see "How a screen uses a scene") |
| `apps/web/src/illustrations/Illustration.tsx` | `Illustration`: one scene on its dotted stage at a size, with its text alternative (`role="img"` and `aria-label`) in the host language. Props: `scene`, `size` (`sm` 128px, `md` 192px default, `lg` 288px, or a width from 48 to 640), `label`, `decorative`, `still`, `progress` (Getting started only), `lang`, `className`. Ids of the SVG definitions come from `useId`, so two copies on one page share none. A name that is not a scene renders nothing |
| `apps/web/src/illustrations/scenes.tsx` | The eight drawings on one 240 by 160 stage, and the entrance timing of each element (`kit.at(delay, duration)`). Exports `SCENES`, `SceneName`, `isSceneName`, `STAGE`, `ENTRANCE_MS` (1200), `PATH_STEPS` (5), `pathTiming` |
| `apps/web/src/illustrations/geometry.ts` | Pure geometry without DOM: smooth paths through points, points on a curve, the seal outline, `litSteps` (how many Getting started steps light for a share of the checklist) |
| `apps/web/src/illustrations/text.ts` | `SCENE_TEXT`: name, text alternative and intended use of each scene, in English and Indonesian |
| `apps/web/src/illustrations/illustrations.css` | Colour roles over the tokens of `src/styles.css` only, and the entrance keyframes. No loop, fill mode `backwards`, reduced motion and `.il-still` switch every animation off |
| `apps/web/src/screens/illustrations/index.tsx` | The gallery's screen definition for the M2-01 registry. In an API build (`VITE_DATA_SOURCE=api`) the body is `NotInThisBuild`, so the lazy import of the gallery is dropped from the bundle |
| `apps/web/src/screens/illustrations/definition.ts` | `galleryScreen(Component)`: id `illustrations`, group `admin`, `nav: false`, every sample persona, permission `sample-build-only` |
| `apps/web/src/screens/illustrations/Screen.tsx`, `text.ts`, `gallery.css`, `meta.json` | The gallery: every scene with its name in code, its use and its text alternative; a scene inside the `EmptyState` of the UI kit; Getting started at 0, 40, 80 and 100%; the three sizes; "Replay entrance" and "Show still frames". `meta.json` lets the shared E2E helpers open it (`open: query`) |
| `apps/web/test/illustrations/library.test.tsx` | 76 unit tests: each scene in both languages and themes, ids, entrance budget of every moving element, props, Getting started progress, geometry, `EmptyState`, and the rules L-1 to L-5 on the stylesheet and sources (tokens in both themes, 3:1 for lines that carry meaning, no text in the pictures, no loop, the waiting state of a drawn line) |
| `apps/web/test/illustrations/gallery.test.tsx` | 9 unit tests: the definition, who may open it in each mode, the inert API body, the gallery in both languages and themes, the gallery stylesheet |
| `apps/web/e2e/illustrations.spec.js` | 7 browser tests (see "Rules L-1 to L-5") |

The orchestrator assigned `apps/web/src/screens/illustrations/**` to this package for the gallery; the plan's Owns list does not name it.

### The scenes

All scenes share one idea taken from the product: the accent thread (the golden thread that links an issue to its evidence) runs to where the next thing belongs. An empty scene ends the thread at an empty place, a finished scene runs it through every node, an error breaks it.

| Name in code | Picture | Entrance |
|---|---|---|
| `getting-started` | A path of five steps rising to a flag. Lit steps carry a tick, the next step is marked, the flag fills only when every step is done | The road and the steps rise, the thread draws through the lit steps, each step lights as the thread reaches it |
| `no-systems` | Four dashed tiles (shield, cog, cycle), the first one in the accent wash | Tiles rise one by one, the thread draws to the first tile, the plus draws in |
| `no-documents` | An empty page with a plus, two faint pages behind it | Pages rise, the thread reaches the edge of the page, the plus pops |
| `no-evidence` | An empty dashed file above an open folder | The folder rises, the file drops in, the thread reaches the file, the arrow draws |
| `no-findings` | A clipboard with three ticks and a magnifying glass that found nothing | The clipboard rises, the ticks draw one by one, the glass slides in |
| `all-done` | A chain of six lit nodes ending in a green seal with a tick | The thread draws through the nodes, each node lights, the ribbon rises and the seal pops |
| `error` | A page panel whose thread snapped, a red warning badge on its corner | The panel rises, both ends of the thread draw in, the break marks fade in, the badge pops |
| `offline` | A plug pulled out of its socket, a cloud that cannot be reached above the gap | The cables draw in with the plug and socket, the two pull apart, the gap and the amber cloud badge appear |

Every scene is complete within 1.2 seconds (the longest are `all-done` and `getting-started` at 100%, at 1.18 s; most end near 1.1 s) and then stands still.

### Design and the skill workflow

Built with the `motionsites-web-builder` skill: decide, study the closest examples (calm, restrained ones), choose media, write the spec, build, then the look-and-fix loop with screenshots scored on the skill's `references/review.md`. No media is used: every scene is inline SVG drawn in code, so nothing was copied from the skill and nothing is loaded at run time.

Look-and-fix rounds (screenshots of each scene in both themes at device scale 2, the early frame, a filmstrip of the entrance at 0 to 1200 ms, the reduced motion frame):

| Round | Weakest points found | Changes |
|---|---|---|
| 1 | Folder, all-done, error and offline scenes read poorly at 192px; error and offline lacked a clear focal point | Redrew the open folder, the all-done chain with ticks and a seal, the error window with a snapped thread and the offline plug and socket; updated their text alternatives |
| 2 | The frame after the entrance differed slightly from the reduced motion frame (fill mode `both` kept animated layers) | Fill mode `backwards` with keyframes that end at the resting style, so the end of the entrance is exactly the still frame |
| 3 | Each drawn line showed a stray dot at its far end while waiting for its turn (a zero-length dash with a round cap); the offline plug and socket showed before anything else | The waiting state of a drawn line keeps its dash off the path (`stroke-dasharray:1 1.02; stroke-dashoffset:1.01`, guarded by a unit test); plug and socket now fade in with their cables before they pull apart |

Final scores on `references/review.md`, judged for an in-app scene library inside a dashboard: first glance 8, signature 8, typography 8 (no text in the pictures, gallery text in the app's IBM Plex), composition 8, colour and light 8, fit with the page 8 (sits in `EmptyState` above its title), motion 9, narrow screens 7, copy 8, polish 8. Average 8.0, nothing under 7. Narrow screens score 7 because the app shell keeps its 1180px layout on every screen (the Licence reference screen behaves the same); inside the screen nothing overflows, the grid collapses to one column and the scenes scale with `max-width:100%`.

### Rules L-1 to L-5

| Rule | How it is met | Checked by |
|---|---|---|
| L-1 | No font, image, video or script; the scenes are SVG in the gallery chunk (about 21 kB, 7 kB gzip, with the gallery page). The nginx Content-Security-Policy needs no change | Unit test on CSS and sources (no `url(`, no `https:`, no `<image>` or `<use>`); the browser spec serves the page with the policy of `deploy/nginx/security-headers.conf` (as MOT-02 does) and finds no request to another origin and no policy violation |
| L-2 | One entrance per element, every step ends within 1.2 s, no loop. Reduced motion and `still` show the final frame at once. Nothing is hidden at rest: an element is held at its start only while it waits for its own animation | Unit tests (budget per element, no `infinite`, fill mode). Browser spec: animations end by 1.2 s on the animation clock, no pixel changes afterwards, no animation under reduced motion, and the reduced motion frame matches the end of the entrance; the scenes reserve their place, so nothing moves around them |
| L-3 | The pictures hold no text. Lines that carry meaning use `--tx3`, `--field`, `--acc`, `--ok`, `--bad` or `--warn`, all at 3:1 or more on the card in both themes (WCAG 1.4.11); the tick on the accent and each line on its tinted fill also reach 3:1. Gallery text is 12px or more at 4.5:1. Nothing moves behind text, so there is no brightest frame to measure | Unit test on the token values of both themes; browser spec on the computed stroke of every line in both themes, no text box over a scene, readable text; `e2e/contrast.spec.js` |
| L-4 | No animated background and nothing runs after 1.2 s, so there is nothing to pause; the SVG has a fixed width and height, so no layout shift | Browser spec (layout boxes unchanged during the entrance) |
| L-5 | Colours from the tokens of `src/styles.css` only (accent `#ad4f0b` light, `#e8731a` dark through `--acc`); no font in the pictures | Unit test (no colour literal in CSS or sources; every token exists in both themes) |

### How the gallery stays out of an API build

`ScreenDef` has no flag for sample-only screens, and no shared file was edited. Two measures inside the package folder:

1. `index.tsx` passes `import.meta.env.VITE_DATA_SOURCE === 'api' ? NotInThisBuild : lazy(() => import('./Screen'))`. Vite replaces the condition at build time, so the API bundle keeps only the small definition (label, help text, permission) and none of the gallery or library code. The browser spec builds the API bundle and checks it.
2. The permission is `sample-build-only`, which is no permission of the F.6 matrix, so `canOpenHost` refuses the screen to every API session (the unit test tries a session holding every permission). Sample builds open host screens by persona and do not check it. The screen has no sidebar entry.

No patch for the orchestrator is needed.

## How a screen uses a scene

```tsx
import { Illustration } from '../../illustrations';
import { EmptyState } from '../ui';

<EmptyState
  title={TEXT.noDocuments}
  text={TEXT.noDocumentsText}
  illustration={<Illustration scene="no-documents" decorative />}
  action={<Button variant="primary" onClick={create}>{ctx.li(TEXT.newDocument)}</Button>}
/>
```

- `scene` is typed (`SceneName`); for a name that comes from data, check it with `isSceneName`.
- Pass `decorative` when the title and text of the empty state already say everything (the usual case); the picture is then hidden from screen readers. Leave it off where the picture adds meaning, for example the Getting started progress.
- `size="sm"` for a table or a card, the default `md` for a page section, `lg` for a whole empty page.
- `Table` of the UI kit takes `empty={<EmptyState ... />}`, so a list shows the scene when it has no rows.
- The scene follows the theme by itself (CSS tokens) and takes the language from the host context.

## Deviations

1. The gallery folder `apps/web/src/screens/illustrations/**` is outside the plan's Owns list; the orchestrator assigned it.
2. The theme is not a prop: the scenes read the colour tokens of the `.mscd` root, so they follow the light and dark theme without one.
3. Narrow screens: the app shell's fixed 1180px layout makes the page scroll sideways at 390px on every host screen. That is outside this package; inside the gallery nothing overflows.

## Follow-ups

For M2-16 (Getting started, account, notifications and operator console) and the screen packages:

| Scene | Where | Notes |
|---|---|---|
| `getting-started` | M2-16 Getting started page, at the top of the checklist | `progress={done / total}` of the onboarding checklist (D.5). Any progress lights the first step; only a complete checklist lights the last step and the flag. Not decorative: its text alternative says how many steps are lit |
| `all-done` | M2-16 Getting started once every step is done; My Tasks and notification lists with nothing left | Decorative next to a "You are all caught up" title |
| `no-systems` | M2-09 management system administration before the first system; M2-16 Getting started when no system exists | |
| `no-documents` | M2-12 document control screens and the document register with no documents | |
| `no-evidence` | M2-11 evidence forms and evidence lists with no files linked | |
| `no-findings` | M2-14 audit registers screens: findings and corrective actions when an audit raised nothing | |
| `error` | Any part of a screen that could not be loaded, next to a Try again button | `Failed` in `apps/web/src/screens/ui/core.tsx` shows an Alert today; the owner of the UI kit may show `<Illustration scene="error" size="sm" decorative />` above it |
| `offline` | The connection to the server is lost, next to a Try again button | |

M2-08 (bulk import), M2-10 (people and roles), M2-13 (registers) and M2-15 (certification timeline) can use `no-documents` or `all-done` where an empty list fits; ask for a new scene in a later motion package if none fits.

## Acceptance

All commands ran with `TZ=UTC`, under the npm and E2E locks. Final run on 2026-10-28, after the review's last finding; that finding asked for no change in MOT-03, so no file of the package changed in that round.

| Command | Result |
|---|---|
| `npm test -w @mscd/web -- test/illustrations` | Pass (2 files, 85 tests: 76 in `library.test.tsx`, 9 in `gallery.test.tsx`) |
| `CI=1 npm run test:e2e -w @mscd/web -- e2e/illustrations.spec.js e2e/contrast.spec.js` | Pass (11 tests, of which 7 in `e2e/illustrations.spec.js`) |
| `CI=1 npm run test:e2e -w @mscd/web -- e2e/illustrations.spec.js --repeat-each=3` | Pass (21 tests, earlier round) |
| `CI=1 npm run test:e2e -w @mscd/web -- e2e/shell.spec.js e2e/screens/probe.spec.js e2e/i18n.spec.js e2e/offline.spec.js` | 26 of 30 pass. The probe and the host screen walk of `e2e/i18n.spec.js` open the gallery and pass, as do the new M2-09 screens. The four per-system walks of the generated views (`no ISMS/QMS/BCMS/ABMS interface label stays in English`) hit the 60 s test timeout at a load average of 37 on the shared host. Rerun alone with `--workers=2`: `e2e/i18n.spec.js` passes 6 of 6, about 26 s per walk |
| `npm run typecheck` | Pass |
| `npm run lint` | Fail only in a file of another package being built at the same time: 3 errors (F.10 `no-restricted-syntax`) in `apps/server/src/cli/backup.ts` (M2-S07), lines 171, 178 and 283. The M2-08 error of the earlier round is gone. The MOT-03 files lint clean (`npx eslint` on its four paths: 0 errors) |
| `npm test` | Pack-tools (95), shared (2343) and mock-providers (104) pass. Server: 352 of 353, the failure is `test/unit/cli/program.test.ts`, which expects `license` to have only `show-id` while M2-S10 adds `license entitlements` in `apps/server/src/cli/license.ts`. Web: 382 of 385, the same 3 failures after one rerun, all caused by the new sidebar entries of M2-09 ("Management systems" and "Routing rules" in the Administration group): `test/screens/host.test.tsx` (the sidebar inserts host screens into their group) and two tests in `test/api/controller.test.ts` (the Licence screen in sample mode, the no-system path in API mode) still expect the group to hold only Framework library, Storage repositories and Licence. The gallery has `nav: false` and appears in none of these lists. MOT-03 changes no server file and none of these test files |
| `npm run check:text` | Pass (79 files) |
| `npm run gen:views:check -w @mscd/web` | Pass (18 views and `hover.css` match the template) |
| `npm run test:int -w @mscd/server -- test/int/seed test/int/parity` | Not required: MOT-03 changes no server code. No Docker container was started |

The orchestrator reruns the root `npm run lint` and `npm test` once M2-S07, M2-S10 and M2-09 finish: M2-S07 fixes `backup.ts`, M2-S10 updates the expectation in `apps/server/test/unit/cli/program.test.ts`, and the sidebar expectations of `test/screens/host.test.tsx` and `test/api/controller.test.ts` need the two M2-09 entries.

## Orchestrator decisions

- The orchestrator assigned the gallery folder `apps/web/src/screens/illustrations/**` to this package (deviation 1 accepted). The gallery is in the sample build only: a build-time switch removes it from the API bundle, and it needs a permission no API session holds. No shared screen file changed.
- Deviations 2 and 3 are accepted. The fixed 1180px shell width on narrow screens belongs to the app shell, not to this package.
- The first run stopped when the session ended. It was resumed with the new `interrupted` option of `.claude/workflows/mscd-m2-wp.js`; the independent check then passed with one minor finding that names only other packages' files.
- At the time of that check, root `npm run lint` and `npm test` failed only in files of packages still being built in this wave (M2-S07 `cli/backup.ts`, the M2-S10 change to the `license` sub-commands, the two Administration entries of M2-09 in the shared host tests). The orchestrator settles them when those packages finish, before the wave's full suites.
- The optional scene above the `Failed` fallback in `apps/web/src/screens/ui/core.tsx` is left to the owner of the UI kit (M2-16 or later).
