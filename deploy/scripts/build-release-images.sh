#!/usr/bin/env bash
# Builds, checks and publishes the MSCD release images for SaaS (M2-S01).
#
#   deploy/scripts/build-release-images.sh --version 1.1.0 \
#     --trusted-keys-dir /secure/trusted --pack-signing-key /secure/pack-signing.key \
#     --registry ghcr.io/mqusaeri --push --digest-file digests.json
#
# Steps:
#   1. Refuses demo image names (ending in -demo) and versions other than x.y.z
#      or x.y.z-rc.n, before anything is built.
#   2. Runs build-bundle.sh --images-only --release: the web image built with
#      VITE_DATA_SOURCE=api and the server image of target release, each with an
#      SBOM and the build provenance (mode=max) when Docker uses the containerd
#      image store. On the loaded images it then runs check-release-artefacts.sh
#      (R-13) and the Trivy gate (no HIGH or CRITICAL vulnerability that has a fix).
#      --release also requires the Alpine updates. A --load test build applies
#      them when the Alpine mirrors answer and warns otherwise; the Trivy gate
#      still decides, so an image without the updates passes only when it has no
#      fixable HIGH or CRITICAL vulnerability.
#   3. --load stops there. --push pushes <server image>:<version> and
#      <web image>:<version> exactly as they were checked, with their SBOM and
#      provenance, and confirms the registry holds the same digests.
#   4. Writes both digests to --digest-file (JSON).
#
# .github/workflows/release.yml runs this with --push, then signs both digests
# with keyless cosign. docs/saas/release.md explains every check.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# x.y.z or x.y.z-rc.n, the only release versions (git tags vx.y.z and vx.y.z-rc.n).
readonly VERSION_PATTERN='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$'
# host[:port]/path, lower case, no tag or digest.
readonly NAME_PATTERN='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+$'
# The source paths of the images, as build-bundle.sh counts them for -dirty.
readonly SOURCE_PATHS=(apps packages packs tools package.json package-lock.json deploy docs)

usage() {
    cat <<'EOF'
Usage: deploy/scripts/build-release-images.sh --version VERSION --trusted-keys-dir DIR
           --pack-signing-key FILE --registry HOST/OWNER (--load | --push) [options]

Builds the MSCD release images (web in API mode, server target release), checks
them for development keys and demo data (R-13) and for HIGH or CRITICAL
vulnerabilities that have a fix, then loads them on this machine (--load) or
pushes them (--push) and writes their digests.

--push builds with build-bundle.sh --release: newest base images, Alpine
updates required, scan gate. --load uses the same gate and applies the Alpine
updates when the mirrors answer (a warning otherwise), for build machines that
cannot reach them.

Required:
  --version VERSION         x.y.z or x.y.z-rc.n, for example 1.1.0 or 1.1.0-rc.1
  --trusted-keys-dir DIR    Release public keys compiled into the server (licence-*.pub,
                            pack-*.pub, anchor-*.pub), outside the repository
  --pack-signing-key FILE   Release pack signing key (Ed25519 PEM), outside the repository
  --registry HOST/OWNER     Registry and owner, for example ghcr.io/mqusaeri; not needed
                            when both --server-image and --web-image are given
  --load | --push           Keep the checked images on this machine, or push them

Options:
  --server-image NAME       Full server image name without a tag
                            (default: <registry>/mscd-server)
  --web-image NAME          Full web image name without a tag (default: <registry>/mscd-web)
  --revision REV            Source revision for the image labels (default: the commit of
                            HEAD, with -dirty when the sources have uncommitted files)
  --build-ca FILE           CA certificate of a TLS-inspecting proxy (default: $MSCD_BUILD_CA)
  --digest-file FILE        Write the digests as JSON (required with --push)
  --source-url URL          Label org.opencontainers.image.source, for example
                            https://github.com/mqusaeri/mscd (links the GHCR packages)
  --no-pull                 Keep the base images of this machine (--load test builds only)
  -h, --help                Show this help

Image names ending in -demo are refused: demo images never reach a release.
--push needs a clean work tree, docker login to the registry and the containerd
image store of Docker (it keeps the SBOM and provenance with the image).

Digest file (both digests are image index digests, sha256:...):
  {"version", "revision", "created", "pushed", "attested",
   "server", "web", "serverImage", "webImage", "serverRef", "webRef"}
EOF
}

