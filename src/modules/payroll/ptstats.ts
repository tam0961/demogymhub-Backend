import type { PackageCategory } from '@prisma/client';
import { fmtDate } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { contribution, inRangeWhere, monthRange } from './service';

const PT_CATEGORIES: PackageCategory[] = ['pt_1on1', 'pt_1on2'];
const PT_POSITIONS = ['pt_fulltime', 'pt_parttime'];

export interface PtStatClient {
  contract_id: string;
  contract_code: string;
  member_id: string;
  member_code: string;
  member_name: string;
  package_name: string;
  sessions_total: number | null;
  sessions_left: number | null;
  taught_in_month: number;
  end_date: string | null;
}

export interface PtStatClass {
  id: string;
  title: string;
  start_at: string;
}

export interface PtStatSale {
  contract_id: string;
  contract_code: string;
  member_name: string;
  package_name: string;
  kind: 'member' | 'pt';
  amount: number;
}

export interface PtStatRow {
  user_id: string;
  name: string;
  position: string;
  clients: PtStatClient[];
  sessions_taught: number;
  group_classes: number;
  classes: PtStatClass[];
  member_sales: number;
  pt_sales: number;
  sales: PtStatSale[];
}

export interface PtStats {
  month: string;
  rows: PtStatRow[];
}

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

export async function computePtStats(month: string, branchId?: string): Promise<PtStats> {
  const { from, to } = monthRange(month);
  const profiles = await prisma.payrollProfile.findMany({
    where: {
      active: true,
      position: { in: PT_POSITIONS },
      user: { status: 'active', OR: [{ staffProfile: null }, { staffProfile: { active: true } }], ...(branchId ? { userRoles: { some: { OR: [{ branchId }, { branchId: null }] } } } : {}) },
    },
    select: { userId: true, position: true, user: { select: { name: true } } },
  });
  const ids = profiles.map((p) => p.userId);
  if (!ids.length) return { month, rows: [] };

  const contracts = await prisma.contract.findMany({
    where: { status: 'active', ptUserId: { in: ids }, package: { category: { in: PT_CATEGORIES } } },
    orderBy: { endDate: { sort: 'asc', nulls: 'last' } },
    select: { id: true, code: true, ptUserId: true, sessionsTotal: true, sessionsLeft: true, endDate: true, packageName: true, member: { select: { id: true, code: true, name: true } }, package: { select: { name: true } } },
  });

  const sessions = await prisma.ptSession.findMany({
    where: {
      status: 'completed',
      trainerId: { in: ids },
      OR: [{ completedAt: { gte: from, lt: to } }, { completedAt: null, startAt: { gte: from, lt: to } }],
    },
    select: { trainerId: true, contractId: true },
  });
  const taughtByContract = new Map<string, number>();
  const taughtByPt = new Map<string, number>();
  for (const s of sessions) {
    if (s.contractId) add(taughtByContract, `${s.trainerId}|${s.contractId}`, 1);
    add(taughtByPt, s.trainerId, 1);
  }

  const classes = await prisma.groupClass.findMany({
    where: { status: 'completed', trainerId: { in: ids }, OR: [{ completedAt: { gte: from, lt: to } }, { completedAt: null, startAt: { gte: from, lt: to } }] },
    orderBy: { startAt: 'asc' },
    select: { id: true, trainerId: true, title: true, startAt: true },
  });

  const pays = await prisma.payment.findMany({
    where: { ...inRangeWhere(from, to), contract: { OR: [{ saleUserId: { in: ids } }, { ptUserId: { in: ids } }] } },
    select: {
      amount: true,
      status: true,
      confirmedAt: true,
      refundedAt: true,
      contract: { select: { id: true, code: true, saleUserId: true, ptUserId: true, packageName: true, member: { select: { name: true } }, package: { select: { name: true, category: true } } } },
    },
  });
  const idSet = new Set(ids);
  const saleByKey = new Map<string, PtStatSale & { owner: string }>();
  for (const p of pays) {
    const v = contribution(p, from, to);
    const c = p.contract;
    if (!v || !c) continue;
    const cat = c.package.category;
    let owner: string | null = null;
    let kind: 'member' | 'pt' = 'member';
    if (cat === 'member') owner = c.saleUserId && idSet.has(c.saleUserId) ? c.saleUserId : null;
    else if (PT_CATEGORIES.includes(cat)) {
      kind = 'pt';
      owner = c.ptUserId && idSet.has(c.ptUserId) ? c.ptUserId : null;
    }
    if (!owner) continue;
    const key = `${owner}|${c.id}`;
    const cur = saleByKey.get(key);
    if (cur) cur.amount += v;
    else saleByKey.set(key, { owner, contract_id: c.id, contract_code: c.code, member_name: c.member.name, package_name: c.packageName ?? c.package.name, kind, amount: v });
  }

  const rows: PtStatRow[] = profiles.map((p) => {
    const clients = contracts
      .filter((c) => c.ptUserId === p.userId)
      .map((c) => ({
        contract_id: c.id,
        contract_code: c.code,
        member_id: c.member.id,
        member_code: c.member.code,
        member_name: c.member.name,
        package_name: c.packageName ?? c.package.name,
        sessions_total: c.sessionsTotal,
        sessions_left: c.sessionsLeft,
        taught_in_month: taughtByContract.get(`${p.userId}|${c.id}`) ?? 0,
        end_date: fmtDate(c.endDate),
      }));
    const myClasses = classes.filter((c) => c.trainerId === p.userId).map((c) => ({ id: c.id, title: c.title, start_at: c.startAt.toISOString() }));
    const sales = [...saleByKey.values()]
      .filter((s) => s.owner === p.userId)
      .map(({ owner: _o, ...s }) => s)
      .sort((a, b) => b.amount - a.amount);
    return {
      user_id: p.userId,
      name: p.user.name,
      position: p.position,
      clients,
      sessions_taught: taughtByPt.get(p.userId) ?? 0,
      group_classes: myClasses.length,
      classes: myClasses,
      member_sales: sales.filter((s) => s.kind === 'member').reduce((a, s) => a + s.amount, 0),
      pt_sales: sales.filter((s) => s.kind === 'pt').reduce((a, s) => a + s.amount, 0),
      sales,
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return { month, rows };
}
