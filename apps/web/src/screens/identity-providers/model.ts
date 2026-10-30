// The view model of the Company sign-in screen (MILESTONE-2 M2-10) and the interface both adapters implement (api.ts
// in API builds, sample.ts in the sample build, chosen by the build in adapter.ts). The helpers check the OIDC and
// SAML forms with the rules of `IdentityProviderRequest` (D.2, F.5, F.9), build its body, and read the SAML metadata
// XML of an identity provider into the form (entity id, sign-on address, signing certificates) without a DOM, so the
// same code runs in the browser and in unit tests.
import type { IdentityProviderPatch, IdentityProviderRequest, LocalLoginPolicy } from '@mscd/shared';
import type { ApiError } from '../../data/api/ApiClient';
import type { TextPair } from '../types';
import { TEXT } from './text';

export type Result<T> = { ok: true; data: T; message?: TextPair | null } | { ok: false; error: ApiError };
export type ProviderKind = 'oidc' | 'saml';
export type ProviderIcon = 'microsoft' | 'google' | 'generic';
export type MfaFallbackCode = 'local_totp' | 'reject';
export type PolicyCode = LocalLoginPolicy;

export const ICONS: readonly ProviderIcon[] = ['microsoft', 'google', 'generic'];
export const POLICIES: readonly PolicyCode[] = ['allowed', 'admins_only', 'disabled'];

/** An identity provider of the organisation (`IdentityProviderView`, secrets left out). */
export interface ProviderModel {
  id: string;
  slug: string;
  kind: ProviderKind;
  displayName: string;
  icon: ProviderIcon;
  enabled: boolean;
  oidc: { issuer: string; clientId: string; scopes: string; subjectMode: 'sub' | 'entra'; entraTenantId?: string; clientSecretSet: boolean } | null;
  saml: { entryPoint: string; idpIssuer: string; idpCertCount: number; spEntityId: string; mfaAuthnContexts: string[] } | null;
  requireMfaClaim: boolean;
  mfaFallback: MfaFallbackCode;
  jitProvisioning: boolean;
  allowedEmailDomains: string[];
  updatedAt: string;
}

/** The answer of `POST .../test` with the time it was run. */
export interface TestOutcome {
  ok: boolean;
  issuer: string;
  endpoints: Record<string, string>;
  message: string | null;
  at: string;
}

export interface PolicyModel {
  localLogin: PolicyCode;
  /** ETag of the organisation row, sent as `If-Match`; null in the sample. */
  etag: string | null;
}

export interface IdpAdapter {
  list(): Promise<Result<ProviderModel[]>>;
  create(body: IdentityProviderRequest, idempotencyKey: string): Promise<Result<ProviderModel>>;
  update(id: string, patch: IdentityProviderPatch): Promise<Result<ProviderModel>>;
  test(id: string): Promise<Result<TestOutcome>>;
  policy(): Promise<Result<PolicyModel>>;
  /** Sets the policy with `If-Match`, then reads it again for the new ETag. */
  setPolicy(localLogin: PolicyCode, etag: string | null): Promise<Result<PolicyModel>>;
}

// ---------------------------------------------------------------------------------------------------------------
// Tests run in this browser session
// ---------------------------------------------------------------------------------------------------------------

const tests = new Map<string, TestOutcome>();

/** The last test of a provider in this browser session (the api keeps no test history). */
export function lastTest(id: string): TestOutcome | null {
  return tests.get(id) ?? null;
}

export function rememberTest(id: string, outcome: TestOutcome): void {
  tests.set(id, outcome);
}

/** Forgets the tests of this session (unit tests). */
export function forgetTests(): void {
  tests.clear();
}

// ---------------------------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------------------------

export interface CommonForm {
  slug: string;
  displayName: string;
  icon: ProviderIcon;
  requireMfaClaim: boolean;
  mfaFallback: MfaFallbackCode;
}

