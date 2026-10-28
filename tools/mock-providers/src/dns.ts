import { type RemoteInfo, type Socket, createSocket } from 'node:dgram';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { adminError } from './errors.js';
import { anyJsonBody } from './http.js';

// A small DNS responder for TXT records (Milestone 2 M2-S11): the email domain verification of MSCD looks up
// `_mscd-verify.<domain>` TXT through `node:dns` with the resolvers of `network.dns_resolvers`. Tests, the API E2E
// stack and the SaaS end-to-end run (M2-S13) point those resolvers here and set the records through the admin API.
//
// It answers queries over UDP only (one question per message, no compression in the question, no EDNS in the answer):
//   - TXT (16) or ANY (255) for a name with records: NOERROR with one TXT record per value (TTL 0, so nothing caches);
//   - any other type for a name with records: NOERROR without answers (NODATA);
//   - a name without records: NXDOMAIN.
// Names compare without case and without a trailing dot. A value longer than 255 bytes is split into several
// character strings of one record, as DNS servers do; `resolveTxt` returns them as the chunks of one record.
//
// Faults: `rcode` answers every query with SERVFAIL or REFUSED, `drop` answers nothing (the client times out).
//
// Admin API (registered on the HTTP server with the other `/_admin` routes):
//   GET    /_admin/dns/records                 every name with its values
//   POST   /_admin/dns/records                 {name, values: [...]} replaces the values of a name; [] removes it
//   DELETE /_admin/dns/records                 removes every record
//   POST   /_admin/dns/fault                   {rcode?: "servfail" | "refused" | null, drop?: boolean}
//   GET    /_admin/dns                         the responder's address (null when no UDP port was opened) and fault

const TYPE_TXT = 16;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const RCODE = { noerror: 0, formerr: 1, servfail: 2, nxdomain: 3, notimp: 4, refused: 5 } as const;
const MAX_NAME = 253;
const MAX_VALUES = 32;
const MAX_VALUE_BYTES = 4096;

export type DnsFaultCode = 'servfail' | 'refused';

export interface DnsFault {
  rcode: DnsFaultCode | null;
  drop: boolean;
}

/** Lower case without a trailing dot; throws for a name that is not a DNS name. */
export function normaliseDnsName(name: string): string {
  const value = name.trim().toLowerCase().replace(/\.$/, '');
  const labels = value.split('.');
  const ok = value.length > 0 && value.length <= MAX_NAME && labels.every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label));
  if (!ok) throw new Error(`"${name}" is not a DNS name`);
  return value;
}

/** The TXT records of the mock DNS zone and its fault switch, shared by the UDP responder and the admin API. */
export class DnsZone {
  private readonly records = new Map<string, string[]>();
  fault: DnsFault = { rcode: null, drop: false };
  /** Queries answered (or dropped) since the last clear, oldest first, at most 200. */
  readonly queries: { name: string; type: number; rcode: number | null }[] = [];

  /** Replaces the TXT values of a name; an empty list removes the name. */
  set(name: string, values: readonly string[]): void {
    const key = normaliseDnsName(name);
    if (values.length === 0) this.records.delete(key);
    else this.records.set(key, [...values]);
  }

  /** The TXT values of a name, or undefined when the name has none. */
  get(name: string): string[] | undefined {
    try {
      const values = this.records.get(normaliseDnsName(name));
      return values ? [...values] : undefined;
    } catch {
      return undefined;
    }
  }

  list(): { name: string; values: string[] }[] {
    return [...this.records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => ({ name, values: [...values] }));
  }

  /** Removes every record and the fault (the admin reset). */
  clear(): void {
    this.records.clear();
    this.fault = { rcode: null, drop: false };
    this.queries.length = 0;
  }

  logQuery(entry: { name: string; type: number; rcode: number | null }): void {
    this.queries.push(entry);
    if (this.queries.length > 200) this.queries.splice(0, this.queries.length - 200);
  }
}

interface Question {
  name: string;
  type: number;
  klass: number;
  /** The question bytes as received, echoed in the answer. */
  raw: Buffer;
}

/** Reads the header and the first question of a query; null when the message is not a query this responder reads. */
export function parseQuery(message: Buffer): { id: number; flags: number; question: Question | null } | null {
  if (message.length < 12) return null;
  const id = message.readUInt16BE(0);
  const flags = message.readUInt16BE(2);
  if (flags & 0x8000) return null; // a response, not a query
  const qdcount = message.readUInt16BE(4);
  if (qdcount !== 1) return { id, flags, question: null };
  const labels: string[] = [];
  let offset = 12;
  for (;;) {
    if (offset >= message.length) return { id, flags, question: null };
    const length = message[offset]!;
    if (length === 0) {
      offset += 1;
      break;
    }
    if (length & 0xc0) return { id, flags, question: null }; // compression in a question is not supported
    if (offset + 1 + length > message.length) return { id, flags, question: null };
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString('latin1'));
    offset += 1 + length;
  }
  if (offset + 4 > message.length) return { id, flags, question: null };
  const type = message.readUInt16BE(offset);
  const klass = message.readUInt16BE(offset + 2);
  return { id, flags, question: { name: labels.join('.'), type, klass, raw: message.subarray(12, offset + 4) } };
}

/** The character strings of one TXT value: chunks of at most 255 bytes, each with its length byte. */
function txtRdata(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const parts: Buffer[] = [];
  if (bytes.length === 0) parts.push(Buffer.from([0]));
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  return Buffer.concat(parts);
}

