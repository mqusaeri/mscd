// A streaming reader of the tar parts of an organisation export (Milestone 3 D.4), for `export verify` and the tests:
// it walks the ustar headers, applies pax extended headers (`path`, `size`) to the entry that follows, and hands each
// regular file entry to a callback with its bytes as a stream, so a part of several GiB is checked without being held
// in memory. Global pax headers and other entry types are skipped.
import { Readable } from 'node:stream';
import { BLOCK, padding } from './tar-format';

export interface TarEntryHeader {
  name: string;
  size: number;
}

/** Called once per regular file entry; must consume `body` (or the reader drains it). */
export type TarEntryHandler = (header: TarEntryHeader, body: AsyncIterable<Buffer>) => Promise<void>;

function cString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function octalField(block: Buffer, start: number, length: number): number {
  const text = cString(block, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`Invalid octal field "${text}" in a tar header`);
  return Number.parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = octalField(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === stored;
}

/** Parses the records of a pax extended header. */
export function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Invalid pax record length');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/** Buffers incoming chunks and hands out exact byte counts. */
class Chunks {
  private readonly iterator: AsyncIterator<Buffer | Uint8Array | string>;
  private buffered: Buffer[] = [];
  private length = 0;
  private ended = false;

  constructor(source: AsyncIterable<Buffer | Uint8Array | string>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(count: number): Promise<boolean> {
    while (this.length < count && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const value = next.value;
      const chunk = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (chunk.length === 0) continue;
      this.buffered.push(chunk);
      this.length += chunk.length;
    }
    return this.length >= count;
  }

  /** Exactly `count` bytes, or null when the source ends first. */
  async read(count: number): Promise<Buffer | null> {
    if (!(await this.fill(count))) return null;
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
    const out = all.subarray(0, count);
    const rest = all.subarray(count);
    this.buffered = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  /** `count` bytes as a stream of chunks. */
  async *stream(count: number): AsyncGenerator<Buffer> {
    let remaining = count;
    while (remaining > 0) {
      if (this.length === 0 && !(await this.fill(1))) throw new Error('The tar stream ended inside an entry');
      const chunk = this.buffered.shift()!;
      this.length -= chunk.length;
      if (chunk.length > remaining) {
        this.buffered.unshift(chunk.subarray(remaining));
        this.length += chunk.length - remaining;
        yield chunk.subarray(0, remaining);
        remaining = 0;
      } else {
        remaining -= chunk.length;
        yield chunk;
      }
    }
  }

  async skip(count: number): Promise<void> {
    for await (const _ of this.stream(count)) {
      // discard
    }
  }
}

/**
 * Reads a tar stream (already decompressed) and calls `onEntry` for every regular file. Throws on a bad checksum, a
 * truncated archive or a missing end of archive.
 */
export async function readTar(source: Readable | AsyncIterable<Buffer | Uint8Array | string>, onEntry: TarEntryHandler): Promise<void> {
  const chunks = new Chunks(source);
  let pax: Record<string, string> = {};
  for (;;) {
    const block = await chunks.read(BLOCK);
    if (!block) throw new Error('The tar stream ended without the end-of-archive blocks');
    if (block.every((b) => b === 0)) return;
    if (!checksumOk(block)) throw new Error('A tar header has a wrong checksum');
    const type = String.fromCharCode(block[156] ?? 0x30);
    const headerName = cString(block, 0, 100);
    const prefix = block.subarray(257, 263).toString('ascii').startsWith('ustar') ? cString(block, 345, 155) : '';
    let size = octalField(block, 124, 12);
    if (type === 'x' || type === 'g') {
      const data = await chunks.read(size);
      if (!data) throw new Error('The tar stream ended inside a pax header');
      await chunks.skip(padding(size));
      if (type === 'x') pax = parsePaxRecords(data);
      continue;
    }
    if (pax.size !== undefined) size = Number.parseInt(pax.size, 10);
    const name = pax.path ?? (prefix ? `${prefix}/${headerName}` : headerName);
    pax = {};
    if (type === '0' || type === '\0') {
      let consumed = 0;
      const body = chunks.stream(size);
      const tracked = (async function* () {
        for await (const chunk of body) {
          consumed += chunk.length;
          yield chunk;
        }
      })();
      await onEntry({ name, size }, tracked);
      // Whatever the handler did not read is skipped, so the next header is found.
      if (consumed < size) await chunks.skip(size - consumed);
    } else {
      await chunks.skip(size);
    }
    await chunks.skip(padding(size));
  }
}
