#!/usr/bin/env bash
# Makes the MSCD SaaS release key set (M2-S01, K.2). The owner runs it once on
# the owner's own computer, from a checkout of this repository after npm ci:
#
#   deploy/scripts/saas-keys.sh --out ~/mscd-release-keys
#
# It writes, in a new folder outside any git work tree:
#   pack-signing.key, pack-signing.pub          signs the framework packs (mscd-pack keygen)
#   licence-signing.key, licence-signing.pub    signs customer licences (mscd-pack keygen)
#   bundle-signing.key, mscd-release.pub        signs the on-premise bundle (EC P-256)
#   production/ and staging/                    platform.key, storage.key, gateway.token and the
#                                               audit anchor pair (mscd-server keys generate)
#   trusted/                                    the public keys compiled into the release server
#                                               image, named as its trusted-keys build context
#                                               expects (licence-*.pub, pack-*.pub, anchor-*.pub)
#   KEYS.txt                                    key ids and what each file is for (no secret)
#
# Then it prints the gh commands that store the values as GitHub environment
# secrets and variables (K.2). It never prints a private value. It ends with a
# reminder to store offline copies in a password manager, because GitHub
# secrets cannot be read back and a lost KEK makes every backup unreadable.
#
# Works with the bash 3.2 of macOS. Needs Node.js 22 and this repository with
# its dependencies installed (npm ci).
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
PACK_CLI=$REPO_DIR/packages/pack-tools/dist/cli.js
# The keys command module of mscd-server (apps/server/src/cli/keys.ts).
SERVER_KEYS_CLI=$REPO_DIR/apps/server/dist/cli/keys.js
DEV_KEY_IDS=$REPO_DIR/packages/pack-tools/dev-keys/dev-key-ids.json
DEFAULT_REPO=mqusaeri/mscd

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BOLD=$'\033[1m' C_RESET=$'\033[0m'
else
    C_RED='' C_GREEN='' C_YELLOW='' C_BOLD='' C_RESET=''
fi

usage() {
    cat <<'EOF'
Usage: deploy/scripts/saas-keys.sh --out DIR [--repo OWNER/NAME] [--print-only]

Makes the MSCD SaaS release key set in DIR (a new or empty folder outside any
git work tree) and prints the gh commands that store it in the GitHub
environments release, production, staging and restore-test.

Options:
  --out DIR           Output folder for the keys (required)
  --repo OWNER/NAME   GitHub repository for the printed commands (default: the
                      origin remote of this checkout, else mqusaeri/mscd)
  --print-only        Print the commands without the closing reminder prompt (tests)
  -h, --help          Show this help

Private values are never printed. Keep DIR until the gh commands have run and
the offline copies are stored, then delete it.
EOF
}

say() { printf '%s\n' "$*"; }
pass() { printf '  %sPASS%s  %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %sWARN%s  %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die() {
    printf '%sERROR%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
    exit 1
}

OUT='' REPO='' PRINT_ONLY=false

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --out)
                [ $# -ge 2 ] && [ -n "$2" ] || die "--out needs a folder. See --help"
                OUT=$2
                shift 2
                ;;
            --repo)
                [ $# -ge 2 ] && [ -n "$2" ] || die "--repo needs OWNER/NAME. See --help"
                REPO=$2
                shift 2
                ;;
            --print-only) PRINT_ONLY=true; shift ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See --help" ;;
        esac
    done
    [ -n "$OUT" ] || die "--out is required (a new folder outside any git work tree). See --help"
    if [ -n "$REPO" ]; then
        printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || die "--repo takes OWNER/NAME, for example mqusaeri/mscd"
    fi
}

