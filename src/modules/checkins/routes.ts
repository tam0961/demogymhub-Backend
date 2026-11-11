import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Checkin, Contract, Member, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { DATE_RE, dateOnly, dayRange, todayVN } from '../../lib/dates';
import { notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize, authorizeAny } from '../../middlewares/auth';
import { contractToApi, lockContract } from '../contracts/service';
import { branchFilter } from '../rbac/scope';
import { denyViewOnly, requireBranchStaff } from './guard';

export const checkinsRouter = Router();
checkinsRouter.use(authenticate);

const uuid = z.string().uuid();

const memberRef = z
  .object({ member_id: uuid.optional(), member_code: z.string().trim().min(1).max(64).optional() })
  .refine((v) => v.member_id || v.member_code, 'member_id or member_code required');

const memberApi = (m: Member) => ({ id: m.id, code: m.code, name: m.name, phone: m.phone, status: m.status, branch_id: m.branchId });

const checkinApi = (c: Checkin & { member?: Member }) => ({
  id: c.id,
  member_id: c.memberId,
  ...(c.member && { member: { id: c.member.id, code: c.member.code, name: c.member.name } }),
  contract_id: c.contractId,
  branch_id: c.branchId,
  result: c.result,
  reason: c.reason,
  checked_in_at: c.checkedInAt,
  checked_out_at: c.checkedOutAt,
  override_by: c.overrideBy,
  deducted: c.deducted,
});

const branchInfo = (id: string) => prisma.branch.findUniqueOrThrow({ where: { id }, select: { id: true, code: true, name: true } });

async function findMember(req: Request, b: z.infer<typeof memberRef>) {
  const m = await prisma.member.findFirst({ where: b.member_id ? { id: b.member_id } : { code: b.member_code } });
  if (!m) throw notFound('Member not found');
  return m;
}

type Outcome = { result: 'allowed' | 'denied'; reason: string | null; contract: Contract | null; checkinId: string };

async function logDenied(req: Request, m: Member, branchId: string, reason: string, contract: Contract | null): Promise<Outcome> {
  const c = await prisma.checkin.create({
    data: { memberId: m.id, contractId: contract?.id ?? null, branchId, result: 'denied', reason, createdBy: req.auth!.userId },
  });
  await audit(req.auth!.userId, 'checkin.denied', { member_id: m.id, reason, checkin_id: c.id }, req.ip, c.id);
  return { result: 'denied', reason, contract, checkinId: c.id };
}

