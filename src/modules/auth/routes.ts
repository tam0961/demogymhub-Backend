import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { audit } from '../../lib/audit';
import { hashPassword, sha256, verifyPassword } from '../../lib/crypto';
import { HttpError, forbidden, unauthorized } from '../../lib/errors';
import { sendMail } from '../../lib/mailer';
import { prisma } from '../../lib/prisma';
import { hit, redis } from '../../lib/redis';
import { authenticate } from '../../middlewares/auth';
import { assignRole } from '../rbac/service';
import {
  blacklistJti,
  bumpTokenVersion,
  clearRefreshCookie,
  consumeAuthToken,
  createAuthToken,
  issueSession,
  renew,
  revokeAllSessions,
  setRefreshCookie,
} from './service';

export const authRouter = Router();

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(128);

const ctxOf = (req: Request) => ({ ip: req.ip, userAgent: req.header('user-agent') });
const refreshCookie = (req: Request): string | undefined => req.cookies?.[config.REFRESH_COOKIE_NAME];

function checkOrigin(req: Request, _res: Response, next: NextFunction) {
  const origin = req.header('origin');
  if (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) throw forbidden('Origin not allowed');
  next();
}

const tooMany = (ttl: number) => new HttpError(429, 'RATE_LIMITED', 'Too many attempts', { retry_after_seconds: ttl });

async function limit(key: string, max: number, windowSec: number) {
  const { count, ttl } = await hit(key, windowSec);
  if (count > max) throw tooMany(ttl);
}

authRouter.post('/register', async (req, res) => {
  const body = z.object({ email, password, name: z.string().trim().min(1).max(100).optional() }).parse(req.body);
  await limit(`register:${req.ip}`, 20, 3600);
  const generic = { data: { message: 'If the email can be registered, a verification link was sent.' } };
  const exists = await prisma.user.findUnique({ where: { email: body.email } });
  if (exists) {
    await hashPassword(body.password);
    return res.status(202).json(generic);
  }
  const user = await prisma.user.create({
    data: { email: body.email, name: body.name ?? body.email.split('@')[0], passwordHash: await hashPassword(body.password) },
  });
  await assignRole(user.id, 'member', null);
  await sendMail(user.email, 'email_verify', await createAuthToken(user.id, 'email_verify', 24 * 3600));
  res.status(202).json(generic);
});

authRouter.get('/verify', async (req, res) => {
  const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.query);
  const userId = await consumeAuthToken(token, 'email_verify');
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  res.json({ data: { verified: true } });
});

authRouter.post('/login', async (req, res) => {
  const body = z.object({ email, password: z.string().min(1).max(128) }).parse(req.body);
  await limit(`login_attempts:ip:${req.ip}`, config.LOGIN_IP_LIMIT, config.LOGIN_WINDOW_SEC);
  await limit(`login_attempts:email:${body.email}`, config.LOGIN_EMAIL_LIMIT, config.LOGIN_WINDOW_SEC);

  const user = await prisma.user.findUnique({ where: { email: body.email } });
  const valid = await verifyPassword(user?.passwordHash ?? null, body.password);

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const retry = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    throw new HttpError(423, 'LOCKED_OUT', 'Account temporarily locked', { retry_after_seconds: retry });
  }
  if (!user || user.status !== 'active' || !valid) {
    if (user) {
      const failed = user.failedLogins + 1;
      const lock = failed >= config.LOCKOUT_THRESHOLD;
      await prisma.user.update({
        where: { id: user.id },
        data: lock
          ? { failedLogins: 0, lockedUntil: new Date(Date.now() + config.LOCKOUT_SEC * 1000) }
          : { failedLogins: failed },
      });
      await audit(user.id, 'auth.login.failed', { locked: lock }, req.ip);
    }
    throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (!user.emailVerified) throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Email not verified');

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await redis.del(`login_attempts:email:${body.email}`);
  const s = await issueSession(updated, ctxOf(req));
  await audit(user.id, 'auth.login.success', {}, req.ip);
  setRefreshCookie(res, s.refresh);
  res.json({ data: { access_token: s.accessToken, user: { id: user.id, email: user.email, name: user.name } } });
});

