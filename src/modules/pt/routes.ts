import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Member, Prisma, PtSession, User } from '@prisma/client';
import { audit } from '../../lib/audit';
import { DATE_RE, dateOnly, dayRange, todayVN } from '../../lib/dates';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { addEvent, lockContract, ptEligibility, ptUsable, type Tx } from '../contracts/service';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed, can } from '../rbac/service';
import { classesRouter } from './classes';
import { assertTrainer, lockKey, ownOnly, requireBotKey, syncZaloShifts } from './shared';
import { fmtDM, lastWord, parseShiftMessage } from './zalo-shift';

export const ptBotRouter = Router();
export const ptRouter = Router();

type Row = PtSession & {
  member: Pick<Member, 'id' | 'code' | 'name' | 'phone'> | null;
  trainer: Pick<User, 'id' | 'name'>;
  contract: { code: string; sessionsLeft: number | null } | null;
};

const include = {
  member: { select: { id: true, code: true, name: true, phone: true } },
  trainer: { select: { id: true, name: true } },
  contract: { select: { code: true, sessionsLeft: true } },
} satisfies Prisma.PtSessionInclude;

const toApi = (s: Row) => ({
  id: s.id,
  branch_id: s.branchId,
  trainer: s.trainer,
  member: s.member,
  contract_id: s.contractId,
  contract_code: s.contract?.code ?? null,
  sessions_left: s.contract?.sessionsLeft ?? null,
  start_at: s.startAt.toISOString(),
  end_at: s.endAt.toISOString(),
  status: s.status,
  source: s.source,
  note: s.note,
  completed_at: s.completedAt?.toISOString() ?? null,
});

const PT_1ON_CATEGORIES = ['pt_1on1', 'pt_1on2'];

async function checkPtContract(tx: Tx, memberId: string, contractId: string, branchId: string) {
  const elig = await ptEligibility(memberId);
  if (!elig.member_package.ok) throw conflict('MEMBER_PACKAGE_EXPIRED', 'Member package is no longer valid');
  await lockContract(tx, contractId);
  const c = await tx.contract.findUnique({ where: { id: contractId }, include: { package: { select: { category: true } } } });
  if (!c || c.memberId !== memberId || c.branchId !== branchId) throw notFound('Contract not found');
  if (!['active', 'expired'].includes(c.status) || c.sessionsTotal == null || !PT_1ON_CATEGORIES.includes(c.package.category)) {
    throw badRequest('CONTRACT_INVALID', 'Contract must be a usable PT 1:1 or 1:2 package');
  }
  if (!ptUsable({ status: c.status, endDate: c.endDate, sessionsTotal: c.sessionsTotal, category: c.package.category }, dateOnly(todayVN()))) {
    throw conflict('PT_USAGE_EXPIRED', 'PT package is past its usage deadline');
  }
  const planned = await tx.ptSession.count({ where: { contractId: c.id, status: 'scheduled' } });
  if ((c.sessionsLeft ?? 0) - planned <= 0) throw conflict('NO_SESSIONS', 'No sessions left on this contract');
}

const date = z.string().regex(DATE_RE);
const listSchema = z.object({
  from: date.optional(),
  to: date.optional(),
  trainer_id: z.string().uuid().optional(),
  member_id: z.string().uuid().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  branch_id: z.string().uuid().optional(),
});

ptRouter.use(authenticate);

ptRouter.get('/sessions', authorize('pt_sessions.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.PtSessionWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.from || q.to) where.startAt = { ...(q.from && { gte: dayRange(q.from).gte }), ...(q.to && { lt: dayRange(q.to).lt }) };
  if (q.status) where.status = q.status;
  if (q.member_id) where.memberId = q.member_id;
  where.trainerId = ownOnly(req) ? req.auth!.userId : q.trainer_id;
  const rows = await prisma.ptSession.findMany({ where, include, orderBy: { startAt: 'asc' }, take: 500 });
  res.json({ data: rows.map(toApi) });
});

const offRangeSchema = z.object({ from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE), branch_id: z.string().uuid().optional() });
const offBodySchema = z.object({ trainer_id: z.string().uuid(), date: z.string().regex(DATE_RE), off: z.boolean(), branch_id: z.string().uuid().optional() });

