import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { dayRange, vnDayOf } from '../../lib/dates';
import { conflict, HttpError, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hit, redis } from '../../lib/redis';
import { ptEligibility } from '../contracts/service';
import { enqueueSheetWrites } from '../sheetsync/write';
import { lockAt, registerInTx } from './classes';
import { normalizePhone } from './sheet-import';

export const publicRouter = Router();

const MAX_PICK = 5;
const VN_MS = 7 * 3600 * 1000;
const hm = (d: Date) => new Date(d.getTime() + VN_MS).toISOString().slice(11, 16);

/** Monday..Sunday of the visible week: the current week, and the next one from 01:00 Saturday. */
export function visibleWeek(now = new Date()) {
  const vn = new Date(now.getTime() + VN_MS);
  const dow = vn.getUTCDay();
  const back = (dow + 6) % 7;
  let monday = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() - back, 12));
  if (dow === 0 || (dow === 6 && vn.getUTCHours() >= 1)) monday = new Date(monday.getTime() + 7 * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

const maskEmail = (e: string | null) => {
  if (!e) return null;
  const [name, domain] = e.split('@');
  return domain ? `${name.slice(0, 2)}***@${domain}` : null;
};

publicRouter.get('/classes', async (req, res) => {
  const code = z.string().min(1).max(20).parse(req.query.branch);
  const branch = await prisma.branch.findUnique({ where: { code } });
  if (!branch) throw notFound('Branch not found');
  const now = new Date();
  const week = visibleWeek(now);
  const rows = await prisma.groupClass.findMany({
    where: { branchId: branch.id, status: 'scheduled', startAt: { gte: dayRange(week.from).gte, lt: dayRange(week.to).lt } },
    include: { registrations: { where: { status: { in: ['booked', 'attended', 'absent'] } }, select: { id: true } } },
    orderBy: { startAt: 'asc' },
  });
  const sessions = rows
    .filter((c) => c.startAt > now && lockAt(c.startAt) > now)
    .map((c) => ({
      id: c.id,
      date: vnDayOf(c.startAt),
      start: hm(c.startAt),
      end: hm(c.endAt),
      muscle_group: c.muscleGroup,
      capacity: c.capacity,
      left: Math.max(0, c.capacity - c.registrations.length),
    }));
  res.json({ data: { branch: { code: branch.code, name: branch.name }, sessions, max_pick: MAX_PICK, week, now: now.toISOString() } });
});

publicRouter.get('/member', async (req, res) => {
  const lookups = await hit('pub:lookup', 60);
  if (lookups.count > 90) throw new HttpError(429, 'RATE', 'Too many lookups, try again shortly');
  const phone = normalizePhone(z.string().min(6).max(20).parse(req.query.phone));
  const m = await prisma.member.findUnique({ where: { phone }, select: { name: true, email: true } });
  res.json({ data: m ? { found: true, name: m.name, email: maskEmail(m.email) } : { found: false } });
});

const bookSchema = z.object({
  phone: z.string().min(6).max(20),
  class_ids: z.array(z.string().uuid()).min(1).max(MAX_PICK * 2),
  website: z.string().max(200).optional(),
});

class BookFailed extends Error {
  constructor(public failed: { class_id: string; reason: string }[]) {
    super('BOOK_FAILED');
  }
}

const REASON: Record<string, string> = {
  CLASS_FULL: 'full',
  CLASS_LOCKED: 'closed',
  CLASS_STARTED: 'closed',
  CLASS_CLOSED: 'closed',
  ALREADY_REGISTERED: 'duplicate',
  NO_SESSIONS: 'no_sessions',
};

publicRouter.post('/book', async (req, res) => {
  const b = bookSchema.parse(req.body);
  if (b.website) {
    res.json({ data: { booked: [] } });
    return;
  }
  const ids = [...new Set(b.class_ids)];
  if (ids.length > MAX_PICK) throw new HttpError(400, 'TOO_MANY', `Choose at most ${MAX_PICK} sessions`);
  const phone = normalizePhone(b.phone);
  if ((await hit(`pub:book:${phone}`, 600)).count > 4) throw new HttpError(429, 'RATE', 'Too many attempts, try again in a few minutes');
  const dupKey = `pub:dup:${phone}:${crypto.createHash('sha1').update([...ids].sort().join(',')).digest('hex')}`;
  if ((await redis.set(dupKey, '1', 'EX', 120, 'NX')) === null) throw new HttpError(409, 'DUPLICATE', 'This booking was just submitted');

  const member = await prisma.member.findUnique({ where: { phone } });
  if (!member) throw new HttpError(404, 'NO_MEMBER', 'Phone number is not a member');
  const elig = await ptEligibility(member.id);
  if (!elig.member_package.ok) throw conflict('MEMBER_PACKAGE_EXPIRED', 'Member package is no longer valid');

  const lockCheck = (startAt: Date) => {
    if (new Date() >= lockAt(startAt)) throw conflict('CLASS_LOCKED', 'Registration is locked from 21:00 the day before the class');
  };
  try {
    const booked = await prisma.$transaction(async (tx) => {
      const failed: { class_id: string; reason: string }[] = [];
      const done: { reg_id: string; class_id: string; start_at: Date; end_at: Date; muscle_group: string | null }[] = [];
      for (const id of ids) {
        try {
          const reg = await registerInTx(tx, { classId: id, member, createdBy: null, source: 'web', lockCheck });
          done.push({ reg_id: reg.id, class_id: id, start_at: reg.class.startAt, end_at: reg.class.endAt, muscle_group: reg.class.muscleGroup });
        } catch (e) {
          if (e instanceof HttpError) failed.push({ class_id: id, reason: REASON[e.code] ?? 'error' });
          else throw e;
        }
      }
      if (failed.length) throw new BookFailed(failed);
      return done;
    });
    void enqueueSheetWrites(booked.map((c) => c.reg_id));
    res.status(201).json({
      data: { name: member.name, booked: booked.map((c) => ({ class_id: c.class_id, date: vnDayOf(c.start_at), start: hm(c.start_at), end: hm(c.end_at), muscle_group: c.muscle_group })) },
    });
  } catch (e) {
    await redis.del(dupKey);
    if (e instanceof BookFailed) throw new HttpError(409, 'CONFLICT', 'Some sessions are no longer available', { failed: e.failed });
    throw e;
  }
});