export interface OidcForm extends CommonForm {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  subjectMode: 'sub' | 'entra';
  entraTenantId: string;
  jitProvisioning: boolean;
  domains: string;
}

export interface SamlForm extends CommonForm {
  entryPoint: string;
  idpIssuer: string;
  idpCerts: string;
  spEntityId: string;
  mfaAuthnContexts: string;
  metadataXml: string;
}

export type FormErrors<F> = Partial<Record<keyof F, TextPair | string>>;

export function emptyOidc(): OidcForm {
  return {
    slug: '', displayName: '', icon: 'generic', requireMfaClaim: true, mfaFallback: 'local_totp', issuer: '', clientId: '', clientSecret: '',
    scopes: 'openid email profile', subjectMode: 'sub', entraTenantId: '', jitProvisioning: false, domains: '',
  };
}

export function emptySaml(): SamlForm {
  return {
    slug: '', displayName: '', icon: 'generic', requireMfaClaim: true, mfaFallback: 'local_totp', entryPoint: '', idpIssuer: '', idpCerts: '',
    spEntityId: '', mfaAuthnContexts: '', metadataXml: '',
  };
}

const SLUG = /^[a-z][a-z0-9-]{1,39}$/;
const SCOPES = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** A suggested short id from the button label or the issuer host. */
export function suggestSlug(text: string): string {
  const base = text.toLowerCase().replace(/^https?:\/\//, '').replace(/^sign in with /, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const start = base.replace(/^[^a-z]+/, '');
  return start.slice(0, 40).replace(/-+$/, '');
}

/** True for an http or https address without credentials or fragment. */
export function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

/** The email domains of the form: split at commas, spaces and new lines, lower case, without duplicates. */
export function domainsOf(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
}

/** The lines of a text area that are not empty. */
export function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * The certificates of the form: each `BEGIN CERTIFICATE` block, else each base64 line, as PEM text. The api stores
 * PEM (F.9). A block with nothing between its markers is dropped, so the form asks for a certificate.
 */
export function certsOf(text: string): string[] {
  const blocks = [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => m[1].replace(/\s+/g, ''));
  const bodies = blocks.length ? blocks : linesOf(text).map((l) => l.replace(/\s+/g, '')).filter((l) => /^[A-Za-z0-9+/=]{16,}$/.test(l));
  return bodies.filter(Boolean).map((b) => `-----BEGIN CERTIFICATE-----\n${(b.match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----`);
}

function tooLong(n: number): TextPair {
  return [TEXT.tooLong[0].replace('{n}', String(n)), TEXT.tooLong[1].replace('{n}', String(n))];
}

function commonErrors<F extends CommonForm>(form: F): FormErrors<F> {
  const out: FormErrors<F> = {};
  if (!SLUG.test(form.slug.trim())) (out as FormErrors<CommonForm>).slug = form.slug.trim() ? TEXT.badSlug : TEXT.required;
  if (!form.displayName.trim()) (out as FormErrors<CommonForm>).displayName = TEXT.required;
  else if (form.displayName.trim().length > 100) (out as FormErrors<CommonForm>).displayName = tooLong(100);
  if (!form.requireMfaClaim && form.mfaFallback === 'reject') (out as FormErrors<CommonForm>).mfaFallback = TEXT.rejectNeedsClaim;
  return out;
}

export function oidcErrors(form: OidcForm): FormErrors<OidcForm> {
  const out = commonErrors(form);
  if (!form.issuer.trim()) out.issuer = TEXT.required;
  else if (!isHttpUrl(form.issuer)) out.issuer = TEXT.badUrl;
  if (!form.clientId.trim()) out.clientId = TEXT.required;
  else if (form.clientId.trim().length > 200) out.clientId = tooLong(200);
  if (!form.clientSecret) out.clientSecret = TEXT.required;
  else if (form.clientSecret.length > 1024) out.clientSecret = tooLong(1024);
  const scopes = form.scopes.trim();
  if (!SCOPES.test(scopes) || !scopes.split(' ').includes('openid')) out.scopes = TEXT.badScopes;
  if (form.subjectMode === 'entra' && !UUID.test(form.entraTenantId.trim())) out.entraTenantId = form.entraTenantId.trim() ? TEXT.badUuid : TEXT.required;
  const domains = domainsOf(form.domains);
  const bad = domains.find((d) => !DOMAIN.test(d) || d.length > 253);
  if (bad) out.domains = [TEXT.badDomain[0].replace('{domain}', bad), TEXT.badDomain[1].replace('{domain}', bad)];
  else if (form.jitProvisioning && !domains.length) out.domains = TEXT.needDomains;
  return out;
}

export function samlErrors(form: SamlForm): FormErrors<SamlForm> {
  const out = commonErrors(form);
  if (!form.entryPoint.trim()) out.entryPoint = TEXT.required;
  else if (!isHttpUrl(form.entryPoint)) out.entryPoint = TEXT.badUrl;
  if (!form.idpIssuer.trim()) out.idpIssuer = TEXT.required;
  else if (form.idpIssuer.trim().length > 500) out.idpIssuer = tooLong(500);
  if (!certsOf(form.idpCerts).length) out.idpCerts = TEXT.needCert;
  if (!form.spEntityId.trim()) out.spEntityId = TEXT.required;
  else if (form.spEntityId.trim().length > 500) out.spEntityId = tooLong(500);
  if (linesOf(form.mfaAuthnContexts).some((c) => c.length > 200)) out.mfaAuthnContexts = tooLong(200);
  return out;
}

/** `IdentityProviderRequest` of the OIDC form. */
export function oidcRequest(form: OidcForm): IdentityProviderRequest {
  const domains = domainsOf(form.domains);
  return {
    slug: form.slug.trim(),
    kind: 'oidc',
    displayName: form.displayName.trim(),
    icon: form.icon,
    oidc: {
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      clientSecret: form.clientSecret,
      scopes: form.scopes.trim(),
      subjectMode: form.subjectMode,
      ...(form.subjectMode === 'entra' ? { entraTenantId: form.entraTenantId.trim().toLowerCase() } : {}),
    },
    requireMfaClaim: form.requireMfaClaim,
    mfaFallback: form.mfaFallback,
    jitProvisioning: form.jitProvisioning,
    allowedEmailDomains: form.jitProvisioning ? domains : [],
  };
}

/** `IdentityProviderRequest` of the SAML form (JIT is never offered for SAML, F.9). */
export function samlRequest(form: SamlForm): IdentityProviderRequest {
  return {
    slug: form.slug.trim(),
    kind: 'saml',
    displayName: form.displayName.trim(),
    icon: form.icon,
    saml: {
      entryPoint: form.entryPoint.trim(),
      idpIssuer: form.idpIssuer.trim(),
      idpCerts: certsOf(form.idpCerts),
      spEntityId: form.spEntityId.trim(),
      mfaAuthnContexts: linesOf(form.mfaAuthnContexts),
    },
    requireMfaClaim: form.requireMfaClaim,
    mfaFallback: form.mfaFallback,
    jitProvisioning: false,
    allowedEmailDomains: [],
  };
}

/**
 * The server's field errors of a form: `body.oidc.issuer` and `body.saml.entryPoint` name the fields of the form,
 * `body.allowedEmailDomains` the domains field.
 */
export function serverFieldErrors<F>(error: ApiError | null | undefined, fields: readonly (keyof F)[]): FormErrors<F> {
  const out: FormErrors<F> = {};
  for (const e of error?.errors ?? []) {
    const path = String(e.path).replace(/^body\./, '').replace(/^(oidc|saml)\./, '');
    const key = (path === 'allowedEmailDomains' ? 'domains' : path.split('.')[0]) as keyof F;
    if (fields.includes(key) && !out[key]) out[key] = e.message;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// SAML metadata XML
// ---------------------------------------------------------------------------------------------------------------

export interface SamlMetadata {
  idpIssuer: string | null;
  entryPoint: string | null;
  certs: string[];
}

const decodeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The attributes of a start tag (`name="value"` or `name='value'`), by local name. */
function attributesOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const name = m[1].includes(':') ? m[1].split(':').pop()! : m[1];
    out[name] = decodeXml(m[3] ?? m[4] ?? '');
  }
  return out;
}

/**
 * Reads the SAML metadata of an identity provider: the `entityID` of the EntityDescriptor that holds an
 * IDPSSODescriptor, its SingleSignOnService location (HTTP-Redirect first, then HTTP-POST, then any), and the signing
 * certificates of its KeyDescriptors (`use="signing"` or no use). Comments are ignored; null when nothing was found.
 */
export function parseSamlMetadata(xml: string): SamlMetadata | null {
  // Removed until none is left: one pass over `<!<!---->-- ... -->` would join the remains into a new comment.
  let text = xml;
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(/<!--[\s\S]*?-->/g, '');
  }
  const idp = /<([\w.-]+:)?IDPSSODescriptor\b[\s\S]*?<\/([\w.-]+:)?IDPSSODescriptor>/.exec(text);
  if (!idp) return null;
  const before = text.slice(0, idp.index);
  const entities = [...before.matchAll(/<([\w.-]+:)?EntityDescriptor\b[^>]*>/g)];
  const entity = entities.length ? attributesOf(entities[entities.length - 1][0]) : {};
  const block = idp[0];
  const services = [...block.matchAll(/<([\w.-]+:)?SingleSignOnService\b[^>]*>/g)].map((m) => attributesOf(m[0]));
  const pick = (suffix: string) => services.find((s) => (s.Binding ?? '').endsWith(suffix))?.Location ?? null;
  const entryPoint = pick('HTTP-Redirect') ?? pick('HTTP-POST') ?? services[0]?.Location ?? null;
  const certs: string[] = [];
  for (const key of block.matchAll(/<([\w.-]+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/([\w.-]+:)?KeyDescriptor>/g)) {
    const use = attributesOf(`<x ${key[2]}>`).use;
    if (use && use !== 'signing') continue;
    for (const cert of key[3].matchAll(/<([\w.-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/([\w.-]+:)?X509Certificate>/g)) {
      const body = cert[2].replace(/\s+/g, '');
      if (body && !certs.includes(body)) certs.push(body);
    }
  }
  const idpIssuer = entity.entityID ?? null;
  if (!idpIssuer && !entryPoint) return null;
  return { idpIssuer, entryPoint, certs };
}

/** The SAML form filled from metadata, and the labels of the fields that changed. */
export function fillFromMetadata(form: SamlForm, meta: SamlMetadata): { form: SamlForm; filled: TextPair[] } {
  const filled: TextPair[] = [];
  const next = { ...form };
  if (meta.idpIssuer) {
    next.idpIssuer = meta.idpIssuer;
    filled.push(TEXT.idpIssuer);
  }
  if (meta.entryPoint) {
    next.entryPoint = meta.entryPoint;
    filled.push(TEXT.entryPoint);
  }
  if (meta.certs.length) {
    next.idpCerts = certsOf(meta.certs.join('\n')).join('\n');
    filled.push(TEXT.idpCerts);
  }
  return { form: next, filled };
}

// ---------------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------------

export function iconLabel(icon: ProviderIcon): TextPair {
  return TEXT[`icon_${icon}`];
}

export function policyLabel(policy: PolicyCode): TextPair {
  return TEXT[`policy_${policy}`];
}

/** The label of an endpoint name of a test result. */
export function endpointLabel(name: string): TextPair {
  const key = `endpoint_${name}` as keyof typeof TEXT;
  return (TEXT[key] as TextPair | undefined) ?? [name, name];
}