ptRouter.get('/off', authorize('pt_sessions.read'), async (req, res) => {
  const q = offRangeSchema.parse(req.query);
  const rows = await prisma.ptDayOff.findMany({ where: { ...branchFilter(req, q.branch_id), date: { gte: dateOnly(q.from), lte: dateOnly(q.to) } }, orderBy: { date: 'asc' } });
  res.json({ data: rows.map((r) => ({ trainer_id: r.trainerId, branch_id: r.branchId, date: r.date.toISOString().slice(0, 10) })) });
});

ptRouter.put('/off', authorize('pt_sessions.create'), async (req, res) => {
  const b = offBodySchema.parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  await assertTrainer(b.trainer_id, branchId);
  const key = { trainerId: b.trainer_id, branchId, date: dateOnly(b.date) };
  if (b.off) await prisma.ptDayOff.upsert({ where: { trainerId_branchId_date: key }, create: key, update: {} });
  else await prisma.ptDayOff.deleteMany({ where: key });
  await audit(req.auth!.userId, b.off ? 'pt.day_off.set' : 'pt.day_off.clear', { trainer_id: b.trainer_id, date: b.date }, req.ip, b.trainer_id);
  res.json({ data: { trainer_id: b.trainer_id, branch_id: branchId, date: b.date, off: b.off } });
});

ptRouter.get('/trainers', authorize('pt_sessions.read'), async (req, res) => {
  const branchId = z.string().uuid().optional().parse(req.query.branch_id);
  const bf = branchFilter(req, branchId);
  const users = await prisma.user.findMany({
    where: { status: 'active', userRoles: { some: { role: { key: 'trainer' }, ...(bf.branchId && { branchId: bf.branchId }) } } },
    select: { id: true, name: true, userRoles: { where: { role: { key: 'trainer' } }, select: { branch: { select: { id: true, name: true } } } } },
    orderBy: { name: 'asc' },
  });
  res.json({ data: users.map((u) => ({ id: u.id, name: u.name, branches: u.userRoles.flatMap((r) => (r.branch ? [r.branch] : [])) })) });
});

const createSchema = z.object({
  member_id: z.string().uuid().nullish(),
  trainer_id: z.string().uuid(),
  contract_id: z.string().uuid().nullish(),
  start_at: z.string().datetime({ offset: true }),
  duration_min: z.number().int().min(15).max(240).default(60),
  note: z.string().trim().max(500).nullish(),
  branch_id: z.string().uuid().optional(),
});

ptRouter.post('/sessions', authorize('pt_sessions.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  if (b.contract_id && !b.member_id) throw badRequest('MEMBER_REQUIRED', 'contract_id needs member_id');
  const startAt = new Date(b.start_at);
  const endAt = new Date(startAt.getTime() + b.duration_min * 60000);

  if (b.member_id) {
    const member = await prisma.member.findUnique({ where: { id: b.member_id } });
    if (!member || member.branchId !== branchId) throw notFound('Member not found');
  }
  await assertTrainer(b.trainer_id, branchId);

  const created = await prisma.$transaction(async (tx) => {
    await lockKey(tx, 'pt:' + b.trainer_id);
    const busy = (who: Prisma.PtSessionWhereInput) =>
      tx.ptSession.findFirst({ where: { status: { in: ['scheduled', 'completed'] }, startAt: { lt: endAt }, endAt: { gt: startAt }, ...who }, select: { id: true } });
    if (await busy({ trainerId: b.trainer_id })) throw conflict('PT_BUSY', 'Trainer already has a session in this time');
    if (b.member_id && (await busy({ memberId: b.member_id }))) throw conflict('MEMBER_BUSY', 'Member already has a session in this time');
    if (b.member_id && b.contract_id) await checkPtContract(tx, b.member_id, b.contract_id, branchId);
    return tx.ptSession.create({
      data: {
        branchId,
        trainerId: b.trainer_id,
        memberId: b.member_id ?? null,
        contractId: b.contract_id ?? null,
        startAt,
        endAt,
        note: b.note ?? null,
        createdBy: req.auth!.userId,
      },
      include,
    });
  });
  await audit(req.auth!.userId, 'pt_session.created', { after: toApi(created) }, req.ip, created.id);
  res.status(201).json({ data: toApi(created) });
});

