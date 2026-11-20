import { Router } from 'express';
import { z } from 'zod';
import { addDays, dateOnly, dayRange, todayVN } from '../../lib/dates';
import { prisma } from '../../lib/prisma';
import { authorize } from '../../middlewares/auth';
import { branchFilter } from '../rbac/scope';

export const statsRouter = Router();

const q = z.object({ branch_id: z.string().uuid().optional() });
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r1 = (x: number) => Math.round(x * 10) / 10;

export const gradeOf = (score: number) => (score >= 80 ? 'Rất tốt' : score >= 65 ? 'Tốt' : score >= 50 ? 'Trung bình' : 'Cần cải thiện');

async function renewalStats(bf: ReturnType<typeof branchFilter>, today: Date) {
  const from = dayRange(fmtDay(addDays(today, -29))).gte;
  const [renewals, expired] = await Promise.all([
    prisma.contract.count({ where: { ...bf, renewedFromId: { not: null }, status: { not: 'cancelled' }, createdAt: { gte: from } } }),
    prisma.contract.findMany({ where: { ...bf, status: 'expired', endDate: { gte: addDays(today, -30), lt: today } }, select: { id: true, totalAmount: true } }),
  ]);
  const denom = renewals + expired.length;
  return { rate: denom > 0 ? renewals / denom : null, expired };
}

export async function computeHealth(bf: ReturnType<typeof branchFilter>) {
  const today = dateOnly(todayVN());
  const until = dayRange(fmtDay(today)).lt;
  const since30 = dayRange(fmtDay(addDays(today, -29))).gte;
  const since120 = dayRange(fmtDay(addDays(today, -119))).gte;
  const since14 = dayRange(fmtDay(addDays(today, -13))).gte;
  const [pay, members, activeMembers, contracts, checkins, renew] = await Promise.all([
    prisma.payment.findMany({ where: { ...bf, status: 'confirmed', confirmedAt: { gte: since120, lt: until } }, select: { amount: true, confirmedAt: true } }),
    prisma.member.count({ where: bf }),
    prisma.member.count({ where: { ...bf, status: 'active' } }),
    prisma.contract.findMany({ where: { ...bf, status: { in: ['signed', 'active', 'frozen'] } }, select: { totalAmount: true, paidAmount: true } }),
    prisma.checkin.findMany({ where: { ...bf, result: 'allowed', checkedInAt: { gte: since14 } }, distinct: ['memberId'], select: { memberId: true } }),
    renewalStats(bf, today),
  ]);
  const cur = pay.filter((x) => x.confirmedAt! >= since30).reduce((s, x) => s + x.amount, 0);
  const prior = pay.filter((x) => x.confirmedAt! < since30).reduce((s, x) => s + x.amount, 0) / 3;
  const revRatio = prior > 0 ? cur / prior : 1;
  const renewRate = renew.rate ?? 0.6;
  const memberRatio = 0.5 * (members ? activeMembers / members : 0) + 0.5 * renewRate;
  const totalValue = contracts.reduce((s, c) => s + c.totalAmount, 0);
  const collected = contracts.reduce((s, c) => s + Math.min(c.paidAmount, c.totalAmount), 0);
  const collectRatio = totalValue > 0 ? collected / totalValue : 0;
  const opsRatio = clamp01((activeMembers ? checkins.length / activeMembers : 0) / 0.75);
  const parts = [
    { key: 'revenue', label: 'Doanh thu', score: r1(25 * clamp01(revRatio / 1.2)) },
    { key: 'members', label: 'Hội viên', score: r1(25 * memberRatio) },
    { key: 'collection', label: 'Thu tiền', score: r1(25 * collectRatio) },
    { key: 'operations', label: 'Vận hành', score: r1(25 * opsRatio) },
  ];
  const score = Math.round(parts.reduce((s, p) => s + p.score, 0));
  return { score, grade: gradeOf(score), parts, renew_rate: renew.rate, renew_rate_used: renewRate };
}

statsRouter.get('/health', authorize('reports.view'), async (req, res) => {
  res.json({ data: await computeHealth(branchFilter(req, q.parse(req.query).branch_id)) });
});

