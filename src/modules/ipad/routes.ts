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
  stage: 'idle' | 'pay' | 'paid' | 'sign' | 'signed';
  payload: Record<string, unknown> | null;
  signature: string | null;
  paired?: boolean;
  code?: string;
}

async function load(token: string): Promise<Session> {
  if (!TOKEN_RE.test(token)) throw notFound('Session not found');
  const raw = await redis.get(key(token));
  if (!raw) throw notFound('Session not found');
  return JSON.parse(raw) as Session;
}

const PAIRED_TTL_SEC = 30 * 24 * 3600;
const CODE_TTL_SEC = 15 * 60;
const codeKey = (code: string) => `ipad:code:${code}`;
const branchKey = (branchId: string) => `ipad:branch:${branchId}`;

const save = (token: string, s: Session) => redis.set(key(token), JSON.stringify(s), 'EX', s.paired ? PAIRED_TTL_SEC : TTL_SEC);

async function newCode(token: string): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if ((await redis.set(codeKey(code), token, 'EX', CODE_TTL_SEC, 'NX')) === 'OK') return code;
  }
  throw new HttpError(503, 'CODE_UNAVAILABLE', 'Could not allocate pairing code');
}

ipadRouter.use(authenticate);

ipadRouter.post('/sessions', authorize('contracts.create'), async (_req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  await save(token, { stage: 'idle', payload: null, signature: null });
  res.status(201).json({ data: { token } });
});

const stageSchema = z.object({
  stage: z.enum(['idle', 'pay', 'paid', 'sign']),
  payload: z.record(z.string(), z.unknown()).nullish(),
});

ipadRouter.put('/sessions/:token', authorize('contracts.create'), async (req, res) => {
  const token = String(req.params.token);
  const cur = await load(token);
  const b = stageSchema.parse(req.body);
  const payload = b.payload ?? null;
  if (payload && JSON.stringify(payload).length > 20000) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
  await save(token, { stage: b.stage, payload, signature: null, paired: cur.paired, code: cur.code });
  res.json({ data: { stage: b.stage } });
});

ipadRouter.get('/sessions/:token', authorize('contracts.create'), async (req, res) => {
  const s = await load(String(req.params.token));
  res.json({ data: { stage: s.stage, signature: s.signature } });
});

const pairSchema = z.object({ code: z.string().regex(/^\d{6}$/), branch_id: z.string().uuid() });

ipadRouter.post('/pair', authorize('contracts.create'), async (req, res) => {
  const b = pairSchema.parse(req.body);
  const token = await redis.get(codeKey(b.code));
  if (!token) throw new HttpError(404, 'CODE_NOT_FOUND', 'Mã không đúng hoặc đã hết hạn');
  const s = await load(token);
  await redis.del(codeKey(b.code));
  await save(token, { ...s, paired: true, code: undefined });
  await redis.set(branchKey(b.branch_id), token, 'EX', PAIRED_TTL_SEC);
  res.json({ data: { token } });
});

ipadRouter.get('/branch', authorize('contracts.create'), async (req, res) => {
  const branchId = z.string().uuid().parse(req.query.branch_id);
  const token = await redis.get(branchKey(branchId));
  if (!token || !(await redis.exists(key(token)))) return res.json({ data: { token: null } });
  res.json({ data: { token } });
});

ipadRouter.delete('/branch', authorize('contracts.create'), async (req, res) => {
  const branchId = z.string().uuid().parse(req.query.branch_id);
  await redis.del(branchKey(branchId));
  res.json({ data: { ok: true } });
});

ipadPublicRouter.use(async (req, _res, next) => {
  const { count } = await hit(`ipad:rl:${req.ip}`, 60);
  if (count > 240) return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests'));
  next();
});

ipadPublicRouter.post('/pair', async (_req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  const code = await newCode(token);
  await save(token, { stage: 'idle', payload: null, signature: null, code });
  res.status(201).json({ data: { token, code } });
});

ipadPublicRouter.get('/:token', async (req, res) => {
  const token = String(req.params.token);
  const s = await load(token);
  let code = s.code ?? null;
  if (!s.paired) {
    if (!code || !(await redis.exists(codeKey(code)))) {
      code = await newCode(token);
      await save(token, { ...s, code });
    }
  } else if (s.paired) {
    await redis.expire(key(token), PAIRED_TTL_SEC);
  }
  res.json({ data: { stage: s.stage, payload: s.payload, paired: !!s.paired, code: s.paired ? null : code } });
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
