import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key(appSecret: string, purpose = 'credentials'): Buffer {
  return createHash('sha256').update(`ftw-${purpose}:${appSecret}`).digest();
}

/** Encrypts binary data (e.g. document copies). Format: iv(12) + tag(16) + data. */
export function encryptBuffer(appSecret: string, data: Buffer, purpose: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(appSecret, purpose), iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(appSecret: string, blob: Buffer, purpose: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key(appSecret, purpose), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

export function encryptJson(appSecret: string, data: unknown, purpose: string): string {
  return encryptBuffer(appSecret, Buffer.from(JSON.stringify(data)), purpose).toString('base64');
}

export function decryptJson<T>(appSecret: string, blob: string, purpose: string): T {
  return JSON.parse(decryptBuffer(appSecret, Buffer.from(blob, 'base64'), purpose).toString('utf8'));
}

export function encrypt(appSecret: string, data: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(appSecret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function decrypt(appSecret: string, blob: string): Record<string, string> {
  const [iv, tag, body] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(appSecret), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}
