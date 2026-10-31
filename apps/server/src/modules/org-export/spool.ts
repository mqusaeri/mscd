// A temporary file of the organisation export build (Milestone 3 D.4): a table's CSV or JSON Lines text is written to
// a file first, because a tar header needs the entry's size before its bytes. The file is added to the current part
// and deleted right after, so the working folder holds one table at a time.
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

export class Spool {
  private readonly stream: WriteStream;
  private failure: Error | null = null;
  size = 0;

  constructor(readonly path: string) {
    this.stream = createWriteStream(path, { flags: 'wx' });
    this.stream.on('error', (error) => {
      this.failure = error;
    });
  }

  async write(data: string | Buffer): Promise<void> {
    if (this.failure) throw this.failure;
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (chunk.length === 0) return;
    this.size += chunk.length;
    if (!this.stream.write(chunk)) {
      await Promise.race([once(this.stream, 'drain'), once(this.stream, 'error').then(([error]) => Promise.reject(error as Error))]);
    }
  }

  /** Closes the file; returns its size in bytes. */
  async close(): Promise<number> {
    if (this.failure) throw this.failure;
    this.stream.end();
    await finished(this.stream);
    return this.size;
  }

  /** The file's bytes as a stream. */
  read(): AsyncIterable<Buffer> {
    return createReadStream(this.path) as AsyncIterable<Buffer>;
  }

  async remove(): Promise<void> {
    this.stream.destroy();
    await rm(this.path, { force: true });
  }
}
