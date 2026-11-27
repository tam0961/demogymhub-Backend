import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { dateOnly, todayVN, vnDayOf } from '../../lib/dates';
import { badRequest } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authorize } from '../../middlewares/auth';
import { contribution, inRangeWhere, monthRange } from '../payroll/service';
import { branchFilter } from '../rbac/scope';

export const workRouter = Router();

const PT_CATEGORIES = ['pt_1on1', 'pt_1on2'] as const;
const PT_POSITIONS = ['pt_fulltime', 'pt_parttime'];
const OFFTRACK_DAYS = 14;
const DAY_MS = 86400000;

const ym = z.object({ year: z.coerce.number().int().min(2020).max(2100), month: z.coerce.number().int().min(1).max(12) });
const ymKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const targetKey = (y: number, m: number) => `work_targets:${ymKey(y, m)}`;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

async function loadTargets(keys: string[]): Promise<Map<string, Record<string, number>>> {
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  return new Map(rows.map((r) => [r.key, (r.value ?? {}) as Record<string, number>]));
}

async function ptProfiles(branch: Prisma.ContractWhereInput['branchId']) {
  const branchId = typeof branch === 'string' ? branch : undefined;
  const rows = await prisma.payrollProfile.findMany({
    where: {
      active: true,
      position: { in: PT_POSITIONS },
      user: { status: 'active', OR: [{ staffProfile: null }, { staffProfile: { active: true } }], ...(branchId ? { userRoles: { some: { OR: [{ branchId }, { branchId: null }] } } } : {}) },
    },
    select: { userId: true, user: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.userId, name: r.user.name })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

workRouter.get('/targets', authorize('reports.view'), async (req, res) => {
  const p = ym.parse(req.query);
  const bf = branchFilter(req);
  const [pts, t] = await Promise.all([ptProfiles(bf.branchId), loadTargets([targetKey(p.year, p.month)])]);
  const cur = t.get(targetKey(p.year, p.month)) ?? {};
  res.json({ data: pts.map((x) => ({ user_id: x.id, name: x.name, target: num(cur[x.id]) })) });
});

workRouter.put('/targets', authorize('payroll.manage'), async (req, res) => {
  const p = ym.parse(req.query);
  const b = z.object({ targets: z.array(z.object({ user_id: z.string().uuid(), target: z.number().int().min(0).max(100_000_000_000) })).max(200) }).parse(req.body);
  const key = targetKey(p.year, p.month);
  const prev = (await loadTargets([key])).get(key) ?? {};
  const next: Record<string, number> = { ...prev };
  for (const t of b.targets) next[t.user_id] = t.target;
  const value = next as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  res.json({ data: { ok: true } });
});

workRouter.get('/', authorize('reports.view'), async (req, res) => {
  const p = ym.extend({ pt_id: z.string().uuid().optional(), branch_id: z.string().uuid().optional() }).parse(req.query);
  const bf = branchFilter(req, p.branch_id);
  const month = ymKey(p.year, p.month);
  const { from, to } = monthRange(month);
  const today = todayVN();
  const dim = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  const nowMonth = today.slice(0, 7);
  const elapsed = month === nowMonth ? Number(today.slice(8, 10)) : month < nowMonth ? dim : 0;

  const pts = await ptProfiles(bf.branchId);
  if (p.pt_id && !pts.some((x) => x.id === p.pt_id)) throw badRequest('INVALID_PT', 'PT not found');
  const ids = pts.map((x) => x.id);
  const nameOf = new Map(pts.map((x) => [x.id, x.name]));

  const histMonths = Array.from({ length: 11 }, (_, i) => {
    const d = new Date(Date.UTC(p.year, p.month - 1 - (11 - i), 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  });
  const histFrom = monthRange(ymKey(histMonths[0].y, histMonths[0].m)).from;
  const prevM = histMonths[histMonths.length - 1];

  const ptContract: Prisma.ContractWhereInput = { ...bf, ptUserId: { in: ids }, package: { category: { in: [...PT_CATEGORIES] } } };
  const saleContract: Prisma.ContractWhereInput = { ...bf, saleUserId: { in: ids }, package: { category: { in: [...PT_CATEGORIES] } } };
  const [targets, pays, created, sessions, leads, active] = await Promise.all([
    loadTargets([...histMonths.map((h) => targetKey(h.y, h.m)), targetKey(p.year, p.month)]),
    prisma.payment.findMany({
      where: { ...inRangeWhere(histFrom, to), contract: saleContract },
      select: { amount: true, status: true, confirmedAt: true, refundedAt: true, contract: { select: { saleUserId: true, renewedFromId: true } } },
    }),
    prisma.contract.findMany({
      where: { ...saleContract, createdAt: { gte: from, lt: to }, status: { notIn: ['cancelled', 'draft'] } },
      select: { saleUserId: true, renewedFromId: true },
    }),
    prisma.ptSession.findMany({
      where: { ...bf, trainerId: { in: ids }, startAt: { gte: from, lt: to } },
      select: { trainerId: true, status: true, startAt: true },
    }),
    prisma.lead.findMany({
      where: { ...bf, assignedTo: { in: ids }, createdAt: { gte: from, lt: to } },
      select: { assignedTo: true, status: true },
    }),
    prisma.contract.findMany({
      where: { ...ptContract, status: 'active' },
      select: { id: true, ptUserId: true, activatedAt: true, createdAt: true, member: { select: { id: true, name: true } } },
    }),
  ]);

  const members = active.map((c) => c.member.id);
  const lastDone = new Map<string, Date>();
  if (members.length) {
    const last = await prisma.ptSession.groupBy({
      by: ['memberId'],
      where: { memberId: { in: members }, status: 'completed', startAt: { lt: to } },
      _max: { startAt: true },
    });
    for (const l of last) if (l.memberId && l._max.startAt) lastDone.set(l.memberId, l._max.startAt);
  }

  const cutoff = new Date(Math.min(to.getTime(), dateOnly(today).getTime() + DAY_MS - 7 * 3600000));
  const absent = active
    .map((c) => {
      const since = lastDone.get(c.member.id) ?? c.activatedAt ?? c.createdAt;
      return { pt: c.ptUserId!, member: c.member.name, days_absent: Math.max(0, Math.floor((cutoff.getTime() - since.getTime()) / DAY_MS)) };
    })
    .filter((a) => a.days_absent >= OFFTRACK_DAYS);

  const sales = new Map<string, { n: number; r: number }>();
  const histTotal = new Map<string, number>();
  const daily = Array.from({ length: elapsed }, (_, i) => ({ day: i + 1, dow: new Date(Date.UTC(p.year, p.month - 1, i + 1)).getUTCDay(), sessions: 0, cancelled: 0, revenue: 0 }));
  for (const pay of pays) {
    const pt = pay.contract?.saleUserId;
    if (!pt) continue;
    const parts: [Date | null, number][] = [];
    if (pay.status === 'confirmed' || pay.status === 'refunded') parts.push([pay.confirmedAt, pay.amount]);
    if (pay.status === 'refunded') parts.push([pay.refundedAt, -pay.amount]);
    for (const [at, v] of parts) {
      if (!at) continue;
      const k = vnDayOf(at).slice(0, 7);
      if (at >= histFrom && at < to) histTotal.set(`${k}|${pt}`, (histTotal.get(`${k}|${pt}`) ?? 0) + v);
      if (k === month) {
        if (!p.pt_id || p.pt_id === pt) {
          const d = daily[Number(vnDayOf(at).slice(8, 10)) - 1];
          if (d) d.revenue += v;
        }
      }
    }
    const v = contribution(pay, from, to);
    if (!v) continue;
    const s = sales.get(pt) ?? { n: 0, r: 0 };
    if (pay.contract?.renewedFromId) s.r += v;
    else s.n += v;
    sales.set(pt, s);
  }

  const cNew = new Map<string, number>();
  const cRenew = new Map<string, number>();
  for (const c of created) {
    const m = c.renewedFromId ? cRenew : cNew;
    m.set(c.saleUserId!, (m.get(c.saleUserId!) ?? 0) + 1);
  }
  const sess = new Map<string, { booked: number; cancelled: number; done: number }>();
  const hourCount = new Map<number, number>();
  for (const s of sessions) {
    const a = sess.get(s.trainerId) ?? { booked: 0, cancelled: 0, done: 0 };
    a.booked += 1;
    if (s.status === 'cancelled') a.cancelled += 1;
    if (s.status === 'completed') a.done += 1;
    sess.set(s.trainerId, a);
    if (p.pt_id && p.pt_id !== s.trainerId) continue;
    if (s.status !== 'cancelled') {
      const h = Number(new Date(s.startAt.getTime() + 7 * 3600000).toISOString().slice(11, 13));
      hourCount.set(h, (hourCount.get(h) ?? 0) + 1);
    }
    const d = daily[Number(vnDayOf(s.startAt).slice(8, 10)) - 1];
    if (d) {
      if (s.status === 'completed') d.sessions += 1;
      if (s.status === 'cancelled') d.cancelled += 1;
    }
  }
  const leadN = new Map<string, number>();
  const leadWon = new Map<string, number>();
  for (const l of leads) {
    leadN.set(l.assignedTo!, (leadN.get(l.assignedTo!) ?? 0) + 1);
    if (l.status === 'converted') leadWon.set(l.assignedTo!, (leadWon.get(l.assignedTo!) ?? 0) + 1);
  }
  const clientsOf = new Map<string, number>();
  for (const c of active) clientsOf.set(c.ptUserId!, (clientsOf.get(c.ptUserId!) ?? 0) + 1);
  const offOf = new Map<string, number>();
  for (const a of absent) offOf.set(a.pt, (offOf.get(a.pt) ?? 0) + 1);

  const cur = targets.get(targetKey(p.year, p.month)) ?? {};
  const pace = elapsed / dim;
  const weeks = Math.max(1, elapsed / 7);
  const rows = pts.map((pt) => {
    const target = num(cur[pt.id]);
    const sl = sales.get(pt.id) ?? { n: 0, r: 0 };
    const total = sl.n + sl.r;
    const pct = target ? total / target : 0;
    const ratio = pace ? pct / pace : 0;
    const ss = sess.get(pt.id) ?? { booked: 0, cancelled: 0, done: 0 };
    const nNew = cNew.get(pt.id) ?? 0;
    const nRenew = cRenew.get(pt.id) ?? 0;
    const clients = clientsOf.get(pt.id) ?? 0;
    const leadsN = leadN.get(pt.id) ?? 0;
    return {
      user_id: pt.id, name: pt.name, target, new_sales: sl.n, renew_sales: sl.r, total, pct,
      status: ratio >= 0.9 ? 'on_track' : ratio >= 0.6 ? 'off_track' : 'low',
      renew_share: total ? sl.r / total : 0, new_contracts: nNew, renew_contracts: nRenew, apv: nNew ? sl.n / nNew : 0,
      leads: leadsN, conversion: leadsN ? (leadWon.get(pt.id) ?? 0) / leadsN : 0,
      sessions_done: ss.done, sessions_week: Math.round(ss.done / weeks), booked: ss.booked, cancelled: ss.cancelled,
      attend_rate: ss.booked ? ss.done / ss.booked : 0, cancel_rate: ss.booked ? ss.cancelled / ss.booked : 0,
      clients, offtrack: offOf.get(pt.id) ?? 0, renew_rate: clients ? nRenew / clients : 0, frequency: clients ? ss.done / (clients * Math.max(0.5, elapsed / 7)) : 0,
    };
  });

  const scope = p.pt_id ? [p.pt_id] : ids;
  const sum = (f: (id: string) => number) => scope.reduce((t, id) => t + f(id), 0);
  const history = histMonths.map((h) => {
    const k = ymKey(h.y, h.m);
    const tg = targets.get(targetKey(h.y, h.m)) ?? {};
    return { label: `T${h.m}`, actual: sum((id) => histTotal.get(`${k}|${id}`) ?? 0), target: sum((id) => num(tg[id])) };
  });
  const pk = ymKey(prevM.y, prevM.m);
  const prevPays = pays.filter((x) => x.contract?.saleUserId && scope.includes(x.contract.saleUserId));
  const prevRange = monthRange(pk);
  const prev = { total: 0, new_sales: 0, renew_sales: 0 };
  for (const pay of prevPays) {
    const v = contribution(pay, prevRange.from, prevRange.to);
    prev.total += v;
    if (pay.contract?.renewedFromId) prev.renew_sales += v;
    else prev.new_sales += v;
  }
  const slots = Math.max(1, elapsed * scope.length);
  const hours = Array.from({ length: 16 }, (_, k) => ({ hour: 6 + k, util: Math.min(100, Math.round(((hourCount.get(6 + k) ?? 0) / slots) * 100)) }));

  res.json({
    data: {
      year: p.year, month: p.month, days_elapsed: elapsed, days_in_month: dim, rows, history, prev, daily, hours,
      off_track: absent.filter((a) => scope.includes(a.pt)).sort((a, b) => b.days_absent - a.days_absent).map((a) => ({ member: a.member, pt_name: nameOf.get(a.pt) ?? '', days_absent: a.days_absent })),
    },
  });
});
