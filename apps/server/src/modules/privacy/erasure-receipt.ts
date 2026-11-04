// The erasure receipt (Milestone 3 D.6.5, M3-13 after ISO M4): proof, kept outside the database, that a person was
// erased in an organisation, so the erasure can be applied again after a restore from an older backup. The erasure
// writes the receipt into its request (`privacy_request.erasure_receipt`); the worker signs it with the audit anchor key
// (as it signs the deletion certificate, ops/deletion/certificate.ts) and emails it to every platform operator and every
// active Tenant Admin of the organisation (`org.lifecycle`, ops/deletion/erasure-receipts.ts). After a restore,
// `mscd-server tenant erasure --reapply <receipt> --confirm <slug>` checks the signature and erases the person again
// with the same pseudonym (`deploy/backup/restore.sh --reapply-erasures <folder>` runs it for every receipt). Without
// email, `mscd-server tenant erasure --print-receipts <slug>` prints the signed receipts, one receipt file per line.
//
// The receipt names no person: organisation id and slug, request id and number, the kind of subject, the account id of
// an erased member, the pseudonym, the time and the ids of the redactions. The signed bytes are the canonical JSON of
// the receipt (keys sorted, no white space); the file holds the canonical JSON with `keyId` and `signature`
// (`ed25519:<base64>`) added, as a deletion certificate does. The member `type: "mscd.erasure-receipt"` is in no anchor
// payload and no certificate, so a receipt never passes as either, and neither passes as a receipt.
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@mscd/shared';

export const ERASURE_RECEIPT_TYPE = 'mscd.erasure-receipt';
export const ERASURE_RECEIPT_VERSION = 1;

/** What the receipt says. No member holds a name or an email. */
export interface ErasureReceipt {
  type: typeof ERASURE_RECEIPT_TYPE;
  version: typeof ERASURE_RECEIPT_VERSION;
  receiptId: string;
  organization: { id: string; slug: string };
  request: { id: string; number: string };
  subjectKind: 'member' | 'other';
  /** The account of an erased member; null for a person without an account. */
  erasedUserId: string | null;
  pseudonym: string;
  erasedAt: string;
  /** The redactions of the erasure (attestation `redactionId`s), tenant chain first. */
  redactionIds: string[];
}

/** A receipt with its signature, as the file holds it. */
export type SignedErasureReceipt = ErasureReceipt & { keyId: string; signature: string };

/** The exact bytes the signature covers. */
export function receiptSigningText(receipt: ErasureReceipt): string {
  return canonicalJson(receipt);
}

/** Signs a receipt with the anchor key (Ed25519). */
export function signReceipt(receipt: ErasureReceipt, key: { privateKey: KeyObject; keyId: string }): { signature: string; keyId: string } {
  const signature = sign(null, Buffer.from(receiptSigningText(receipt), 'utf8'), key.privateKey);
  return { signature: `ed25519:${signature.toString('base64')}`, keyId: key.keyId };
}

/** The file text of a signed receipt: canonical JSON on one line and a newline. */
export function receiptFileText(receipt: ErasureReceipt, signature: string, keyId: string): string {
  return `${canonicalJson({ ...receipt, keyId, signature })}\n`;
}

/** The file name of the email attachment. */
export function receiptFileName(receipt: Pick<ErasureReceipt, 'organization' | 'request'>): string {
  return `erasure-receipt-${receipt.organization.slug}-${receipt.request.number}.json`;
}

/** Why a receipt file does not verify. */
export type ReceiptProblem = 'not-json' | 'not-a-receipt' | 'no-signature' | 'unknown-key' | 'bad-signature';

export interface ReceiptCheck {
  ok: boolean;
  problem: ReceiptProblem | null;
  receipt: ErasureReceipt | null;
  keyId: string | null;
  /** The signature of a receipt that verifies (`ed25519:<base64>`). */
  signature?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isReceipt(value: Record<string, unknown>): boolean {
  const org = value.organization as { id?: unknown; slug?: unknown } | undefined;
  const request = value.request as { id?: unknown; number?: unknown } | undefined;
  return (
    value.type === ERASURE_RECEIPT_TYPE &&
    value.version === ERASURE_RECEIPT_VERSION &&
    typeof value.receiptId === 'string' &&
    typeof org?.id === 'string' && UUID.test(org.id) && typeof org.slug === 'string' &&
    typeof request?.id === 'string' && UUID.test(request.id) && typeof request.number === 'string' &&
    (value.subjectKind === 'member' || value.subjectKind === 'other') &&
    (value.erasedUserId === null || (typeof value.erasedUserId === 'string' && UUID.test(value.erasedUserId))) &&
    (value.subjectKind === 'other') === (value.erasedUserId === null) &&
    typeof value.pseudonym === 'string' && /^Former user [0-9A-F]{4,8}$/.test(value.pseudonym) &&
    typeof value.erasedAt === 'string' &&
    Array.isArray(value.redactionIds) && value.redactionIds.every((id) => typeof id === 'string')
  );
}

/** Parses and verifies a receipt file against trusted anchor keys. */
export function verifyReceiptText(text: string, trustedKeys: readonly { keyId: string; publicKeyPem: string }[]): ReceiptCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not-json', receipt: null, keyId: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, problem: 'not-json', receipt: null, keyId: null };
  const { keyId, signature, ...rest } = parsed as Record<string, unknown>;
  if (!isReceipt(rest)) return { ok: false, problem: 'not-a-receipt', receipt: null, keyId: null };
  const receipt = rest as unknown as ErasureReceipt;
  if (typeof keyId !== 'string' || typeof signature !== 'string') return { ok: false, problem: 'no-signature', receipt, keyId: null };
  const match = /^ed25519:([A-Za-z0-9+/]{86}==)$/.exec(signature);
  if (!match) return { ok: false, problem: 'bad-signature', receipt, keyId };
  const key = trustedKeys.find((k) => k.keyId === keyId);
  if (!key) return { ok: false, problem: 'unknown-key', receipt, keyId };
  let valid: boolean;
  try {
    valid = verify(null, Buffer.from(receiptSigningText(receipt), 'utf8'), createPublicKey(key.publicKeyPem), Buffer.from(match[1]!, 'base64'));
  } catch {
    valid = false;
  }
  return valid ? { ok: true, problem: null, receipt, keyId, signature } : { ok: false, problem: 'bad-signature', receipt, keyId };
}

/** The plain message of a problem. */
export function receiptProblemText(problem: ReceiptProblem): string {
  switch (problem) {
    case 'not-json':
      return 'the file is not a JSON object';
    case 'not-a-receipt':
      return `the file is not an MSCD erasure receipt (type ${ERASURE_RECEIPT_TYPE}, version ${ERASURE_RECEIPT_VERSION})`;
    case 'no-signature':
      return 'the file has no keyId and signature';
    case 'unknown-key':
      return 'the receipt is signed with a key that is not among the trusted anchor keys';
    case 'bad-signature':
      return 'the signature does not match the content: the file was changed or is damaged';
  }
}
