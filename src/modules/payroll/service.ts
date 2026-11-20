import type { Prisma } from '@prisma/client';
import { vnDayOf } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { DEFAULT_SETTINGS, computeRow, flatRate, sumRows, type PayrollRow, type PayrollSettings, type Position, type TaxMode } from './calc';

const SETTINGS_KEY = 'payroll';
const PT_CATEGORIES = ['pt_1on1', 'pt_1on2'];

export async function getPayrollSettings(): Promise<PayrollSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  return { ...DEFAULT_SETTINGS, ...((row?.value ?? {}) as Partial<PayrollSettings>) };
}

export async function savePayrollSettings(s: PayrollSettings): Promise<PayrollSettings> {
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, update: { value: s as unknown as Prisma.InputJsonValue }, create: { key: SETTINGS_KEY, value: s as unknown as Prisma.InputJsonValue } });
  return s;
}

export function monthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { from: new Date(`${month}-01T00:00:00+07:00`), to: new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+07:00`) };
}

const monthOf = (d: Date) => vnDayOf(d).slice(0, 7);

interface PayLike {
  amount: number;
  status: string;
  confirmedAt: Date | null;
  refundedAt: Date | null;
}

/** Thực thu of one payment inside [from, to): confirmed money in, refunded money out (refunds and negative payments reduce it). */
export function contribution(p: PayLike, from: Date, to: Date): number {
  let v = 0;
  if ((p.status === 'confirmed' || p.status === 'refunded') && p.confirmedAt && p.confirmedAt >= from && p.confirmedAt < to) v += p.amount;
  if (p.status === 'refunded' && p.refundedAt && p.refundedAt >= from && p.refundedAt < to) v -= p.amount;
  return v;
}

export const inRangeWhere = (from: Date, to: Date): Prisma.PaymentWhereInput => ({
  OR: [
    { status: { in: ['confirmed', 'refunded'] }, confirmedAt: { gte: from, lt: to } },
    { status: 'refunded', refundedAt: { gte: from, lt: to } },
  ],
});

interface MonthRevenue {
  memberBySale: Map<string, number>;
  memberTotal: number;
  ptByAttr: Map<string, number>;
}

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

async function monthRevenue(month: string, marketingIds: Set<string>): Promise<MonthRevenue> {
  const { from, to } = monthRange(month);
  const pays = await prisma.payment.findMany({
    where: inRangeWhere(from, to),
    select: {
      amount: true,
      status: true,
      confirmedAt: true,
      refundedAt: true,
      contract: { select: { saleUserId: true, ptUserId: true, package: { select: { category: true } } } },
    },
  });
  const out: MonthRevenue = { memberBySale: new Map(), memberTotal: 0, ptByAttr: new Map() };
  for (const p of pays) {
    const v = contribution(p, from, to);
    if (!v || !p.contract) continue;
    const cat = p.contract.package.category;
    if (cat === 'member') {
      out.memberTotal += v;
      if (p.contract.saleUserId) add(out.memberBySale, p.contract.saleUserId, v);
    } else if (PT_CATEGORIES.includes(cat)) {
      const attr = p.contract.ptUserId ?? (p.contract.saleUserId && marketingIds.has(p.contract.saleUserId) ? p.contract.saleUserId : null);
      if (attr) add(out.ptByAttr, attr, v);
    }
  }
  return out;
}

export interface Preview {
  month: string;
  status: 'open' | 'closed';
  rows: PayrollRow[];
  totals: Record<string, number | boolean>;
}

export async function computePreview(month: string, branchId?: string): Promise<Preview> {
  const settings = await getPayrollSettings();
  const { from, to } = monthRange(month);

  const all = await prisma.payrollProfile.findMany({ where: { active: true, user: { status: 'active', OR: [{ staffProfile: null }, { staffProfile: { active: true } }] } }, include: { user: { select: { id: true, name: true, userRoles: { select: { branchId: true } } } } } });
  const marketingIds = new Set(all.filter((p) => p.position === 'marketing').map((p) => p.userId));
  const staff = branchId ? all.filter((p) => p.user.userRoles.some((r) => r.branchId === null || r.branchId === branchId)) : all;

  const cache = new Map<string, Promise<MonthRevenue>>();
  const revenueOf = (m: string) => {
    let r = cache.get(m);
    if (!r) {
      r = monthRevenue(m, marketingIds);
      cache.set(m, r);
    }
    return r;
  };
  const cur = await revenueOf(month);

  // 60% part: per taught 1-1 session, per contract
  const sessions = await prisma.ptSession.findMany({
    where: {
      status: 'completed',
      contractId: { not: null },
      OR: [{ completedAt: { gte: from, lt: to } }, { completedAt: null, startAt: { gte: from, lt: to } }],
    },
    select: {
      trainerId: true,
      contractId: true,
      contract: { select: { id: true, ptUserId: true, sessionsTotal: true, createdAt: true, package: { select: { category: true } } } },
    },
  });
  const taught = new Map<string, Map<string, number>>();
  const contracts = new Map<string, NonNullable<(typeof sessions)[number]['contract']>>();
  for (const s of sessions) {
    const c = s.contract;
    if (!c || !PT_CATEGORIES.includes(c.package.category) || !c.sessionsTotal || c.sessionsTotal <= 0) continue;
    contracts.set(c.id, c);
    const byContract = taught.get(s.trainerId) ?? new Map<string, number>();
    byContract.set(c.id, (byContract.get(c.id) ?? 0) + 1);
    taught.set(s.trainerId, byContract);
  }
  const paidToDate = new Map<string, number>();
  if (contracts.size) {
    const epoch = new Date(0);
    const pays = await prisma.payment.findMany({
      where: { contractId: { in: [...contracts.keys()] }, ...inRangeWhere(epoch, to) },
      select: { contractId: true, amount: true, status: true, confirmedAt: true, refundedAt: true },
    });
    for (const p of pays) if (p.contractId) add(paidToDate, p.contractId, contribution(p, epoch, to));
  }
  const sessionPay = new Map<string, number>();
  const sessionCount = new Map<string, number>();
  for (const [trainerId, byContract] of taught) {
    for (const [cid, n] of byContract) {
      const c = contracts.get(cid)!;
      const rev = await revenueOf(monthOf(c.createdAt));
      const rate = flatRate(rev.ptByAttr.get(c.ptUserId ?? trainerId) ?? 0, settings.ptTiers);
      const perSession = (settings.ptSessionShare * (rate / 100) * (paidToDate.get(cid) ?? 0)) / c.sessionsTotal!;
      add(sessionPay, trainerId, perSession * n);
      add(sessionCount, trainerId, n);
    }
  }

  const classes = await prisma.groupClass.findMany({
    where: { status: 'completed', trainerId: { not: null }, OR: [{ completedAt: { gte: from, lt: to } }, { completedAt: null, startAt: { gte: from, lt: to } }] },
    select: { trainerId: true },
  });
  const classCount = new Map<string, number>();
  for (const c of classes) if (c.trainerId) add(classCount, c.trainerId, 1);

  const adjustments = new Map((await prisma.payrollAdjustment.findMany({ where: { month } })).map((a) => [a.userId, a]));

  const rows = staff
    .map((p) =>
      computeRow(
        {
          userId: p.userId,
          name: p.user.name,
          profile: { position: p.position as Position, baseSalary: p.baseSalary, hasInsurance: p.hasInsurance, taxMode: p.taxMode as TaxMode, dependents: p.dependents },
          memberSales: cur.memberBySale.get(p.userId) ?? 0,
          gymMemberTotal: cur.memberTotal,
          ptSales: cur.ptByAttr.get(p.userId) ?? 0,
          ptSessionPay: sessionPay.get(p.userId) ?? 0,
          ptSessionsTaught: sessionCount.get(p.userId) ?? 0,
          groupClasses: classCount.get(p.userId) ?? 0,
          penalty: adjustments.get(p.userId)?.penalty ?? 0,
          adjustment: adjustments.get(p.userId)?.adjustment ?? 0,
          note: adjustments.get(p.userId)?.note ?? null,
        },
        settings,
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return { month, status: 'open', rows, totals: sumRows(rows) };
}
