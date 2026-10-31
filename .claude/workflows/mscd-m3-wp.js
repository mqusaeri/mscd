export const meta = {
  name: 'mscd-m3-wp',
  whenToUse: 'Build one Milestone 3 work package: pass args {wp: "M3-02", notes: "..."}',
  description: 'Implement one MSCD platform work package from MILESTONE-3.md, then independently verify, fix, and re-verify it',
  phases: [
    { title: 'Implement', detail: 'build the work package exactly per the plan' },
    { title: 'Verify', detail: 'independent acceptance run plus adversarial review' },
    { title: 'Fix', detail: 'resolve findings, re-verify (up to 2 rounds)' },
  ],
}

const WP = args.wp
const CTX = `
You are working on MSCD Milestone 3 in this repository (the working directory, a git repo). Milestone 1 (39 work packages of docs/platform/BUILD-PLAN.md) and Milestone 2 (docs/platform/MILESTONE-2.md, including M2-21 faster browser tests) are complete and verified. Your plan of record is docs/platform/MILESTONE-3.md: read its plain summary, section 0 (it keeps the Milestone 2 rules with changes), its decisions section, its wave table and your package. Read the sections of MILESTONE-2.md and BUILD-PLAN.md it refers to (section 0 rules, the F.6 role matrix, the contract tables) when your package touches them.
Project guide: CLAUDE.md (rules that are easy to break: generated views, 12px minimum text, WCAG AA contrast, demo material, writing rules).
YOUR WORK PACKAGE: ${WP} (find "#### ${WP}" in docs/platform/MILESTONE-3.md; follow its Owns list, Brief and Acceptance exactly, plus the common acceptance of that plan).
${args.notes || ''}
CONCURRENCY RULES (several agents work in this repo at the same time, on other work packages):
- Only create or edit files your work package owns. You may read anything. Never revert, reformat, move or delete files you do not own. Never run git checkout, reset, stash, clean, commit or push.
- npm and node_modules use a reader/writer lock: anything that changes node_modules or the lockfile must run as "flock /tmp/mscd-npm.lock <command>" (exclusive); every test, build, typecheck, lint or E2E command must run as "flock -s /tmp/mscd-npm.lock <command>" (shared). If a dependency is missing, install the exact version with "flock /tmp/mscd-npm.lock npm install <pkg>@<version> -w <workspace>" and list it in your handoff note.
- Web E2E runs (Playwright, ports 4173 and 4174): wrap them in "flock /tmp/mscd-e2e.lock flock -s /tmp/mscd-npm.lock <command>".
- LOCK ORDER: a run that needs both the host lock and the e2e lock (API E2E, test:e2e:api) takes them in this one order: "flock /tmp/mscd-stack.lock flock /tmp/mscd-e2e.lock flock -s /tmp/mscd-npm.lock <command>". Never take /tmp/mscd-stack.lock while you hold /tmp/mscd-e2e.lock: two packages deadlocked that way.
- Server integration tests: set MSCD_TEST_CONTAINER_PREFIX=${WP.toLowerCase()}- .
- Docker: name every container, network, volume and compose project you create with the prefix "${WP.toLowerCase()}-". Never stop or remove containers you did not start; never prune. Remove your own containers at the end. If Docker is not running, say so in the report instead of skipping tests.
- Never run "pkill -f" with a pattern that can match your own shell; kill by PID.
- MEMORY: the build host has 16 GB shared with other tools. Run at most one Compose stack at a time (SaaS stack, smoke test, journey or the API E2E stack), never next to another one, and take it down as soon as its run ends. Two SaaS stacks at once terminated WSL on 2026-10-29.
- Temporary files and logs: use your own subfolder of the scratchpad or of /var/tmp named after your work package (for example "${WP.toLowerCase()}/"); several packages share those folders, so never reuse a generic file name such as e2e-api.log.
- Writing rules for any document or UI text: plain English, no em dash (U+2014), no centre dot (U+00B7), no meta commentary.
- SPEED RULE: the machine is shared by up to four packages. Do not run the full web E2E suite (all of apps/web/e2e) or the full server integration suite; run your package's acceptance commands, the targeted specs and tests of the files you touch, and the reduced common acceptance of section G.1. The orchestrator runs the full suites once per wave.
- BROWSER SUITE RULE (owner, 2026-10-31: the full browser suites were the slowest part of every package): where an acceptance command names \"npm run test:e2e\" or \"npm run test:e2e:api\" without spec files, run it with the spec files of your package and of the screens and shared code you touched (for example \"npm run test:e2e:api -w @mscd/web -- e2e/routing.spec.js e2e/shell.spec.js\"), never the whole suite. List the specs you ran in the acceptance note. The orchestrator runs both full suites once per wave, and CI runs them on every push to main.
- Write the handoff note docs/platform/handoff/${WP}.md (what was built, deviations, follow-ups, acceptance results).
`

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, passed: { type: 'boolean' }, note: { type: 'string' } }, required: ['command', 'passed', 'note'] } },
    needsFromOrchestrator: { type: 'array', items: { type: 'string' }, description: 'changes needed outside owned paths, missing packages, plan problems' },
  },
  required: ['summary', 'filesChanged', 'acceptance', 'needsFromOrchestrator'],
}
const REVIEW = {
  type: 'object',
  properties: {
    acceptancePassed: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, where: { type: 'string' }, problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'where', 'problem', 'evidence', 'fix'] } },
  },
  required: ['acceptancePassed', 'problems'],
}

