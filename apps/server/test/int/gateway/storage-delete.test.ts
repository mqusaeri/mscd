// Deletion of stored content through the storage gateway (Milestone 3 D.1), on a SeaweedFS container: every version of
// one vault object (`gateway.objects.delete`, also in a bucket that keeps versions), `unsupported` for adapters without
// stored content, and the purge of one organisation (`gateway.tenants.purge`): every version below its prefix goes,
// the other organisation keeps everything, and the gateway drops the organisation's cached data key.
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '../../../src/common/tokens';
import { m365AdapterFactory } from '../../../src/gateway/adapters/m365';
import { managedVaultAdapterFactory } from '../../../src/gateway/adapters/managed-vault/vault-adapter';
import { deleteStoredObject } from '../../../src/modules/storage/gateway-client';
import { gatewayCall, gatewayConfig, putObject, startGateway, startSeaweed, vaultEnv, type RunningGateway, type Seaweed } from './helpers';

const ORG = '00000000-0000-4000-8000-00000000d001';
const OTHER_ORG = '00000000-0000-4000-8000-00000000d002';
const VAULT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_VAULT_ID = '44444444-4444-4444-8444-444444444444';
const SP_ID = '55555555-5555-4555-8555-555555555555';
/** A bucket of its own that keeps every version of an object (as a bucket with object lock does). */
const VERSIONED_BUCKET = 'mscd-vault-versions';