# absolute PATH: PATH made absolute without resolving it (it may not exist yet).
absolute() {
    case "$1" in
        /*) printf '%s' "$1" ;;
        *) printf '%s/%s' "$PWD" "$1" ;;
    esac
}

# in_git_work_tree DIR: true when DIR, or the nearest folder of it that exists,
# is inside a git work tree or a .git folder. Symbolic links are resolved.
in_git_work_tree() {
    local dir=$1 answer
    while [ ! -d "$dir" ]; do dir=$(dirname -- "$dir"); done
    dir=$(cd -- "$dir" && pwd -P)
    if command -v git >/dev/null 2>&1; then
        answer=$(unset GIT_DIR GIT_WORK_TREE; git -C "$dir" rev-parse --is-inside-work-tree --is-inside-git-dir 2>/dev/null || true)
        case "$answer" in *true*) return 0 ;; esac
    fi
    # Also without git: a .git entry in the folder or one of its parents.
    while :; do
        if [ -e "$dir/.git" ] || [ "$(basename -- "$dir")" = .git ]; then return 0; fi
        [ "$dir" != / ] || return 1
        dir=$(dirname -- "$dir")
    done
}

check_out_dir() {
    case "$OUT" in
        *"'"* | *'"'* | *\\* | *'$'* | *'`'*) die "--out must not hold quotes, backslashes, \$ or backticks (the printed commands quote it)" ;;
    esac
    OUT=$(absolute "$OUT")
    if in_git_work_tree "$OUT"; then
        die "--out $OUT is inside a git work tree. Release keys never go into a repository (R-11); choose a folder in your home directory, for example ~/mscd-release-keys."
    fi
    if [ -e "$OUT" ]; then
        [ -d "$OUT" ] || die "--out $OUT exists and is not a folder"
        if [ -n "$(ls -A -- "$OUT")" ]; then
            die "--out $OUT is not empty. Choose a new folder; existing keys are never replaced."
        fi
        CREATED_OUT=false
    else
        CREATED_OUT=true
    fi
}

check_tools() {
    command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node.js 22 and run npm ci in $REPO_DIR."
    local major
    major=$(node -p 'process.versions.node.split(".")[0]')
    [ "$major" -ge 22 ] || die "Node.js $(node -v) is too old; MSCD needs Node.js 22 or later"
    [ -d "$REPO_DIR/node_modules" ] || die "The dependencies are not installed. Run npm ci in $REPO_DIR first."
    [ -f "$DEV_KEY_IDS" ] || die "Cannot find $DEV_KEY_IDS; run this script from the MSCD repository"
    if [ ! -f "$PACK_CLI" ] || [ ! -f "$SERVER_KEYS_CLI" ]; then
        say "Building mscd-pack and mscd-server (once; npm run build)"
        (cd "$REPO_DIR" && npm run build -w @mscd/shared -w @mscd/pack-tools -w @mscd/server >/dev/null) ||
            die "The build failed. Run: npm run build -w @mscd/shared -w @mscd/pack-tools -w @mscd/server"
    fi
    [ -f "$PACK_CLI" ] && [ -f "$SERVER_KEYS_CLI" ] || die "mscd-pack or mscd-server is missing after the build"
}

# server_keys_generate DIR: "mscd-server keys generate --out DIR". Only the keys
# command module of mscd-server is loaded, so no other server module (or a
# half-updated build of one) can stop the key generation.
server_keys_generate() {
    node - "$REPO_DIR/apps/server" "$SERVER_KEYS_CLI" "$1" <<'NODE'
const [serverDir, keysModule, out] = process.argv.slice(2);
const { Command } = require(require.resolve('commander', { paths: [serverDir] }));
const program = new Command('mscd-server').exitOverride();
require(keysModule).register(program);
program.parseAsync(['node', 'mscd-server', 'keys', 'generate', '--out', out]).catch((error) => {
  process.stderr.write(`mscd-server keys generate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
NODE
}

default_repo() {
    local url
    url=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)
    url=$(printf '%s' "$url" | sed -n 's#^.*github\.com[:/]\([A-Za-z0-9_.-]*/[A-Za-z0-9_.-]*\)$#\1#p' | sed 's#\.git$##')
    if [ -n "$url" ]; then printf '%s' "$url"; else printf '%s' "$DEFAULT_REPO"; fi
}

DONE=false CREATED_OUT=false
cleanup() {
    # A run that stopped half way leaves no partial key set behind.
    if [ "$DONE" != true ] && [ -n "$OUT" ] && [ -d "$OUT" ]; then
        chmod -R u+w "$OUT" 2>/dev/null || true
        if [ "$CREATED_OUT" = true ]; then
            rm -rf -- "$OUT"
        else
            find "$OUT" -mindepth 1 -delete 2>/dev/null || true
        fi
    fi
}

