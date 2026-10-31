// The parts of an organisation export (Milestone 3 D.4): gzipped tar files written one at a time into a folder, each
// holding at most `partBytes` bytes. Entries are added one after another; a part is closed and handed to `onPart`
// (which uploads it to the vault, or keeps it in the folder of the command line) before the next one starts, so the
// folder never holds more than one open part. An entry larger than a whole part is cut into numbered pieces
// (`<name>.001`, `<name>.002`, ...), each in a part of its own; the manifest lists the pieces, and the README says how
// to join them. The SHA-256 of every entry, every piece and every part is computed while the bytes are written.
import { createHash, type Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { createGzip, type Gzip } from 'node:zlib';
import { ByteReader } from './byte-reader';
import { BLOCK, END_OF_ARCHIVE, entryHeaders, padding } from './tar-format';

/** A closed part: its number (from 1), file name, local path, size and SHA-256 of the gzipped bytes. */
export interface ArchivePart {
  part: number;
  name: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

/** One piece of an entry larger than a part. */
export interface EntryPiece {
  path: string;
  part: number;
  sizeBytes: number;
  sha256: string;
}

/** An entry as written: the part that holds it (null when it is cut into pieces), its size and SHA-256. */
export interface WrittenEntry {
  path: string;
  part: number | null;
  sizeBytes: number;
  sha256: string;
  pieces?: EntryPiece[];
}

export interface ArchiveWriterOptions {
  /** Folder of the part files. */
  dir: string;
  /** Part file names are `<baseName>-part-<n>.tar.gz`. */
  baseName: string;
  /** Largest part on disk (gzipped bytes). */
  partBytes: number;
  /** Modification time of every entry. */
  mtime: Date;
  /** Called with each closed part, in order; the writer starts the next part only after it returns. */
  onPart(part: ArchivePart): Promise<void>;
}

/** Smallest part the writer accepts (the profile minimum is 64 MiB; tests use smaller parts). */
export const MIN_PART_BYTES = 64 * 1024;

/**
 * Uncompressed tar bytes one part may hold. gzip adds at most about 0.03 % to incompressible data plus a few bytes of
 * header and trailer, so with a tenth of a percent and 4 KiB kept free the gzipped part stays within `partBytes`.
 */
export function partBudget(partBytes: number): number {
  const budget = Math.floor(partBytes * 0.999) - 4096;
  return budget - (budget % BLOCK);
}

class HashingCounter extends Transform {
  readonly hash: Hash = createHash('sha256');
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

/** One open part: tar bytes go into gzip, the gzipped bytes through a hash into the file. */
class OpenPart {
  readonly gzip: Gzip = createGzip({ level: 6 });
  private readonly counter = new HashingCounter();
  private readonly done: Promise<void>;
  private failure: Error | null = null;
  /** Uncompressed tar bytes written so far. */
  used = 0;
  entries = 0;

  constructor(
    readonly part: number,
    readonly name: string,
    readonly filePath: string,
  ) {
    this.done = pipeline(this.gzip, this.counter, createWriteStream(filePath, { flags: 'wx' }));
    this.done.catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    });
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.failure) throw this.failure;
    this.used += chunk.length;
    if (!this.gzip.write(chunk)) {
      await Promise.race([once(this.gzip, 'drain'), this.done.then(() => undefined)]);
      if (this.failure) throw this.failure;
    }
  }

  async close(): Promise<ArchivePart> {
    await this.write(Buffer.alloc(END_OF_ARCHIVE, 0));
    this.gzip.end();
    await this.done;
    return { part: this.part, name: this.name, path: this.filePath, sizeBytes: this.counter.bytes, sha256: this.counter.hash.digest('hex') };
  }

  async abort(): Promise<void> {
    this.gzip.destroy();
    await this.done.catch(() => undefined);
    await rm(this.filePath, { force: true });
  }
}

/** The writer of the parts of one export. */
export class ArchiveWriter {
  private readonly budget: number;
  private current: OpenPart | null = null;
  private partCount = 0;
  private readonly closed: ArchivePart[] = [];

  constructor(private readonly options: ArchiveWriterOptions) {
    if (!Number.isSafeInteger(options.partBytes) || options.partBytes < MIN_PART_BYTES) {
      throw new Error(`The part size must be at least ${MIN_PART_BYTES} bytes`);
    }
    this.budget = partBudget(options.partBytes);
  }

  /** Parts closed so far. */
  get parts(): readonly ArchivePart[] {
    return this.closed;
  }

  /** Number of the part being written (or of the next one, before any entry). */
  get currentPart(): number {
    return this.current ? this.current.part : this.partCount + 1;
  }

  partName(part: number): string {
    return `${this.options.baseName}-part-${part}.tar.gz`;
  }

  /** Room left in the current part for one more entry (whole budget when no part is open). */
  private room(): number {
    return this.budget - (this.current?.used ?? 0);
  }

  private async openPart(): Promise<OpenPart> {
    this.partCount += 1;
    const name = this.partName(this.partCount);
    this.current = new OpenPart(this.partCount, name, path.join(this.options.dir, name));
    return this.current;
  }