describe('deletion of stored content (Milestone 3 D.1)', () => {
  let seaweed: Seaweed;
  let gateway: RunningGateway;
  let base: string;
  let tenant: { orgId: string; wrappedDek: string };
  let otherTenant: { orgId: string; wrappedDek: string };
  const vault = (orgId = ORG, id = VAULT_ID) => ({ id, slug: 'vault', adapter: 'managed_vault', modes: ['stored'], config: { prefix: `tenants/${orgId}/` } });
  const scopeRoot = { folderId: null, path: 'ISMS' };
  const put = async (owner: { orgId: string; wrappedDek: string }, repository = vault(owner.orgId)) => {
    const reply = await putObject(
      base,
      { tenant: owner, repository, scopeRoot, folderPath: 'A.5.1', fileName: 'Register.csv', maxBytes: 1024 * 1024, metadataMinimization: false },
      Buffer.concat([Buffer.from('code,name\n'), randomBytes(512)]),
    );
    expect(reply.status, reply.body.toString('utf8')).toBe(200);
    return reply.json<{ externalItemId: string; hashValue: string }>();
  };
  const objectRef = (externalItemId: string) => ({
    externalItemId,
    externalVersionId: null,
    hashAlgorithm: 'sha256',
    hashValue: null,
    hashSource: 'computed',
    folderPath: null,
  });
  const versionsBelow = async (prefix: string) => {
    const listed = await seaweed.s3.send(new ListObjectVersionsCommand({ Bucket: VERSIONED_BUCKET, Prefix: prefix }));
    return [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].map((v) => v.Key);
  };
  const exists = async (key: string) =>
    seaweed.s3.send(new HeadObjectCommand({ Bucket: VERSIONED_BUCKET, Key: key })).then(
      () => true,
      (error: { $metadata?: { httpStatusCode?: number } }) => {
        if (error.$metadata?.httpStatusCode === 404) return false;
        throw error;
      },
    );

  /** A `GatewayClient` over plain HTTP calls, for the api's typed calls (JSON routes only). */
  const client: GatewayClient = {
    post: async <T>(path: string, body: unknown) => {
      const reply = await gatewayCall(base, path, body);
      if (reply.status !== 200) throw new Error(`${reply.status} ${reply.body.toString('utf8')}`);
      return reply.json() as T;
    },
    putObject: () => Promise.reject(new Error('not used')),
    stream: () => Promise.reject(new Error('not used')) as Promise<{ stream: Readable; size: number | null; detectedType: string }>,
  };

  beforeAll(async () => {
    seaweed = await startSeaweed();
    await seaweed.s3.send(new CreateBucketCommand({ Bucket: VERSIONED_BUCKET }));
    await seaweed.s3.send(new PutBucketVersioningCommand({ Bucket: VERSIONED_BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));
    gateway = await startGateway(gatewayConfig({ ...vaultEnv(seaweed), MSCD__GATEWAY__VAULT__BUCKET: VERSIONED_BUCKET }), {
      factories: [managedVaultAdapterFactory, m365AdapterFactory],
    });
    base = gateway.url;
    tenant = { orgId: ORG, wrappedDek: (await gatewayCall(base, '/v1/keys/data-key', { orgId: ORG })).json<{ wrappedDek: string }>().wrappedDek };
    otherTenant = { orgId: OTHER_ORG, wrappedDek: (await gatewayCall(base, '/v1/keys/data-key', { orgId: OTHER_ORG })).json<{ wrappedDek: string }>().wrappedDek };
  });
  afterAll(async () => {
    await gateway?.close();
    await seaweed?.stop();
  });

  it('removes every version of a vault object, so none is left in a bucket that keeps versions', async () => {
    const stored = await put(tenant);
    // The upload already leaves two versions (the gateway writes the object, then its metadata by a copy onto itself);
    // an overwrite adds one more.
    const written = (await versionsBelow(stored.externalItemId)).length;
    expect(written).toBeGreaterThanOrEqual(1);
    await seaweed.s3.send(new PutObjectCommand({ Bucket: VERSIONED_BUCKET, Key: stored.externalItemId, Body: randomBytes(64) }));
    expect(await versionsBelow(stored.externalItemId)).toHaveLength(written + 1);
    expect(written + 1).toBeGreaterThanOrEqual(2);

    // Through the api's typed call (storage/gateway-client.ts).
    const deleted = await deleteStoredObject(client, { tenant, repository: vault(), object: objectRef(stored.externalItemId) } as Parameters<typeof deleteStoredObject>[1]);
    expect(deleted).toEqual({ deleted: true, versions: written + 1 });
    expect(await versionsBelow(stored.externalItemId)).toEqual([]);
    expect(await exists(stored.externalItemId)).toBe(false);

    // Deleting again finds nothing; the stream of the gone object is not found.
    const again = await gatewayCall(base, '/v1/objects/delete', { tenant, repository: vault(), object: objectRef(stored.externalItemId) });
    expect(again.json()).toEqual({ deleted: false, versions: 0 });
    const stream = await gatewayCall(base, '/v1/stream', { tenant, repository: vault(), object: objectRef(stored.externalItemId) });
    expect(stream.status).toBe(404);
  });

  it('removes a delete marker left by a plain delete, together with the versions under it', async () => {
    const stored = await put(tenant);
    await seaweed.s3.send(new PutObjectCommand({ Bucket: VERSIONED_BUCKET, Key: stored.externalItemId, Body: randomBytes(32) }));
    await seaweed.s3.send(new DeleteObjectCommand({ Bucket: VERSIONED_BUCKET, Key: stored.externalItemId }));
    const markedVersions = (await versionsBelow(stored.externalItemId)).length;
    expect(await exists(stored.externalItemId)).toBe(false);
    const deleted = await gatewayCall(base, '/v1/objects/delete', { tenant, repository: vault(), object: objectRef(stored.externalItemId) });
    expect(deleted.json()).toEqual({ deleted: true, versions: markedVersions });
    expect(await versionsBelow(stored.externalItemId)).toEqual([]);
  });

  it('keeps every delete inside the repository of the calling organisation', async () => {
    const theirs = await put(otherTenant);
    // Another organisation's key through this organisation's repository is outside its root.
    const outside = await gatewayCall(base, '/v1/objects/delete', { tenant, repository: vault(), object: objectRef(theirs.externalItemId) });
    expect(outside.status).toBe(403);
    expect(outside.json()).toMatchObject({ type: expect.stringMatching(/outside-root$/) });
    // A repository whose prefix lies outside the organisation is refused before anything is read.
    const foreignPrefix = await gatewayCall(base, '/v1/objects/delete', { tenant, repository: vault(OTHER_ORG), object: objectRef(theirs.externalItemId) });
    expect(foreignPrefix.status).toBe(403);
    expect(foreignPrefix.json()).toMatchObject({ reason: 'tenant-prefix' });
    expect(await exists(theirs.externalItemId)).toBe(true);
  });

  it('answers 422 unsupported for a Microsoft 365 repository, which keeps no stored content', async () => {
    const sharepoint = {
      id: SP_ID,
      slug: 'sp',
      adapter: 'm365',
      modes: ['link'],
      config: { siteId: 'contoso.sharepoint.com,1,2', driveId: 'drive-sp', rootFolderId: 'root-compliance', roots: { isms: { folderId: 'f-isms', path: 'Compliance/ISMS' } } },
    };
    const object = { ...objectRef('01ITEM'), hashAlgorithm: 'quickxor', hashSource: 'provider' };
    const reply = await gatewayCall(base, '/v1/objects/delete', { tenant, repository: sharepoint, object });
    expect(reply.status, reply.body.toString('utf8')).toBe(422);
    expect(reply.json()).toMatchObject({ type: expect.stringMatching(/unsupported$/), detail: expect.stringMatching(/m365/) });
  });

  it('purges every object version of one organisation and none of the other, and drops its cached data key', async () => {
    const mine = [await put(tenant), await put(tenant)];
    await seaweed.s3.send(new PutObjectCommand({ Bucket: VERSIONED_BUCKET, Key: mine[0]!.externalItemId, Body: randomBytes(16) }));
    const theirs = await put(otherTenant, vault(OTHER_ORG, OTHER_VAULT_ID));
    expect(gateway.runtime.dataKeys.holds(ORG)).toBe(true);
    expect(gateway.runtime.dataKeys.holds(OTHER_ORG)).toBe(true);
    const before = await versionsBelow(`tenants/${ORG}/`);
    expect(new Set(before)).toEqual(new Set(mine.map((m) => m.externalItemId)));

    const purged = await gatewayCall(base, '/v1/tenants/purge', { orgId: ORG, confirmOrgId: ORG });
    expect(purged.status, purged.body.toString('utf8')).toBe(200);
    // Only keys below tenants/<ORG>/ count: the two objects of this test with every version.
    expect(purged.json()).toEqual({ objectsDeleted: 2, versionsDeleted: before.length, retained: [] });
    expect(await versionsBelow(`tenants/${ORG}/`)).toEqual([]);

    // The other organisation keeps its objects and can still read them.
    expect(await exists(theirs.externalItemId)).toBe(true);
    const stream = await gatewayCall(base, '/v1/stream', { tenant: otherTenant, repository: vault(OTHER_ORG, OTHER_VAULT_ID), object: objectRef(theirs.externalItemId) });
    expect(stream.status).toBe(200);
    // The cached data key of the purged organisation is gone; the other organisation's stays.
    expect(gateway.runtime.dataKeys.holds(ORG)).toBe(false);
    expect(gateway.runtime.dataKeys.holds(OTHER_ORG)).toBe(true);

    // A second purge finds nothing; a purge whose confirmation names another organisation does nothing.
    expect((await gatewayCall(base, '/v1/tenants/purge', { orgId: ORG, confirmOrgId: ORG })).json()).toEqual({ objectsDeleted: 0, versionsDeleted: 0, retained: [] });
    const mismatch = await gatewayCall(base, '/v1/tenants/purge', { orgId: OTHER_ORG, confirmOrgId: ORG });
    expect(mismatch.status).toBe(400);
    expect(await exists(theirs.externalItemId)).toBe(true);
  });

  it('logs both operations under their own names, and refuses a purge body with other members', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const stored = await put(otherTenant, vault(OTHER_ORG, OTHER_VAULT_ID));
      await gatewayCall(base, '/v1/objects/delete', { tenant: otherTenant, repository: vault(OTHER_ORG, OTHER_VAULT_ID), object: objectRef(stored.externalItemId) });
      const strict = await gatewayCall(base, '/v1/tenants/purge', { orgId: OTHER_ORG, confirmOrgId: OTHER_ORG, prefix: 'tenants/' });
      expect(strict.status).toBe(400);
      const entries = [...log.mock.calls, ...warn.mock.calls]
        .map((call) => call[0] as Record<string, unknown>)
        .filter((entry) => entry && typeof entry === 'object' && entry.event === 'gateway.call');
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: 'objects.delete', orgId: OTHER_ORG, adapter: 'managed_vault', outcome: 'ok' }),
          expect.objectContaining({ operation: 'tenants.purge', outcome: 'bad-request' }),
        ]),
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
