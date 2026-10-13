import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption (AES-256-GCM) for secrets at rest: TOTP secrets and the links inside
 * queued emails. Format: version (1 byte) | IV (12) | tag (16) | ciphertext. The key comes from
 * IDENTITY_ENCRYPTION_KEY (32 bytes, base64); a KMS-managed key replaces it before production.
 * `context` is bound as additional authenticated data, so a value can't be moved between purposes.
 */
const VERSION = 1;

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('IDENTITY_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    this.key = key;
  }

  seal(plaintext: Buffer | string, context: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  open(sealed: Buffer, context: string): Buffer {
    if (sealed.length < 29 || sealed[0] !== VERSION) throw new Error('Unsupported sealed value.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(1, 13));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(sealed.subarray(13, 29));
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  }

  sealText(plaintext: string, context: string): string {
    return this.seal(plaintext, context).toString('base64');
  }

  openText(sealed: string, context: string): string {
    return this.open(Buffer.from(sealed, 'base64'), context).toString('utf8');
  }
}
