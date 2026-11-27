import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { DATE_RE, dateOnly, dayRange, todayVN } from '../../lib/dates';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middlewares/auth';
import { contribution, inRangeWhere, monthRange } from '../payroll/service';
import { branchFilter } from '../rbac/scope';
import { createPtSession } from '../pt/routes';

export const ptAppRouter = Router();

ptAppRouter.use(authenticate);
ptAppRouter.use((req, _res, next) => {
  if (!req.access?.roles.includes('trainer')) return next(forbidden('Trainer only'));
  next();
});

const me = (req: Request) => req.auth!.userId;
const date = z.string().regex(DATE_RE);

const OFF_TRACK_DAYS = 14;
const PT_CATEGORIES = ['pt_1on1', 'pt_1on2', 'pt_group'] as const;

ptAppRouter.get('/contracts', async (req, res) => {
  const q = z.object({ status: z.string().optional(), q: z.string().optional() }).parse(req.query);
  const where: Prisma.ContractWhereInput = { ...branchFilter(req), ptUserId: me(req), package: { OR: [{ category: { in: [...PT_CATEGORIES] } }, { displayGroup: 'pt_group' }] } };
  if (q.status) where.status = q.status as Prisma.ContractWhereInput['status'];
  if (q.q) where.member = { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }] };
  const rows = await prisma.contract.findMany({
    where,
    include: { member: { select: { id: true, code: true, name: true, phone: true } }, package: { select: { name: true, category: true, displayGroup: true } } },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  const memberIds = [...new Set(rows.map((c) => c.memberId))];
  const lastCheckin = await prisma.checkin.groupBy({ by: ['memberId'], where: { memberId: { in: memberIds }, result: 'allowed' }, _max: { checkedInAt: true } });
  const lastSession = await prisma.ptSession.groupBy({ by: ['memberId'], where: { memberId: { in: memberIds }, status: 'completed' }, _max: { startAt: true } });
  const lastBy = new Map<string, Date>();
  for (const r of [...lastCheckin.map((x) => [x.memberId, x._max.checkedInAt] as const), ...lastSession.map((x) => [x.memberId, x._max.startAt] as const)]) {
    const [id, at] = r;
    if (id && at && (!lastBy.get(id) || at > lastBy.get(id)!)) lastBy.set(id, at);
  }
  const offBefore = Date.now() - OFF_TRACK_DAYS * 86400000;
  res.json({
    data: rows.map((c) => {
      const last = lastBy.get(c.memberId) ?? null;
      const since = last ?? c.startDate;
      return {
      last_active: last ? last.toISOString() : null,
      off_track: c.status === 'active' && !!since && since.getTime() < offBefore,
      id: c.id,
      code: c.code,
      status: c.status,
      member: c.member,
      package_name: c.package.name,
      category: c.package.displayGroup === 'pt_group' ? 'pt_group' : c.package.category,
      sessions_total: c.sessionsTotal,
      sessions_left: c.sessionsLeft,
      start_date: c.startDate,
      end_date: c.endDate,
      total_amount: c.totalAmount - c.discount,
      paid_amount: c.paidAmount,
    };
    }),
  });
});

ptAppRouter.get('/schedule', async (req, res) => {
  const q = z.object({ from: date, to: date }).parse(req.query);
  const rows = await prisma.ptSession.findMany({
    where: { ...branchFilter(req), trainerId: me(req), startAt: { gte: dayRange(q.from).gte, lt: dayRange(q.to).lt } },
    include: {
      member: { select: { id: true, code: true, name: true, phone: true } },
      contract: { select: { code: true, sessionsLeft: true, package: { select: { category: true } } } },
    },
    orderBy: { startAt: 'asc' },
    take: 500,
  });
  res.json({
    data: rows.map((s) => ({
      id: s.id,
      start_at: s.startAt.toISOString(),
      end_at: s.endAt.toISOString(),
      status: s.status,
      note: s.note,
      kind: s.contract?.package.category === 'pt_1on2' ? 'pt_1on2' : 'pt_1on1',
      member: s.member,
      contract_code: s.contract?.code ?? null,
      sessions_left: s.contract?.sessionsLeft ?? null,
    })),
  });
});

