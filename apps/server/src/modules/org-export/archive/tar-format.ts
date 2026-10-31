// Tar headers of the organisation export (Milestone 3 D.4), extending the ustar writer of
// `evidence-packs/tar-stream.ts` with POSIX pax extended headers: an entry whose name is not printable ASCII of at
// most 99 bytes, or whose size does not fit the 11 octal digits of ustar, gets a pax header (typeflag `x`) with the
// full `path` and `size`, followed by the ustar header with an ASCII fallback name. Names are therefore never cut at
// 99 bytes and never collide, and every common tool (GNU tar, bsdtar, 7-Zip, Windows tar) reads them.
import { tarEntryName, tarHeader } from '../../evidence-packs/tar-stream';

export const BLOCK = 512;
/** Largest size the 11 octal digits of a ustar header hold (8 GiB minus 1 byte). */
export const USTAR_MAX_SIZE = 0o77777777777;
/** The two zero blocks that end a tar archive. */
export const END_OF_ARCHIVE = BLOCK * 2;

/** Bytes of padding after `size` data bytes up to the next block boundary. */
export function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** True when a name fits a plain ustar header: printable ASCII, 1 to 99 bytes. */
export function fitsUstar(name: string): boolean {
  return /^[\x20-\x7e]{1,99}$/.test(name);
}

/** One pax record `"<length> <key>=<value>\n"`, where the length counts the whole record in bytes. */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body, 'utf8');
  let length = bodyLength + String(bodyLength).length;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return Buffer.from(`${length}${body}`, 'utf8');
}

/** The checksum of a header block written into its field (bytes 148 to 155 count as spaces). */
function writeChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

/** A ustar header block with another typeflag (`x` for a pax extended header). */
function withTypeflag(header: Buffer, flag: string): Buffer {
  header.write(flag, 156, 1, 'ascii');
  writeChecksum(header);
  return header;
}

/**
 * The header blocks of one regular file entry: the plain ustar header when the name and size fit, else a pax header
 * with the full path (UTF-8) and size, its records padded to a block, and the ustar header with an ASCII fallback.
 */
export function entryHeaders(name: string, size: number, mtime: Date): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Archive entry ${name} has an invalid size ${size}`);
  const plain = fitsUstar(name);
  const large = size > USTAR_MAX_SIZE;
  if (plain && !large) return tarHeader(name, size, mtime);
  const records = Buffer.concat([...(plain ? [] : [paxRecord('path', name)]), ...(large ? [paxRecord('size', String(size))] : [])]);
  const fallback = tarEntryName(name);
  const pax = withTypeflag(tarHeader(tarEntryName(`PaxHeaders/${fallback}`), records.length, mtime), 'x');
  const recordBlocks = Buffer.concat([records, Buffer.alloc(padding(records.length), 0)]);
  return Buffer.concat([pax, recordBlocks, tarHeader(fallback, large ? 0 : size, mtime)]);
}

/** Bytes one entry takes in the archive: its header blocks, its data and the padding after it. */
export function entryArchiveBytes(name: string, size: number): number {
  return entryHeaders(name, size, new Date(0)).length + size + padding(size);
}
