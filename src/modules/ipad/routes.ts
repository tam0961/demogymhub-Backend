import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { HttpError, notFound } from '../../lib/errors';
import { hit, redis } from '../../lib/redis';
import { authenticate, authorize } from '../../middlewares/auth';

export const ipadRouter = Router();
export const ipadPublicRouter = Router();

const TTL_SEC = 2 * 3600;
const key = (token: string) => `ipad:${token}`;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

interface Session {
  stage: 'idle' | 'pay' | 'sign' | 'signed';
  payload: Record<string, unknown> | null;
  signature: string | null;
}

async function load(token: string): Promise<Session> {
  if (!TOKEN_RE.test(token)) throw notFound('Session not found');
  const raw = await redis.get(key(token));
  if (!raw) throw notFound('Session not found');
  return JSON.parse(raw) as Session;
}

const save = (token: string, s: Session) => redis.set(key(token), JSON.stringify(s), 'EX', TTL_SEC);

ipadRouter.use(authenticate);

ipadRouter.post('/sessions', authorize('contracts.create'), async (_req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  await save(token, { stage: 'idle', payload: null, signature: null });
  res.status(201).json({ data: { token } });
});

const stageSchema = z.object({
  stage: z.enum(['idle', 'pay', 'sign']),
  payload: z.record(z.string(), z.unknown()).nullish(),
});

ipadRouter.put('/sessions/:token', authorize('contracts.create'), async (req, res) => {
  const token = String(req.params.token);
  await load(token);
  const b = stageSchema.parse(req.body);
  const payload = b.payload ?? null;
  if (payload && JSON.stringify(payload).length > 20000) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
  await save(token, { stage: b.stage, payload, signature: null });
  res.json({ data: { stage: b.stage } });
});

ipadRouter.get('/sessions/:token', authorize('contracts.create'), async (req, res) => {
  const s = await load(String(req.params.token));
  res.json({ data: { stage: s.stage, signature: s.signature } });
});

ipadPublicRouter.use(async (req, _res, next) => {
  const { count } = await hit(`ipad:rl:${req.ip}`, 60);
  if (count > 240) return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests'));
  next();
});

ipadPublicRouter.get('/:token', async (req, res) => {
  const s = await load(String(req.params.token));
  res.json({ data: { stage: s.stage, payload: s.payload } });
});

const signSchema = z.object({ signature: z.string().startsWith('data:image/png;base64,').max(400000) });

ipadPublicRouter.post('/:token/sign', async (req, res) => {
  const token = String(req.params.token);
  const s = await load(token);
  if (s.stage !== 'sign') throw new HttpError(409, 'NOT_SIGNING', 'Nothing to sign right now');
  const b = signSchema.parse(req.body);
  await save(token, { ...s, stage: 'signed', signature: b.signature });
  res.json({ data: { stage: 'signed' } });
});