  /** Closes the current part (when it holds an entry) and hands it to `onPart`. */
  private async rotate(): Promise<void> {
    const open = this.current;
    if (!open) return;
    this.current = null;
    const part = await open.close();
    this.closed.push(part);
    await this.options.onPart(part);
  }

  /** The current part when the entry fits in it, else a new part. */
  private async partFor(bytes: number): Promise<OpenPart> {
    if (this.current && this.current.entries > 0 && this.current.used + bytes > this.budget) await this.rotate();
    return this.current ?? (await this.openPart());
  }

  /** Writes one entry (or piece) of exactly `size` bytes from the reader into `part`; returns its SHA-256. */
  private async writeEntry(part: OpenPart, name: string, size: number, reader: ByteReader, overall: Hash | null): Promise<string> {
    await part.write(entryHeaders(name, size, this.options.mtime));
    const hash = createHash('sha256');
    for await (const chunk of reader.take(size, `Archive entry ${name}`)) {
      hash.update(chunk);
      overall?.update(chunk);
      await part.write(chunk);
    }
    const pad = padding(size);
    if (pad > 0) await part.write(Buffer.alloc(pad, 0));
    part.entries += 1;
    return hash.digest('hex');
  }

  /** Adds an entry of `size` bytes from a stream of chunks (a vault file, a spooled table). */
  async add(name: string, size: number, source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>): Promise<WrittenEntry> {
    const reader = new ByteReader(source);
    try {
      const headers = entryHeaders(name, size, this.options.mtime).length;
      const whole = headers + size + padding(size);
      if (whole <= this.budget) {
        const part = await this.partFor(whole);
        const sha256 = await this.writeEntry(part, name, size, reader, null);
        await reader.expectEnd(`Archive entry ${name}`);
        return { path: name, part: part.part, sizeBytes: size, sha256 };
      }
      return await this.addPieces(name, size, reader);
    } finally {
      await reader.close();
    }
  }

  /** Adds a buffer as one entry. */
  addBuffer(name: string, body: Buffer): Promise<WrittenEntry> {
    return this.add(name, body.length, [body]);
  }

  /** An entry larger than a part: pieces that each fill a part of their own, the first one after the current part. */
  private async addPieces(name: string, size: number, reader: ByteReader): Promise<WrittenEntry> {
    const overall = createHash('sha256');
    const pieces: EntryPiece[] = [];
    let offset = 0;
    let index = 0;
    while (offset < size) {
      index += 1;
      const pieceName = `${name}.${String(index).padStart(3, '0')}`;
      if (this.current && this.current.entries > 0) await this.rotate();
      const part = this.current ?? (await this.openPart());
      const headers = entryHeaders(pieceName, size, this.options.mtime).length;
      let pieceSize = this.room() - headers;
      pieceSize -= pieceSize % BLOCK;
      if (pieceSize <= 0) throw new Error(`The part size is too small for the entry ${name}`);
      pieceSize = Math.min(pieceSize, size - offset);
      const sha256 = await this.writeEntry(part, pieceName, pieceSize, reader, overall);
      pieces.push({ path: pieceName, part: part.part, sizeBytes: pieceSize, sha256 });
      offset += pieceSize;
    }
    await reader.expectEnd(`Archive entry ${name}`);
    return { path: name, part: null, sizeBytes: size, sha256: overall.digest('hex'), pieces };
  }

  /**
   * Writes the last entry of the export (the manifest) into the current part, or into a new part when it does not fit,
   * and closes that part. `body(lastPart)` builds the entry for the number of the part that will hold it.
   */
  async finish(name: string, body: (lastPart: number) => Buffer): Promise<{ entry: WrittenEntry; lastPart: number }> {
    let target = this.current && this.current.entries > 0 ? this.current.part : this.currentPart;
    let bytes = body(target);
    let whole = entryHeaders(name, bytes.length, this.options.mtime).length + bytes.length + padding(bytes.length);
    if (this.current && this.current.entries > 0 && this.current.used + whole > this.budget) {
      await this.rotate();
      target = this.currentPart;
      bytes = body(target);
      whole = entryHeaders(name, bytes.length, this.options.mtime).length + bytes.length + padding(bytes.length);
    }
    if (whole > this.budget) throw new Error(`The manifest (${bytes.length} bytes) is larger than one part; raise lifecycle.export_part_bytes`);
    const part = this.current ?? (await this.openPart());
    if (part.part !== target) throw new Error('The manifest part changed while it was written');
    const sha256 = await this.writeEntry(part, name, bytes.length, new ByteReader([bytes]), null);
    await this.rotate();
    return { entry: { path: name, part: part.part, sizeBytes: bytes.length, sha256 }, lastPart: part.part };
  }

  /** Removes the open part file after a failure (closed parts belong to `onPart`). */
  async abort(): Promise<void> {
    const open = this.current;
    this.current = null;
    if (open) await open.abort();
  }
}
