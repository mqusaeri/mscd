// The archive writer of the organisation export (Milestone 3 D.4) without a database: pax headers for long and UTF-8
// names, part rotation within the part size, entries cut into pieces when they are larger than a part, the manifest as
// the last entry of the last part, and the reader that `export verify` uses. The parts are also unpacked with the
// system's `tar`, as a customer would.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveWriter, partBudget, type ArchivePart } from '../../../src/modules/org-export/archive/archive-writer';
import { readTar } from '../../../src/modules/org-export/archive/tar-reader';
import { entryHeaders, paxRecord } from '../../../src/modules/org-export/archive/tar-format';

const run = promisify(execFile);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function unpack(file: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  await readTar(createReadStream(file).pipe(createGunzip()), async (header, body) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk);
    out.set(header.name, Buffer.concat(chunks));
  });
  return out;
}

describe('organisation export archive (D.4)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mscd-archive-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes pax records whose length counts the whole record', () => {
    for (const value of ['a', 'x'.repeat(5), 'y'.repeat(95), 'z'.repeat(996)]) {
      const record = paxRecord('path', value);
      expect(Number(record.toString('utf8').split(' ')[0])).toBe(record.length);
    }
    // A plain short ASCII name gets one header block; a long or UTF-8 name a pax header first.
    expect(entryHeaders('README.txt', 10, new Date(0)).length).toBe(512);
    expect(entryHeaders(`files/vault/${'n'.repeat(120)}.pdf`, 10, new Date(0)).length).toBe(512 * 3);
    expect(entryHeaders('files/vault/Kebijakan Keamanan Informasi (rev. 3) – final.pdf', 10, new Date(0)).length).toBe(512 * 3);
  });

  it('rotates parts within the part size, cuts large entries into pieces and ends with the manifest', async () => {
    const out = await mkdtemp(path.join(dir, 'parts-'));
    const partBytes = 128 * 1024;
    const closed: ArchivePart[] = [];
    const writer = new ArchiveWriter({ dir: out, baseName: 'mscd-export-test-2026-10-31', partBytes, mtime: new Date('2026-10-31T00:00:00Z'), onPart: async (p) => void closed.push(p) });
    const longName = `files/vault-main/0b7e8c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c/${'Laporan tinjauan manajemen '.repeat(6)}ä.pdf`;
    const bodies = new Map<string, Buffer>([
      ['README.txt', Buffer.from('hello\r\n')],
      ['data/tenant/risk.csv', randomBytes(40_000)],
      [longName, randomBytes(70_000)],
      ['files/vault-main/big.bin', randomBytes(300_000)],
      ['data/tenant/task.jsonl', Buffer.from('{"a":1}\n'.repeat(3000))],
    ]);
    const written = [];
    for (const [name, body] of bodies) written.push(await writer.add(name, body.length, [body.subarray(0, 1000), body.subarray(1000)]));
    const { lastPart } = await writer.finish('manifest.json', (last) => Buffer.from(JSON.stringify({ last })));
    expect(closed.map((p) => p.part)).toEqual([...Array(closed.length).keys()].map((n) => n + 1));
    expect(lastPart).toBe(closed.length);
    expect(closed.length).toBeGreaterThanOrEqual(4);
    for (const part of closed) {
      expect(part.sizeBytes).toBeLessThanOrEqual(partBytes);
      expect((await stat(part.path)).size).toBe(part.sizeBytes);
      expect(sha(await readFile(part.path))).toBe(part.sha256);
    }
    // The big entry is cut into pieces in parts of their own; joined, they give the original bytes.
    const big = written.find((w) => w.path === 'files/vault-main/big.bin')!;
    expect(big.part).toBeNull();
    expect(big.pieces!.length).toBeGreaterThanOrEqual(3);
    expect(big.sha256).toBe(sha(bodies.get('files/vault-main/big.bin')!));
    const unpacked = new Map<string, Buffer>();
    for (const part of closed) for (const [name, body] of await unpack(part.path)) unpacked.set(name, body);
    expect(Buffer.concat(big.pieces!.map((p) => unpacked.get(p.path)!))).toEqual(bodies.get('files/vault-main/big.bin'));
    for (const piece of big.pieces!) expect(sha(unpacked.get(piece.path)!)).toBe(piece.sha256);
    // Long and UTF-8 names come back whole; every entry has its bytes and hash.
    for (const w of written.filter((x) => x.part !== null)) {
      expect(unpacked.get(w.path)).toEqual(bodies.get(w.path));
      expect(sha(unpacked.get(w.path)!)).toBe(w.sha256);
    }
    expect(JSON.parse(unpacked.get('manifest.json')!.toString())).toEqual({ last: lastPart });
    expect(partBudget(partBytes) % 512).toBe(0);

    // The system's tar reads the pax names too.
    const extract = await mkdtemp(path.join(dir, 'x-'));
    for (const part of closed) await run('tar', ['-xzf', part.path, '-C', extract]);
    expect(await readFile(path.join(extract, longName))).toEqual(bodies.get(longName));
    expect((await readdir(path.join(extract, 'files/vault-main'))).sort()).toContain('big.bin.001');
  });

  it('refuses an entry whose stream is shorter or longer than announced', async () => {
    const out = await mkdtemp(path.join(dir, 'bad-'));
    const writer = new ArchiveWriter({ dir: out, baseName: 'x', partBytes: 128 * 1024, mtime: new Date(), onPart: async () => undefined });
    await expect(writer.add('short.bin', 100, [Buffer.alloc(50)])).rejects.toThrow(/before its announced size/);
    await writer.abort();
    const again = new ArchiveWriter({ dir: await mkdtemp(path.join(dir, 'bad2-')), baseName: 'x', partBytes: 128 * 1024, mtime: new Date(), onPart: async () => undefined });
    await expect(again.add('long.bin', 10, [Buffer.alloc(50)])).rejects.toThrow(/longer than its announced size/);
    await again.abort();
  });
});
