import type { PackageCategory, Prisma } from '@prisma/client';
import { addDays, dateOnly, fmtDate, todayVN } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { contribution, inRangeWhere, monthRange } from '../payroll/service';

export const STAFF_POSITIONS = ['pt_fulltime', 'pt_parttime', 'marketing', 'sale', 'reception', 'other'] as const;
export type StaffPosition = (typeof STAFF_POSITIONS)[number];

const PT_CATS: PackageCategory[] = ['pt_1on1', 'pt_1on2', 'pt_group'];
export const isPtPosition = (p: string) => p.startsWith('pt_');
export const hasKpi = (p: string) => p !== 'reception' && p !== 'other';

/** Payroll has no 'reception' position: it is stored there as 'other'. */
export const payrollPositionOf = (p: StaffPosition) => (p === 'reception' ? 'other' : p);

export function effectivePosition(staffPosition: string, payrollPosition: string | null | undefined): string {
  if (!payrollPosition) return staffPosition;
  if (payrollPosition === 'other' && staffPosition === 'reception') return 'reception';
  return payrollPosition;
}

export interface Kpi {
  contracts_sold: number;
  member_contracts: number;
  pt_contracts: number;
  new_customers: number;
  revenue: number;
  member_revenue: number;
  pt_revenue: number;
  avg_contract_value: number;
  debt_outstanding: number;
  active_clients: number;
  sessions_taught: number;
  group_classes: number;
  session_done_rate: number;
  no_show_rate: number;
  sessions_left_total: number;
  expiring_30: number;
  renewal_rate: number | null;
}

const zeroKpi = (): Kpi => ({
  contracts_sold: 0,
  member_contracts: 0,
  pt_contracts: 0,
  new_customers: 0,
  revenue: 0,
  member_revenue: 0,
  pt_revenue: 0,
  avg_contract_value: 0,
  debt_outstanding: 0,
  active_clients: 0,
  sessions_taught: 0,
  group_classes: 0,
  session_done_rate: 0,
  no_show_rate: 0,
  sessions_left_total: 0,
  expiring_30: 0,
  renewal_rate: null,
});

export interface StaffRef {
  userId: string;
  position: string;
}

export const shiftMonth = (month: string, delta: number): string => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/**
 * Business KPIs of the given staff for one month (VN time). A contract is credited to its Sale and, for PT positions,
 * also to the PT in charge (one credit per person even if both are the same person).
 */
