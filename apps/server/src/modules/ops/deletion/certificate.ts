// The deletion certificate (Milestone 3 D.5.5): a JSON document signed with Ed25519 by the audit anchor key of the
// worker (`audit.anchor_key_file`, the key that signs the anchors of the audit chains). The signed bytes are the
// canonical JSON of the certificate (keys sorted, no white space, packages/shared canonicalJson). The member
// `type: "mscd-deletion-certificate-v1"` is never part of an anchor payload, so a certificate can never pass as an anchor
// and an anchor never as a certificate. The file an operator downloads (and the email attaches) is the canonical JSON of
// the certificate with two more members, `keyId` and `signature` (`ed25519:<base64>`), as a signed anchor line is: to
// verify, remove both, take the canonical JSON of the rest and verify the signature with the trusted anchor key of that
// key id (`mscd-server tenant verify-certificate <file>`).
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@mscd/shared';
import type { TrustedKey } from '../../../generated/build-info';

export const CERTIFICATE_TYPE = 'mscd-deletion-certificate-v1';

/** What the certificate says (D.5.5). Every member is plain data without personal data of the organisation's people. */
export interface DeletionCertificate {
  type: typeof CERTIFICATE_TYPE;
  certificateId: string;
  /** The deletion record the certificate closes (`tenant purge --reapply` names it after a restore). */
  deletionId: string;
  installationId: string;
  issuedAt: string;
  organization: { id: string; slug: string; name: string };
  dates: {
    offboardingStartedAt: string | null;
    archivedAt: string | null;
    deletionScheduledAt: string;
    /** `system` when the move to archived scheduled it, `platform operator` when an operator set the date. */
    deletionScheduledBy: 'system' | 'platform operator';
    deletionScheduledFor: string;
    deletionCompletedAt: string;
  };
  /** The final export, or null when no export was taken (the text says so). */
  finalExport: { id: string; readyAt: string | null; manifestSha256: string | null } | null;
  finalExportText: string;
  steps: { step: string; detail: string | null; counts: Record<string, number | boolean> }[];
  checks: { check: string; passed: boolean; detail: string }[];
  remains: string[];
  /** Repositories in the customer's own Microsoft 365 or Google Drive, which MSCD does not touch. */
  customerRepositories: { adapter: string; name: string }[];
  backups: { statement: string; copiesEndBy: string; assumes: string };
  howToVerify: string;
}

/** A certificate with its signature, as the downloaded file holds it. */
export type SignedCertificate = DeletionCertificate & { keyId: string; signature: string };

/** The exact bytes the signature covers. */
export function certificateSigningText(certificate: DeletionCertificate): string {
  return canonicalJson(certificate);
}

/** Signs a certificate with the anchor key (Ed25519). */
export function signCertificate(certificate: DeletionCertificate, key: { privateKey: KeyObject; keyId: string }): { signature: string; keyId: string } {
  const signature = sign(null, Buffer.from(certificateSigningText(certificate), 'utf8'), key.privateKey);
  return { signature: `ed25519:${signature.toString('base64')}`, keyId: key.keyId };
}

/** The file text of a signed certificate: canonical JSON on one line and a newline. */
export function certificateFileText(certificate: DeletionCertificate, signature: string, keyId: string): string {
  return `${canonicalJson({ ...certificate, keyId, signature })}\n`;
}

/** The file name of the download and the email attachment. */
export function certificateFileName(certificate: Pick<DeletionCertificate, 'organization' | 'dates'>): string {
  return `deletion-certificate-${certificate.organization.slug}-${certificate.dates.deletionCompletedAt.slice(0, 10)}.json`;
}

/** Why a certificate file does not verify, or null when it does. */
export type CertificateProblem = 'not-json' | 'not-a-certificate' | 'no-signature' | 'unknown-key' | 'bad-signature';

export interface CertificateCheck {
  ok: boolean;
  problem: CertificateProblem | null;
  certificate: DeletionCertificate | null;
  keyId: string | null;
}

/** Parses and verifies a certificate file against trusted anchor keys (the compiled `anchor` keys of the release). */
export function verifyCertificateText(text: string, trustedKeys: readonly Pick<TrustedKey, 'keyId' | 'publicKeyPem'>[]): CertificateCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not-json', certificate: null, keyId: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, problem: 'not-json', certificate: null, keyId: null };
  const { keyId, signature, ...rest } = parsed as Record<string, unknown>;
  const certificate = rest as unknown as DeletionCertificate;
  if (rest.type !== CERTIFICATE_TYPE || typeof rest.certificateId !== 'string' || typeof (rest.organization as { id?: unknown } | undefined)?.id !== 'string') {
    return { ok: false, problem: 'not-a-certificate', certificate: null, keyId: null };
  }
  if (typeof keyId !== 'string' || typeof signature !== 'string') return { ok: false, problem: 'no-signature', certificate, keyId: null };
  const match = /^ed25519:([A-Za-z0-9+/]{86}==)$/.exec(signature);
  if (!match) return { ok: false, problem: 'bad-signature', certificate, keyId };
  const key = trustedKeys.find((k) => k.keyId === keyId);
  if (!key) return { ok: false, problem: 'unknown-key', certificate, keyId };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(certificateSigningText(certificate), 'utf8'), createPublicKey(key.publicKeyPem), Buffer.from(match[1]!, 'base64'));
  } catch {
    valid = false;
  }
  return valid ? { ok: true, problem: null, certificate, keyId } : { ok: false, problem: 'bad-signature', certificate, keyId };
}

/** The plain message of a problem. */
export function certificateProblemText(problem: CertificateProblem): string {
  switch (problem) {
    case 'not-json':
      return 'the file is not a JSON object';
    case 'not-a-certificate':
      return `the file is not an MSCD deletion certificate (type ${CERTIFICATE_TYPE})`;
    case 'no-signature':
      return 'the file has no keyId and signature';
    case 'unknown-key':
      return 'the certificate is signed with a key that is not among the trusted anchor keys of this release';
    case 'bad-signature':
      return 'the signature does not match the content: the file was changed or is damaged';
  }
}
