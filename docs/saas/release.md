# Releases: images, signatures and checks

A release of MSCD for the SaaS service is two container images, `ghcr.io/mqusaeri/mscd-server` and `ghcr.io/mqusaeri/mscd-web`, built from one git tag. Each image is checked before it is published, signed after it is published, and named by its digest (a `sha256:` fingerprint of its exact content) in the file `digests.json` of the GitHub Release. The production server runs only these digests, and only after their signatures are checked (`deploy-prod.yml`, M2-S05).

This page covers the one-time setup, cutting a release, what each check means, how to verify an image yourself, the security scans, and test builds on a build machine. The plan behind it is package M2-S01 in section K of the [Milestone 2 plan](../platform/MILESTONE-2.md#k-saas-production-track).

## Files

| File | What it does |
|---|---|
| `.github/workflows/release.yml` | Builds, checks, pushes and signs the images for a tag `vX.Y.Z` or `vX.Y.Z-rc.N`, and creates the GitHub Release. Optional job: the signed on-premise bundle |
| `deploy/scripts/build-release-images.sh` | Builds and checks the two images, then keeps them on the machine (`--load`) or pushes them (`--push`) and writes `digests.json` |
| `deploy/scripts/build-bundle.sh --images-only` | The build and check half of the script above: images, release artefact check, vulnerability gate, no bundle |
| `deploy/scripts/saas-keys.sh` | Makes the release key set on the owner's computer and prints the commands that store it in GitHub |
| `.github/workflows/security-scan.yml` | CodeQL, gitleaks, OSV and Trivy scans on every push and pull request, plus a nightly scan of the released images |
| `.github/dependabot.yml` | Weekly grouped update proposals for npm packages, GitHub Actions and the base images of `deploy/docker` |
| `tools/scripts/check-workflows.mjs` | Checks the SaaS workflows against rule S-4 (see [Workflow rules](#workflow-rules)) |

## Before the first release

The owner does this once. [owner-inputs.md](owner-inputs.md) sections 1 and 2 hold the exact commands.

1. **GitHub settings.** The environments `release`, `staging`, `production` and `restore-test` exist; the owner is a required reviewer on `release` and `production`; tags `v*.*.*` are protected.
2. **Release key set.** On your own computer, in a clone of the repository at the release version, run `npm ci` and then:

   ```bash
   bash deploy/scripts/saas-keys.sh --out ~/mscd-release-keys
   ```

   The folder must be new (or empty) and outside any git work tree; the script refuses anything else and never replaces an existing key. It needs Node.js 22 and builds `mscd-pack` and `mscd-server` once when they are missing. It writes:

   | File | Use |
   |---|---|
   | `pack-signing.key` | Signs the framework packs inside the server image. Secret `MSCD_PACK_SIGNING_KEY` of `release` |
   | `licence-signing.key` | Signs customer licences (`mscd-pack licence sign`). Offline only, never in GitHub |
   | `bundle-signing.key`, `mscd-release.pub` | Sign and check the on-premise bundle. Secret `MSCD_RELEASE_SIGNING_KEY` of `release` |
   | `trusted/*.pub` | The public keys compiled into the release server image: variables `MSCD_TRUSTED_KEYS_LICENCE_PUB`, `MSCD_TRUSTED_KEYS_PACK_PUB` and `MSCD_TRUSTED_KEYS_ANCHOR_PUB` of `release` |
   | `production/` and `staging/` | Each holds `platform.key` and `storage.key` (the two key-encryption keys, KEKs), the audit anchor pair and a `gateway.token`. Secrets `PLATFORM_KEY`, `STORAGE_KEY` and `AUDIT_ANCHOR_KEY` of that environment; `restore-test` gets copies of the production KEKs |
   | `KEYS.txt` | The key ids and what each file is for. It holds no secret |

   Staging has keys of its own, so a problem on staging (for example during the penetration test) never exposes a production key. The release image trusts both audit anchor public keys. The `gateway.token` files are not uploaded: the deploy writes its own token on the server.

   The script then prints the `gh` commands that store each value. It never prints a private value. Run the printed commands, then store an offline copy of every `.key` file and of `KEYS.txt` in a password manager, as the closing reminder says. GitHub secrets cannot be read back, and losing `platform.key` or `storage.key` makes every backup of that environment unreadable. When the copies are stored and checked, delete the folder.

3. **Packages.** After the first release has pushed the images, check in the package settings of `mscd-server` and `mscd-web` that they stay private and that this repository has Actions access (Read or higher). `deploy-prod.yml`, `restore-test.yml` and the nightly image scan pull them with the job token.

## Cutting a release

1. Make sure `version` in `apps/server/package.json` is the version you release (for a release candidate, the version it leads to: `1.1.0` for `v1.1.0-rc.1`). The workflow stops when the tag and this version differ.
2. Tag the commit on the default branch and push the tag:

   ```bash
   git tag v1.1.0-rc.1
   git push origin v1.1.0-rc.1
   ```

3. Open the run of **Release** in the Actions tab and approve the `release` environment. Nothing is built before the approval.
4. The job builds, checks, pushes and signs the images (about 30 minutes) and creates the GitHub Release `v1.1.0-rc.1`. A tag with `-rc.N` becomes a pre-release.
5. The release page lists both digests and holds `digests.json` and the SBOM files. `deploy-prod.yml` reads the digests from there.

Each version is released once. When a release run fails before the GitHub Release exists, fix the cause and start the run again from the same tag. When the GitHub Release exists, publish a new version (for example `v1.1.0-rc.2`) instead of changing it.

To start a run by hand, start it from the tag so the signature names the tag (the deploy checks exactly that name):

```bash
gh workflow run release.yml --repo mqusaeri/mscd --ref v1.1.0 -f tag=v1.1.0
```

Add `-f bundle=true` to also build the signed on-premise bundle. It is attached to the same release as `mscd-onprem-<version>.tar.gz`, its `.sha256` file and `mscd-release.pub`. The bundle job asks for a second approval of `release`.

## What each check means

| Check | Where | What it protects | When it fails |
|---|---|---|---|
| Tag and version | `release.yml` | The tag, the image labels and the version the server reports are the same | Fix the tag or `apps/server/package.json` |
| Release exists | `release.yml` | A published version never changes under the same name | Publish a new version |
| Demo images refused | `build-release-images.sh` | Image names ending in `-demo` never reach a release (S-7). Checked before anything else | Use the release image names |
| Version pattern | `build-release-images.sh` | Only `x.y.z` and `x.y.z-rc.n` | Use a valid version |
| Committed sources | `build-release-images.sh --push` | Pushed images are built from one commit, named in their labels and in `digests.json` | Commit the changes; a release builds from a clean checkout |
| Release keys | `build-bundle.sh` | Trusted keys and the pack signing key come from outside the repository, match each other, and are no development key (R-11) | Use the release key set |
| Server build | `server.Dockerfile` | The trusted keys are compiled in, every pack is signed with the release key and verified, and no file holds a development key id | See the build log |
| Alpine updates | `build-bundle.sh --release` | Security updates of the base system are applied when the images are built | The Alpine mirrors could not be reached; run again |
| Release artefact check | `check-release-artefacts.sh` | No development key, development secret, demo or test profile or demo seed data in either image (R-13) | Find the file named in the log and remove it from the image |
| Vulnerability gate | Trivy 0.74.0 | No HIGH or CRITICAL vulnerability that has a fix, in the system packages or the npm packages of either image | Update the package named in `SECURITY-SCAN.txt` (build logs artefact) or wait for the base image fix, then release a new version |
| Same image pushed | `build-release-images.sh --push` | The pushed digest is the digest of the checked image, and the registry serves it under the version tag | Run again; report it if it repeats |
| SBOM and provenance | BuildKit (`--sbom=true`, `--provenance=mode=max`) | Each image carries its software list (SPDX) and a record of how it was built (SLSA). This needs the containerd image store of Docker, which the workflow turns on | |
| Signature | cosign, keyless | The digest was published by `release.yml` of this repository at this tag. The certificate comes from Sigstore for the GitHub identity of the run; no signing key is stored anywhere | |
| Signed attestations | cosign `attest` | The SBOM and the provenance are signed by the same identity | |
| GitHub attestation | `actions/attest-build-provenance` | A second provenance record kept by GitHub (`gh attestation verify`), while the repository is public | |

The signatures and attestations are recorded in the public Sigstore transparency log. The record holds the repository name, the workflow, the tag and the image digest, nothing else.

## Verify an image yourself

Install cosign 3 (`brew install cosign`, or the release binary from GitHub) and the GitHub CLI. Then, for release `v1.1.0`:

```bash
gh release download v1.1.0 --repo mqusaeri/mscd --pattern digests.json
SERVER=$(jq -r .serverRef digests.json)
WEB=$(jq -r .webRef digests.json)
ID=https://github.com/mqusaeri/mscd/.github/workflows/release.yml@refs/tags/v1.1.0
ISSUER=https://token.actions.githubusercontent.com

# The signature: published by release.yml at this tag
cosign verify "$SERVER" --certificate-identity "$ID" --certificate-oidc-issuer "$ISSUER"
cosign verify "$WEB" --certificate-identity "$ID" --certificate-oidc-issuer "$ISSUER"

# The signed SBOM and build provenance
cosign verify-attestation "$SERVER" --type spdxjson --certificate-identity "$ID" --certificate-oidc-issuer "$ISSUER" >/dev/null
cosign verify-attestation "$SERVER" --type slsaprovenance1 --certificate-identity "$ID" --certificate-oidc-issuer "$ISSUER" >/dev/null
# (slsaprovenance02 when the release log says the provenance was SLSA 0.2)

# The GitHub attestation
gh attestation verify "oci://$SERVER" --repo mqusaeri/mscd
```

Log in first when the packages are private: `gh auth refresh -s read:packages`, then `gh auth token | docker login ghcr.io -u <your user> --password-stdin`. Each `cosign verify` prints the verified claims and exits 0. Any other result means the image is not the one `release.yml` published: do not run it.

Always deploy by digest (`ghcr.io/mqusaeri/mscd-server@sha256:...`), never by the version tag alone: a tag can be moved, a digest cannot.

## Security scans

`security-scan.yml` runs on every push and pull request and every night at 02:23 UTC.

| Job | What it checks | When it fails |
|---|---|---|
| CodeQL | Security problems in the JavaScript and TypeScript code. The alerts go to Security, Code scanning, which only people with write access can see; the log shows only their number | Fix or, when it is a false alarm, dismiss the alert there with a reason |
| gitleaks | Secrets in the whole git history. Development keys and demo secrets (R-11), test fixtures and the example values of the API contract are allowed by name; every other finding fails | Rotate the secret at once (the history of a public repository cannot be recalled), then remove it from the code |
| OSV | Known vulnerabilities in the packages of `package-lock.json` | Update the package (Dependabot usually proposes it) |
| Trivy configuration | HIGH or CRITICAL misconfiguration in `deploy/` (Dockerfiles, Helm chart) | Fix the file named in the log |
| Released images (nightly) | The two digests of the latest GitHub Release against today's vulnerability data, so the running images are scanned again as new problems are published | Release a patch version with the fix and deploy it |

The scanners are pinned: actions by commit, the Trivy image by digest, gitleaks by version and checksum.

## Dependency updates

Dependabot opens one pull request per group every Monday: npm minor and patch updates (production and development separately), npm major updates, GitHub Actions and the base images of `deploy/docker`. It proposes only releases that are at least 14 days old. For actions it updates the commit SHA and the tag comment together. A pull request that changes `package-lock.json` passes the normal CI before it is merged.

## Workflow rules

Rule S-4 of the plan applies to every SaaS workflow, and `tools/scripts/check-workflows.mjs` checks it:

1. The workflow sets `permissions` at the top level (and never `write-all`); jobs add what they need.
2. Every action from outside this repository (GitHub's own included) is pinned to a full 40-character commit SHA with the tag in a comment: `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`. A `docker://` image needs a digest.
3. No secret in script text: `${{ secrets.X }}` and `${{ github.token }}` go into `env:`, and the script uses the variable. A value written into script text can end up in logs and in the process list.
4. A job of the environment `production` or `staging`, or of an environment chosen by an expression, has a concurrency group with `cancel-in-progress: false`, so two deploys never run at once and a running deploy is never cancelled half way.

```bash
node tools/scripts/check-workflows.mjs .github/workflows/release.yml   # given files
node tools/scripts/check-workflows.mjs --saas                          # every SaaS workflow that exists
node tools/scripts/check-workflows.mjs --saas --require-all            # and fail when one is missing
node tools/scripts/check-workflows.mjs --self-test                     # the checker's own cases
```

To pin a new action, look up the commit of its release tag and use a release that is at least two weeks old:

```bash
git ls-remote --tags https://github.com/actions/checkout | grep 'refs/tags/v7.0.1'
```

For an annotated tag, use the commit of the line ending in `^{}`.

## Test builds on a build machine

Agents and test scripts build release images with throwaway keys made at test time and deleted afterwards (rule S-2); they never use the real key set:

```bash
K=$(mktemp -d)
bash deploy/scripts/saas-keys.sh --out "$K/keys" --print-only >/dev/null
bash deploy/scripts/build-release-images.sh --version 1.1.0-rc.1 \
  --trusted-keys-dir "$K/keys/trusted" --pack-signing-key "$K/keys/pack-signing.key" \
  --build-ca "$MSCD_BUILD_CA" --registry localhost/mqusaeri --load --digest-file "$K/digests.json"
rm -rf "$K"
```

- `--load` keeps the images on the machine and pushes nothing. It runs the same release artefact check and vulnerability gate as a release. It applies the Alpine updates when the mirrors answer and warns when they do not, so a build machine without access to the mirrors can still build; the gate then decides whether the base images are current enough.
- `--no-pull` keeps the base images already on the machine, which saves pulls from Docker Hub in repeated test runs. `--push` refuses it.
- The build logs and `SECURITY-SCAN.txt` are in `deploy/dist/mscd-images-<version>.logs/`.
- Images built from uncommitted sources are labelled `<commit>-dirty`, and `--push` refuses them.
- `--push` needs the containerd image store of Docker, because only that store keeps the SBOM and provenance with a loaded image. Add `"features": {"containerd-snapshotter": true}` to `/etc/docker/daemon.json` and restart Docker.

## Troubleshooting

| Message | Meaning and fix |
|---|---|
| `demo images are refused` | An image name ends in `-demo`. Release images use the release names |
| `Start the run from the tag` | A run by hand was started from a branch. Use `--ref <tag>` as shown above |
| `The GitHub Release ... exists` | That version is published. Release a new version |
| `has HIGH or CRITICAL vulnerabilities that have a fix` | Read `SECURITY-SCAN.txt` in the `release-image-logs` artefact. For an npm package, update it (the lockfile change goes through review); for a system package, run the release again when the Alpine updates or a newer base image carry the fix |
| `apk update failed and APK_UPGRADE=true` | The build machine cannot reach the Alpine mirrors. A release needs them; a `--load` test build continues without them |
| `contains the development key id` | A development key reached an image. Check the trusted keys and the pack signing key you passed |
| `The pushed ... digest ... is not the checked image` | The registry stored something else than the checked image. Do not use the release; run it again |
| `Variable MSCD_TRUSTED_KEYS_..._PUB is not set` | Run the `gh variable set` lines that `saas-keys.sh` printed |
