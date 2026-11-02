// The public anchor keys the in-app anchor checks trust (build plan D-16, D-33; Milestone 3 M3-12): the chain verifier
// (`GET /admin/audit-trail/verify`, the purge of an organisation) and the nightly `audit.verify-chain` job, which signs
// a new anchor only for a chain whose newest anchor verifies.
//
// A release compiles in the anchor keys of its `MSCD_TRUSTED_KEYS_DIR` (SaaS: the operator's production and staging
// keys, `saas-keys.sh`; a key stays trusted for as long as its `anchor-*.pub` file stays in that folder). An on-premise
// installation makes its own anchor key pair when it is installed, which no release knows, so the checks also trust,
// the way `mscd-server export verify --anchor-key` does:
//
// 1. the public half of the installation's signing key, when this process can read `audit.anchor_key_file` (the worker,
//    which signs the anchors);
// 2. every public key in the file beside it with `.pub` in place of `.key` (`secrets/audit-anchor.pub` beside
//    `secrets/audit-anchor.key`): the installation's current public key and, after the key was replaced, the earlier
//    ones (PEM blocks one after the other), so the anchors signed before the change keep verifying. A process that
//    cannot read the private key (the api) trusts the installation's keys through this file only, so the deployment
//    must give it that file; a process that reads neither file logs a warning when it starts.
//
// The keys come from files the operator controls and never from the database: someone who can rewrite the database
// still cannot make the checks trust a key of their own. A private key in the `.pub` file is refused, so it is never
// copied around, and a file that cannot be used is logged and left out (the checks then refuse the anchors it would
// have proved, which the audit trail screen and the `mscd_audit_chain_broken` metric show).
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import type { MscdConfig } from '../../config/mscd-config';
import { anchorKeyId, compiledAnchorKeys } from './anchors';

/** Where a trusted anchor key comes from. */
export type AnchorKeySource = 'build' | 'signing-key' | 'public-key-file';

/** A public anchor key the checks trust. */
export interface TrustedAnchorKey {
  keyId: string;
  publicKeyPem: string;
  source: AnchorKeySource;
}

/** One PEM block (`-----BEGIN <label>-----` to the matching end line). */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

function named(key: KeyObject): { keyId: string; publicKeyPem: string } {
  return { keyId: anchorKeyId(key), publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString() };
}

/**
 * The public Ed25519 keys of a PEM text, in file order (one or more `PUBLIC KEY` blocks). Throws for a private key, a
 * block of another kind, a key that is not Ed25519, or a text without a public key; `file` names the source in the
 * message.
 */