# make_keys: every file of the key set. Nothing is printed from a private file.
make_keys() {
    local env
    (umask 077 && mkdir -p -- "$OUT")
    chmod 0700 "$OUT"
    (umask 077 && mkdir -p -- "$OUT/trusted")

    node "$PACK_CLI" keygen --out "$OUT" --name pack-signing >/dev/null
    node "$PACK_CLI" keygen --out "$OUT" --name licence-signing >/dev/null
    pass "Pack and licence signing pairs (mscd-pack keygen)"

    # Separate KEKs and anchor keys per environment: a staging server never
    # holds a key that opens production data.
    for env in production staging; do
        server_keys_generate "$OUT/$env" >/dev/null
        chmod 0700 "$OUT/$env"
        pass "$env: platform.key, storage.key, gateway.token and the audit anchor pair (mscd-server keys generate)"
    done

    cp -- "$OUT/licence-signing.pub" "$OUT/trusted/licence-release.pub"
    cp -- "$OUT/pack-signing.pub" "$OUT/trusted/pack-release.pub"
    cp -- "$OUT/production/audit-anchor.pub" "$OUT/trusted/anchor-production.pub"
    cp -- "$OUT/staging/audit-anchor.pub" "$OUT/trusted/anchor-staging.pub"
    chmod 0755 "$OUT/trusted"
    chmod 0644 "$OUT"/trusted/*.pub

    # The bundle signing key (EC P-256, as build-bundle.sh --sign-key takes),
    # the key ids, the development key check and KEYS.txt.
    node - "$OUT" "$DEV_KEY_IDS" <<'NODE'
const { createHash, createPublicKey, generateKeyPairSync } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const [out, devIdsFile] = process.argv.slice(2);

const bundle = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
writeFileSync(path.join(out, 'bundle-signing.key'), bundle.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
writeFileSync(path.join(out, 'mscd-release.pub'), bundle.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });

const keyId = (file) => {
  const key = createPublicKey(readFileSync(path.join(out, file)));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 public key`);
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
};
const devIds = new Set(JSON.parse(readFileSync(devIdsFile, 'utf8')));
const keys = [
  ['trusted/pack-release.pub', 'pack signing key (pack-signing.key)'],
  ['trusted/licence-release.pub', 'licence signing key (licence-signing.key)'],
  ['trusted/anchor-production.pub', 'production audit anchor key (production/audit-anchor.key)'],
  ['trusted/anchor-staging.pub', 'staging audit anchor key (staging/audit-anchor.key)'],
].map(([file, what]) => ({ file, what, id: keyId(file) }));
const dev = keys.filter((k) => devIds.has(k.id));
if (dev.length > 0) {
  process.stderr.write(`Development key ids found: ${dev.map((k) => `${k.file} ${k.id}`).join(', ')}. The tools may be modified; nothing is kept.\n`);
  process.exit(3);
}
if (new Set(keys.map((k) => k.id)).size !== keys.length) {
  process.stderr.write('Two generated keys have the same key id; nothing is kept.\n');
  process.exit(3);
}
const bundleFingerprint = createHash('sha256').update(bundle.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const lines = [
  'MSCD SaaS release key set',
  `Created ${new Date().toISOString()}. This file holds no secret.`,
  '',
  'Key ids (first 16 hexadecimal characters of the SHA-256 of the public key):',
  ...keys.map((k) => `  ${k.id}  ${k.what}`),
  `Bundle signing key fingerprint (SHA-256 of mscd-release.pub, DER): ${bundleFingerprint}`,
  '',
  'Files:',
  '  pack-signing.key             secret MSCD_PACK_SIGNING_KEY (environment release)',
  '  bundle-signing.key           secret MSCD_RELEASE_SIGNING_KEY (environment release)',
  '  licence-signing.key          offline only: signs customer licences (mscd-pack licence sign)',
  '  trusted/licence-release.pub  variable MSCD_TRUSTED_KEYS_LICENCE_PUB (environment release)',
  '  trusted/pack-release.pub     variable MSCD_TRUSTED_KEYS_PACK_PUB (environment release)',
  '  trusted/anchor-*.pub         variable MSCD_TRUSTED_KEYS_ANCHOR_PUB (both files, environment release)',
  '  production/platform.key      secret PLATFORM_KEY (environments production and restore-test)',
  '  production/storage.key       secret STORAGE_KEY (environments production and restore-test)',
  '  production/audit-anchor.key  secret AUDIT_ANCHOR_KEY (environment production)',
  '  staging/platform.key         secret PLATFORM_KEY (environment staging)',
  '  staging/storage.key          secret STORAGE_KEY (environment staging)',
  '  staging/audit-anchor.key     secret AUDIT_ANCHOR_KEY (environment staging)',
  '  */gateway.token              not uploaded: the deploy writes its own gateway token on the server',
  '  mscd-release.pub             public key delivered with on-premise bundles',
  '',
  'Keep an offline copy of every .key file in a password manager. GitHub secrets cannot be read back,',
  'and losing platform.key or storage.key makes every backup of that environment unreadable.',
  '',
];
writeFileSync(path.join(out, 'KEYS.txt'), lines.join('\n'), { mode: 0o644, flag: 'wx' });
NODE
    pass "Bundle signing key (EC P-256) and mscd-release.pub"
    pass "No key id is a development key id (dev-key-ids.json)"
    sed -n 's/^  \([0-9a-f]\{16\}\)  \(.*\)$/        key \1 \2/p' "$OUT/KEYS.txt"
}