export async function computeKpis(month: string, staff: StaffRef[], branchIds: string[] | null): Promise<Map<string, Kpi>> {
  const out = new Map<string, Kpi>();
  for (const s of staff) out.set(s.userId, zeroKpi());
  const ids = new Set(staff.filter((s) => hasKpi(s.position)).map((s) => s.userId));
  const ptIds = new Set(staff.filter((s) => hasKpi(s.position) && isPtPosition(s.position)).map((s) => s.userId));
  if (!ids.size) return out;

  const { from, to } = monthRange(month);
  const idList = [...ids];
  const ptList = [...ptIds];
  const creditOr = (): Prisma.ContractWhereInput[] => [{ saleUserId: { in: idList } }, ...(ptList.length ? [{ ptUserId: { in: ptList } }] : [])];
  const branchContract: Prisma.ContractWhereInput = branchIds ? { branchId: { in: branchIds } } : {};
  const credit = (saleId: string | null, ptId: string | null): string[] => {
    const set = new Set<string>();
    if (saleId && ids.has(saleId)) set.add(saleId);
    if (ptId && ptIds.has(ptId)) set.add(ptId);
    return [...set];
  };
  const isPtCat = (c: string) => c.startsWith('pt_');
  const k = (id: string) => out.get(id)!;

  // contracts sold in the month
  const sold = await prisma.contract.findMany({
    where: { ...branchContract, createdAt: { gte: from, lt: to }, status: { not: 'cancelled' }, bundleOfId: null, OR: creditOr() },
    select: { memberId: true, saleUserId: true, ptUserId: true, package: { select: { category: true } } },
  });
  for (const c of sold) {
    for (const id of credit(c.saleUserId, c.ptUserId)) {
      k(id).contracts_sold += 1;
      if (isPtCat(c.package.category)) k(id).pt_contracts += 1;
      else k(id).member_contracts += 1;
    }
  }

  // new customers: first ever contract was sold by the person in the month (Sale), or the first PT contract with this PT
  const cand = [...new Set(sold.map((c) => c.memberId))];
  if (cand.length) {
    const history = await prisma.contract.findMany({
      where: { memberId: { in: cand }, status: { not: 'cancelled' }, bundleOfId: null },
      orderBy: { createdAt: 'asc' },
      select: { memberId: true, saleUserId: true, ptUserId: true, createdAt: true, package: { select: { category: true } } },
    });
    const newSets = new Map<string, Set<string>>();
    const addNew = (id: string, memberId: string) => {
      let s = newSets.get(id);
      if (!s) newSets.set(id, (s = new Set()));
      s.add(memberId);
    };
    const firstOf = new Map<string, (typeof history)[number]>();
    const firstPtWith = new Map<string, (typeof history)[number]>();
    for (const h of history) {
      if (!firstOf.has(h.memberId)) firstOf.set(h.memberId, h);
      if (isPtCat(h.package.category) && h.ptUserId) {
        const key = `${h.memberId}|${h.ptUserId}`;
        if (!firstPtWith.has(key)) firstPtWith.set(key, h);
      }
    }
    for (const [memberId, h] of firstOf) {
      if (h.createdAt >= from && h.createdAt < to && h.saleUserId && ids.has(h.saleUserId)) addNew(h.saleUserId, memberId);
    }
    for (const [key, h] of firstPtWith) {
      if (h.createdAt >= from && h.createdAt < to && h.ptUserId && ptIds.has(h.ptUserId)) addNew(h.ptUserId, key.split('|')[0]);
    }
    for (const [id, set] of newSets) k(id).new_customers = set.size;
  }

  // revenue (thực thu) in the month
  const pays = await prisma.payment.findMany({
    where: { ...inRangeWhere(from, to), ...(branchIds ? { branchId: { in: branchIds } } : {}), contract: { OR: creditOr() } },
    select: { amount: true, status: true, confirmedAt: true, refundedAt: true, contract: { select: { saleUserId: true, ptUserId: true, package: { select: { category: true } } } } },
  });
  for (const p of pays) {
    const v = contribution(p, from, to);
    if (!v || !p.contract) continue;
    for (const id of credit(p.contract.saleUserId, p.contract.ptUserId)) {
      k(id).revenue += v;
      if (isPtCat(p.contract.package.category)) k(id).pt_revenue += v;
      else k(id).member_revenue += v;
    }
  }

  // outstanding debt on running contracts they sold
  const running = await prisma.contract.findMany({
    where: { ...branchContract, status: { in: ['active', 'frozen'] }, OR: creditOr() },
    select: { saleUserId: true, ptUserId: true, totalAmount: true, paidAmount: true },
  });
  for (const c of running) {
    const debt = c.totalAmount - c.paidAmount;
    if (debt <= 0) continue;
    for (const id of credit(c.saleUserId, c.ptUserId)) k(id).debt_outstanding += debt;
  }

  // PT portfolio: active clients, remaining sessions, expiring soon
  if (ptList.length) {
    const today = dateOnly(todayVN());
    const in30 = addDays(today, 30);
    const clients = await prisma.contract.findMany({
      where: { ...branchContract, status: { in: ['active', 'frozen'] }, ptUserId: { in: ptList }, package: { category: { in: PT_CATS } } },
      select: { memberId: true, ptUserId: true, sessionsLeft: true, endDate: true },
    });
    const members = new Map<string, Set<string>>();
    for (const c of clients) {
      const id = c.ptUserId!;
      let s = members.get(id);
      if (!s) members.set(id, (s = new Set()));
      s.add(c.memberId);
      k(id).sessions_left_total += c.sessionsLeft ?? 0;
      if (c.endDate && c.endDate >= today && c.endDate <= in30) k(id).expiring_30 += 1;
    }
    for (const [id, s] of members) k(id).active_clients = s.size;

    // renewal rate: PT contracts that ended in the last 90 days and whose member bought another PT contract afterwards
    const since = addDays(today, -90);
    const ended = await prisma.contract.findMany({
      where: { ...branchContract, status: { not: 'cancelled' }, ptUserId: { in: ptList }, package: { category: { in: PT_CATS } }, endDate: { gte: since, lte: today } },
      select: { id: true, memberId: true, ptUserId: true, endDate: true },
    });
    if (ended.length) {
      const later = await prisma.contract.findMany({
        where: { memberId: { in: [...new Set(ended.map((e) => e.memberId))] }, status: { not: 'cancelled' }, package: { category: { in: PT_CATS } } },
        select: { id: true, memberId: true, createdAt: true },
      });
      const total = new Map<string, number>();
      const renewed = new Map<string, number>();
      for (const e of ended) {
        const id = e.ptUserId!;
        bump(total, id, 1);
        const endAt = e.endDate!.getTime();
        if (later.some((l) => l.memberId === e.memberId && l.id !== e.id && l.createdAt.getTime() > endAt)) bump(renewed, id, 1);
      }
      for (const [id, n] of total) k(id).renewal_rate = n ? (renewed.get(id) ?? 0) / n : null;
    }

    // teaching load
    const sessions = await prisma.ptSession.findMany({
      where: { ...(branchIds ? { branchId: { in: branchIds } } : {}), trainerId: { in: ptList }, startAt: { gte: from, lt: to }, status: { in: ['completed', 'no_show', 'cancelled'] } },
      select: { trainerId: true, status: true },
    });
    const cnt = new Map<string, { completed: number; no_show: number; cancelled: number }>();
    for (const s of sessions) {
      const c = cnt.get(s.trainerId) ?? { completed: 0, no_show: 0, cancelled: 0 };
      c[s.status as 'completed' | 'no_show' | 'cancelled'] += 1;
      cnt.set(s.trainerId, c);
    }
    for (const [id, c] of cnt) {
      const all = c.completed + c.no_show + c.cancelled;
      k(id).sessions_taught = c.completed;
      k(id).session_done_rate = all ? c.completed / all : 0;
      k(id).no_show_rate = all ? c.no_show / all : 0;
    }
    const classes = await prisma.groupClass.groupBy({
      by: ['trainerId'],
      where: { ...(branchIds ? { branchId: { in: branchIds } } : {}), trainerId: { in: ptList }, status: 'completed', startAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
    for (const c of classes) if (c.trainerId) k(c.trainerId).group_classes = c._count._all;
  }

  for (const id of idList) {
    const kp = k(id);
    kp.avg_contract_value = kp.contracts_sold ? Math.round(kp.revenue / kp.contracts_sold) : 0;
  }
  return out;
}

export interface BranchRef {
  id: string;
  code: string;
  name: string;
}

export interface StaffRow {
  user_id: string;
  name: string;
  phone: string | null;
  position: string;
  active: boolean;
  hired_on: string | null;
  left_on: string | null;
  note: string | null;
  employee_no: string | null;
  branches: BranchRef[];
  kpi: Kpi;
  prev: { contracts_sold: number; revenue: number; sessions_taught: number; new_customers: number };
  rank: { revenue: number | null };
}

const profileInclude = {
  user: {
    select: {
      id: true,
      name: true,
      employeeNo: true,
      payrollProfile: { select: { position: true } },
      userRoles: { select: { branchId: true, branch: { select: { id: true, code: true, name: true } } } },
    },
  },
} satisfies Prisma.StaffProfileInclude;

export type LoadedProfile = Prisma.StaffProfileGetPayload<{ include: typeof profileInclude }>;

export async function loadProfiles(branchIds: string[] | null, userId?: string): Promise<LoadedProfile[]> {
  const where: Prisma.StaffProfileWhereInput = {
    ...(userId ? { userId } : {}),
    ...(branchIds ? { user: { userRoles: { some: { OR: [{ branchId: { in: branchIds } }, { branchId: null }] } } } } : {}),
  };
  return prisma.staffProfile.findMany({ where, include: profileInclude });
}

export async function buildRows(profiles: LoadedProfile[], month: string, branchIds: string[] | null): Promise<StaffRow[]> {
  const refs = profiles.map((p) => ({ userId: p.userId, position: effectivePosition(p.position, p.user.payrollProfile?.position) }));
  const [cur, prev] = await Promise.all([computeKpis(month, refs, branchIds), computeKpis(shiftMonth(month, -1), refs, branchIds)]);
  const rows: StaffRow[] = profiles.map((p, i) => {
    const kp = cur.get(p.userId)!;
    const pv = prev.get(p.userId)!;
    const seen = new Set<string>();
    const branches: BranchRef[] = [];
    for (const r of p.user.userRoles) {
      if (r.branch && !seen.has(r.branch.id)) {
        seen.add(r.branch.id);
        branches.push(r.branch);
      }
    }
    return {
      user_id: p.userId,
      name: p.user.name,
      phone: p.phone,
      position: refs[i].position,
      active: p.active,
      hired_on: fmtDate(p.hiredOn),
      left_on: fmtDate(p.leftOn),
      note: p.note,
      employee_no: p.user.employeeNo,
      branches,
      kpi: kp,
      prev: { contracts_sold: pv.contracts_sold, revenue: pv.revenue, sessions_taught: pv.sessions_taught, new_customers: pv.new_customers },
      rank: { revenue: null },
    };
  });
  for (const r of rows) {
    if (!hasKpi(r.position)) continue;
    const peers = rows.filter((x) => x.position === r.position);
    r.rank.revenue = 1 + peers.filter((x) => x.kpi.revenue > r.kpi.revenue).length;
  }
  rows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'vi'));
  return rows;
}

export async function staffDetail(profile: LoadedProfile, month: string, branchIds: string[] | null) {
  const [row] = await buildRows([profile], month, branchIds);
  const position = row.position;
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  const trend = [];
  for (const m of months) {
    const kp = (await computeKpis(m, [{ userId: profile.userId, position }], branchIds)).get(profile.userId)!;
    trend.push({ month: m, contracts_sold: kp.contracts_sold, revenue: kp.revenue, sessions_taught: kp.sessions_taught, new_customers: kp.new_customers });
  }
  const branchContract: Prisma.ContractWhereInput = branchIds ? { branchId: { in: branchIds } } : {};
  const clientRows = await prisma.contract.findMany({
    where: { ...branchContract, status: { in: ['active', 'frozen'] }, ptUserId: profile.userId, package: { category: { in: PT_CATS } } },
    orderBy: { endDate: { sort: 'asc', nulls: 'last' } },
    select: { code: true, status: true, sessionsLeft: true, endDate: true, packageName: true, member: { select: { id: true, code: true, name: true } }, package: { select: { name: true } } },
  });
  const clients = clientRows.map((c) => ({
    member_id: c.member.id,
    member_code: c.member.code,
    member_name: c.member.name,
    package_name: c.packageName ?? c.package.name,
    contract_code: c.code,
    sessions_left: c.sessionsLeft,
    end_date: fmtDate(c.endDate),
    status: c.status,
  }));
  const { from, to } = monthRange(month);
  const inMonth = await prisma.contract.findMany({
    where: { ...branchContract, createdAt: { gte: from, lt: to }, status: { not: 'cancelled' }, bundleOfId: null, OR: [{ saleUserId: profile.userId }, { ptUserId: profile.userId }] },
    orderBy: { createdAt: 'desc' },
    select: { id: true, code: true, totalAmount: true, paidAmount: true, createdAt: true, saleUserId: true, packageName: true, member: { select: { name: true } }, package: { select: { name: true } } },
  });
  const contracts = inMonth.map((c) => ({
    id: c.id,
    code: c.code,
    member_name: c.member.name,
    package_name: c.packageName ?? c.package.name,
    total_amount: c.totalAmount,
    paid_amount: c.paidAmount,
    created_at: c.createdAt.toISOString(),
    role: c.saleUserId === profile.userId ? ('sale' as const) : ('pt' as const),
  }));
  return { staff: row, trend, clients, contracts };
}
