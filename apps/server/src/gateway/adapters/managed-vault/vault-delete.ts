// Deletion of stored content in the Managed Vault bucket (Milestone 3 D.1): every version of one object
// (`gateway.objects.delete`, used by the disposal of M3-06 and the export expiry of M3-02) and every version below the
// prefix of one organisation (`gateway.tenants.purge`, step 4 of the purge of M3-03, D.5.2). The bucket may keep
// versions, because the audit anchors use object lock, so a plain delete would only add a delete marker: these
// functions list the versions and delete markers and remove each one by its version id. A version that a retention
// rule of the bucket still protects is never forced; it is reported with the date its retention ends (null under a
// legal hold without one). The store's `deleteVersions` counts a refusal as retention only when object lock confirms it.
import type { ObjectDeleteResult, TenantPurgeResult } from '@mscd/shared';
import { forbidden } from '../../problems';
import type { RetainedVersion, StoredVersion, VaultStore } from './vault-store';

/** Versions listed per page. */
const PAGE = 1000;

/** Every stored version and delete marker of the object with this exact key. */
async function versionsOf(store: VaultStore, key: string): Promise<StoredVersion[]> {
  const versions: StoredVersion[] = [];
  let marker: { keyMarker?: string; versionIdMarker?: string } | undefined;
  do {
    const page = await store.listVersions(key, PAGE, marker);
    versions.push(...page.versions.filter((v) => v.key === key));
    marker = page.next;
  } while (marker);
  return versions;
}

/** The latest retention end of the protected versions of one object; null when none names one (a legal hold). */
function latestRetention(versions: readonly RetainedVersion[]): Date | null {
  let latest: Date | null = null;
  for (const version of versions) {
    if (version.retainUntil && (!latest || version.retainUntil.getTime() > latest.getTime())) latest = version.retainUntil;
  }
  return latest;
}

/**
 * Removes every stored version of one object. `deleted` says whether the object had content (a version that is not a
 * delete marker), `versions` how many versions and delete markers were removed. When a retention rule of the bucket
 * still protects a version, the call is refused (`forbidden`) with its end date after removing what it may.
 */
export async function deleteObjectVersions(store: VaultStore, key: string): Promise<ObjectDeleteResult> {
  const versions = await versionsOf(store, key);
  if (versions.length === 0) {
    // A store that lists no versions for a key it holds: remove it with a plain delete.
    if (!(await store.head(key))) return { deleted: false, versions: 0 };
    await store.delete(key);
    return { deleted: true, versions: 1 };
  }
  const result = await store.deleteVersions(versions);
  if (result.retained.length > 0) {
    const until = latestRetention(result.retained);
    throw forbidden(`A retention rule of the bucket protects the object${until ? ` until ${until.toISOString()}` : ''}; it is not deleted`);
  }
  let removed = result.deleted.length;
  // A version the listing did not show (written meanwhile, or a store without version listing) goes too.
  if (await store.head(key)) {
    await store.delete(key);
    removed += 1;
  }
  return { deleted: versions.some((v) => !v.deleteMarker), versions: removed };
}

/**
 * Removes every version of every object below `tenants/<orgId>/`. `objectsDeleted` counts the keys left without any
 * version, `versionsDeleted` the versions and delete markers removed, `retained` the objects a retention rule of the
 * bucket still protects (one entry per key, with the latest end date the store reports).
 */
export async function purgeTenantObjects(store: VaultStore, prefix: string): Promise<TenantPurgeResult> {
  const removedKeys = new Set<string>();
  const retainedKeys = new Map<string, RetainedVersion[]>();
  let versionsDeleted = 0;
  let marker: { keyMarker?: string; versionIdMarker?: string } | undefined;
  do {
    const page = await store.listVersions(prefix, PAGE, marker);
    const versions = page.versions.filter((v) => v.key.startsWith(prefix));
    if (versions.length > 0) {
      const result = await store.deleteVersions(versions);
      versionsDeleted += result.deleted.length;
      for (const version of result.deleted) removedKeys.add(version.key);
      for (const version of result.retained) retainedKeys.set(version.key, [...(retainedKeys.get(version.key) ?? []), version]);
    }
    marker = page.next;
  } while (marker);
  // A store that lists no versions: the plain listing and deletes remove what is left.
  let token: string | undefined;
  do {
    const page = await store.list(prefix, PAGE, token);
    for (const key of page.keys) {
      if (!key.startsWith(prefix) || retainedKeys.has(key)) continue;
      await store.delete(key);
      removedKeys.add(key);
      versionsDeleted += 1;
    }
    token = page.next;
  } while (token);
  const retained: TenantPurgeResult['retained'] = [];
  for (const [key, versions] of [...retainedKeys].sort(([a], [b]) => a.localeCompare(b))) {
    removedKeys.delete(key);
    const until = latestRetention(versions);
    retained.push({ key, retainUntil: until ? until.toISOString() : null });
  }
  return { objectsDeleted: removedKeys.size, versionsDeleted, retained };
}
