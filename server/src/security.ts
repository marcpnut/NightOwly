import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

function derivePasswordKey(password: string, salt: Buffer, length: number, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, length, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, derived) => error ? reject(error) : resolve(derived as Buffer)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const cost = 16_384;
  const derived = await derivePasswordKey(password, salt, 64, cost);
  return `scrypt$${cost}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costText, saltText, keyText] = encoded.split('$');
  const cost = Number(costText);
  if (algorithm !== 'scrypt' || !Number.isInteger(cost) || cost < 16_384 || cost > 262_144 || !saltText || !keyText) return false;
  let salt: Buffer, expected: Buffer;
  try { salt = Buffer.from(saltText, 'base64url'); expected = Buffer.from(keyText, 'base64url'); }
  catch { return false; }
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await derivePasswordKey(password, salt, expected.length, cost);
  return timingSafeEqual(actual, expected);
}

export function encryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIAL_KEY must be 32 random bytes encoded as base64.');
  return key;
}

export function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(value: string, key: Buffer): string {
  const [version, iv, tag, data] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Invalid encrypted provider setting.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export function tokenMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function secretMatches(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