# quote VALUE: VALUE in single quotes for the printed commands (check_out_dir
# refused quotes, so no escaping is needed).
quote() { printf "'%s'" "$1"; }

print_commands() {
    local o=$OUT repo=$1 env
    {
        say ''
        say "${C_BOLD}Store the keys in GitHub${C_RESET} (gh, signed in as the owner; run from any folder):"
        say ''
        say "export GH_REPO=$repo"
        say ''
        say '# The four environments (an existing environment is kept as it is). Then set the'
        say '# required reviewer and the deployment rules in Settings > Environments (docs/saas/release.md).'
        for env in release staging production restore-test; do
            say "gh api --method PUT \"repos/\$GH_REPO/environments/$env\" --silent"
        done
        say ''
        say '# Environment release: build, check and sign the release images and the bundle'
        say "gh secret set --env release MSCD_PACK_SIGNING_KEY < $(quote "$o/pack-signing.key")"
        say "gh secret set --env release MSCD_RELEASE_SIGNING_KEY < $(quote "$o/bundle-signing.key")"
        say "gh variable set --env release MSCD_TRUSTED_KEYS_LICENCE_PUB < $(quote "$o/trusted/licence-release.pub")"
        say "gh variable set --env release MSCD_TRUSTED_KEYS_PACK_PUB < $(quote "$o/trusted/pack-release.pub")"
        say "cat $(quote "$o/trusted/anchor-production.pub") $(quote "$o/trusted/anchor-staging.pub") | gh variable set --env release MSCD_TRUSTED_KEYS_ANCHOR_PUB"
        say ''
        say '# Environment production'
        say "gh secret set --env production PLATFORM_KEY < $(quote "$o/production/platform.key")"
        say "gh secret set --env production STORAGE_KEY < $(quote "$o/production/storage.key")"
        say "gh secret set --env production AUDIT_ANCHOR_KEY < $(quote "$o/production/audit-anchor.key")"
        say ''
        say '# Environment staging (keys of its own)'
        say "gh secret set --env staging PLATFORM_KEY < $(quote "$o/staging/platform.key")"
        say "gh secret set --env staging STORAGE_KEY < $(quote "$o/staging/storage.key")"
        say "gh secret set --env staging AUDIT_ANCHOR_KEY < $(quote "$o/staging/audit-anchor.key")"
        say ''
        say '# Environment restore-test: copies of the production KEKs, so the weekly restore test'
        say '# can open the production backups (D-S12)'
        say "gh secret set --env restore-test PLATFORM_KEY < $(quote "$o/production/platform.key")"
        say "gh secret set --env restore-test STORAGE_KEY < $(quote "$o/production/storage.key")"
        say ''
        say "Key ids and what each file is for: $o/KEYS.txt"
    }
}

print_reminder() {
    local o=$OUT
    say ''
    say "${C_BOLD}Store offline copies now.${C_RESET}"
    say 'GitHub secrets cannot be read back, and losing platform.key or storage.key makes every'
    say 'backup of that environment unreadable. Put each of these files in a password manager'
    say '(as an attachment or a secure note), with KEYS.txt:'
    say "  $o/pack-signing.key"
    say "  $o/licence-signing.key"
    say "  $o/bundle-signing.key"
    say "  $o/production/platform.key, storage.key, audit-anchor.key"
    say "  $o/staging/platform.key, storage.key, audit-anchor.key"
    say 'When the gh commands have run and the copies are stored, delete the folder:'
    say "  rm -rf $(quote "$o")"
}

main() {
    parse_args "$@"
    check_out_dir
    trap cleanup EXIT
    trap 'exit 130' INT TERM HUP
    check_tools
    local repo=${REPO:-$(default_repo)}

    say "${C_BOLD}MSCD SaaS release key set${C_RESET} in $OUT"
    make_keys
    DONE=true

    # One write, so a reader that stops early (grep -q) cannot interrupt it.
    local text
    text=$(print_commands "$repo")
    if [ "$PRINT_ONLY" = true ]; then
        printf '%s\n' "$text"
        return 0
    fi
    printf '%s\n' "$text"
    print_reminder
    if [ -t 0 ]; then
        local answer=''
        while [ "$answer" != stored ]; do
            printf '\nType "stored" when the offline copies are in the password manager: '
            read -r answer || break
        done
    else
        warn "No terminal: confirm yourself that the offline copies are stored before you delete $OUT"
    fi
}

main "$@"