ptAppRouter.get('/classes', async (req, res) => {
  const q = z.object({ from: date, to: date }).parse(req.query);
  const rows = await prisma.groupClass.findMany({
    where: { ...branchFilter(req), startAt: { gte: dayRange(q.from).gte, lt: dayRange(q.to).lt } },
    include: {
      trainer: { select: { id: true, name: true } },
      registrations: { where: { status: { in: ['booked', 'attended', 'absent'] } }, select: { id: true, name: true, phone: true, status: true } },
    },
    orderBy: { startAt: 'asc' },
    take: 500,
  });
  res.json({
    data: rows.map((c) => ({
      id: c.id,
      title: c.title,
      muscle_group: c.muscleGroup,
      trainer: c.trainer,
      mine: c.trainerId === me(req),
      start_at: c.startAt.toISOString(),
      end_at: c.endAt.toISOString(),
      capacity: c.capacity,
      status: c.status,
      registered: c.registrations.length,
      registrations: c.trainerId === me(req) ? c.registrations : [],
    })),
  });
});

ptAppRouter.get('/leads', async (req, res) => {
  const rows = await prisma.lead.findMany({
    where: { ...branchFilter(req), assignedTo: me(req) },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  res.json({
    data: rows.map((l) => ({
      id: l.id,
      name: l.name,
      phone: l.phone,
      source: l.source,
      interest: l.interest,
      status: l.status,
      note: l.note,
      trial_at: l.trialAt,
      created_at: l.createdAt,
    })),
  });
});

const leadPatch = z.object({
  status: z.enum(['new', 'contacted', 'trial_booked', 'lost']).optional(),
  note: z.string().max(1000).nullable().optional(),
});

ptAppRouter.patch('/leads/:id', async (req, res) => {
  const body = leadPatch.parse(req.body);
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id }, select: { id: true, assignedTo: true } });
  if (!lead || lead.assignedTo !== me(req)) throw notFound('Lead not found');
  await prisma.lead.update({ where: { id: lead.id }, data: { ...(body.status && { status: body.status }), ...(body.note !== undefined && { note: body.note }) } });
  res.json({ data: { id: lead.id } });
});

ptAppRouter.get('/off', async (req, res) => {
  const q = z.object({ from: date, to: date }).parse(req.query);
  const rows = await prisma.ptDayOff.findMany({ where: { trainerId: me(req), date: { gte: dateOnly(q.from), lte: dateOnly(q.to) } }, orderBy: { date: 'asc' } });
  res.json({ data: rows.map((r) => r.date.toISOString().slice(0, 10)) });
});

ptAppRouter.put('/off', async (req, res) => {
  const b = z.object({ date, off: z.boolean() }).parse(req.body);
  const access = req.access!;
  const branchId = access.branchIds[0];
  if (!branchId) throw forbidden('No branch');
  const key = { trainerId: me(req), branchId, date: dateOnly(b.date) };
  if (b.off) await prisma.ptDayOff.upsert({ where: { trainerId_branchId_date: key }, create: key, update: {} });
  else await prisma.ptDayOff.deleteMany({ where: key });
  await audit(me(req), b.off ? 'pt.day_off.set' : 'pt.day_off.clear', { trainer_id: me(req), date: b.date }, req.ip, me(req));
  res.json({ data: { date: b.date, off: b.off } });
});

const bookSchema = z.object({
  contract_id: z.string().uuid(),
  partner_contract_id: z.string().uuid().nullish(),
  start_at: z.string().datetime({ offset: true }),
  duration_min: z.number().int().min(15).max(240).default(60),
  note: z.string().trim().max(500).nullish(),
});

ptAppRouter.post('/sessions', async (req, res) => {
  const b = bookSchema.parse(req.body);
  const own = { select: { memberId: true, branchId: true, ptUserId: true, package: { select: { category: true } } } } as const;
  const c = await prisma.contract.findUnique({ where: { id: b.contract_id }, ...own });
  if (!c || c.ptUserId !== me(req)) throw notFound('Contract not found');
  if (new Date(b.start_at).getTime() < Date.now() - 3600000) throw badRequest('PAST_TIME', 'Cannot book a session in the past');
  const pair = c.package.category === 'pt_1on2';
  if (pair && !b.partner_contract_id) throw badRequest('PAIR_INCOMPLETE', 'A 1-2 session needs a second customer');
  if (!pair && b.partner_contract_id) throw badRequest('PAIR_NOT_ALLOWED', 'Only a PT 1:2 package can have a second customer');
  const pc = b.partner_contract_id ? await prisma.contract.findUnique({ where: { id: b.partner_contract_id }, ...own }) : null;
  if (b.partner_contract_id && (!pc || pc.ptUserId !== me(req) || pc.package.category !== 'pt_1on2')) throw notFound('Contract not found');
  const created = await createPtSession(req, {
    member_id: c.memberId, contract_id: b.contract_id, trainer_id: me(req), start_at: b.start_at, duration_min: b.duration_min, note: b.note, branch_id: c.branchId,
    ...(pc && b.partner_contract_id ? { partner: { member_id: pc.memberId, contract_id: b.partner_contract_id } } : {}),
  });
  res.status(201).json({ data: { id: created.first.id } });
});

