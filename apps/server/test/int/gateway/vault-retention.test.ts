// Object lock and the deletion of stored content (Milestone 3 D.1, D.5.2 step 4): the vault store and the purge on an
// in-memory object store with versions, retention dates and legal holds, because the SeaweedFS container of the other
// gateway tests has no object lock. A version the store refuses to delete counts as kept by a bucket retention rule
// only when the store confirms it (a retention end still ahead, or a legal hold); any other refusal, such as a vault
// credential without the right to delete versions, fails the purge instead of reporting the content as kept.
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectLegalHoldCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { deleteObjectVersions, purgeTenantObjects } from '../../../src/gateway/adapters/managed-vault/vault-delete';
import { VaultStore } from '../../../src/gateway/adapters/managed-vault/vault-store';

const PREFIX = 'tenants/00000000-0000-4000-8000-00000000e001/';
const OTHER = 'tenants/00000000-0000-4000-8000-00000000e002/';
const FUTURE = new Date('2099-01-01T00:00:00Z');
const PAST = new Date('2020-01-01T00:00:00Z');

interface FakeVersion {
  key: string;
  versionId: string;
  deleteMarker?: boolean;
  retainUntil?: Date;
  legalHold?: boolean;
  /** The store refuses to delete this version for a reason other than object lock (a missing permission). */
  denied?: boolean;
}

/** S3 errors as the SDK raises them: a name and the HTTP status. */
function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

/**
 * An in-memory versioned bucket that answers the commands of the vault store. Object lock refuses the delete of a
 * version whose retention end is ahead or that has a legal hold (`AccessDenied`, as S3 does); a `denied` version is
 * refused the same way without any retention, as with a credential that lacks `s3:DeleteObjectVersion`.
 */
class FakeBucket {
  readonly calls: string[] = [];
  constructor(public versions: FakeVersion[]) {}

  private current(): string[] {
    const keys = new Set<string>();
    for (const v of this.versions) if (!v.deleteMarker) keys.add(v.key);
    return [...keys].sort();
  }

  async send(command: unknown): Promise<unknown> {
    this.calls.push((command as object).constructor.name);
    if (command instanceof ListObjectVersionsCommand) {
      const prefix = command.input.Prefix ?? '';
      const below = this.versions.filter((v) => v.key.startsWith(prefix));
      return {
        Versions: below.filter((v) => !v.deleteMarker).map((v) => ({ Key: v.key, VersionId: v.versionId })),
        DeleteMarkers: below.filter((v) => v.deleteMarker).map((v) => ({ Key: v.key, VersionId: v.versionId })),
        IsTruncated: false,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const Deleted: { Key: string; VersionId: string }[] = [];
      const Errors: { Key: string; VersionId: string; Code: string }[] = [];
      for (const item of command.input.Delete?.Objects ?? []) {
        const version = this.versions.find((v) => v.key === item.Key && v.versionId === item.VersionId);
        if (!version) {
          Deleted.push({ Key: item.Key!, VersionId: item.VersionId! });
          continue;
        }
        const locked = version.legalHold === true || (version.retainUntil !== undefined && version.retainUntil.getTime() > Date.now());
        if (locked || version.denied) {
          Errors.push({ Key: version.key, VersionId: version.versionId, Code: 'AccessDenied' });
          continue;
        }
        this.versions = this.versions.filter((v) => v !== version);
        Deleted.push({ Key: version.key, VersionId: version.versionId });
      }
      return { Deleted, Errors };
    }
    if (command instanceof GetObjectRetentionCommand) {
      const version = this.versions.find((v) => v.key === command.input.Key && v.versionId === command.input.VersionId);
      if (!version?.retainUntil) throw s3Error('NoSuchObjectLockConfiguration', 404);
      return { Retention: { Mode: 'GOVERNANCE', RetainUntilDate: version.retainUntil } };
    }
    if (command instanceof GetObjectLegalHoldCommand) {
      const version = this.versions.find((v) => v.key === command.input.Key && v.versionId === command.input.VersionId);
      if (!version) throw s3Error('NoSuchKey', 404);
      return { LegalHold: { Status: version.legalHold ? 'ON' : 'OFF' } };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? '';
      return { Contents: this.current().filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })), IsTruncated: false };
    }
    if (command instanceof HeadObjectCommand) {
      if (!this.current().includes(command.input.Key!)) throw s3Error('NotFound', 404);
      return { Metadata: {}, ContentLength: 1 };
    }
    if (command instanceof DeleteObjectCommand) {
      // A plain delete in a versioned bucket only adds a delete marker.
      this.versions.push({ key: command.input.Key!, versionId: `dm-${this.versions.length}`, deleteMarker: true });
      return {};
    }
    throw new Error(`The fake bucket does not answer ${(command as object).constructor.name}`);
  }
}

