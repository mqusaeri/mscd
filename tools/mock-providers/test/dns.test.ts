import { Resolver } from 'node:dns/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DnsZone, answerQuery, normaliseDnsName, startDnsResponder, startMockProviders, type RunningMockProviders } from '../src/index.js';
import { build, call } from './helpers.js';

// The DNS responder for TXT records (Milestone 2 M2-S11): answers through node:dns, as the email domain verification of
// the server reads it, the admin routes, the faults and the message format.

/** A resolver of node:dns that asks only the responder at `address` (`host:port`), with a short timeout. */
function resolverFor(address: string, timeout = 400): Resolver {
  const resolver = new Resolver({ timeout, tries: 1 });
  resolver.setServers([address]);
  return resolver;
}

/** A DNS query for one name and type, as a resolver sends it (recursion desired). */
function query(name: string, type = 16, id = 0x1234): Buffer {
  const labels = name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'latin1')]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

let running: RunningMockProviders | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('DNS responder', () => {
  it('answers TXT records set through the admin API to node:dns, and NXDOMAIN for other names', async () => {
    running = await startMockProviders({ dnsPort: 0 });
    expect(running.dns?.address).toMatch(/^127\.0\.0\.1:\d+$/);
    const set = await fetch(`${running.url}/_admin/dns/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '_MSCD-Verify.Example.co.id.', values: ['mscd-verify=abc', 'v=spf1 -all'] }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ name: '_mscd-verify.example.co.id', values: ['mscd-verify=abc', 'v=spf1 -all'] });

    const resolver = resolverFor(running.dns!.address);
    expect(await resolver.resolveTxt('_mscd-verify.example.co.id')).toEqual([['mscd-verify=abc'], ['v=spf1 -all']]);
    // Names compare without case.
    expect(await resolver.resolveTxt('_MSCD-VERIFY.EXAMPLE.CO.ID')).toEqual([['mscd-verify=abc'], ['v=spf1 -all']]);
    await expect(resolver.resolveTxt('_mscd-verify.other.co.id')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    // A name with records but no record of the asked type: no data.
    await expect(resolver.resolve4('_mscd-verify.example.co.id')).rejects.toMatchObject({ code: 'ENODATA' });

    const listed = (await (await fetch(`${running.url}/_admin/dns/records`)).json()) as { records: unknown[]; queries: unknown[] };
    expect(listed.records).toEqual([{ name: '_mscd-verify.example.co.id', values: ['mscd-verify=abc', 'v=spf1 -all'] }]);
    expect(listed.queries.length).toBeGreaterThanOrEqual(4);
    expect(await (await fetch(`${running.url}/_admin/dns`)).json()).toEqual({ address: running.dns!.address, fault: { rcode: null, drop: false }, records: 1 });

    // An empty list removes the name; a changed value is answered at once (TTL 0).
    await fetch(`${running.url}/_admin/dns/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '_mscd-verify.example.co.id', values: ['mscd-verify=new'] }) });
    expect(await resolver.resolveTxt('_mscd-verify.example.co.id')).toEqual([['mscd-verify=new']]);
    await fetch(`${running.url}/_admin/dns/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '_mscd-verify.example.co.id', values: [] }) });
    await expect(resolver.resolveTxt('_mscd-verify.example.co.id')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('splits a value longer than 255 bytes into the character strings of one record', async () => {
    const zone = new DnsZone();
    const responder = await startDnsResponder(zone);
    try {
      const long = `mscd-verify=${'x'.repeat(300)}`;
      zone.set('_mscd-verify.long.example', [long]);
      const records = await resolverFor(responder.address).resolveTxt('_mscd-verify.long.example');
      expect(records).toHaveLength(1);
      expect(records[0]!.map((chunk) => chunk.length)).toEqual([255, long.length - 255]);
      expect(records[0]!.join('')).toBe(long);
    } finally {
      await responder.close();
    }
  });

  it('answers SERVFAIL or REFUSED, or nothing at all, while a fault is set', async () => {
    running = await startMockProviders({ dnsPort: 0 });
    const admin = (body: unknown) => fetch(`${running!.url}/_admin/dns/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await fetch(`${running.url}/_admin/dns/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a.example', values: ['x'] }) });
    const resolver = resolverFor(running.dns!.address);
    expect((await admin({ rcode: 'servfail' })).status).toBe(200);
    await expect(resolver.resolveTxt('a.example')).rejects.toMatchObject({ code: 'ESERVFAIL' });
    await admin({ rcode: 'refused' });
    await expect(resolver.resolveTxt('a.example')).rejects.toMatchObject({ code: 'EREFUSED' });
    await admin({ drop: true });
    await expect(resolver.resolveTxt('a.example')).rejects.toMatchObject({ code: 'ETIMEOUT' });
    await admin({ rcode: null, drop: false });
    expect(await resolver.resolveTxt('a.example')).toEqual([['x']]);
    expect((await admin({ rcode: 'nxdomain' })).status).toBe(400);
  });

  it('forgets records and faults on reset, and refuses bad admin input', async () => {
    const app = build();
    try {
      expect((await call(app, 'POST', '/_admin/dns/records', { json: { name: 'b.example', values: ['y'] } })).statusCode).toBe(200);
      expect((await call(app, 'POST', '/_admin/dns/fault', { json: { drop: true } })).statusCode).toBe(200);
      // Without a UDP port the records are kept all the same (the address is null).
      expect((await call(app, 'GET', '/_admin/dns')).json()).toEqual({ address: null, fault: { rcode: null, drop: true }, records: 1 });
      await call(app, 'POST', '/_admin/reset');
      expect((await call(app, 'GET', '/_admin/dns')).json()).toEqual({ address: null, fault: { rcode: null, drop: false }, records: 0 });

      for (const json of [{ values: ['x'] }, { name: 'bad name', values: [] }, { name: 'c.example' }, { name: 'c.example', values: [1] }, { name: 'c.example', values: ['x'.repeat(5000)] }]) {
        const response = await call(app, 'POST', '/_admin/dns/records', { json });
        expect(response.statusCode, JSON.stringify(json)).toBe(400);
        expect(response.json().error.code).toBe('bad_request');
      }
      await call(app, 'POST', '/_admin/dns/records', { json: { name: 'c.example', values: ['1'] } });
      expect((await call(app, 'DELETE', '/_admin/dns/records')).json()).toEqual({ removed: 1 });
    } finally {
      await app.close();
    }
  });

  it('reads the message format: one question echoed, TXT and ANY answered, other opcodes and malformed queries refused', () => {
    const zone = new DnsZone();
    zone.set('t.example', ['v1']);
    const answer = answerQuery(zone, query('T.Example'))!;
    expect(answer.readUInt16BE(0)).toBe(0x1234);
    const flags = answer.readUInt16BE(2);
    expect(flags & 0x8000).toBe(0x8000); // a response
    expect(flags & 0x0100).toBe(0x0100); // recursion desired copied
    expect(flags & 0x000f).toBe(0); // NOERROR
    expect(answer.readUInt16BE(4)).toBe(1);
    expect(answer.readUInt16BE(6)).toBe(1);
    // The question is echoed with the case it was asked in.
    expect(answer.subarray(12, 12 + 11).toString('latin1')).toContain('Example');
    expect(answerQuery(zone, query('t.example', 255))!.readUInt16BE(6)).toBe(1);
    expect(answerQuery(zone, query('t.example', 1))!.readUInt16BE(6)).toBe(0);
    expect(answerQuery(zone, query('u.example'))!.readUInt16BE(2) & 0x000f).toBe(3); // NXDOMAIN
    const notQuery = query('t.example');
    notQuery.writeUInt16BE(0x0100 | (2 << 11), 2); // opcode STATUS
    expect(answerQuery(zone, notQuery)!.readUInt16BE(2) & 0x000f).toBe(4); // NOTIMP
    expect(answerQuery(zone, Buffer.from([1, 2, 3]))).toBeNull();
    const twoQuestions = query('t.example');
    twoQuestions.writeUInt16BE(2, 4);
    expect(answerQuery(zone, twoQuestions)!.readUInt16BE(2) & 0x000f).toBe(1); // FORMERR
    const response = query('t.example');
    response.writeUInt16BE(0x8100, 2);
    expect(answerQuery(zone, response)).toBeNull();
  });

  it('normalises names and refuses what is not a DNS name', () => {
    expect(normaliseDnsName(' _MSCD-verify.Example.CO.ID. ')).toBe('_mscd-verify.example.co.id');
    for (const bad of ['', 'a..b', '-a.example', `${'a'.repeat(64)}.example`, 'a b.example']) expect(() => normaliseDnsName(bad), bad).toThrow(/is not a DNS name/);
  });
});