ptAppRouter.patch('/sessions/:id/note', async (req, res) => {
  const b = z.object({ note: z.string().trim().max(500).nullable() }).parse(req.body);
  const s = await prisma.ptSession.findUnique({ where: { id: req.params.id }, select: { id: true, trainerId: true } });
  if (!s || s.trainerId !== me(req)) throw notFound('Session not found');
  await prisma.ptSession.update({ where: { id: s.id }, data: { note: b.note || null } });
  res.json({ data: { id: s.id } });
});

ptAppRouter.get('/revenue', async (req, res) => {
  const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
  const month = q.month ?? todayVN().slice(0, 7);
  const { from, to } = monthRange(month);
  const pays = await prisma.payment.findMany({
    where: { ...inRangeWhere(from, to), contract: { ...branchFilter(req), saleUserId: me(req) } },
    select: {
      amount: true,
      status: true,
      confirmedAt: true,
      refundedAt: true,
      contract: { select: { package: { select: { category: true, displayGroup: true } } } },
    },
  });
  const sum = { member: 0, pt: 0, group: 0 };
  for (const p of pays) {
    const pk = p.contract?.package;
    const kind = pk?.category === 'pt_group' || pk?.displayGroup === 'pt_group' ? 'group' : pk?.category === 'member' ? 'member' : 'pt';
    sum[kind] += contribution(p, from, to);
  }
  const t = await prisma.setting.findUnique({ where: { key: `work_targets:${month}` } });
  const target = Number(((t?.value ?? {}) as Record<string, unknown>)[me(req)] ?? 0) || 0;
  res.json({
    data: {
      month,
      member: sum.member,
      pt: sum.pt,
      group: sum.group,
      total: sum.member + sum.pt + sum.group,
      kpi: { target, achieved: sum.pt, pct: target > 0 ? Math.round((sum.pt / target) * 1000) / 10 : null },
    },
  });
});

ptAppRouter.get('/performance', async (req, res) => {
  const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
  const month = q.month ?? todayVN().slice(0, 7);
  const from = dayRange(`${month}-01`).gte;
  const next = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1));
  const to = dayRange(`${next.toISOString().slice(0, 7)}-01`).gte;
  const mine = { ...branchFilter(req), ptUserId: me(req), package: { OR: [{ category: { in: [...PT_CATEGORIES] } }, { displayGroup: 'pt_group' }] } } satisfies Prisma.ContractWhereInput;
  const [sessions, classes, leadsTotal, leadsWon, contractsAll, renewals] = await Promise.all([
    prisma.ptSession.count({ where: { trainerId: me(req), status: 'completed', startAt: { gte: from, lt: to } } }),
    prisma.groupClass.count({ where: { trainerId: me(req), status: 'completed', startAt: { gte: from, lt: to } } }),
    prisma.lead.count({ where: { assignedTo: me(req), createdAt: { gte: from, lt: to } } }),
    prisma.lead.count({ where: { assignedTo: me(req), status: 'converted', createdAt: { gte: from, lt: to } } }),
    prisma.contract.findMany({ where: { ...mine, status: { in: ['active', 'expired', 'frozen'] } }, select: { memberId: true } }),
    prisma.contract.count({ where: { ...mine, renewedFromId: { not: null }, createdAt: { gte: from, lt: to } } }),
  ]);
  const clients = new Set(contractsAll.map((c) => c.memberId)).size;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  res.json({
    data: {
      month,
      sessions_done: sessions,
      classes_done: classes,
      leads_assigned: leadsTotal,
      leads_converted: leadsWon,
      conversion_rate: pct(leadsWon, leadsTotal),
      clients,
      renewals,
      renew_rate: pct(renewals, clients),
    },
  });
});
