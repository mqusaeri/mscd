import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { adminError } from './errors.js';
import { originOf } from './http.js';

// OpenID Connect discovery of a mock issuer (Milestone 2 M2-S11, follow-up 1 of M2-10): MSCD runs discovery before it
// saves an OpenID Connect provider and again for "Test", so tests need an issuer that answers it.
//
//   GET /oidc/{realm}/.well-known/openid-configuration      the provider metadata of issuer <origin>/oidc/{realm}
//   GET /oidc/{realm}/.well-known/oauth-authorization-server the same document (RFC 8414 path)
//   GET /oidc/{realm}/jwks                                   one RSA signing key (made when first asked for)
//
// Discovery only: the authorization, token, userinfo and logout endpoints are named in the document but not served,
// so a sign-in through this issuer stops at the provider's page. `{realm}` is 1 to 64 letters, digits, `_` or `-`.

const REALM = /^[A-Za-z0-9_-]{1,64}$/;

export interface OidcContext {
  publicUrl: string | undefined;
}

/** The issuer URL of a realm for a request (the public URL when configured, else the request's origin). */
export function issuerOf(request: FastifyRequest, publicUrl: string | undefined, realm: string): string {
  return `${originOf(request, publicUrl)}/oidc/${realm}`;
}

/** The discovery document of an issuer. */
export function discoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    end_session_endpoint: `${issuer}/logout`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'email', 'email_verified', 'name'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
  };
}

export function registerOidcRoutes(app: FastifyInstance, context: OidcContext): void {
  let signingKey: { publicKey: KeyObject; kid: string } | undefined;
  const realmOf = (request: FastifyRequest): string => {
    const realm = (request.params as { realm?: string }).realm ?? '';
    if (!REALM.test(realm)) throw adminError(404, 'not_found', `Unknown realm "${realm}".`);
    return realm;
  };
  const document = async (request: FastifyRequest) => discoveryDocument(issuerOf(request, context.publicUrl, realmOf(request)));
  app.get('/oidc/:realm/.well-known/openid-configuration', document);
  app.get('/oidc/:realm/.well-known/oauth-authorization-server', document);
  app.get('/oidc/:realm/jwks', async (request) => {
    realmOf(request);
    signingKey ??= { publicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey, kid: 'mock-oidc-1' };
    return { keys: [{ ...signingKey.publicKey.export({ format: 'jwk' }), kid: signingKey.kid, use: 'sig', alg: 'RS256' }] };
  });
}
