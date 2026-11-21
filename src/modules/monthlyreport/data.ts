import { prisma } from '../../lib/prisma';
import { contribution, inRangeWhere } from '../payroll/service';

export interface ReportData {
  month: string;
  label: string;
  generatedAt: string;
  branches: { name: string; revenue: number; contractsNew: number; membersNew: number; checkins: number }[];
  totals: { revenue: number; contractsNew: number; membersNew: number; checkins: number; ptSessions: number; groupClasses: number; debtCount: number; debtAmount: number; expiring7: number };
  byCategory: { label: string; revenue: number }[];
  sales: { name: string; revenue: number }[];
  pts: { name: string; sessions: number; classes: number }[];
  ptKpi: PtKpi[];
}

export interface PtKpi {
  name: string;
  weeks: number[];
  sessions: number;
  classes: number;
  perDay: number;
  booked: number;
  completed: number;
  cancelled: number;
  leads: number;
  contractsPt: number;
  contractsGroup: number;
  customers: number;
  offTrack: number;
  renewed: number;
}

const PT_CATS = ['pt_1on1', 'pt_1on2', 'pt_group'] as const;
const OFF_TRACK_DAYS = 14;
const weekOf = (d: Date) => Math.min(4, Math.floor((new Date(d.getTime() + 7 * 3600_000).getUTCDate() - 1) / 7));

const CATEGORY_LABEL: Record<string, string> = { member: 'Gói member', pt_1on1: 'Gói PT 1:1', pt_1on2: 'Gói PT 1:2', pt_group: 'Gói PT nhóm', day: 'Vé lẻ' };

export function monthRange(month: string) {
  const from = new Date(`${month}-01T00:00:00+07:00`);
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from, to: new Date(`${next}-01T00:00:00+07:00`) };
}

export const previousMonthVN = (now = new Date()) => {
  const v = new Date(now.getTime() + 7 * 3600_000);
  const y = v.getUTCFullYear();
  const m = v.getUTCMonth();
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
};

