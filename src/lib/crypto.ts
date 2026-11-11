import crypto from 'crypto';
import argon2 from 'argon2';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const uuid = () => crypto.randomUUID();

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });

let dummy: Promise<string> | undefined;
export async function verifyPassword(hash: string | null, pw: string): Promise<boolean> {
  dummy ??= argon2.hash('dummy-password-for-timing', { type: argon2.argon2id });
  if (!hash) {
    await argon2.verify(await dummy, pw).catch(() => false);
    return false;
  }
  return argon2.verify(hash, pw).catch(() => false);
}