async function evaluate(req: Request, m: Member, branchId: string): Promise<Outcome> {
  const userId = req.auth!.userId;
  if (m.branchId !== branchId) return logDenied(req, m, branchId, 'WRONG_BRANCH', null);
  const today = dateOnly(todayVN());

  const inside = await prisma.checkin.findFirst({
    where: { memberId: m.id, result: 'allowed', checkedOutAt: null, checkedInAt: { gte: dayRange(todayVN()).gte } },
    orderBy: { checkedInAt: 'desc' },
    include: { contract: true },
  });
  if (inside) return { result: 'allowed', reason: null, contract: inside.contract, checkinId: inside.id };

  const contracts = await prisma.contract.findMany({
    where: { memberId: m.id, branchId: m.branchId, status: { in: ['active', 'frozen', 'expired'] } },
    orderBy: [{ endDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
  });
  const deductedToday = new Set(
    (await prisma.checkin.findMany({ where: { memberId: m.id, deductedDay: today }, select: { contractId: true } })).map((c) => c.contractId),
  );
  let noSessions: Contract | null = null;
  let frozen: Contract | null = null;
  let expired: Contract | null = null;
  for (const c of contracts) {
    if (c.status === 'frozen') frozen ??= c;
    else if (c.status === 'expired' || (c.endDate && c.endDate < today)) expired ??= c;
    else if (c.startDate && c.startDate > today) continue;
    else if (c.sessionsTotal != null && (c.sessionsLeft ?? 0) <= 0 && !deductedToday.has(c.id)) noSessions ??= c;
    else {
      const res = await prisma.$transaction(async (tx) => {
        await lockContract(tx, c.id);
        const f = await tx.contract.findUniqueOrThrow({ where: { id: c.id } });
        if (f.status !== 'active') return null;
        let deduct = false;
        if (f.sessionsTotal != null) {
          const already = await tx.checkin.count({ where: { contractId: f.id, deductedDay: today } });
          if (!already) {
            if ((f.sessionsLeft ?? 0) <= 0) return 'NO_SESSIONS' as const;
            deduct = true;
          }
        }
        const updated = deduct
          ? await tx.contract.update({ where: { id: f.id }, data: { sessionsLeft: { decrement: 1 } } })
          : f;
        const ci = await tx.checkin.create({
          data: {
            memberId: m.id,
            contractId: f.id,
            branchId: m.branchId,
            result: 'allowed',
            deducted: deduct,
            deductedDay: deduct ? today : null,
            createdBy: userId,
          },
        });
        return { contract: updated, id: ci.id };
      });
      if (res === 'NO_SESSIONS') noSessions ??= c;
      else if (res) return { result: 'allowed', reason: null, contract: res.contract, checkinId: res.id };
    }
  }
  if (frozen) return logDenied(req, m, m.branchId, 'FROZEN', frozen);
  if (noSessions) return logDenied(req, m, m.branchId, 'NO_SESSIONS', noSessions);
  if (expired) return logDenied(req, m, m.branchId, 'EXPIRED', expired);
  return logDenied(req, m, m.branchId, 'NO_ACTIVE_CONTRACT', null);
}

const respond = (m: Member, o: Outcome, branch: { id: string; code: string; name: string }) => ({
  data: {
    result: o.result,
    reason: o.reason,
    member: memberApi(m),
    contract: o.contract ? contractToApi(o.contract) : null,
    checkin_id: o.checkinId,
    branch,
  },
});

checkinsRouter.post('/', denyViewOnly, authorize('checkins.create'), async (req, res) => {
  const branchId = requireBranchStaff(req);
  const branch = await branchInfo(branchId);
  const b = memberRef.and(z.object({ direction: z.enum(['in', 'out']).default('in') })).parse(req.body);
  const m = await findMember(req, b);
  if (b.direction === 'out') {
    const open = await prisma.checkin.findFirst({
      where: { memberId: m.id, result: 'allowed', checkedOutAt: null },
      orderBy: { checkedInAt: 'desc' },
      include: { contract: true },
    });
    if (!open || open.branchId !== branchId) {
      return res.json({ data: { result: 'denied', reason: 'NOT_CHECKED_IN', member: memberApi(m), contract: null, checkin_id: null, branch } });
    }
    await prisma.checkin.updateMany({ where: { id: open.id, checkedOutAt: null }, data: { checkedOutAt: new Date() } });
    return res.json(respond(m, { result: 'allowed', reason: null, contract: open.contract, checkinId: open.id }, branch));
  }
  res.json(respond(m, await evaluate(req, m, branchId), branch));
});

checkinsRouter.post(
  '/override',
  denyViewOnly,
  authorizeAny('checkins.override', 'contracts.override_checkin'),
  async (req, res) => {
    const branchId = requireBranchStaff(req);
    const b = z.object({ member_id: uuid, reason: z.string().trim().min(3).max(500) }).parse(req.body);
    const m = await prisma.member.findUnique({ where: { id: b.member_id } });
    if (!m || m.branchId !== branchId) throw notFound('Member not found');
    const userId = req.auth!.userId;
    const contract = await prisma.contract.findFirst({ where: { memberId: m.id, branchId: m.branchId }, orderBy: { createdAt: 'desc' } });
    const c = await prisma.checkin.create({
      data: { memberId: m.id, contractId: contract?.id ?? null, branchId: m.branchId, result: 'allowed', reason: b.reason, overrideBy: userId, createdBy: userId },
    });
    await audit(userId, 'checkin.override', { member_id: m.id, checkin_id: c.id, reason: b.reason }, req.ip, c.id);
    res.json(respond(m, { result: 'allowed', reason: b.reason, contract, checkinId: c.id }, await branchInfo(branchId)));
  },
);

checkinsRouter.post('/:id/checkout', denyViewOnly, authorize('checkins.create'), async (req, res) => {
  const branchId = requireBranchStaff(req);
  const id = uuid.parse(req.params.id);
  const c = await prisma.checkin.findUnique({ where: { id }, include: { member: true } });
  if (!c || c.branchId !== branchId) throw notFound('Check-in not found');
  if (c.result !== 'allowed') throw notFound('Check-in not found');
  await prisma.checkin.updateMany({ where: { id, checkedOutAt: null }, data: { checkedOutAt: new Date() } });
  const fresh = await prisma.checkin.findUniqueOrThrow({ where: { id }, include: { member: true } });
  res.json({ data: checkinApi(fresh) });
});

checkinsRouter.get('/live', authorize('checkins.read'), async (req, res) => {
  const where: Prisma.CheckinWhereInput = {
    ...branchFilter(req),
    result: 'allowed',
    checkedOutAt: null,
    checkedInAt: { gte: dayRange(todayVN()).gte },
  };
  const rows = await prisma.checkin.findMany({ where, include: { member: true }, orderBy: { checkedInAt: 'desc' }, take: 500 });
  res.json({ data: { count: rows.length, items: rows.map(checkinApi) } });
});

const listSchema = z.object({
  date: z.string().regex(DATE_RE).optional(),
  result: z.enum(['allowed', 'denied']).optional(),
  branch_id: uuid.optional(),
  member_id: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

checkinsRouter.get('/', authorize('checkins.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.CheckinWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.date) where.checkedInAt = dayRange(q.date);
  if (q.result) where.result = q.result;
  if (q.member_id) where.memberId = q.member_id;
  const [total, rows] = await Promise.all([
    prisma.checkin.count({ where }),
    prisma.checkin.findMany({ where, include: { member: true }, orderBy: { checkedInAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  res.json({ data: rows.map(checkinApi), meta: { page: q.page, limit: q.limit, total } });
});