/** The answer of a query against the zone: the response bytes, or null when the zone drops it. */
export function answerQuery(zone: DnsZone, message: Buffer): Buffer | null {
  const query = parseQuery(message);
  if (!query) return null;
  const { id, flags, question } = query;
  const opcode = (flags >> 11) & 0x0f;
  const recursionDesired = flags & 0x0100;
  const header = (rcode: number, answers: number, authoritative: boolean) => {
    const out = Buffer.alloc(12);
    out.writeUInt16BE(id, 0);
    out.writeUInt16BE(0x8000 | (opcode << 11) | (authoritative ? 0x0400 : 0) | recursionDesired | 0x0080 | rcode, 2);
    out.writeUInt16BE(question ? 1 : 0, 4);
    out.writeUInt16BE(answers, 6);
    return out;
  };
  if (zone.fault.drop) {
    zone.logQuery({ name: question?.name.toLowerCase() ?? '', type: question?.type ?? 0, rcode: null });
    return null;
  }
  if (!question || opcode !== 0) {
    const rcode = !question ? RCODE.formerr : RCODE.notimp;
    zone.logQuery({ name: question?.name.toLowerCase() ?? '', type: question?.type ?? 0, rcode });
    return Buffer.concat([header(rcode, 0, false), question?.raw ?? Buffer.alloc(0)]);
  }
  const name = question.name.toLowerCase();
  if (zone.fault.rcode) {
    const rcode = RCODE[zone.fault.rcode];
    zone.logQuery({ name, type: question.type, rcode });
    return Buffer.concat([header(rcode, 0, false), question.raw]);
  }
  const values = question.klass === CLASS_IN ? zone.get(name) : undefined;
  if (!values) {
    zone.logQuery({ name, type: question.type, rcode: RCODE.nxdomain });
    return Buffer.concat([header(RCODE.nxdomain, 0, true), question.raw]);
  }
  const wanted = question.type === TYPE_TXT || question.type === TYPE_ANY;
  const answers = wanted
    ? values.map((value) => {
        const rdata = txtRdata(value);
        const rr = Buffer.alloc(12);
        rr.writeUInt16BE(0xc00c, 0); // pointer to the name of the question
        rr.writeUInt16BE(TYPE_TXT, 2);
        rr.writeUInt16BE(CLASS_IN, 4);
        rr.writeUInt32BE(0, 6); // TTL 0: a resolver never serves an old value
        rr.writeUInt16BE(rdata.length, 10);
        return Buffer.concat([rr, rdata]);
      })
    : [];
  zone.logQuery({ name, type: question.type, rcode: RCODE.noerror });
  return Buffer.concat([header(RCODE.noerror, answers.length, true), question.raw, ...answers]);
}

export interface RunningDnsResponder {
  /** The address to put in `network.dns_resolvers`, for example `127.0.0.1:53053`. */
  address: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

/** Opens the UDP responder of a zone. Port 0 picks a free port. */
export async function startDnsResponder(zone: DnsZone, options: { port?: number; host?: string } = {}): Promise<RunningDnsResponder> {
  const host = options.host ?? '127.0.0.1';
  const socket: Socket = createSocket(host.includes(':') ? 'udp6' : 'udp4');
  socket.on('message', (message: Buffer, remote: RemoteInfo) => {
    let reply: Buffer | null = null;
    try {
      reply = answerQuery(zone, message);
    } catch (error) {
      process.stderr.write(`mock-providers dns: ${(error as Error).message}\n`);
    }
    if (reply) socket.send(reply, remote.port, remote.address);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(options.port ?? 0, host, () => {
      socket.off('error', reject);
      resolve();
    });
  });
  socket.on('error', (error) => process.stderr.write(`mock-providers dns: ${error.message}\n`));
  const port = socket.address().port;
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return {
    address: shown.includes(':') ? `[${shown}]:${port}` : `${shown}:${port}`,
    host,
    port,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

function bad(message: string): Error {
  return adminError(400, 'bad_request', message);
}

function objectBody(request: FastifyRequest): Record<string, unknown> {
  const body = anyJsonBody(request, 'admin');
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('The request body must be a JSON object.');
  return body as Record<string, unknown>;
}

/** The admin routes of the zone (see the file comment). `responder` gives the address once the UDP port is open. */
export function registerDnsAdminRoutes(app: FastifyInstance, zone: DnsZone, responder: () => string | null): void {
  app.get('/_admin/dns', async () => ({ address: responder(), fault: zone.fault, records: zone.list().length }));
  app.get('/_admin/dns/records', async () => ({ records: zone.list(), queries: zone.queries }));
  app.post('/_admin/dns/records', async (request) => {
    const body = objectBody(request);
    if (typeof body.name !== 'string') throw bad('name must be a DNS name such as _mscd-verify.example.co.id.');
    if (!Array.isArray(body.values) || body.values.length > MAX_VALUES || body.values.some((v) => typeof v !== 'string' || Buffer.byteLength(v) > MAX_VALUE_BYTES)) {
      throw bad(`values must be a list of at most ${MAX_VALUES} strings of at most ${MAX_VALUE_BYTES} bytes ([] removes the name).`);
    }
    let name: string;
    try {
      name = normaliseDnsName(body.name);
    } catch (error) {
      throw bad((error as Error).message);
    }
    zone.set(name, body.values as string[]);
    return { name, values: zone.get(name) ?? [] };
  });
  app.delete('/_admin/dns/records', async () => {
    const removed = zone.list().length;
    for (const { name } of zone.list()) zone.set(name, []);
    return { removed };
  });
  app.post('/_admin/dns/fault', async (request) => {
    const body = objectBody(request);
    const rcode = body.rcode ?? null;
    if (rcode !== null && rcode !== 'servfail' && rcode !== 'refused') throw bad('rcode must be "servfail", "refused" or null.');
    if (body.drop !== undefined && typeof body.drop !== 'boolean') throw bad('drop must be true or false.');
    zone.fault = { rcode, drop: body.drop === true };
    return zone.fault;
  });
}
