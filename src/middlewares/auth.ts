import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyAccess } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { audit } from '../lib/audit';
import { can, loadAccess, type Access } from '../modules/rbac/service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; jti: string; exp: number };
      access?: Access;
    }
  }
}

const tvKey = (id: string) => `tv:${id}`;
export const invalidateTv = (id: string) => redis.del(tvKey(id));

async function currentTokenVersion(userId: string): Promise<number | null> {
  const cached = await redis.get(tvKey(userId));
  if (cached !== null) return Number(cached);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true, status: true } });
  const v = u && u.status === 'active' ? u.tokenVersion : -1;
  await redis.set(tvKey(userId), String(v), 'EX', 60);
  return v;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.header('authorization');
  if (!h?.startsWith('Bearer ')) throw unauthorized('TOKEN_INVALID', 'Missing token');
  const claims = verifyAccess(h.slice(7));
  if (await redis.exists(`revoked_jti:${claims.jti}`)) throw unauthorized('TOKEN_INVALID');
  const tv = await currentTokenVersion(claims.sub);
  if (tv === null || tv !== claims.tv) throw unauthorized('TOKEN_INVALID');
  req.auth = { userId: claims.sub, jti: claims.jti, exp: claims.exp };
  req.access = await loadAccess(claims.sub);
  next();
}

export const authorize = (permission: string) => async (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth || !req.access) throw unauthorized('TOKEN_INVALID', 'Not authenticated');
  if (can(req.access, permission)) return next();
  await audit(req.auth.userId, 'permission.checked.denied', { permission, method: req.method, path: req.originalUrl }, req.ip);
  throw forbidden(`You do not have permission: ${permission}`);
};

export const authorizeAny = (...permissions: string[]) => async (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth || !req.access) throw unauthorized('TOKEN_INVALID', 'Not authenticated');
  if (permissions.some((p) => can(req.access!, p))) return next();
  await audit(req.auth.userId, 'permission.checked.denied', { permission: permissions.join('|'), method: req.method, path: req.originalUrl }, req.ip);
  throw forbidden(`You do not have permission: ${permissions.join(' or ')}`);
};