statsRouter.get('/alerts', authorize('reports.view'), async (req, res) => {
  const bf = branchFilter(req, q.parse(req.query).branch_id);
  const today = dateOnly(todayVN());
  const d30 = addDays(today, 30);
  const since14 = dayRange(fmtDay(addDays(today, -13))).gte;
  const [expiring, debtRows, open, refunds, renew] = await Promise.all([
    prisma.contract.findMany({ where: { ...bf, status: 'active', package: { category: 'member' }, endDate: { gte: today, lte: d30 } }, select: { memberId: true, totalAmount: true } }),
    prisma.contract.findMany({ where: { ...bf, status: { in: ['signed', 'active', 'frozen', 'expired'] } }, select: { totalAmount: true, paidAmount: true, endDate: true } }),
    prisma.contract.findMany({ where: { ...bf, status: { in: ['draft', 'signed'] } }, select: { totalAmount: true } }),
    prisma.payment.findMany({ where: { ...bf, status: 'confirmed', refundRequestedAt: { not: null }, refundedAt: null }, select: { amount: true } }),
    renewalStats(bf, today),
  ]);
  const ids = [...new Set(expiring.map((c) => c.memberId))];
  const recent = ids.length
    ? new Set((await prisma.checkin.findMany({ where: { ...bf, memberId: { in: ids }, result: 'allowed', checkedInAt: { gte: since14 } }, distinct: ['memberId'], select: { memberId: true } })).map((c) => c.memberId))
    : new Set<string>();
  const lapsed = ids.filter((id) => !recent.has(id)).length;
  const debtors = debtRows.filter((c) => c.totalAmount > c.paidAmount);
  const overdue = debtors.filter((c) => c.endDate && c.endDate < today);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const items: { key: string; label: string; count: number; impact: number; detail: string; tone: 'bad' | 'warn' }[] = [
    { key: 'expiring_30', label: 'Hợp đồng hết hạn trong 30 ngày', count: expiring.length, impact: sum(expiring.map((c) => c.totalAmount)), detail: `${lapsed} hội viên bỏ tập hơn 14 ngày`, tone: 'warn' },
    { key: 'debt', label: 'Hợp đồng còn nợ', count: debtors.length, impact: sum(debtors.map((c) => c.totalAmount - c.paidAmount)), detail: `${overdue.length} hợp đồng quá hạn`, tone: 'bad' },
    { key: 'unsigned', label: 'Hợp đồng chưa ký hoặc chưa kích hoạt', count: open.length, impact: sum(open.map((c) => c.totalAmount)), detail: '', tone: 'warn' },
    { key: 'refund_pending', label: 'Phiếu hoàn tiền chờ duyệt', count: refunds.length, impact: sum(refunds.map((r) => r.amount)), detail: '', tone: 'warn' },
  ];
  if (renew.rate != null && renew.rate < 0.6) {
    items.push({ key: 'renew_rate', label: 'Tỉ lệ tái ký dưới 60%', count: renew.expired.length, impact: sum(renew.expired.map((c) => c.totalAmount)), detail: `Tái ký ${Math.round(renew.rate * 100)}%`, tone: 'bad' });
  }
  res.json({ data: items.filter((i) => i.count > 0).sort((a, b) => b.impact - a.impact) });
});

statsRouter.get('/capacity', authorize('reports.view'), async (req, res) => {
  const bf = branchFilter(req, q.parse(req.query).branch_id);
  const today = dateOnly(todayVN());
  const from = dayRange(fmtDay(addDays(today, -29))).gte;
  const to = dayRange(fmtDay(today)).lt;
  const [checkins, sessions, tickets] = await Promise.all([
    prisma.checkin.findMany({ where: { ...bf, result: 'allowed', checkedInAt: { gte: from, lt: to } }, select: { checkedInAt: true } }),
    prisma.ptSession.groupBy({ by: ['status'], where: { ...bf, startAt: { gte: from, lt: to } }, _count: { _all: true } }),
    prisma.dayTicket.findMany({ where: { ...bf, issuedOn: { gte: addDays(today, -29), lte: today }, payment: { status: 'confirmed' } }, select: { payment: { select: { amount: true } } } }),
  ]);
  const heat = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const c of checkins) {
    const v = new Date(c.checkedInAt.getTime() + 7 * 3600 * 1000);
    heat[(v.getUTCDay() + 6) % 7][v.getUTCHours()]++;
  }
  const byHour = Array.from({ length: 24 }, (_, h) => heat.reduce((s, row) => s + row[h], 0));
  let peak: { from_hour: number; to_hour: number; count: number } | null = null;
  for (let h = 0; h < 23; h++) {
    const count = byHour[h] + byHour[h + 1];
    if (count > 0 && (!peak || count > peak.count)) peak = { from_hour: h, to_hour: h + 2, count };
  }
  const n = (s: string) => sessions.find((x) => x.status === s)?._count._all ?? 0;
  const booked = sessions.reduce((s, x) => s + x._count._all, 0);
  res.json({
    data: {
      days: 30,
      total_checkins: checkins.length,
      avg_per_day: Math.round((checkins.length / 30) * 10) / 10,
      heatmap: heat,
      peak,
      pt_funnel: { booked, attended: n('completed'), no_show: n('no_show'), cancelled: n('cancelled'), completion_rate: booked ? n('completed') / booked : null },
      day_tickets: { count: tickets.length, amount: tickets.reduce((s, t) => s + t.payment.amount, 0) },
    },
  });
});
