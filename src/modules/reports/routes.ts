import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { DATE_RE, addDays, dateOnly, dayRange, todayVN, vnDayOf } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize, authorizeAny } from '../../middlewares/auth';
import { paymentToApi } from '../contracts/service';
import { branchFilter } from '../rbac/scope';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const q = z.object({ branch_id: z.string().uuid().optional(), date: z.string().regex(DATE_RE).optional() });
const METHODS = ['cash', 'transfer', 'vietqr', 'ewallet'] as const;
const zeroByMethod = () => ({ cash: 0, transfer: 0, vietqr: 0, ewallet: 0 });

reportsRouter.get('/dashboard', authorize('reports.view'), async (req, res) => {
  const p = q.parse(req.query);
  const bf = branchFilter(req, p.branch_id);
  const day = p.date ?? todayVN();
  const range = dayRange(day);
  const dayStart = dateOnly(day);

  const paidToday = await prisma.payment.groupBy({
    by: ['method'],
    where: { ...bf, status: 'confirmed', confirmedAt: range },
    _sum: { amount: true },
  });
  const byMethod = zeroByMethod();
  for (const g of paidToday) byMethod[g.method] = g._sum.amount ?? 0;

  const from7 = addDays(dayStart, -6);
  const pay7 = await prisma.payment.findMany({
    where: { ...bf, status: 'confirmed', confirmedAt: { gte: dayRange(from7.toISOString().slice(0, 10)).gte, lt: range.lt } },
    select: { amount: true, confirmedAt: true },
  });
  const buckets = new Map<string, number>();
  for (let i = 0; i < 7; i++) buckets.set(addDays(from7, i).toISOString().slice(0, 10), 0);
  for (const x of pay7) {
    const k = vnDayOf(x.confirmedAt!);
    if (buckets.has(k)) buckets.set(k, buckets.get(k)! + x.amount);
  }

  const [newContracts, activeMembers, expiring, allowed, denied, inside, debtRows] = await Promise.all([
    prisma.contract.count({ where: { ...bf, createdAt: range, status: { not: 'cancelled' } } }),
    prisma.member.count({ where: { ...bf, status: 'active' } }),
    prisma.contract.count({ where: { ...bf, status: 'active', endDate: { gte: dayStart, lte: addDays(dayStart, 7) } } }),
    prisma.checkin.count({ where: { ...bf, result: 'allowed', checkedInAt: range } }),
    prisma.checkin.count({ where: { ...bf, result: 'denied', checkedInAt: range } }),
    prisma.checkin.count({ where: { ...bf, result: 'allowed', checkedOutAt: null, checkedInAt: range } }),
    prisma.contract.findMany({
      where: { ...bf, status: { in: ['signed', 'active', 'frozen', 'expired'] } },
      select: { totalAmount: true, paidAmount: true },
    }),
  ]);

  res.json({
    data: {
      revenue_today: METHODS.reduce((s, m) => s + byMethod[m], 0),
      revenue_by_method: byMethod,
      new_contracts_today: newContracts,
      active_members: activeMembers,
      expiring_in_7_days: expiring,
      checkins_today: allowed,
      denied_today: denied,
      inside_now: inside,
      debt_total: debtRows.reduce((s, c) => s + Math.max(0, c.totalAmount - c.paidAmount), 0),
      revenue_7d: [...buckets].map(([date, amount]) => ({ date, amount })),
    },
  });
});

reportsRouter.get('/daily-closing', authorizeAny('reports.view', 'reports.view_revenue'), async (req, res) => {
  const p = q.parse(req.query);
  const where: Prisma.PaymentWhereInput = {
    ...branchFilter(req, p.branch_id),
    status: 'confirmed',
    confirmedAt: dayRange(p.date ?? todayVN()),
  };
  const rows = await prisma.payment.findMany({ where, orderBy: { confirmedAt: 'asc' }, include: { contract: { select: { id: true, code: true, member: { select: { name: true } } } } } });
  const byMethod = zeroByMethod();
  for (const r of rows) byMethod[r.method] += r.amount;
  res.json({
    data: {
      date: p.date ?? todayVN(),
      by_method: byMethod,
      total: rows.reduce((s, r) => s + r.amount, 0),
      transactions_count: rows.length,
      transactions: rows.map(paymentToApi),
    },
  });
});

