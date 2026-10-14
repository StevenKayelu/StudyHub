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
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(this.timeoutMs, () => fail(new Error('clamd timed out')));
      socket.on('error', fail);
      socket.on('data', (data) => {
        reply += data.toString('utf8');
      });
      socket.on('end', () => {
        const text = reply.replace(/\0/g, '').trim();
        if (/: OK$/.test(text)) resolve({ clean: true });
        else if (/ FOUND$/.test(text))
          resolve({ clean: false, signature: text.replace(/^stream: /, '').replace(/ FOUND$/, '') });
        else reject(new Error(`Unexpected clamd reply: ${text.slice(0, 200)}`));
      });
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        content.on('data', (chunk: Buffer) => {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        });
        content.on('end', () => socket.write(Buffer.alloc(4)));
        content.on('error', fail);
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
