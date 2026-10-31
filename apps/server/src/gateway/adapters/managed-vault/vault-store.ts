// S3 access of the Managed Vault (build plan D-10, D.5, A.3): any S3-compatible store, path-style addressing and a
// configurable endpoint (SeaweedFS in Compose and tests). Credentials come from `gateway.vault.access_key_file` and
// `secret_key_file`, read once at start. Object keys are `tenants/<org_id>/<object_id>` and
// `audit-anchors/<chain>/<date>.json`; nothing else is written.
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectLegalHoldCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type ObjectLockConfiguration,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import type { MscdConfig } from '../../../config/mscd-config';
import { GatewayError } from '../../problems';

/** Metadata of one stored object (`x-amz-meta-*`, lower-case keys without the prefix). */
export type ObjectMetadataMap = Record<string, string>;

export interface HeadResult {
  metadata: ObjectMetadataMap;
  contentLength: number;
  lastModified: Date | null;
}

interface S3ErrorShape {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
  $retryable?: unknown;
}

function statusOf(error: unknown): number | undefined {
  return (error as S3ErrorShape | null)?.$metadata?.httpStatusCode;
}

function isMissing(error: unknown): boolean {
  const e = error as S3ErrorShape | null;
  return statusOf(error) === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey';
}

/** Maps an S3 failure to a gateway problem (D.5 slugs). */
export function s3Problem(error: unknown, what: string): GatewayError {
  if (error instanceof GatewayError) return error;
  const status = statusOf(error);
  const name = (error as S3ErrorShape | null)?.name ?? '';
  if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return new GatewayError('not-found', `${what}: not found`);
  if (status === 403) return new GatewayError('forbidden', `${what}: the object store refused access`);
  if (status === 503 || status === 429 || name === 'SlowDown') {
    return new GatewayError('rate-limited', `${what}: the object store is throttling`, { retryAfter: 1 });
  }
  if (status === undefined) {
    return new GatewayError('unreachable', `${what}: the object store is unreachable`, {}, { cause: error });
  }
  return new GatewayError('internal', `${what}: the object store answered ${status} (${name || 'unknown error'})`, {}, { cause: error });
}

/** One stored version or delete marker of an object (`ListObjectVersions`). */
export interface StoredVersion {
  key: string;
  /** The version id; `null` (the string) for an object written while the bucket had no versioning. */
  versionId: string;
  deleteMarker: boolean;
}

/** What object lock says about one version: its retention end and whether a legal hold is on. */
export interface VersionProtection {
  /** The end of the version's retention; null when it has none (or the store does not say). */
  retainUntil: Date | null;
  legalHold: boolean;
}

/** A version the store refused to delete because object lock still protects it. */
export interface RetainedVersion extends StoredVersion, VersionProtection {}

/** Outcome of `deleteVersions`: the versions removed and those a retention rule of the bucket still protects. */
export interface DeleteVersionsResult {
  deleted: StoredVersion[];
  retained: RetainedVersion[];
}

/** Whether object lock protects a version now: a retention end still ahead, or a legal hold. */
export function isProtected(protection: VersionProtection, now: Date = new Date()): boolean {
  return protection.legalHold || (protection.retainUntil !== null && protection.retainUntil.getTime() > now.getTime());
}

/** Largest batch of `DeleteObjects` (S3 limit). */
const DELETE_BATCH = 1000;

export interface VaultStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export class VaultStore {
  readonly bucket: string;
  private readonly s3: S3Client;
  private lockConfig: Promise<ObjectLockConfiguration | null> | null = null;

