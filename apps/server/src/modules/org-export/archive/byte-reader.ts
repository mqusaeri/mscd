// Reads exactly the bytes an archive entry announced from a stream of chunks (Milestone 3 D.4): `take(n)` yields the
// next `n` bytes and keeps what is left of the last chunk for the following call, so one source can be cut into the
// pieces of an entry that is larger than one part.

function toBuffer(chunk: Uint8Array | string): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

export class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array | string>;
  private leftover: Buffer | null = null;
  private done = false;

  constructor(source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>) {
    this.iterator =
      Symbol.asyncIterator in source
        ? (source as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]()
        : (async function* () {
            yield* source as Iterable<Uint8Array | string>;
          })();
  }

  /** The next `count` bytes; throws when the source ends earlier. */
  async *take(count: number, label: string): AsyncGenerator<Buffer> {
    let remaining = count;
    while (remaining > 0) {
      let chunk = this.leftover;
      this.leftover = null;
      if (!chunk) {
        if (this.done) throw new Error(`${label} ended ${remaining} bytes before its announced size`);
        const next = await this.iterator.next();
        if (next.done) {
          this.done = true;
          throw new Error(`${label} ended ${remaining} bytes before its announced size`);
        }
        chunk = toBuffer(next.value);
        if (chunk.length === 0) continue;
      }
      if (chunk.length > remaining) {
        this.leftover = chunk.subarray(remaining);
        chunk = chunk.subarray(0, remaining);
      }
      remaining -= chunk.length;
      yield chunk;
    }
  }

  /** Throws when the source still has bytes (it was longer than announced); closes the source either way. */
  async expectEnd(label: string): Promise<void> {
    try {
      if (this.leftover && this.leftover.length > 0) throw new Error(`${label} is longer than its announced size`);
      while (!this.done) {
        const next = await this.iterator.next();
        if (next.done) {
          this.done = true;
          break;
        }
        if (toBuffer(next.value).length > 0) throw new Error(`${label} is longer than its announced size`);
      }
    } finally {
      await this.close();
    }
  }

  /** Releases the source (for example a gateway response) without reading the rest. */
  async close(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.iterator.return?.().catch(() => undefined);
  }
}