async function loadSession(req: Request) {
  const id = z.string().uuid().parse(req.params.id);
  const s = await prisma.ptSession.findUnique({ where: { id }, include });
  if (!s || !branchAllowed(req.access!, s.branchId)) throw notFound('Session not found');
  return s;
}

const assignSchema = z.object({ member_id: z.string().uuid(), contract_id: z.string().uuid().nullish() });

ptRouter.post('/sessions/:id/assign', async (req, res) => {
  const a = req.access!;
  if (!can(a, 'pt_sessions.create') && !can(a, 'pt_sessions.complete')) throw forbidden();
  const s = await loadSession(req);
  if (ownOnly(req) && s.trainerId !== req.auth!.userId) throw forbidden('Not your session');
  const b = assignSchema.parse(req.body);
  const member = await prisma.member.findUnique({ where: { id: b.member_id } });
  if (!member || member.branchId !== s.branchId) throw notFound('Member not found');
  const updated = await prisma.$transaction(async (tx) => {
    await lockKey(tx, 'pt:' + s.trainerId);
    const cur = await tx.ptSession.findUniqueOrThrow({ where: { id: s.id } });
    if (cur.status !== 'scheduled') throw conflict('NOT_SCHEDULED', 'Session is not in scheduled state');
    const clash = await tx.ptSession.findFirst({
      where: { id: { not: s.id }, memberId: b.member_id, status: { in: ['scheduled', 'completed'] }, startAt: { lt: cur.endAt }, endAt: { gt: cur.startAt } },
      select: { id: true },
    });
    if (clash) throw conflict('MEMBER_BUSY', 'Member already has a session in this time');
    if (b.contract_id) await checkPtContract(tx, b.member_id, b.contract_id, s.branchId);
    return tx.ptSession.update({ where: { id: s.id }, data: { memberId: b.member_id, contractId: b.contract_id ?? null }, include });
  });
  await audit(req.auth!.userId, 'pt_session.assigned', { after: toApi(updated) }, req.ip, s.id);
  res.json({ data: toApi(updated) });
});

ptRouter.post('/sessions/:id/complete', authorize('pt_sessions.complete'), async (req, res) => {
  const s = await loadSession(req);
  if (ownOnly(req) && s.trainerId !== req.auth!.userId) throw forbidden('Not your session');
  if (!s.memberId) throw conflict('NO_MEMBER', 'Assign a member before completing the session');
  const elig = await ptEligibility(s.memberId);
  if (s.contractId && !elig.eligible) throw conflict('NOT_ELIGIBLE', 'Member package or PT package is no longer usable');
  const done = await prisma.$transaction(async (tx) => {
    if (s.contractId) await lockContract(tx, s.contractId);
    const flip = await tx.ptSession.updateMany({ where: { id: s.id, status: 'scheduled' }, data: { status: 'completed', completedAt: new Date() } });
    if (flip.count === 0) throw conflict('NOT_SCHEDULED', 'Session is not in scheduled state');
    if (s.contractId) {
      const c = await tx.contract.findUniqueOrThrow({ where: { id: s.contractId } });
      if ((c.sessionsLeft ?? 0) <= 0) throw conflict('NO_SESSIONS', 'No sessions left on this contract');
      await tx.contract.update({ where: { id: c.id }, data: { sessionsLeft: { decrement: 1 } } });
      await addEvent(tx, c.id, 'pt_session_completed', req.auth!.userId, null, { pt_session_id: s.id });
    }
    return tx.ptSession.findUniqueOrThrow({ where: { id: s.id }, include });
  });
  await audit(req.auth!.userId, 'pt_session.completed', { after: toApi(done) }, req.ip, s.id);
  res.json({ data: toApi(done) });
});

async function deduct(tx: Tx, s: PtSession, by: string, type: string) {
  if (!s.contractId) return;
  await lockContract(tx, s.contractId);
  const c = await tx.contract.findUniqueOrThrow({ where: { id: s.contractId } });
  if ((c.sessionsLeft ?? 0) <= 0) throw conflict('NO_SESSIONS', 'No sessions left on this contract');
  await tx.contract.update({ where: { id: c.id }, data: { sessionsLeft: { decrement: 1 } } });
  await addEvent(tx, c.id, type, by, null, { pt_session_id: s.id });
}