/** A vault store whose S3 client is the fake bucket. */
function storeOn(bucket: FakeBucket): VaultStore {
  const store = new VaultStore({ endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'mscd-vault', forcePathStyle: true, accessKeyId: 'k', secretAccessKey: 's' });
  (store as unknown as { s3: FakeBucket }).s3 = bucket;
  return store;
}

describe('object lock and the deletion of stored content (Milestone 3 D.1, D.5.2)', () => {
  it('purges every version it may, and lists the objects a retention rule or a legal hold keeps, with the retention end', async () => {
    const bucket = new FakeBucket([
      // The older version of a kept file is under governance retention; its newer version is not.
      { key: `${PREFIX}kept`, versionId: 'k1', retainUntil: FUTURE },
      { key: `${PREFIX}kept`, versionId: 'k2' },
      { key: `${PREFIX}plain`, versionId: 'p1' },
      { key: `${PREFIX}plain`, versionId: 'p2' },
      { key: `${PREFIX}plain`, versionId: 'p3', deleteMarker: true },
      // A legal hold names no end date.
      { key: `${PREFIX}held`, versionId: 'h1', legalHold: true },
      // A retention end that has passed protects nothing.
      { key: `${PREFIX}lapsed`, versionId: 'l1', retainUntil: PAST },
      { key: `${OTHER}theirs`, versionId: 't1' },
    ]);
    const result = await purgeTenantObjects(storeOn(bucket), PREFIX);
    expect(result).toEqual({
      objectsDeleted: 2,
      versionsDeleted: 5,
      retained: [
        { key: `${PREFIX}held`, retainUntil: null },
        { key: `${PREFIX}kept`, retainUntil: FUTURE.toISOString() },
      ],
    });
    expect(bucket.versions.map((v) => `${v.key}@${v.versionId}`).sort()).toEqual([`${PREFIX}held@h1`, `${PREFIX}kept@k1`, `${OTHER}theirs@t1`]);
  });

  it('fails the purge when the store refuses a delete that object lock does not explain, and reports nothing as kept', async () => {
    for (const refused of [
      { key: `${PREFIX}a`, versionId: 'a1', denied: true },
      // AccessDenied on a version whose retention has ended is a missing permission, not retention.
      { key: `${PREFIX}a`, versionId: 'a1', denied: true, retainUntil: PAST },
    ] satisfies FakeVersion[]) {
      const bucket = new FakeBucket([refused, { key: `${PREFIX}b`, versionId: 'b1' }]);
      await expect(purgeTenantObjects(storeOn(bucket), PREFIX)).rejects.toThrow(/refused to delete 1 object version\(s\): tenants\/.*\/a: AccessDenied/);
      expect(bucket.versions.map((v) => v.versionId)).toContain('a1');
    }
  });

  it('refuses the delete of one object that a retention rule keeps, with its end date, after removing what it may', async () => {
    const bucket = new FakeBucket([
      { key: `${PREFIX}record`, versionId: 'r1', retainUntil: FUTURE },
      { key: `${PREFIX}record`, versionId: 'r2' },
    ]);
    await expect(deleteObjectVersions(storeOn(bucket), `${PREFIX}record`)).rejects.toThrow(`protects the object until ${FUTURE.toISOString()}`);
    expect(bucket.versions.map((v) => v.versionId)).toEqual(['r1']);

    // A refusal without retention fails as an error of the store, not as a kept object.
    const denied = new FakeBucket([{ key: `${PREFIX}record`, versionId: 'r1', denied: true }]);
    await expect(deleteObjectVersions(storeOn(denied), `${PREFIX}record`)).rejects.toThrow(/refused to delete/);
  });
});