VERSION='' REVISION='' TRUSTED_KEYS_DIR='' PACK_SIGNING_KEY='' BUILD_CA=${MSCD_BUILD_CA:-}
REGISTRY='' SERVER_IMAGE='' WEB_IMAGE='' MODE='' DIGEST_FILE='' SOURCE_URL='' NO_PULL=false

need_value() {
    if [[ $# -lt 2 || -z $2 || $2 == --* ]]; then
        die "Option $1 needs a value. See --help"
    fi
}

set_mode() {
    [[ -z $MODE || $MODE == "$1" ]] || die "Use --load or --push, not both"
    MODE=$1
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version) need_value "$@"; VERSION=$2; shift 2 ;;
            --revision) need_value "$@"; REVISION=$2; shift 2 ;;
            --trusted-keys-dir) need_value "$@"; TRUSTED_KEYS_DIR=$(absolute_path "$2"); shift 2 ;;
            --pack-signing-key) need_value "$@"; PACK_SIGNING_KEY=$(absolute_path "$2"); shift 2 ;;
            --build-ca)
                # An empty value means no build CA, like an unset MSCD_BUILD_CA.
                [[ $# -ge 2 && $2 != --* ]] || die "Option --build-ca needs a value. See --help"
                BUILD_CA=$2
                shift 2
                ;;
            --registry) need_value "$@"; REGISTRY=${2%/}; shift 2 ;;
            --server-image) need_value "$@"; SERVER_IMAGE=$2; shift 2 ;;
            --web-image) need_value "$@"; WEB_IMAGE=$2; shift 2 ;;
            --load) set_mode load; shift ;;
            --push) set_mode push; shift ;;
            --digest-file) need_value "$@"; DIGEST_FILE=$(absolute_path "$2"); shift 2 ;;
            --source-url) need_value "$@"; SOURCE_URL=$2; shift 2 ;;
            --no-pull) NO_PULL=true; shift ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See --help" ;;
        esac
    done
    if [[ -n $REGISTRY ]]; then
        SERVER_IMAGE=${SERVER_IMAGE:-$REGISTRY/mscd-server}
        WEB_IMAGE=${WEB_IMAGE:-$REGISTRY/mscd-web}
    fi
}

# image_repository NAME: NAME without a tag or digest (the last ":" after the last "/").
image_repository() {
    local name=${1%%@*} last
    last=${name##*/}
    if [[ $last == *:* ]]; then name=${name%:*}; fi
    printf '%s' "$name"
}

# refuse_demo_name NAME: stops when NAME (without a tag or digest) ends in -demo.
refuse_demo_name() {
    local repo
    [[ -n $1 ]] || return 0
    repo=$(image_repository "$1")
    if [[ $repo == *-demo ]]; then
        die "demo images are refused: $1 ends in -demo. Release images are built from the release target only (R-13, S-7)."
    fi
}

# refuse_demo_images ARGS...: the first check, before the arguments are parsed,
# so no other mistake on the command line can hide it (S-7). The default names
# derived from --registry are checked again after parsing.
refuse_demo_images() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --server-image | --web-image)
                if [[ $# -ge 2 ]]; then refuse_demo_name "$2"; fi
                ;;
            --server-image=* | --web-image=*) refuse_demo_name "${1#*=}" ;;
        esac
        shift
    done
}

validate_args() {
    [[ -n $VERSION ]] || die "--version is required (x.y.z or x.y.z-rc.n). See --help"
    [[ $VERSION =~ $VERSION_PATTERN ]] ||
        die "Version '$VERSION' does not match x.y.z or x.y.z-rc.n (for example 1.1.0 or 1.1.0-rc.1)"
    [[ -n $MODE ]] || die "Use --load (keep the images here) or --push (publish them). See --help"
    [[ -n $SERVER_IMAGE && -n $WEB_IMAGE ]] ||
        die "--registry is required (for example ghcr.io/mqusaeri), unless --server-image and --web-image are both given"
    local name
    for name in "$SERVER_IMAGE" "$WEB_IMAGE"; do
        [[ $name =~ $NAME_PATTERN ]] ||
            die "Image name '$name' must be a full lower-case name without a tag, such as ghcr.io/mqusaeri/mscd-server"
    done
    [[ $SERVER_IMAGE != "$WEB_IMAGE" ]] || die "--server-image and --web-image must differ"
    [[ -n $TRUSTED_KEYS_DIR ]] || die "--trusted-keys-dir is required (the release public keys; see --help)"
    [[ -n $PACK_SIGNING_KEY ]] || die "--pack-signing-key is required (the release pack signing key; see --help)"
    if [[ -n $REVISION && ! $REVISION =~ ^[0-9A-Za-z._-]{1,64}$ ]]; then
        die "Revision '$REVISION' may hold only letters, digits, '.', '_' and '-' (at most 64)"
    fi
    if [[ -n $SOURCE_URL && ! $SOURCE_URL =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._-]+)+$ ]]; then
        die "--source-url takes an https URL such as https://github.com/mqusaeri/mscd"
    fi
    if [[ $MODE == push ]]; then
        [[ -n $DIGEST_FILE ]] || die "--push needs --digest-file (the deploy reads the digests from it)"
        [[ $NO_PULL == false ]] || die "--no-pull is for --load test builds; pushed images start from the newest base images"
    fi
    if [[ -n $DIGEST_FILE && -d $DIGEST_FILE ]]; then
        die "--digest-file $DIGEST_FILE is a folder; name a file such as digests.json"
    fi
}