export async function buildReport(month: string): Promise<ReportData> {
  const { from, to } = monthRange(month);
  const branches = await prisma.branch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const payments = await prisma.payment.findMany({
    where: inRangeWhere(from, to),
    select: { amount: true, status: true, confirmedAt: true, refundedAt: true, branchId: true, kind: true, contract: { select: { saleUserId: true, package: { select: { category: true } } } } },
  });
  const revByBranch = new Map<string, number>();
  const revByCat = new Map<string, number>();
  const revBySale = new Map<string, number>();
  for (const p of payments) {
    const v = contribution(p, from, to);
    if (!v) continue;
    revByBranch.set(p.branchId, (revByBranch.get(p.branchId) ?? 0) + v);
    const cat = p.contract?.package.category ?? 'day';
    revByCat.set(cat, (revByCat.get(cat) ?? 0) + v);
    const sale = p.contract?.saleUserId;
    if (sale) revBySale.set(sale, (revBySale.get(sale) ?? 0) + v);
  }

  const range = { gte: from, lt: to };
  const [contracts, members, checkins, sessions, classes, debt, expiring] = await Promise.all([
    prisma.contract.groupBy({ by: ['branchId'], where: { createdAt: range, status: { not: 'cancelled' } }, _count: { _all: true } }),
    prisma.member.groupBy({ by: ['branchId'], where: { createdAt: range }, _count: { _all: true } }),
    prisma.checkin.groupBy({ by: ['branchId'], where: { result: 'allowed', checkedInAt: range }, _count: { _all: true } }),
    prisma.ptSession.groupBy({ by: ['trainerId'], where: { status: 'completed', OR: [{ completedAt: range }, { completedAt: null, startAt: range }] }, _count: { _all: true } }),
    prisma.groupClass.groupBy({ by: ['trainerId'], where: { status: 'completed', trainerId: { not: null }, OR: [{ completedAt: range }, { completedAt: null, startAt: range }] }, _count: { _all: true } }),
    prisma.contract.findMany({ where: { status: { in: ['active', 'signed', 'frozen'] } }, select: { totalAmount: true, paidAmount: true } }),
    prisma.contract.count({ where: { status: 'active', endDate: { gte: new Date(), lt: new Date(Date.now() + 7 * 86400_000) } } }),
  ]);
  const count = (rows: { branchId: string; _count: { _all: number } }[], id: string) => rows.find((r) => r.branchId === id)?._count._all ?? 0;

  const ids = [...new Set([...revBySale.keys(), ...sessions.map((s) => s.trainerId), ...classes.map((c) => c.trainerId as string)])];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const name = (id: string) => users.find((u) => u.id === id)?.name ?? 'Không rõ';

  const ptIds = [...new Set([...sessions.map((s) => s.trainerId), ...classes.map((c) => c.trainerId as string)])];
  const [allSessions, leads, ptContracts, customerRows] = await Promise.all([
    prisma.ptSession.findMany({ where: { OR: [{ startAt: range }, { status: 'completed', completedAt: range }] }, select: { trainerId: true, status: true, startAt: true, completedAt: true } }),
    prisma.lead.groupBy({ by: ['assignedTo'], where: { assignedTo: { not: null }, createdAt: range }, _count: { _all: true } }),
    prisma.contract.findMany({ where: { createdAt: range, status: { not: 'cancelled' }, ptUserId: { not: null } }, select: { ptUserId: true, renewedFromId: true, package: { select: { category: true } } } }),
    prisma.contract.findMany({ where: { status: 'active', ptUserId: { not: null }, package: { category: { in: [...PT_CATS] } } }, select: { ptUserId: true, memberId: true } }),
  ]);
  const lastIn = customerRows.length
    ? await prisma.checkin.groupBy({ by: ['memberId'], where: { memberId: { in: [...new Set(customerRows.map((c) => c.memberId))] }, result: 'allowed' }, _max: { checkedInAt: true } })
    : [];
  const lastAt = new Map(lastIn.map((l) => [l.memberId, l._max.checkedInAt]));
  const cutoff = Date.now() - OFF_TRACK_DAYS * 86400_000;
  const [yy, mm] = month.split('-').map(Number);
  const days = new Date(yy, mm, 0).getDate();
  const kpiIds = new Set<string>([...ptIds, ...allSessions.map((x) => x.trainerId), ...leads.map((l) => l.assignedTo as string), ...ptContracts.map((c) => c.ptUserId as string), ...customerRows.map((c) => c.ptUserId as string)]);
  const kpiUsers = kpiIds.size ? await prisma.user.findMany({ where: { id: { in: [...kpiIds] } }, select: { id: true, name: true } }) : [];
  const ptKpi: PtKpi[] = [...kpiIds].map((id) => {
    const mine = allSessions.filter((x) => x.trainerId === id);
    const done = mine.filter((x) => x.status === 'completed' && (x.completedAt ?? x.startAt) >= from && (x.completedAt ?? x.startAt) < to);
    const weeks = [0, 0, 0, 0, 0];
    for (const x of done) weeks[weekOf((x.completedAt ?? x.startAt) as Date)]++;
    const booked = mine.filter((x) => x.startAt >= from && x.startAt < to);
    const cs = ptContracts.filter((c) => c.ptUserId === id);
    const cust = customerRows.filter((c) => c.ptUserId === id);
    const members = [...new Set(cust.map((c) => c.memberId))];
    return {
      name: kpiUsers.find((u) => u.id === id)?.name ?? 'Không rõ',
      weeks,
      sessions: done.length,
      classes: classes.find((c) => c.trainerId === id)?._count._all ?? 0,
      perDay: Math.round((done.length / days) * 10) / 10,
      booked: booked.length,
      completed: booked.filter((x) => x.status === 'completed').length,
      cancelled: booked.filter((x) => x.status === 'cancelled' || x.status === 'no_show').length,
      leads: leads.find((l) => l.assignedTo === id)?._count._all ?? 0,
      contractsPt: cs.filter((c) => c.package.category !== 'pt_group').length,
      contractsGroup: cs.filter((c) => c.package.category === 'pt_group').length,
      customers: members.length,
      offTrack: members.filter((m) => { const t = lastAt.get(m); return !t || t.getTime() < cutoff; }).length,
      renewed: cs.filter((c) => c.renewedFromId).length,
    };
  }).sort((a, b) => b.sessions + b.classes - (a.sessions + a.classes));
  const owed = debt.map((c) => c.totalAmount - c.paidAmount).filter((x) => x > 0);

  const branchRows = branches.map((b) => ({ name: b.name, revenue: revByBranch.get(b.id) ?? 0, contractsNew: count(contracts, b.id), membersNew: count(members, b.id), checkins: count(checkins, b.id) }));
  return {
    month,
    label: `${month.slice(5, 7)}/${month.slice(0, 4)}`,
    generatedAt: new Date().toISOString(),
    branches: branchRows,
    totals: {
      revenue: branchRows.reduce((a, b) => a + b.revenue, 0),
      contractsNew: branchRows.reduce((a, b) => a + b.contractsNew, 0),
      membersNew: branchRows.reduce((a, b) => a + b.membersNew, 0),
      checkins: branchRows.reduce((a, b) => a + b.checkins, 0),
      ptSessions: sessions.reduce((a, s) => a + s._count._all, 0),
      groupClasses: classes.reduce((a, c) => a + c._count._all, 0),
      debtCount: owed.length,
      debtAmount: owed.reduce((a, b) => a + b, 0),
      expiring7: expiring,
    },
    byCategory: [...revByCat.entries()].map(([k, v]) => ({ label: CATEGORY_LABEL[k] ?? k, revenue: v })).sort((a, b) => b.revenue - a.revenue),
    sales: [...revBySale.entries()].map(([id, v]) => ({ name: name(id), revenue: v })).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    pts: ptIds.map((id) => ({ name: name(id), sessions: sessions.find((s) => s.trainerId === id)?._count._all ?? 0, classes: classes.find((c) => c.trainerId === id)?._count._all ?? 0 })).sort((a, b) => b.sessions + b.classes - (a.sessions + a.classes)),
    ptKpi,
  };
}
