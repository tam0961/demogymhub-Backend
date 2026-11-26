import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { DATE_RE, dayRange } from '../../lib/dates';
import { forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middlewares/auth';
import { branchFilter } from '../rbac/scope';

export const ptAppRouter = Router();

ptAppRouter.use(authenticate);
ptAppRouter.use((req, _res, next) => {
  if (!req.access?.roles.includes('trainer')) return next(forbidden('Trainer only'));
  next();
});

const me = (req: Request) => req.auth!.userId;
const date = z.string().regex(DATE_RE);

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
  res.json({
    data: rows.map((c) => ({
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
    })),
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
      registrations: c.registrations,
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