# sources_dirty: true when the image sources have uncommitted or untracked files.
sources_dirty() {
    [[ -n $(git -C "$REPO_DIR" status --porcelain -- "${SOURCE_PATHS[@]}" 2>/dev/null) ]]
}

resolve_revision() {
    local head='' dirty=false
    if git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        head=$(git -C "$REPO_DIR" rev-parse HEAD)
        if sources_dirty; then dirty=true; fi
    elif [[ $MODE == push ]]; then
        die "$REPO_DIR is not a git work tree; release images are built from a commit"
    fi
    if [[ $dirty == true ]]; then
        if [[ $MODE == push ]]; then
            git -C "$REPO_DIR" status --short -- "${SOURCE_PATHS[@]}" | head -n 20 | sed 's/^/        /'
            die "The sources have uncommitted or untracked files (above). Commit them before pushing release images."
        fi
        warn "The sources have uncommitted or untracked files: test images only, never push them"
    fi
    if [[ -z $REVISION ]]; then
        REVISION=${head:-unknown}
        if [[ $dirty == true ]]; then REVISION+=-dirty; fi
    elif [[ -n $head && $MODE == push && $REVISION != "$head" ]]; then
        die "--revision $REVISION is not the checked-out commit $head; release images are labelled with the commit they are built from"
    fi
}

# check_docker: Docker, Buildx and the image store. ATTEST is true when the
# images can carry their SBOM and provenance (containerd image store).
check_docker() {
    command -v docker >/dev/null 2>&1 || die "docker is not installed"
    docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon. Start Docker and run again."
    docker buildx version >/dev/null 2>&1 || die "docker buildx is not available. Install the Docker Buildx plugin."
    if docker info --format '{{json .DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter.v1'; then
        ATTEST=true
        pass "Docker uses the containerd image store: the images carry an SBOM and the build provenance"
    elif [[ $MODE == push ]]; then
        die 'Pushed release images need their SBOM and provenance, which Docker keeps only in the containerd image store. Add "features": {"containerd-snapshotter": true} to /etc/docker/daemon.json and restart Docker.'
    else
        ATTEST=false
        warn "Docker does not use the containerd image store: these test images carry no SBOM or provenance"
    fi
}

# local_digest IMAGE: the digest of the image on this machine. With the
# containerd image store it is the image index digest, the one a push publishes.
local_digest() {
    docker image inspect --format '{{.Id}}' "$1"
}