export function anchorPublicKeysOf(text: string, file: string): { keyId: string; publicKeyPem: string }[] {
  const blocks = [...text.matchAll(PEM_BLOCK)];
  if (blocks.some((b) => b[1]!.includes('PRIVATE KEY'))) {
    throw new Error(`${file} holds a private key; it must hold the public anchor keys only (audit-anchor.pub)`);
  }
  const keys: { keyId: string; publicKeyPem: string }[] = [];
  for (const block of blocks) {
    if (block[1] !== 'PUBLIC KEY') throw new Error(`${file} holds a ${block[1]} block; it must hold public anchor keys only`);
    let key: KeyObject;
    try {
      key = createPublicKey(block[0]);
    } catch (error) {
      throw new Error(`${file} holds a public key that cannot be read: ${(error as Error).message}`);
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} holds a ${key.asymmetricKeyType ?? 'unknown'} key; anchor keys are Ed25519`);
    keys.push(named(key));
  }
  if (keys.length === 0) throw new Error(`${file} holds no public key`);
  return keys;
}

/**
 * The file of the installation's public anchor keys: beside `audit.anchor_key_file`, with `.pub` in place of `.key`
 * (`/run/secrets/audit-anchor.key` gives `/run/secrets/audit-anchor.pub`; a name without `.key` gets `.pub` added).
 */
export function anchorPublicKeyFile(anchorKeyFile: string): string {
  return path.join(path.dirname(anchorKeyFile), `${path.basename(anchorKeyFile).replace(/\.key$/, '')}.pub`);
}

/** The public half of the Ed25519 private key in `file`, or null when this process cannot read the file. */
function signingKeyOf(file: string, logger: Pick<Logger, 'warn' | 'debug'>): { keyId: string; publicKeyPem: string } | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // The api and the command line hold no private anchor key (only the worker signs, D-33).
    logger.debug(`audit.anchor_key_file ${file} is not readable here (${(error as NodeJS.ErrnoException).code ?? 'error'}); this process trusts the public anchor keys only`);
    return null;
  }
  try {
    const privateKey = createPrivateKey(text);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('it is no Ed25519 key');
    return named(createPublicKey(privateKey));
  } catch (error) {
    logger.warn(`audit.anchor_key_file ${file} holds no usable Ed25519 private key (${(error as Error).message}); its public half is not trusted`);
    return null;
  }
}

/**
 * The anchor keys this process trusts: the keys compiled into the build, the public half of the installation's signing
 * key when this process can read it, and every key of the installation's `.pub` file (current and earlier keys). Each
 * key id once, in that order.
 */
export function trustedAnchorKeys(
  config: Pick<MscdConfig, 'profile'>,
  logger: Pick<Logger, 'log' | 'warn' | 'debug'> = new Logger('audit.anchor-keys'),
  compiled: readonly { keyId: string; publicKeyPem: string }[] = compiledAnchorKeys(),
): TrustedAnchorKey[] {
  const keys: TrustedAnchorKey[] = [];
  const add = (key: { keyId: string; publicKeyPem: string }, source: AnchorKeySource): boolean => {
    if (keys.some((k) => k.keyId === key.keyId)) return false;
    keys.push({ keyId: key.keyId, publicKeyPem: key.publicKeyPem, source });
    return true;
  };
  for (const key of compiled) add(key, 'build');
  const file = config.profile.audit.anchor_key_file;
  if (!file) return keys;

  const signing = signingKeyOf(file, logger);
  if (signing && add(signing, 'signing-key')) {
    logger.log(`Trusting the installation's anchor key ${signing.keyId} (the public half of audit.anchor_key_file)`);
  }
  const publicFile = anchorPublicKeyFile(file);
  let listed: { keyId: string; publicKeyPem: string }[] = [];
  if (!existsSync(publicFile)) {
    logger.debug(`No public anchor key file ${publicFile}; the anchor checks trust the keys of this build${signing ? ' and the signing key' : ''}`);
  } else {
    try {
      listed = anchorPublicKeysOf(readFileSync(publicFile, 'utf8'), publicFile);
      const added = listed.filter((key) => add(key, 'public-key-file'));
      if (added.length > 0) logger.log(`Trusting ${added.length} anchor key(s) of ${publicFile}: ${added.map((k) => k.keyId).join(', ')}`);
      if (signing && !listed.some((k) => k.keyId === signing.keyId)) {
        logger.warn(`${publicFile} does not hold the public half of audit.anchor_key_file (${signing.keyId}); processes without the private key will refuse its anchors`);
      }
    } catch (error) {
      logger.warn(`The public anchor key file cannot be used: ${(error as Error).message}`);
    }
  }
  if (!signing && listed.length === 0) {
    // The api of an installation whose deployment gives it no audit-anchor.pub: "Verify chain" refuses the installation's
    // own anchors (on-premise every anchor; SaaS compiles its keys in, so nothing changes there).
    logger.warn(
      `This process can use neither audit.anchor_key_file (${file}) nor ${publicFile}, so it trusts only the anchor keys compiled into ` +
        `this release and refuses every anchor signed with another key (on-premise: the installation's own key). Give this process ` +
        `${publicFile} (Compose: the secret audit-anchor.pub; Helm: the public anchor key in the secret of the api and the worker)`,
    );
  }
  return keys;
}