ptRouter.post('/sessions/:id/no-show', async (req, res) => {
  const a = req.access!;
  if (!can(a, 'pt_sessions.complete') && !can(a, 'pt_sessions.cancel')) throw forbidden();
  const s = await loadSession(req);
  if (ownOnly(req) && s.trainerId !== req.auth!.userId) throw forbidden('Not your session');
  if (!s.memberId) throw conflict('NO_MEMBER', 'Session has no member');
  const out = await prisma.$transaction(async (tx) => {
    const flip = await tx.ptSession.updateMany({ where: { id: s.id, status: 'scheduled' }, data: { status: 'no_show' } });
    if (flip.count === 0) throw conflict('NOT_SCHEDULED', 'Session is not in scheduled state');
    await deduct(tx, s, req.auth!.userId, 'pt_session_no_show');
    return tx.ptSession.findUniqueOrThrow({ where: { id: s.id }, include });
  });
  await audit(req.auth!.userId, 'pt_session.no_show', { before: toApi(s), after: toApi(out) }, req.ip, s.id);
  res.json({ data: toApi(out) });
});

const updateSchema = z.object({
  start_at: z.string().datetime({ offset: true }).optional(),
  duration_min: z.number().int().min(15).max(240).optional(),
  trainer_id: z.string().uuid().optional(),
  contract_id: z.string().uuid().nullable().optional(),
});

ptRouter.patch('/sessions/:id', authorize('pt_sessions.create'), async (req, res) => {
  const s = await loadSession(req);
  const b = updateSchema.parse(req.body);
  const trainerId = b.trainer_id ?? s.trainerId;
  const startAt = b.start_at ? new Date(b.start_at) : s.startAt;
  const endAt = new Date(startAt.getTime() + (b.duration_min ?? Math.round((s.endAt.getTime() - s.startAt.getTime()) / 60000)) * 60000);
  const contractId = b.contract_id === undefined ? s.contractId : b.contract_id;
  if (contractId && !s.memberId) throw badRequest('MEMBER_REQUIRED', 'contract_id needs a member');
  if (trainerId !== s.trainerId) await assertTrainer(trainerId, s.branchId);
  const out = await prisma.$transaction(async (tx) => {
    await lockKey(tx, 'pt:' + trainerId);
    const cur = await tx.ptSession.findUniqueOrThrow({ where: { id: s.id } });
    if (cur.status !== 'scheduled') throw conflict('NOT_SCHEDULED', 'Session is not in scheduled state');
    const busy = (who: Prisma.PtSessionWhereInput) =>
      tx.ptSession.findFirst({ where: { id: { not: s.id }, status: { in: ['scheduled', 'completed'] }, startAt: { lt: endAt }, endAt: { gt: startAt }, ...who }, select: { id: true } });
    if (await busy({ trainerId })) throw conflict('PT_BUSY', 'Trainer already has a session in this time');
    if (s.memberId && (await busy({ memberId: s.memberId }))) throw conflict('MEMBER_BUSY', 'Member already has a session in this time');
    if (s.memberId && contractId && contractId !== s.contractId) await checkPtContract(tx, s.memberId, contractId, s.branchId);
    return tx.ptSession.update({ where: { id: s.id }, data: { trainerId, startAt, endAt, contractId }, include });
  });
  await audit(req.auth!.userId, 'pt_session.updated', { before: toApi(s), after: toApi(out) }, req.ip, s.id);
  res.json({ data: toApi(out) });
});

const FREE_CANCEL_MIN = 90;
const CANCEL_OVERRIDE_ROLES = ['super_admin', 'owner', 'branch_manager'];
const cancelSchema = z.object({ cancel_free: z.boolean().optional() }).default({});

