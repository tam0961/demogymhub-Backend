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
const METHODS = ['cash', 'transfer', 'vietqr', 'ewallet', 'card'] as const;
const zeroByMethod = () => ({ cash: 0, transfer: 0, vietqr: 0, ewallet: 0, card: 0 });

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

  const paidKinds = await prisma.payment.findMany({
    where: { ...bf, status: 'confirmed', confirmedAt: range },
    select: { amount: true, contract: { select: { package: { select: { category: true, displayGroup: true } } } } },
  });
  const byKind: Record<string, number> = { member: 0, pt_1on1: 0, pt_1on2: 0, pt_group: 0, retail: 0 };
  for (const x of paidKinds) {
    const pk = x.contract?.package;
    const kind = !pk ? 'retail' : pk.displayGroup === 'pt_group' ? 'pt_group' : pk.category;
    byKind[kind] = (byKind[kind] ?? 0) + x.amount;
  }

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
    prisma.contract.count({ where: { ...bf, status: 'active', package: { category: 'member' }, endDate: { gte: dayStart, lte: addDays(dayStart, 7) } } }),
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
      revenue_by_kind: byKind,
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
  const expWhere = { ...bf, status: 'active' as const, package: { category: 'member' as const }, endDate: { gte: today, lte: addDays(today, 2) } };
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
      pending_refunds: { count: refundCount, items: refunds.map((r) => ({ id: r.id, contract_code: r.contract?.code ?? '', amount: r.amount })) },
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

const expiringQ = z.object({ days: z.enum(['7', '14', '30']).default('7'), branch_id: z.string().uuid().optional() });

