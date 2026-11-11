import type { CookieOptions, Response } from 'express';
import { config } from '../../config';
import { audit } from '../../lib/audit';
import { randomToken, sha256, uuid } from '../../lib/crypto';
import { HttpError } from '../../lib/errors';
import { signAccess } from '../../lib/jwt';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { invalidateTv } from '../../middlewares/auth';
import { invalidateAccess, loadAccess } from '../rbac/service';

const cookieOpts = (): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/api/auth',
});

export function setRefreshCookie(res: Response, raw: string) {
  res.cookie(config.REFRESH_COOKIE_NAME, raw, { ...cookieOpts(), maxAge: config.REFRESH_TTL_SEC * 1000 });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(config.REFRESH_COOKIE_NAME, cookieOpts());
}

export async function issueSession(
  user: { id: string; tokenVersion: number },
  ctx: { ip?: string; userAgent?: string },
  familyId: string = uuid(),
) {
  const access = await loadAccess(user.id);
  const { token, jti } = signAccess(user.id, user.tokenVersion, access.roles);
  const refresh = randomToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refresh),
      familyId,
      jti,
      userAgent: ctx.userAgent?.slice(0, 255) ?? null,
      ip: ctx.ip ?? null,
      expiresAt: new Date(Date.now() + config.REFRESH_TTL_SEC * 1000),
    },
  });
  return { accessToken: token, refresh, familyId };
}

export async function bumpTokenVersion(userId: string) {
  const u = await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
  await invalidateTv(userId);
  return u;
}

export async function revokeAllSessions(userId: string, exceptFamily?: string) {
  await prisma.refreshToken.deleteMany({
    where: { userId, ...(exceptFamily ? { familyId: { not: exceptFamily } } : {}) },
  });
}

export async function blacklistJti(jti: string, ttlSec: number) {
  await redis.set(`revoked_jti:${jti}`, '1', 'EX', Math.max(1, Math.ceil(ttlSec)));
}

export async function renew(raw: string | undefined, ctx: { ip?: string; userAgent?: string }) {
  if (!raw) throw new HttpError(401, 'TOKEN_INVALID', 'Missing refresh token');
  const row = await prisma.refreshToken.findFirst({ where: { tokenHash: sha256(raw) } });
  if (!row || row.expiresAt < new Date()) throw new HttpError(401, 'TOKEN_INVALID', 'Invalid refresh token');

  const graceMs = config.RENEW_GRACE_SEC * 1000;
  const recentlyUsed = () => !!row.usedAt && Date.now() - row.usedAt.getTime() < graceMs;

  if (row.used) {
    if (recentlyUsed()) throw new HttpError(409, 'RENEW_CONFLICT', 'Token was just rotated, retry with the new cookie');
    await revokeAllSessions(row.userId);
    await bumpTokenVersion(row.userId);
    await audit(row.userId, 'auth.refresh.reuse_detected', { familyId: row.familyId }, ctx.ip);
    throw new HttpError(401, 'REUSE_DETECTED', 'Refresh token reuse detected');
  }

  const upd = await prisma.refreshToken.updateMany({
    where: { id: row.id, used: false },
    data: { used: true, usedAt: new Date() },
  });
  if (upd.count !== 1) throw new HttpError(409, 'RENEW_CONFLICT', 'Token was just rotated, retry with the new cookie');

  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user || user.status !== 'active') throw new HttpError(401, 'TOKEN_INVALID', 'Invalid refresh token');
  return issueSession(user, ctx, row.familyId);
}

export async function createAuthToken(userId: string, kind: 'email_verify' | 'password_reset', ttlSec: number) {
  const raw = randomToken();
  await prisma.authToken.create({
    data: { userId, kind, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + ttlSec * 1000) },
  });
  return raw;
}

export async function consumeAuthToken(raw: string, kind: 'email_verify' | 'password_reset') {
  const row = await prisma.authToken.findFirst({
    where: { tokenHash: sha256(raw), kind, usedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!row) throw new HttpError(400, 'INVALID_TOKEN', 'Invalid or expired token');
  const upd = await prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (upd.count !== 1) throw new HttpError(400, 'INVALID_TOKEN', 'Invalid or expired token');
  return row.userId;
}

export { invalidateAccess };