ptRouter.post('/sessions/:id/cancel', authorize('pt_sessions.cancel'), async (req, res) => {
  const s = await loadSession(req);
  const b = cancelSchema.parse(req.body ?? {});
  if (b.cancel_free && !req.access!.roles.some((r) => CANCEL_OVERRIDE_ROLES.includes(r))) throw forbidden('Only owner or manager can cancel for free');
  const late = !b.cancel_free && !!s.memberId && s.startAt.getTime() - Date.now() < FREE_CANCEL_MIN * 60000;
  const out = await prisma.$transaction(async (tx) => {
    const flip = await tx.ptSession.updateMany({ where: { id: s.id, status: 'scheduled' }, data: { status: late ? 'no_show' : 'cancelled' } });
    if (flip.count === 0) throw conflict('NOT_SCHEDULED', 'Session is not in scheduled state');
    if (late) await deduct(tx, s, req.auth!.userId, 'pt_session_late_cancel');
    return tx.ptSession.findUniqueOrThrow({ where: { id: s.id }, include });
  });
  await audit(req.auth!.userId, late ? 'pt_session.late_cancelled' : 'pt_session.cancelled', { before: toApi(s), after: toApi(out) }, req.ip, s.id);
  res.json({ data: toApi(out) });
});

ptRouter.use('/classes', classesRouter);

const botSchema = z.object({
  branch_id: z.string().uuid(),
  trainer_id: z.string().uuid(),
  date,
  hours: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(24),
});

ptBotRouter.post('/shifts', async (req, res) => {
  requireBotKey(req);
  const b = botSchema.parse(req.body);
  await assertTrainer(b.trainer_id, b.branch_id);
  res.json({ data: await syncZaloShifts(b.branch_id, b.trainer_id, b.date, b.hours) });
});

const messageSchema = z.object({
  branch_id: z.string().uuid(),
  text: z.string().min(1).max(4000),
  sent_at: z.string().datetime({ offset: true }).optional(),
});

ptBotRouter.post('/message', async (req, res) => {
  requireBotKey(req);
  const b = messageSchema.parse(req.body);
  const sentAt = b.sent_at ? new Date(b.sent_at) : new Date();
  const parsed = parseShiftMessage(b.text, sentAt);
  if (!parsed) {
    res.json({ data: { handled: false, reply: null } });
    return;
  }
  const today = todayVN(new Date());
  if (parsed.date < today) {
    res.json({ data: { handled: true, date: parsed.date, reply: `Bỏ qua ca ngày ${fmtDM(parsed.date)} vì đã qua.`, results: [], errors: [] } });
    return;
  }
  const trainers = await prisma.user.findMany({
    where: { status: 'active', userRoles: { some: { role: { key: 'trainer' }, OR: [{ branchId: b.branch_id }, { branchId: null }] } } },
    select: { id: true, name: true },
  });
  const results: { trainer: string; added: number; removed: number; reopened: number; off: boolean }[] = [];
  const errors: string[] = [];
  const reported = new Set<string>();
  for (const entry of parsed.entries) {
    const found = trainers.filter((t) => lastWord(t.name) === lastWord(entry.name));
    if (found.length === 0) {
      errors.push(`Chưa có PT "${entry.name}" trong GymHub.`);
      continue;
    }
    if (found.length > 1) {
      errors.push(`Có nhiều PT trùng tên "${entry.name}".`);
      continue;
    }
    const t = found[0];
    const r = await syncZaloShifts(b.branch_id, t.id, parsed.date, entry.off ? [] : entry.hours);
    const offKey = { trainerId: t.id, branchId: b.branch_id, date: dateOnly(parsed.date) };
    if (entry.off) await prisma.ptDayOff.upsert({ where: { trainerId_branchId_date: offKey }, create: offKey, update: {} });
    else await prisma.ptDayOff.deleteMany({ where: offKey });
    reported.add(t.id);
    results.push({ trainer: t.name, off: entry.off, ...r });
  }
  const day = dayRange(parsed.date);
  const withShifts = await prisma.ptSession.findMany({
    where: { branchId: b.branch_id, startAt: { gte: day.gte, lt: day.lt }, status: { not: 'cancelled' } },
    select: { trainerId: true },
    distinct: ['trainerId'],
  });
  const have = new Set([...reported, ...withShifts.map((s) => s.trainerId)]);
  const missing = trainers.filter((t) => !have.has(t.id)).map((t) => t.name);
  const head = `Đã ghi nhận ca ngày ${fmtDM(parsed.date)}`;
  const tail = missing.length ? `Còn thiếu: ${missing.join(', ')}.` : `Đã đủ cho ${trainers.length} PT.`;
  const reply = [results.length ? `${head}. ${tail}` : null, ...errors].filter(Boolean).join('\n') || null;
  res.json({ data: { handled: true, date: parsed.date, reply, results, errors, missing } });
});