reportsRouter.get('/today-tasks', authorize('contracts.read'), async (req, res) => {
  const p = q.parse(req.query);
  const bf = branchFilter(req, p.branch_id);
  const today = dateOnly(todayVN());
  const LIMIT = 5;
  const who = { member: { select: { name: true } } } as const;
  const expWhere = { ...bf, status: 'active' as const, endDate: { gte: today, lte: addDays(today, 2) } };
  const refundWhere = { ...bf, status: 'confirmed' as const, refundRequestedAt: { not: null }, refundedAt: null };

  const [draftCount, drafts, unpaidRows, expCount, expiring, refundCount, refunds] = await Promise.all([
    prisma.contract.count({ where: { ...bf, status: 'draft' } }),
    prisma.contract.findMany({ where: { ...bf, status: 'draft' }, orderBy: { createdAt: 'asc' }, take: LIMIT, select: { id: true, code: true, ...who } }),
    prisma.contract.findMany({
      where: { ...bf, status: { in: ['signed', 'active', 'frozen'] } },
      select: { id: true, code: true, totalAmount: true, paidAmount: true, ...who },
    }),
    prisma.contract.count({ where: expWhere }),
    prisma.contract.findMany({
      where: expWhere,
      orderBy: [{ endDate: 'asc' }, { code: 'asc' }],
      take: LIMIT,
      select: { id: true, code: true, endDate: true, ...who },
    }),
    prisma.payment.count({ where: refundWhere }),
    prisma.payment.findMany({
      where: refundWhere,
      orderBy: { refundRequestedAt: 'asc' },
      take: LIMIT,
      select: { id: true, amount: true, contract: { select: { code: true } } },
    }),
  ]);

  const debtors = unpaidRows
    .map((c) => ({ id: c.id, code: c.code, member_name: c.member.name, debt_amount: c.totalAmount - c.paidAmount }))
    .filter((c) => c.debt_amount > 0)
    .sort((a, b) => b.debt_amount - a.debt_amount);

  res.json({
    data: {
      awaiting_signature: { count: draftCount, items: drafts.map((c) => ({ id: c.id, code: c.code, member_name: c.member.name })) },
      unpaid: {
        count: debtors.length,
        total_debt: debtors.reduce((s, c) => s + c.debt_amount, 0),
        items: debtors.slice(0, LIMIT),
      },
      expiring_in_2_days: {
        count: expCount,
        items: expiring.map((c) => ({ id: c.id, code: c.code, member_name: c.member.name, end_date: c.endDate!.toISOString().slice(0, 10) })),
      },
      pending_refunds: { count: refundCount, items: refunds.map((r) => ({ id: r.id, contract_code: r.contract.code, amount: r.amount })) },
    },
  });
});

reportsRouter.get('/checkin-stats', authorize('checkins.read'), async (req, res) => {
  const p = q.parse(req.query);
  const bf = branchFilter(req, p.branch_id);
  const date = p.date ?? todayVN();
  const [branches, rows] = await Promise.all([
    prisma.branch.findMany({ where: bf.branchId ? { id: bf.branchId } : {}, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
    prisma.checkin.findMany({ where: { ...bf, checkedInAt: dayRange(date) }, select: { branchId: true, result: true, checkedInAt: true, checkedOutAt: true } }),
  ]);
  const out = branches.map((branch) => {
    const mine = rows.filter((r) => r.branchId === branch.id);
    const by = new Array<number>(24).fill(0);
    for (const r of mine) if (r.result === 'allowed') by[new Date(r.checkedInAt.getTime() + 7 * 3600 * 1000).getUTCHours()]++;
    return {
      branch,
      checkins_today: mine.filter((r) => r.result === 'allowed').length,
      denied_today: mine.filter((r) => r.result === 'denied').length,
      inside_now: mine.filter((r) => r.result === 'allowed' && !r.checkedOutAt).length,
      by_hour: by.map((count, hour) => ({ hour, count })),
    };
  });
  const sum = (k: 'checkins_today' | 'denied_today' | 'inside_now') => out.reduce((s, b) => s + b[k], 0);
  res.json({
    data: { date, branches: out, totals: { checkins_today: sum('checkins_today'), denied_today: sum('denied_today'), inside_now: sum('inside_now') } },
  });
});
