import { afterEach, describe, expect, it } from 'vitest';
import { startMockProviders, type RunningMockProviders } from '../src/index.js';
import { ORIGIN, build, call } from './helpers.js';

// OpenID Connect discovery of a mock issuer (Milestone 2 M2-S11, follow-up 1 of M2-10).

let running: RunningMockProviders | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('OpenID Connect discovery', () => {
  it('serves the provider metadata of the issuer <origin>/oidc/<realm> on both well-known paths', async () => {
    const app = build();
    try {
      for (const path of ['/oidc/e2e/.well-known/openid-configuration', '/oidc/e2e/.well-known/oauth-authorization-server']) {
        const response = await call(app, 'GET', path);
        expect(response.statusCode).toBe(200);
        const doc = response.json();
        expect(doc).toMatchObject({
          issuer: `${ORIGIN}/oidc/e2e`,
          authorization_endpoint: `${ORIGIN}/oidc/e2e/authorize`,
          token_endpoint: `${ORIGIN}/oidc/e2e/token`,
          jwks_uri: `${ORIGIN}/oidc/e2e/jwks`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      expect((await call(app, 'GET', '/oidc/bad%20realm/.well-known/openid-configuration')).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('uses the public URL as the origin and serves one RSA signing key', async () => {
    const app = build({ publicUrl: 'https://idp.example.test/' });
    try {
      expect((await call(app, 'GET', '/oidc/corp/.well-known/openid-configuration')).json().issuer).toBe('https://idp.example.test/oidc/corp');
      const keys = (await call(app, 'GET', '/oidc/corp/jwks')).json().keys;
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ kty: 'RSA', kid: 'mock-oidc-1', use: 'sig', alg: 'RS256', e: 'AQAB' });
      expect(keys[0].d).toBeUndefined();
      // The same key on the next request.
      expect((await call(app, 'GET', '/oidc/corp/jwks')).json().keys[0].n).toBe(keys[0].n);
    } finally {
      await app.close();
    }
  });

  it('answers a real HTTP discovery request on the listening server', async () => {
    running = await startMockProviders();
    const doc = (await (await fetch(`${running.url}/oidc/realm-1/.well-known/openid-configuration`)).json()) as { issuer: string };
    expect(doc.issuer).toBe(`${running.url}/oidc/realm-1`);
    expect(running.dns).toBeNull();
  });
});