  constructor(options: VaultStoreOptions) {
    this.bucket = options.bucket;
    this.s3 = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
    });
  }

  /** The store of `gateway.vault` (reads the access key files). */
  static fromConfig(config: MscdConfig): VaultStore {
    const vault = config.profile.gateway.vault;
    return new VaultStore({
      endpoint: vault.endpoint,
      region: vault.region,
      bucket: vault.bucket,
      forcePathStyle: vault.force_path_style,
      accessKeyId: config.readSecretFile(vault.access_key_file, 'gateway.vault.access_key_file'),
      secretAccessKey: config.readSecretFile(vault.secret_key_file, 'gateway.vault.secret_key_file'),
    });
  }

  /** `s3://<bucket>/<key>`. */
  location(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }

  async checkBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      throw s3Problem(error, `Bucket ${this.bucket}`);
    }
  }

  /** Streams `body` to `key` (multipart above the part size). `signal` aborts the upload. */
  async upload(key: string, body: Readable, metadata: ObjectMetadataMap, signal?: AbortSignal): Promise<void> {
    const upload = new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/octet-stream', Metadata: metadata },
      queueSize: 2,
      leavePartsOnError: false,
    });
    const abort = () => void upload.abort().catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await upload.done();
    } catch (error) {
      throw s3Problem(error, `Upload of ${key}`);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  /** Replaces the metadata of an object by a server-side copy onto itself. */
  async replaceMetadata(key: string, metadata: ObjectMetadataMap): Promise<void> {
    await this.copy(key, key, metadata);
  }

  /** Server-side copy with new metadata. */
  async copy(sourceKey: string, targetKey: string, metadata: ObjectMetadataMap): Promise<void> {
    try {
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: targetKey,
          CopySource: `${this.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
          MetadataDirective: 'REPLACE',
          Metadata: metadata,
          ContentType: 'application/octet-stream',
        }),
      );
    } catch (error) {
      throw s3Problem(error, `Copy of ${sourceKey}`);
    }
  }

  /** Metadata and size of an object; null when it does not exist. */
  async head(key: string): Promise<HeadResult | null> {
    try {
      const result = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { metadata: result.Metadata ?? {}, contentLength: result.ContentLength ?? 0, lastModified: result.LastModified ?? null };
    } catch (error) {
      if (isMissing(error)) return null;
      throw s3Problem(error, `Object ${key}`);
    }
  }

  /** The stored bytes of an object; null when it does not exist. */
  async get(key: string, signal?: AbortSignal): Promise<{ body: Readable; contentLength: number; metadata: ObjectMetadataMap } | null> {
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      return { body: result.Body as Readable, contentLength: result.ContentLength ?? 0, metadata: result.Metadata ?? {} };
    } catch (error) {
      if (isMissing(error)) return null;
      throw s3Problem(error, `Object ${key}`);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw s3Problem(error, `Delete of ${key}`);
    }
  }

  /** One page of keys below a prefix. */
  async list(prefix: string, maxKeys: number, continuationToken?: string): Promise<{ keys: string[]; next?: string }> {
    try {
      const result = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: maxKeys, ContinuationToken: continuationToken }),
      );
      return {
        keys: (result.Contents ?? []).map((c) => c.Key).filter((k): k is string => typeof k === 'string'),
        next: result.IsTruncated ? result.NextContinuationToken : undefined,
      };
    } catch (error) {
      throw s3Problem(error, `Listing of ${prefix}`);
    }
  }

  /**
   * One page of the stored versions and delete markers below a prefix (Milestone 3 D.1, `gateway.objects.delete` and
   * `gateway.tenants.purge`). A bucket without versioning lists each object once with the version id `null`.
   */
  async listVersions(
    prefix: string,
    maxKeys: number,
    marker?: { keyMarker?: string; versionIdMarker?: string },
  ): Promise<{ versions: StoredVersion[]; next?: { keyMarker?: string; versionIdMarker?: string } }> {
    try {
      const result = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: maxKeys,
          KeyMarker: marker?.keyMarker,
          VersionIdMarker: marker?.versionIdMarker,
        }),
      );
      const versions: StoredVersion[] = [];
      for (const version of result.Versions ?? []) {
        if (typeof version.Key === 'string') versions.push({ key: version.Key, versionId: version.VersionId ?? 'null', deleteMarker: false });
      }
      for (const deleteMarker of result.DeleteMarkers ?? []) {
        if (typeof deleteMarker.Key === 'string') versions.push({ key: deleteMarker.Key, versionId: deleteMarker.VersionId ?? 'null', deleteMarker: true });
      }
      const next = result.IsTruncated ? { keyMarker: result.NextKeyMarker, versionIdMarker: result.NextVersionIdMarker } : undefined;
      return { versions, ...(next ? { next } : {}) };
    } catch (error) {
      throw s3Problem(error, `Version listing of ${prefix}`);
    }
  }

  /**
   * Removes the given versions and delete markers for good (`DeleteObjects` with version ids, in batches of 1000). A
   * version that a retention rule of the bucket still protects (object lock) is refused by the store and returned under
   * `retained` with its end date; governance retention is never bypassed. A refusal counts as retention only when the
   * store confirms it (`GetObjectRetention` names an end still ahead, or `GetObjectLegalHold` is on): an `AccessDenied`
   * without that, such as a vault credential that lacks `s3:DeleteObjectVersion`, fails the call like any other refusal,
   * so a purge never reports content as kept when it was simply not deleted.
   */
  async deleteVersions(versions: readonly StoredVersion[]): Promise<DeleteVersionsResult> {
    const deleted: StoredVersion[] = [];
    const retained: RetainedVersion[] = [];
    for (let start = 0; start < versions.length; start += DELETE_BATCH) {
      const batch = versions.slice(start, start + DELETE_BATCH);
      const byName = new Map(batch.map((v) => [`${v.key}\n${v.versionId}`, v]));
      let result;
      try {
        result = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((v) => ({ Key: v.key, VersionId: v.versionId })), Quiet: false },
          }),
        );
      } catch (error) {
        throw s3Problem(error, `Delete of ${batch.length} object version(s)`);
      }
      for (const item of result.Deleted ?? []) {
        const version = byName.get(`${item.Key}\n${item.VersionId ?? 'null'}`) ?? (item.Key ? { key: item.Key, versionId: item.VersionId ?? 'null', deleteMarker: false } : null);
        if (version) deleted.push(version);
      }
      const failures: string[] = [];
      for (const item of result.Errors ?? []) {
        const version = byName.get(`${item.Key}\n${item.VersionId ?? 'null'}`) ?? { key: item.Key ?? '', versionId: item.VersionId ?? 'null', deleteMarker: false };
        if (item.Code === 'AccessDenied' && !version.deleteMarker) {
          const protection = await this.protection(version);
          if (isProtected(protection)) {
            retained.push({ ...version, ...protection });
            continue;
          }
        }
        failures.push(`${item.Key ?? '?'}: ${item.Code ?? 'error'}`);
      }
      if (failures.length > 0) {
        throw new GatewayError('internal', `The object store refused to delete ${failures.length} object version(s): ${failures.slice(0, 3).join(', ')}`);
      }
    }
    return { deleted, retained };
  }

  /**
   * What object lock says about a version: the end of its retention (`GetObjectRetention`) and its legal hold
   * (`GetObjectLegalHold`). A question the store does not answer (no object lock on the bucket, no retention on the
   * version, a store without legal holds, or a credential that may not ask) counts as no protection, so the caller
   * treats the refusal it is checking as a failure and not as retention.
   */
  async protection(version: StoredVersion): Promise<VersionProtection> {
    const target = { Bucket: this.bucket, Key: version.key, ...(version.versionId === 'null' ? {} : { VersionId: version.versionId }) };
    let retainUntil: Date | null = null;
    try {
      retainUntil = (await this.s3.send(new GetObjectRetentionCommand(target))).Retention?.RetainUntilDate ?? null;
    } catch {
      retainUntil = null;
    }
    let legalHold = false;
    try {
      legalHold = (await this.s3.send(new GetObjectLegalHoldCommand(target))).LegalHold?.Status === 'ON';
    } catch {
      legalHold = false;
    }
    return { retainUntil, legalHold };
  }

  /**
   * Writes a small object only when the key is free (`If-None-Match: *`). Answers `exists` when an object is
   * already there. With S3 object lock on the bucket, the bucket's default retention applies; without a default
   * rule the object gets governance retention of `lockDays`.
   */
  async putIfAbsent(key: string, body: Buffer, contentType: string, lockDays: number): Promise<'created' | 'exists'> {
    const lock = await this.objectLock();
    const retention =
      lock?.ObjectLockEnabled === 'Enabled' && !lock.Rule?.DefaultRetention
        ? { ObjectLockMode: 'GOVERNANCE' as const, ObjectLockRetainUntilDate: new Date(Date.now() + lockDays * 86_400_000) }
        : {};
    try {
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, IfNoneMatch: '*', ...retention }),
      );
      return 'created';
    } catch (error) {
      const status = statusOf(error);
      if (status === 412 || (error as S3ErrorShape | null)?.name === 'PreconditionFailed') return 'exists';
      throw s3Problem(error, `Write of ${key}`);
    }
  }

  /** The bucket's object lock configuration (read once); null when the bucket has none. */
  objectLock(): Promise<ObjectLockConfiguration | null> {
    this.lockConfig ??= this.s3
      .send(new GetObjectLockConfigurationCommand({ Bucket: this.bucket }))
      .then((result) => result.ObjectLockConfiguration ?? null)
      .catch(() => null);
    return this.lockConfig;
  }

  close(): void {
    this.s3.destroy();
  }
}