# push_image REF: pushes REF and prints the pushed digest.
push_image() {
    local ref=$1 out digest
    if ! out=$(docker push "$ref" 2>&1); then
        printf '%s\n' "$out" | tail -n 15 | sed 's/^/        /' >&2
        die "docker push $ref failed. Log in first (docker login ${ref%%/*}) and check the package permissions."
    fi
    digest=$(printf '%s\n' "$out" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' | tail -n 1)
    [[ -n $digest ]] || die "docker push $ref did not report a digest"
    printf '%s' "$digest"
}

# registry_digest REF: the digest the registry serves for REF.
registry_digest() {
    docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$1" 2>/dev/null
}

write_digest_file() {
    local pushed=$1 server=$2 web=$3 tmp
    install -d -m 0755 "$(dirname -- "$DIGEST_FILE")"
    tmp=$(mktemp "$(dirname -- "$DIGEST_FILE")/.digests.XXXXXX")
    cat >"$tmp" <<EOF
{
  "version": "$VERSION",
  "revision": "$REVISION",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pushed": $pushed,
  "attested": $ATTEST,
  "server": "$server",
  "web": "$web",
  "serverImage": "$SERVER_IMAGE",
  "webImage": "$WEB_IMAGE",
  "serverRef": "$SERVER_IMAGE@$server",
  "webRef": "$WEB_IMAGE@$web"
}
EOF
    chmod 0644 "$tmp"
    mv -f -- "$tmp" "$DIGEST_FILE"
    pass "Digests written to $DIGEST_FILE"
}

main() {
    refuse_demo_images "$@"
    parse_args "$@"
    refuse_demo_name "$SERVER_IMAGE"
    refuse_demo_name "$WEB_IMAGE"
    validate_args

    local server_ref=$SERVER_IMAGE:$VERSION web_ref=$WEB_IMAGE:$VERSION
    title "MSCD release images $VERSION ($MODE)"

    step "Checking the inputs"
    resolve_revision
    check_docker
    pass "Version $VERSION, revision $REVISION"
    pass "Images $server_ref and $web_ref"

    local args=(--images-only --version "$VERSION" --revision "$REVISION"
        --trusted-keys-dir "$TRUSTED_KEYS_DIR" --pack-signing-key "$PACK_SIGNING_KEY"
        --server-image "$SERVER_IMAGE" --web-image "$WEB_IMAGE")
    if [[ $MODE == push ]]; then
        # Newest base images, Alpine updates required, scan gate.
        args+=(--release)
    else
        # The same gate; the Alpine updates are applied when the mirrors answer.
        args+=(--os-updates auto --scan gate)
        if [[ $NO_PULL == false ]]; then args+=(--pull); fi
    fi
    if [[ -n $BUILD_CA ]]; then args+=(--build-ca "$BUILD_CA"); fi
    if [[ $ATTEST == true ]]; then args+=(--attest); fi
    if [[ -n $SOURCE_URL ]]; then args+=(--source-url "$SOURCE_URL"); fi
    if [[ $NO_PULL == true ]]; then args+=(--no-pull); fi

    # Build, release artefact check and Trivy gate; build-bundle.sh stops on any failure.
    bash "$SCRIPT_DIR/build-bundle.sh" "${args[@]}"

    step "Release images"
    image_exists "$server_ref" || die "$server_ref was not built"
    image_exists "$web_ref" || die "$web_ref was not built"
    [[ $(docker image inspect --format '{{index .Config.Labels "com.cyberlentera.mscd.flavor"}}' "$server_ref") == release ]] ||
        die "$server_ref is not a release build (label com.cyberlentera.mscd.flavor)"
    local server web
    server=$(local_digest "$server_ref")
    web=$(local_digest "$web_ref")

    if [[ $MODE == push ]]; then
        local pushed_server pushed_web
        info "Pushing $server_ref"
        pushed_server=$(push_image "$server_ref")
        info "Pushing $web_ref"
        pushed_web=$(push_image "$web_ref")
        # The pushed digest must be the digest of the checked image, and the
        # registry must serve it under the version tag.
        [[ $pushed_server == "$server" ]] || die "The pushed server digest $pushed_server is not the checked image $server"
        [[ $pushed_web == "$web" ]] || die "The pushed web digest $pushed_web is not the checked image $web"
        [[ $(registry_digest "$server_ref") == "$server" ]] || die "The registry does not serve $server for $server_ref"
        [[ $(registry_digest "$web_ref") == "$web" ]] || die "The registry does not serve $web for $web_ref"
        pass "Pushed $SERVER_IMAGE@$server"
        pass "Pushed $WEB_IMAGE@$web"
    else
        pass "Loaded $server_ref ($server)"
        pass "Loaded $web_ref ($web)"
    fi

    if [[ -n $DIGEST_FILE ]]; then
        write_digest_file "$([[ $MODE == push ]] && echo true || echo false)" "$server" "$web"
    fi
    if [[ $MODE == push ]]; then
        printf '\n%sRelease images pushed.%s Sign both digests next (release.yml does this with cosign).\n' \
            "$C_GREEN$C_BOLD" "$C_RESET"
    else
        printf '\n%sRelease images checked and loaded.%s Nothing was pushed (--load).\n' "$C_GREEN$C_BOLD" "$C_RESET"
    fi
}

ATTEST=false
main "$@"