// args.interrupted: an earlier implementer was stopped part way (for example the session ended). The new implementer
// finishes the work in the tree; args.previousTranscript may name the stopped agent's transcript (JSON lines).
const RESUME = args.interrupted
  ? `\nRESUMING: an earlier implementer of ${WP} was stopped part way. Its work is in the working tree, uncommitted (git status shows it; only your owned and assigned paths are yours).${args.previousTranscript ? ` Its transcript (JSON lines) is at ${args.previousTranscript}; read its last part for its plan and progress.` : ''} Check what is done, keep what is right, finish the rest, and do not start over.\n`
  : ''

phase('Implement')
const built = await agent(`${CTX}${RESUME}
TASK: Implement ${WP} completely and to production quality, following the plan exactly. Then run every acceptance command of ${WP} (and the common acceptance that applies at this point of the build) and iterate until they all pass. Report each command with pass/fail.`, { label: `implement:${WP}`, phase: 'Implement', schema: REPORT })

const verifyPrompt = (round, prior) => `${CTX}
TASK: You are the independent verifier for ${WP} (round ${round}). Do NOT edit any files.
1. Run every acceptance command of ${WP} literally (browser suites with targeted spec files, as the BROWSER SUITE RULE says), from a clean state where the command implies it (for example stop and remove the compose project first if the acceptance starts one). Record exact output for failures.
2. Adversarially review the implementation against the Milestone 3 plan, the Milestone 1 and 2 rules it keeps, and the UI contract: missing items from the brief, behaviour that differs from the plan, security issues (secrets in files, injection, missing auth checks, RLS gaps where relevant), fragile code (hard-coded paths, race conditions, unpinned versions), files changed outside the owned paths (check with "git status --porcelain" and compare with the Owns list; note that other agents are concurrently changing other paths, so only flag files that this WP's report claims or that clearly belong to its feature), and violations of the writing rules.
Only report problems you can prove with evidence. Severity blocker = acceptance fails or the brief is not met; major = real defect; minor = polish.
${prior ? 'Implementer report:\n' + JSON.stringify(prior) : ''}`

phase('Verify')
let review = await agent(verifyPrompt(1, built), { label: `verify:${WP}`, phase: 'Verify', schema: REVIEW })
const history = [{ built, review }]
let round = 1
while (review && (!review.acceptancePassed || review.problems.some((p) => p.severity !== 'minor')) && round <= 2) {
  phase('Fix')
  const fixed = await agent(`${CTX}
TASK: Fix every finding below for ${WP} (all blockers and majors; minors when cheap), staying inside your owned paths. Then re-run all acceptance commands until they pass.
FINDINGS:
${JSON.stringify(review.problems, null, 1)}
ACCEPTANCE PASSED BEFORE FIX: ${review.acceptancePassed}`, { label: `fix:${WP}:r${round}`, phase: 'Fix', schema: REPORT })
  round++
  review = await agent(verifyPrompt(round, fixed), { label: `verify:${WP}:r${round}`, phase: 'Fix', schema: REVIEW })
  history.push({ fixed, review })
}
if (review && review.problems.length && review.problems.every((p) => p.severity === 'minor') && review.acceptancePassed) {
  const polished = await agent(`${CTX}
TASK: Apply these minor findings for ${WP} where they are safe and cheap, then re-run the acceptance commands.
FINDINGS:
${JSON.stringify(review.problems, null, 1)}`, { label: `polish:${WP}`, phase: 'Fix', schema: REPORT })
  history.push({ polished })
}
return { wp: WP, final: review, rounds: round, history }
