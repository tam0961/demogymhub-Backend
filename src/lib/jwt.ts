import jwt from 'jsonwebtoken';
import { config } from '../config';
import { uuid } from './crypto';
import { unauthorized } from './errors';

const keys: Record<string, string> = { k1: config.JWT_SECRET };
if (config.JWT_SECRET_PREV) keys.k0 = config.JWT_SECRET_PREV;

export interface AccessClaims {
  sub: string;
  jti: string;
  tv: number;
  exp: number;
  roles: string[];
}

export function signAccess(userId: string, tv: number, roles: string[], jti = uuid()) {
  const token = jwt.sign({ tv, roles }, keys.k1, {
    algorithm: 'HS256',
    keyid: 'k1',
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    subject: userId,
    jwtid: jti,
    expiresIn: config.ACCESS_TTL_SEC,
    notBefore: 0,
  });
  return { token, jti };
}

export function verifyAccess(token: string): AccessClaims {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded && typeof decoded === 'object' ? decoded.header.kid : undefined;
  const key = kid ? keys[kid] : undefined;
  if (!key) throw unauthorized('TOKEN_INVALID');
  try {
    return jwt.verify(token, key, {
      algorithms: ['HS256'],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      clockTolerance: 60,
    }) as unknown as AccessClaims;
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) throw unauthorized('TOKEN_EXPIRED', 'Token expired');
    throw unauthorized('TOKEN_INVALID');
  }
}