authRouter.post('/renew', checkOrigin, async (req, res) => {
  try {
    const s = await renew(refreshCookie(req), ctxOf(req));
    setRefreshCookie(res, s.refresh);
    res.json({ data: { access_token: s.accessToken } });
  } catch (e) {
    if (!(e instanceof HttpError && e.code === 'RENEW_CONFLICT')) clearRefreshCookie(res);
    throw e;
  }
});

authRouter.post('/logout', checkOrigin, authenticate, async (req, res) => {
  await blacklistJti(req.auth!.jti, req.auth!.exp - Date.now() / 1000);
  const raw = refreshCookie(req);
  if (raw) {
    const row = await prisma.refreshToken.findFirst({ where: { tokenHash: sha256(raw), userId: req.auth!.userId } });
    if (row) await prisma.refreshToken.deleteMany({ where: { familyId: row.familyId, userId: row.userId } });
  }
  clearRefreshCookie(res);
  res.json({ data: { ok: true } });
});

authRouter.post('/logout-all', checkOrigin, authenticate, async (req, res) => {
  await bumpTokenVersion(req.auth!.userId);
  await revokeAllSessions(req.auth!.userId);
  clearRefreshCookie(res);
  res.json({ data: { ok: true } });
});

authRouter.post('/forgot-password', async (req, res) => {
  const body = z.object({ email }).parse(req.body);
  const generic = { data: { message: 'If that email exists, a reset link was sent.' } };
  const a = await hit(`forgot:email:${body.email}`, 60);
  const b = await hit(`forgot:ip:${req.ip}`, 3600);
  if (a.count > 1 || b.count > 20) return res.json(generic);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (user && user.status === 'active') {
    await sendMail(user.email, 'password_reset', await createAuthToken(user.id, 'password_reset', 30 * 60));
  }
  res.json(generic);
});

authRouter.post('/reset-password', async (req, res) => {
  const body = z.object({ token: z.string().min(10).max(200), new_password: password }).parse(req.body);
  const userId = await consumeAuthToken(body.token, 'password_reset');
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(body.new_password), failedLogins: 0, lockedUntil: null } });
  await bumpTokenVersion(userId);
  await revokeAllSessions(userId);
  await audit(userId, 'auth.password.reset', {}, req.ip);
  res.json({ data: { ok: true } });
});

authRouter.post('/change-password', authenticate, async (req, res) => {
  const body = z.object({ current: z.string().min(1).max(128), new: password }).parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (!(await verifyPassword(user.passwordHash, body.current))) throw unauthorized('INVALID_CREDENTIALS', 'Invalid password');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.new) } });
  const bumped = await bumpTokenVersion(user.id);

  const raw = refreshCookie(req);
  const current = raw ? await prisma.refreshToken.findFirst({ where: { tokenHash: sha256(raw), userId: user.id } }) : null;
  await revokeAllSessions(user.id, current?.familyId);
  await audit(user.id, 'auth.password.changed', {}, req.ip);

  const s = await issueSession(bumped, ctxOf(req), current?.familyId);
  if (current) await prisma.refreshToken.deleteMany({ where: { id: current.id } });
  setRefreshCookie(res, s.refresh);
  res.json({ data: { access_token: s.accessToken } });
});

authRouter.get('/sessions', authenticate, async (req, res) => {
  const raw = refreshCookie(req);
  const cur = raw ? await prisma.refreshToken.findFirst({ where: { tokenHash: sha256(raw) } }) : null;
  const rows = await prisma.refreshToken.findMany({
    where: { userId: req.auth!.userId, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    data: rows.map((r) => ({
      id: r.id,
      user_agent: r.userAgent,
      ip: r.ip,
      created_at: r.createdAt,
      current: !!cur && cur.familyId === r.familyId,
    })),
  });
});

authRouter.delete('/sessions/:id', authenticate, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const row = await prisma.refreshToken.findFirst({ where: { id, userId: req.auth!.userId } });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
  await prisma.refreshToken.deleteMany({ where: { familyId: row.familyId, userId: row.userId } });
  await blacklistJti(row.jti, config.ACCESS_TTL_SEC);
  res.json({ data: { ok: true } });
});