reportsRouter.get('/expiring', authorize('reports.view'), async (req, res) => {
  const p = expiringQ.parse(req.query);
  const days = Number(p.days);
  const today = dateOnly(todayVN());
  const rows = await prisma.contract.findMany({
    where: { ...branchFilter(req, p.branch_id), status: 'active', package: { category: 'member' }, endDate: { gte: today, lte: addDays(today, days) } },
    orderBy: { endDate: 'asc' },
    select: {
      endDate: true,
      packageName: true,
      package: { select: { name: true } },
      member: { select: { id: true, name: true, phone: true, code: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
  });
  const renewed = new Set(
    (
      await prisma.contract.findMany({
        where: { memberId: { in: rows.map((c) => c.member.id) }, status: { in: ['active', 'signed'] }, package: { category: 'member' }, endDate: { gt: addDays(today, days) } },
        select: { memberId: true },
      })
    ).map((c) => c.memberId),
  );
  const seen = new Set<string>(renewed);
  const data = [];
  for (const c of rows) {
    if (seen.has(c.member.id)) continue;
    seen.add(c.member.id);
    data.push({
      member_id: c.member.id,
      member_code: c.member.code,
      name: c.member.name,
      phone: c.member.phone,
      package_name: c.packageName ?? c.package.name,
      end_date: c.endDate!.toISOString().slice(0, 10),
      days_left: Math.round((c.endDate!.getTime() - today.getTime()) / 86400000),
      branch: c.branch,
    });
  }
  res.json({ data, meta: { days, total: data.length } });
});

const servicesQ = z.object({ branch_id: z.string().uuid().optional(), days: z.coerce.number().int().refine((d) => [7, 30, 90, 365].includes(d)).default(30) });

reportsRouter.get('/revenue-services', authorize('reports.view'), async (req, res) => {
  const p = servicesQ.parse(req.query);
  const bf = branchFilter(req, p.branch_id);
  const today = dateOnly(todayVN());
  const from = dayRange(addDays(today, -(p.days - 1)).toISOString().slice(0, 10)).gte;
  const to = dayRange(today.toISOString().slice(0, 10)).lt;
  const include = { contract: { select: { id: true, packageName: true, package: { select: { id: true, name: true, category: true } } } } } as const;
  const [paid, refunded] = await Promise.all([
    prisma.payment.findMany({ where: { ...bf, status: { in: ['confirmed', 'refunded'] }, confirmedAt: { gte: from, lt: to } }, select: { amount: true, contract: include.contract } }),
    prisma.payment.findMany({ where: { ...bf, status: 'refunded', refundedAt: { gte: from, lt: to } }, select: { amount: true, contract: include.contract } }),
  ]);
  const rows = new Map<string, { name: string; group: 'gym' | 'pt'; revenue: number; contracts: Set<string> }>();
  const add = (x: { amount: number; contract: { id: string; packageName: string | null; package: { id: string; name: string; category: string } } | null }, sign: 1 | -1) => {
    const key = x.contract ? x.contract.package.id : 'retail';
    const r = rows.get(key) ?? (x.contract ? { name: x.contract.packageName ?? x.contract.package.name, group: x.contract.package.category === 'member' ? 'gym' : 'pt', revenue: 0, contracts: new Set<string>() } : { name: 'Vé lẻ', group: 'gym' as const, revenue: 0, contracts: new Set<string>() });
    r.revenue += sign * x.amount;
    if (sign === 1) r.contracts.add(x.contract?.id ?? `retail:${x.amount}:${r.contracts.size}`);
    rows.set(key, r);
  };
  for (const x of paid) add(x, 1);
  for (const x of refunded) add(x, -1);
  const total = [...rows.values()].reduce((s, r) => s + r.revenue, 0);
  const groups = (['gym', 'pt'] as const).map((g) => ({ key: g, revenue: [...rows.values()].filter((r) => r.group === g).reduce((s, r) => s + r.revenue, 0) }));
  const items = [...rows.values()]
    .map((r) => ({ name: r.name, group: r.group, contracts: r.contracts.size, revenue: r.revenue, average: r.contracts.size ? Math.round(r.revenue / r.contracts.size) : null, share: total > 0 ? r.revenue / total : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
  res.json({ data: { days: p.days, total, groups, items } });
});

reportsRouter.get('/contract-progress', authorize('reports.view'), async (req, res) => {
  const p = z.object({ branch_id: z.string().uuid().optional() }).parse(req.query);
  const bf = branchFilter(req, p.branch_id);
  const today = dateOnly(todayVN());
  const rows = await prisma.contract.findMany({
    where: { ...bf, status: { in: ['draft', 'signed', 'active', 'frozen'] } },
    select: { id: true, code: true, status: true, totalAmount: true, paidAmount: true, startDate: true, endDate: true, sessionsTotal: true, sessionsLeft: true, createdAt: true, packageName: true, package: { select: { name: true } }, member: { select: { name: true, code: true } } },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });
  const progressOf = (c: (typeof rows)[number]) => {
    if (c.status === 'draft' || c.status === 'signed') return 0;
    if (c.sessionsTotal) return Math.min(1, Math.max(0, (c.sessionsTotal - (c.sessionsLeft ?? c.sessionsTotal)) / c.sessionsTotal));
    if (c.startDate && c.endDate) {
      const span = c.endDate.getTime() - c.startDate.getTime();
      return span > 0 ? Math.min(1, Math.max(0, (today.getTime() - c.startDate.getTime()) / span)) : 1;
    }
    return 0;
  };
  const scored = rows.map((c) => ({ c, progress: progressOf(c) }));
  const live = scored.filter((x) => x.c.status === 'active' || x.c.status === 'frozen');
  const total = rows.reduce((s, c) => s + c.totalAmount, 0);
  const paid = rows.reduce((s, c) => s + c.paidAmount, 0);
  const debtors = rows.filter((c) => c.totalAmount > c.paidAmount);
  const buckets = [0, 0, 0, 0];
  for (const x of live) buckets[x.progress < 0.25 ? 0 : x.progress < 0.5 ? 1 : x.progress < 0.75 ? 2 : 3]++;
  res.json({
    data: {
      summary: {
        total_value: total,
        paid,
        debt: debtors.reduce((s, c) => s + (c.totalAmount - c.paidAmount), 0),
        debt_contracts: debtors.length,
        running: live.length,
        average_progress: live.length ? live.reduce((s, x) => s + x.progress, 0) / live.length : 0,
      },
      buckets,
      recent: scored.slice(0, 12).map(({ c, progress }) => ({
        id: c.id, code: c.code, status: c.status, created_at: c.createdAt, package: c.packageName ?? c.package.name,
        member: { name: c.member.name, code: c.member.code }, progress,
      })),
    },
  });
});

const businessQ = z.object({
  branch_id: z.string().uuid().optional(),
  mode: z.enum(['month', 'year']).default('month'),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

type Kind = 'member' | 'pt' | 'group';
const kindOf = (p: { category: string; displayGroup: string | null }): Kind => (p.displayGroup === 'pt_group' || p.category === 'pt_group' ? 'group' : p.category === 'member' ? 'member' : 'pt');
const clamp25 = (x: number) => Math.max(0, Math.min(25, Math.round(x * 25)));
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);

reportsRouter.get('/business', authorize('reports.view'), async (req, res) => {
  const p = businessQ.parse(req.query);
  const bf = branchFilter(req, p.branch_id);
  const todayStr = todayVN();
  const today = dateOnly(todayStr);
  const year = p.year ?? Number(todayStr.slice(0, 4));
  const month = p.month ?? Number(todayStr.slice(5, 7));
  const mm = String(month).padStart(2, '0');
  const firstDay = p.mode === 'month' ? `${year}-${mm}-01` : `${year}-01-01`;
  const lastDay = p.mode === 'month' ? fmtDay(new Date(Date.UTC(year, month, 0))) : `${year}-12-31`;
  const from = dayRange(firstDay).gte;
  const to = dayRange(lastDay).lt;
  const labels = p.mode === 'month' ? Array.from({ length: Number(lastDay.slice(8, 10)) }, (_, i) => i + 1) : Array.from({ length: 12 }, (_, i) => i + 1);
  const empty = () => labels.map((label) => ({ label, member: 0, pt: 0, group: 0 }));
  const bucketOf = (d: Date) => (p.mode === 'month' ? Number(vnDayOf(d).slice(8, 10)) : Number(vnDayOf(d).slice(5, 7))) - 1;

  const pkgSel = { select: { category: true, displayGroup: true, name: true } } as const;
  const [created, paid, refunded] = await Promise.all([
    prisma.contract.findMany({ where: { ...bf, createdAt: { gte: from, lt: to }, status: { not: 'cancelled' } }, select: { totalAmount: true, createdAt: true, package: pkgSel } }),
    prisma.payment.findMany({ where: { ...bf, status: { in: ['confirmed', 'refunded'] }, confirmedAt: { gte: from, lt: to } }, select: { amount: true, confirmedAt: true, contract: { select: { package: pkgSel } } } }),
    prisma.payment.findMany({ where: { ...bf, status: 'refunded', refundedAt: { gte: from, lt: to } }, select: { amount: true, refundedAt: true, contract: { select: { package: pkgSel } } } }),
  ]);
  const revenue = empty();
  for (const c of created) revenue[bucketOf(c.createdAt)][kindOf(c.package)] += c.totalAmount;
  const collected = empty();
  for (const x of paid) collected[bucketOf(x.confirmedAt!)][x.contract ? kindOf(x.contract.package) : 'member'] += x.amount;
  for (const x of refunded) collected[bucketOf(x.refundedAt!)][x.contract ? kindOf(x.contract.package) : 'member'] -= x.amount;
  const sum = (rows: typeof revenue) => rows.reduce((s, r) => s + r.member + r.pt + r.group, 0);

  const d7 = addDays(today, 7);
  const d30 = addDays(today, 30);
  const d14 = addDays(today, -13);
  const since14 = dayRange(fmtDay(d14)).gte;
  const memberLive = { ...bf, status: 'active' as const, package: { category: 'member' as const } };
  const [branches, activeByBranch, expiringRows, ptActive, checkins14, ptDone14] = await Promise.all([
    prisma.branch.findMany({ select: { id: true, code: true, name: true } }),
    prisma.member.groupBy({ by: ['branchId'], where: { ...bf, status: 'active' }, _count: { _all: true } }),
    prisma.contract.findMany({
      where: { ...memberLive, endDate: { gte: today, lte: d30 } },
      select: { id: true, branchId: true, endDate: true, totalAmount: true, packageName: true, member: { select: { id: true, name: true } }, package: { select: { name: true } } },
      orderBy: { endDate: 'asc' },
    }),
    prisma.contract.findMany({ where: { ...bf, status: 'active', package: { category: { in: ['pt_1on1', 'pt_1on2', 'pt_group'] } } }, select: { branchId: true, memberId: true } }),
    prisma.checkin.findMany({ where: { ...bf, result: 'allowed', checkedInAt: { gte: since14 } }, select: { memberId: true, checkedInAt: true } }),
    prisma.ptSession.findMany({ where: { ...bf, status: 'completed', startAt: { gte: since14 } }, select: { startAt: true } }),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b]));
  const byBranch = (rows: { branchId: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.branchId, (m.get(r.branchId) ?? 0) + 1);
    return [...m.entries()].map(([id, count]) => ({ branch: branchName.get(id)?.name ?? '', code: branchName.get(id)?.code ?? '', count }));
  };
  const past14 = Array.from({ length: 14 }, (_, i) => fmtDay(addDays(d14, i)));
  const next14 = Array.from({ length: 14 }, (_, i) => fmtDay(addDays(today, i)));
  const countPerDay = (days: string[], keys: string[]) => days.map((d) => keys.filter((k) => k === d).length);
  const expiring7 = expiringRows.filter((c) => c.endDate! <= d7);
  const cards = {
    member_active: {
      total: activeByBranch.reduce((s, g) => s + g._count._all, 0),
      by_branch: activeByBranch.map((g) => ({ branch: branchName.get(g.branchId)?.name ?? '', code: branchName.get(g.branchId)?.code ?? '', count: g._count._all })),
      spark: countPerDay(past14, checkins14.map((c) => vnDayOf(c.checkedInAt))),
    },
    expiring_7: { total: expiring7.length, by_branch: byBranch(expiring7), spark: countPerDay(next14, expiringRows.map((c) => fmtDay(c.endDate!))) },
    pt_active: { total: ptActive.length, members: new Set(ptActive.map((c) => c.memberId)).size, by_branch: byBranch(ptActive), spark: countPerDay(past14, ptDone14.map((s) => vnDayOf(s.startAt))) },
  };

  const since30 = dayRange(fmtDay(addDays(today, -29))).gte;
  const since120 = dayRange(fmtDay(addDays(today, -119))).gte;
  const since90 = dayRange(fmtDay(addDays(today, -89))).gte;
  const until = dayRange(todayStr).lt;
  const [pay120, refund120, activeContracts, memberTotals, expiredWindow, creditRows, openRows, refundReq, recent, activityCheckins, activityPays, activityLeads, debtRows] = await Promise.all([
    prisma.payment.findMany({ where: { ...bf, status: { in: ['confirmed', 'refunded'] }, confirmedAt: { gte: since120, lt: until } }, select: { amount: true, confirmedAt: true } }),
    prisma.payment.findMany({ where: { ...bf, status: 'refunded', refundedAt: { gte: since120, lt: until } }, select: { amount: true, refundedAt: true } }),
    prisma.contract.findMany({ where: { ...bf, status: 'active' }, select: { packageName: true, packageId: true, package: { select: { name: true } } } }),
    prisma.member.groupBy({ by: ['status'], where: bf, _count: { _all: true } }),
    prisma.contract.findMany({ where: { ...bf, status: { in: ['active', 'expired'] }, package: { category: 'member' }, endDate: { gte: addDays(today, -90), lt: today } }, select: { id: true } }),
    prisma.contract.findMany({ where: { ...bf, status: { notIn: ['cancelled', 'draft'] }, createdAt: { gte: since90 } }, select: { totalAmount: true, paidAmount: true } }),
    prisma.contract.findMany({ where: { ...bf, status: { in: ['draft', 'signed'] } }, select: { totalAmount: true } }),
    prisma.payment.findMany({ where: { ...bf, status: 'confirmed', refundRequestedAt: { not: null } }, select: { amount: true } }),
    prisma.contract.findMany({
      where: { ...bf, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { id: true, code: true, status: true, totalAmount: true, createdAt: true, branchId: true, packageName: true, package: { select: { name: true } }, member: { select: { name: true, code: true } } },
    }),
    prisma.checkin.findMany({ where: { ...bf, result: 'allowed' }, orderBy: { checkedInAt: 'desc' }, take: 8, select: { checkedInAt: true, branchId: true, member: { select: { name: true } } } }),
    prisma.payment.findMany({ where: { ...bf, status: 'confirmed' }, orderBy: { confirmedAt: 'desc' }, take: 8, select: { amount: true, confirmedAt: true, contract: { select: { member: { select: { name: true } } } } } }),
    prisma.lead.findMany({ where: bf, orderBy: { createdAt: 'desc' }, take: 8, select: { name: true, createdAt: true } }),
    prisma.contract.findMany({ where: { ...bf, status: { notIn: ['cancelled', 'draft'] } }, select: { totalAmount: true, paidAmount: true } }),
  ]);
  const net = (a: Date, b: Date) =>
    pay120.filter((x) => x.confirmedAt! >= a && x.confirmedAt! < b).reduce((s, x) => s + x.amount, 0) - refund120.filter((x) => x.refundedAt! >= a && x.refundedAt! < b).reduce((s, x) => s + x.amount, 0);
  const cur30 = net(since30, until);
  const prior = net(since120, since30) / 3;
  const revRatio = prior > 0 ? Math.min(1, cur30 / prior) : cur30 > 0 ? 1 : 0;
  const totalMembers = memberTotals.reduce((s, g) => s + g._count._all, 0);
  const validMembers = memberTotals.filter((g) => g.status === 'active').reduce((s, g) => s + g._count._all, 0);
  const validRate = totalMembers ? validMembers / totalMembers : 0;
  const renewed = expiredWindow.length ? new Set((await prisma.contract.findMany({ where: { renewedFromId: { in: expiredWindow.map((c) => c.id) } }, select: { renewedFromId: true } })).map((c) => c.renewedFromId)) : new Set<string | null>();
  const renewRate = expiredWindow.length ? expiredWindow.filter((c) => renewed.has(c.id)).length / expiredWindow.length : null;
  const memberScore = renewRate == null ? validRate : validRate * 0.5 + renewRate * 0.5;
  const creditTotal = creditRows.reduce((s, c) => s + c.totalAmount, 0);
  const collectRate = creditTotal > 0 ? Math.min(1, creditRows.reduce((s, c) => s + c.paidAmount, 0) / creditTotal) : 0;
  const attendRate = cards.member_active.total ? Math.min(1, new Set(checkins14.map((c) => c.memberId)).size / cards.member_active.total) : 0;
  const parts = [
    { key: 'revenue', label: 'Doanh thu', score: clamp25(revRatio) },
    { key: 'members', label: 'Hội viên', score: clamp25(memberScore) },
    { key: 'collection', label: 'Thu tiền', score: clamp25(collectRate) },
    { key: 'attendance', label: 'Vận hành', score: clamp25(attendRate) },
  ];
  const health = { score: parts.reduce((s, x) => s + x.score, 0), parts };

  const debtors = debtRows.filter((c) => c.totalAmount > c.paidAmount);
  const alerts = {
    expiring_30: { count: expiringRows.length, impact: expiringRows.reduce((s, c) => s + c.totalAmount, 0) },
    unsigned: { count: openRows.length, impact: openRows.reduce((s, c) => s + c.totalAmount, 0) },
    debt: { count: debtors.length, impact: debtors.reduce((s, c) => s + c.totalAmount - c.paidAmount, 0) },
    refund_pending: { count: refundReq.length, impact: refundReq.reduce((s, x) => s + x.amount, 0) },
    renew_rate: renewRate,
  };

  const pkgMap = new Map<string, { name: string; contracts: number }>();
  for (const c of activeContracts) {
    const r = pkgMap.get(c.packageId) ?? { name: c.packageName ?? c.package.name, contracts: 0 };
    r.contracts++;
    pkgMap.set(c.packageId, r);
  }
  const packages = [...pkgMap.values()].sort((a, b) => b.contracts - a.contracts).map((r) => ({ ...r, share: activeContracts.length ? r.contracts / activeContracts.length : 0 }));

  const activity = [
    ...activityCheckins.map((c) => ({ type: 'checkin' as const, at: c.checkedInAt, text: `${c.member.name} check-in tại ${branchName.get(c.branchId)?.name ?? ''}` })),
    ...activityPays.map((x) => ({ type: 'payment' as const, at: x.confirmedAt!, text: `${x.contract?.member.name ?? 'Khách vé lẻ'} thanh toán ${x.amount.toLocaleString('vi-VN')} ₫` })),
    ...activityLeads.map((l) => ({ type: 'lead' as const, at: l.createdAt, text: `Khách tiềm năng mới: ${l.name}` })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 8);

  res.json({
    data: {
      mode: p.mode,
      year,
      month,
      revenue: { total: sum(revenue), rows: revenue },
      collected: { total: sum(collected), rows: collected },
      cards,
      packages: { total: activeContracts.length, rows: packages },
      health,
      alerts,
      recent_contracts: recent.map((c) => ({ id: c.id, code: c.code, status: c.status, total_amount: c.totalAmount, created_at: c.createdAt, package: c.packageName ?? c.package.name, member: c.member, branch: branchName.get(c.branchId) ?? null })),
      expiring_list: expiring7.slice(0, 8).map((c) => ({ id: c.id, member: c.member, package: c.packageName ?? c.package.name, end_date: fmtDay(c.endDate!), days_left: Math.round((c.endDate!.getTime() - today.getTime()) / 86400000), branch: branchName.get(c.branchId) ?? null })),
      activity,
    },
  });
});
