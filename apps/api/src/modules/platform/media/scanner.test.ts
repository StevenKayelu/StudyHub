import { createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { ClamdScanner } from './scanner';

let server: Server | undefined;
const sockets = new Set<Socket>();
async function scanner(handler: (socket: Socket) => void, timeout = 1000): Promise<ClamdScanner> {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TCP address missing');
  return new ClamdScanner('127.0.0.1', address.port, timeout);
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('clamd production adapter over TCP', () => {
  it('frames all content and terminates INSTREAM before accepting a clean result', async () => {
    let received = Buffer.alloc(0);
    const client = await scanner((socket) =>
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= 10 + 4 + 5 + 4 && received.subarray(-4).equals(Buffer.alloc(4))) {
          socket.write('stream: ');
          socket.end('OK\0');
        }
      }),
    );
    await expect(client.scan(Readable.from([Buffer.from('hello')]))).resolves.toEqual({ clean: true });
    expect(received.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(received.readUInt32BE(10)).toBe(5);
    expect(received.subarray(14, 19).toString()).toBe('hello');
    expect(received.readUInt32BE(19)).toBe(0);
  });

  it('returns the malware signature and stops the source', async () => {
    const client = await scanner((socket) => socket.once('data', () => socket.end('stream: Eicar FOUND\0')));
    const source = Readable.from([Buffer.from('test')]);
    await expect(client.scan(source)).resolves.toEqual({ clean: false, signature: 'Eicar' });
    expect(source.destroyed).toBe(true);
  });

  it.each(['garbage\0', 'other: OK\0', 'stream: size limit exceeded ERROR\0', ''])(
    'fails closed on %j',
    async (reply) => {
      const client = await scanner((socket) => socket.once('data', () => socket.end(reply)));
      await expect(client.scan(Readable.from(['test']))).rejects.toThrow();
    },
  );

  it('bounds replies from a faulty scanner', async () => {
    const client = await scanner((socket) => socket.once('data', () => socket.write('x'.repeat(4097))));
    await expect(client.scan(Readable.from(['test']))).rejects.toThrow('protocol limit');
  });

  it('times out and destroys the storage stream when the scanner never responds', async () => {
    const client = await scanner(() => {}, 30);
    const source = Readable.from(['test']);
    await expect(client.scan(source)).rejects.toThrow('timed out');
    expect(source.destroyed).toBe(true);
  });

  it('rejects storage read errors', async () => {
    const client = await scanner(() => {});
    const source = new Readable({
      read() {
        this.destroy(new Error('storage read failed'));
      },
    });
    await expect(client.scan(source)).rejects.toThrow('storage read failed');
  });
});
