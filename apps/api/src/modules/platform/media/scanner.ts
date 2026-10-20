import { Socket } from 'node:net';
import type { Readable } from 'node:stream';

/** Malware scanning before an asset becomes READY (BR-29, F11 AC 2). */
export interface MalwareScanner {
  readonly name: string;
  scan(content: Readable): Promise<{ clean: true } | { clean: false; signature: string }>;
}

/**
 * ClamAV over the clamd INSTREAM protocol (TCP): chunks prefixed with a 4-byte big-endian length,
 * terminated by a zero-length chunk; the reply is "stream: OK" or "stream: <signature> FOUND".
 */
export class ClamdScanner implements MalwareScanner {
  readonly name = 'clamd';

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 120_000,
  ) {}

  scan(content: Readable): Promise<{ clean: true } | { clean: false; signature: string }> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let reply = '';
      let settled = false;
      const cleanup = () => {
        settled = true;
        content.removeListener('error', fail);
        content.destroy();
        socket.destroy();
      };
      const fail = (error: Error) => {
        if (settled) return;
        cleanup();
        reject(error);
      };
      content.on('error', fail);
      socket.setTimeout(this.timeoutMs, () => fail(new Error('clamd timed out')));
      socket.on('error', fail);
      socket.on('data', (data) => {
        reply += data.toString('utf8');
        if (reply.length > 4096) fail(new Error('clamd reply exceeds protocol limit'));
      });
      socket.on('close', () => {
        if (!settled) fail(new Error('clamd connection closed before scan result'));
      });
      socket.on('end', () => {
        if (settled) return;
        const text = reply.replace(/\0/g, '').trim();
        if (text === 'stream: OK') {
          cleanup();
          resolve({ clean: true });
        } else if (/^stream: .+ FOUND$/.test(text)) {
          cleanup();
          resolve({ clean: false, signature: text.replace(/^stream: /, '').replace(/ FOUND$/, '') });
        } else fail(new Error(`Unexpected clamd reply: ${text.slice(0, 200)}`));
      });
      socket.connect(this.port, this.host, () => {
        // Await writes so large uploads cannot accumulate unbounded socket buffers when clamd
        // reads slowly. Stop consuming storage content after rejection, disconnect or timeout.
        const write = (chunk: Buffer | string) =>
          new Promise<void>((done, rejectWrite) => {
            socket.write(chunk, (error) => (error ? rejectWrite(error) : done()));
          });
        void (async () => {
          await write('zINSTREAM\0');
          for await (const chunk of content) {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(bytes.length);
            await write(size);
            await write(bytes);
          }
          if (!settled) await write(Buffer.alloc(4));
        })().catch(fail);
      });
    });
  }
}

/** The standard EICAR antivirus test string (harmless by design). */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * DEVELOPMENT AND TESTS ONLY: flags the EICAR test file and nothing else, so the reject path can be
 * exercised without running ClamAV. The configuration refuses it in production.
 */
export class EicarOnlyScanner implements MalwareScanner {
  readonly name = 'eicar-only';

  async scan(content: Readable): Promise<{ clean: true } | { clean: false; signature: string }> {
    let tail = '';
    for await (const chunk of content) {
      const text = tail + Buffer.from(chunk as Buffer).toString('latin1');
      if (text.includes(EICAR)) return { clean: false, signature: 'Eicar-Test-Signature' };
      tail = text.slice(-EICAR.length);
    }
    return { clean: true };
  }
}
