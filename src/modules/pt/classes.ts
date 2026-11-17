import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { DATE_RE, dateOnly, dayRange, todayVN } from '../../lib/dates';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authorize } from '../../middlewares/auth';
import { addEvent, lockContract, ptEligibility, ptUsable, type Tx } from '../contracts/service';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';
import { assertTrainer, lockKey, ownOnly } from './shared';

export const classesRouter = Router();

const LIVE = ['booked', 'attended', 'absent'] as const;

const classInclude = {
  trainer: { select: { id: true, name: true } },
  registrations: { where: { status: { in: [...LIVE] } }, select: { id: true } },
} satisfies Prisma.GroupClassInclude;

type ClassRow = Prisma.GroupClassGetPayload<{ include: typeof classInclude }>;

const classToApi = (c: ClassRow) => ({
  id: c.id,
  branch_id: c.branchId,
  title: c.title,
  trainer: c.trainer,
  start_at: c.startAt.toISOString(),
  end_at: c.endAt.toISOString(),
  capacity: c.capacity,
  registered: c.registrations.length,
  status: c.status,
  completed_at: c.completedAt?.toISOString() ?? null,
});

const regInclude = {
  class: { select: { id: true, title: true, startAt: true, endAt: true, status: true, trainer: { select: { id: true, name: true } } } },
  contract: { select: { code: true } },
} satisfies Prisma.GroupRegistrationInclude;

type RegRow = Prisma.GroupRegistrationGetPayload<{ include: typeof regInclude }>;

const regToApi = (r: RegRow) => ({
  id: r.id,
  member_id: r.memberId,
  name: r.name,
  phone: r.phone,
  email: r.email,
  status: r.status,
  deducted: r.deducted,
  source: r.source,
  contract_code: r.contract?.code ?? null,
  created_at: r.createdAt.toISOString(),
  class: {
    id: r.class.id,
    title: r.class.title,
    start_at: r.class.startAt.toISOString(),
    end_at: r.class.endAt.toISOString(),
    status: r.class.status,
    trainer: r.class.trainer,
  },
});

const date = z.string().regex(DATE_RE);
const rangeSchema = z.object({
  from: date.optional(),
  to: date.optional(),
  branch_id: z.string().uuid().optional(),
  trainer_id: z.string().uuid().optional(),
  status: z.string().optional(),
});

const rangeFilter = (q: { from?: string; to?: string }) =>
  q.from || q.to ? { gte: q.from ? dayRange(q.from).gte : undefined, lt: q.to ? dayRange(q.to).lt : undefined } : undefined;

classesRouter.get('/', authorize('pt_sessions.read'), async (req, res) => {
  const q = rangeSchema.parse(req.query);
  const where: Prisma.GroupClassWhereInput = { ...branchFilter(req, q.branch_id), startAt: rangeFilter(q) };
  where.trainerId = ownOnly(req) ? req.auth!.userId : q.trainer_id;
  const rows = await prisma.groupClass.findMany({ where, include: classInclude, orderBy: { startAt: 'asc' }, take: 500 });
  res.json({ data: rows.map(classToApi) });
});

classesRouter.get('/registrations', authorize('pt_sessions.read'), async (req, res) => {
  const q = rangeSchema.parse(req.query);
  const classWhere: Prisma.GroupClassWhereInput = { ...branchFilter(req, q.branch_id), startAt: rangeFilter(q) };
  const where: Prisma.GroupRegistrationWhereInput = { class: classWhere };
  if (ownOnly(req)) classWhere.trainerId = req.auth!.userId;
  if (q.status && ['booked', 'attended', 'absent', 'cancelled'].includes(q.status)) where.status = q.status as 'booked';
  const rows = await prisma.groupRegistration.findMany({ where, include: regInclude, orderBy: [{ class: { startAt: 'asc' } }, { createdAt: 'asc' }], take: 1000 });
  res.json({ data: rows.map(regToApi) });
});

classesRouter.get('/stats', authorize('pt_sessions.read'), async (req, res) => {
  const q = rangeSchema.parse(req.query);
  const classWhere: Prisma.GroupClassWhereInput = { ...branchFilter(req, q.branch_id), startAt: rangeFilter(q) };
  if (ownOnly(req)) classWhere.trainerId = req.auth!.userId;
  const classes = await prisma.groupClass.findMany({
    where: classWhere,
    select: { status: true, capacity: true, trainer: { select: { id: true, name: true } }, registrations: { select: { status: true } } },
  });
  const regs = { booked: 0, attended: 0, absent: 0, cancelled: 0 };
  let seats = 0;
  let filled = 0;
  const perTrainer = new Map<string, { name: string; classes: number; attended: number }>();
  for (const c of classes) {
    for (const r of c.registrations) regs[r.status]++;
    if (c.status === 'cancelled') continue;
    const live = c.registrations.filter((r) => r.status !== 'cancelled').length;
    seats += c.capacity;
    filled += live;
    if (c.status === 'completed' && c.trainer) {
      const t = perTrainer.get(c.trainer.id) ?? { name: c.trainer.name, classes: 0, attended: 0 };
      t.classes++;
      t.attended += c.registrations.filter((r) => r.status === 'attended').length;
      perTrainer.set(c.trainer.id, t);
    }
  }
  res.json({
    data: {
      classes: {
        total: classes.length,
        scheduled: classes.filter((c) => c.status === 'scheduled').length,
        completed: classes.filter((c) => c.status === 'completed').length,
        cancelled: classes.filter((c) => c.status === 'cancelled').length,
      },
      registrations: regs,
      fill_rate: seats ? Math.round((filled / seats) * 100) : 0,
      trainers: [...perTrainer.entries()].map(([id, t]) => ({ id, ...t })),
    },
  });
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(100).default('PT nhóm'),
  trainer_id: z.string().uuid().nullish(),
  start_at: z.string().datetime({ offset: true }),
  duration_min: z.number().int().min(15).max(240).default(60),
  capacity: z.number().int().min(1).max(50).default(3),
  branch_id: z.string().uuid().optional(),
});

classesRouter.post('/', authorize('pt_sessions.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  if (b.trainer_id) await assertTrainer(b.trainer_id, branchId);
  const startAt = new Date(b.start_at);
  const created = await prisma.groupClass.create({
    data: {
      branchId,
      trainerId: b.trainer_id ?? null,
      title: b.title,
      startAt,
      endAt: new Date(startAt.getTime() + b.duration_min * 60000),
      capacity: b.capacity,
      createdBy: req.auth!.userId,
    },
    include: classInclude,
  });
  await audit(req.auth!.userId, 'group_class.created', { after: classToApi(created) }, req.ip, created.id);
  res.status(201).json({ data: classToApi(created) });
});

async function loadClass(req: Request) {
  const id = z.string().uuid().parse(req.params.id);
  const c = await prisma.groupClass.findUnique({ where: { id }, include: classInclude });
  if (!c || !branchAllowed(req.access!, c.branchId)) throw notFound('Class not found');
  return c;
}

async function refund(tx: Tx, reg: { id: string; contractId: string | null; deducted: boolean }, by: string | null, reason: string) {
  if (reg.deducted && reg.contractId) {
    await lockContract(tx, reg.contractId);
    await tx.contract.update({ where: { id: reg.contractId }, data: { sessionsLeft: { increment: 1 } } });
    await addEvent(tx, reg.contractId, 'group_class_refunded', by, reason, { registration_id: reg.id });
  }
  await tx.groupRegistration.update({ where: { id: reg.id }, data: { status: 'cancelled', cancelledAt: new Date(), deducted: false } });
}

const registerSchema = z.object({ member_id: z.string().uuid() });

classesRouter.post('/:id/registrations', authorize('pt_sessions.create'), async (req, res) => {
  const cls = await loadClass(req);
  const b = registerSchema.parse(req.body);
  const member = await prisma.member.findUnique({ where: { id: b.member_id } });
  if (!member || member.branchId !== cls.branchId) throw notFound('Member not found');
  const elig = await ptEligibility(member.id);
  if (!elig.member_package.ok) throw conflict('MEMBER_PACKAGE_EXPIRED', 'Member package is no longer valid');

  const reg = await prisma.$transaction(async (tx) => {
    await lockKey(tx, 'class:' + cls.id);
    const cur = await tx.groupClass.findUniqueOrThrow({ where: { id: cls.id } });
    if (cur.status !== 'scheduled') throw conflict('CLASS_CLOSED', 'Class is not open for registration');
    if (cur.startAt <= new Date()) throw conflict('CLASS_STARTED', 'Class has already started');
    const live = await tx.groupRegistration.findMany({ where: { classId: cls.id, status: { in: [...LIVE] } }, select: { memberId: true } });
    if (live.length >= cur.capacity) throw conflict('CLASS_FULL', 'Class is full');
    if (live.some((r) => r.memberId === member.id)) throw conflict('ALREADY_REGISTERED', 'Member is already registered');

    const today = dateOnly(todayVN());
    const candidates = await tx.contract.findMany({
      where: { memberId: member.id, branchId: cls.branchId, status: { in: ['active', 'expired'] }, package: { OR: [{ category: 'pt_group' }, { displayGroup: 'pt_group' }] }, sessionsLeft: { gt: 0 } },
      include: { package: { select: { category: true } } },
      orderBy: { endDate: { sort: 'asc', nulls: 'last' } },
    });
    const pick = candidates.find((c) => ptUsable({ status: c.status, endDate: c.endDate, sessionsTotal: c.sessionsTotal, category: 'pt_group' }, today));
    if (!pick) throw conflict('NO_SESSIONS', 'Member has no usable PT group package with sessions left');
    await lockContract(tx, pick.id);
    const fresh = await tx.contract.findUniqueOrThrow({ where: { id: pick.id } });
    if ((fresh.sessionsLeft ?? 0) <= 0) throw conflict('NO_SESSIONS', 'Member has no sessions left');
    await tx.contract.update({ where: { id: pick.id }, data: { sessionsLeft: { decrement: 1 } } });
    const created = await tx.groupRegistration.create({
      data: {
        classId: cls.id,
        memberId: member.id,
        contractId: pick.id,
        name: member.name,
        phone: member.phone,
        email: member.email,
        deducted: true,
        createdBy: req.auth!.userId,
      },
      include: regInclude,
    });
    await addEvent(tx, pick.id, 'group_class_reserved', req.auth!.userId, null, { registration_id: created.id, class_id: cls.id });
    return created;
  });
  await audit(req.auth!.userId, 'group_registration.created', { after: regToApi(reg) }, req.ip, reg.id);
  res.status(201).json({ data: regToApi(reg) });
});

classesRouter.post('/registrations/:id/cancel', authorize('pt_sessions.cancel'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const found = await prisma.groupRegistration.findUnique({ where: { id }, include: { class: { select: { branchId: true } } } });
  if (!found || !branchAllowed(req.access!, found.class.branchId)) throw notFound('Registration not found');
  const out = await prisma.$transaction(async (tx) => {
    await lockKey(tx, 'class:' + found.classId);
    const cur = await tx.groupRegistration.findUniqueOrThrow({ where: { id } });
    if (cur.status !== 'booked') throw conflict('NOT_BOOKED', 'Only booked registrations can be cancelled');
    await refund(tx, cur, req.auth!.userId, 'registration cancelled');
    return tx.groupRegistration.findUniqueOrThrow({ where: { id }, include: regInclude });
  });
  await audit(req.auth!.userId, 'group_registration.cancelled', { after: regToApi(out) }, req.ip, id);
  res.json({ data: regToApi(out) });
});

classesRouter.post('/:id/complete', authorize('pt_sessions.complete'), async (req, res) => {
  const cls = await loadClass(req);
  if (ownOnly(req) && cls.trainer?.id !== req.auth!.userId) throw forbidden('Not your class');
  if (!cls.trainer) throw conflict('NO_TRAINER', 'Assign a trainer before completing the class');
  const out = await prisma.$transaction(async (tx) => {
    await lockKey(tx, 'class:' + cls.id);
    const flip = await tx.groupClass.updateMany({ where: { id: cls.id, status: 'scheduled' }, data: { status: 'completed', completedAt: new Date() } });
    if (flip.count === 0) throw conflict('NOT_SCHEDULED', 'Class is not in scheduled state');
    await tx.groupRegistration.updateMany({ where: { classId: cls.id, status: 'booked' }, data: { status: 'attended' } });
    return tx.groupClass.findUniqueOrThrow({ where: { id: cls.id }, include: classInclude });
  });
  await audit(req.auth!.userId, 'group_class.completed', { after: classToApi(out) }, req.ip, cls.id);
  res.json({ data: classToApi(out) });
});

const attendanceSchema = z.object({ status: z.enum(['attended', 'absent']) });

classesRouter.post('/registrations/:id/attendance', authorize('pt_sessions.complete'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = attendanceSchema.parse(req.body);
  const found = await prisma.groupRegistration.findUnique({ where: { id }, include: { class: { select: { branchId: true, trainerId: true, status: true } } } });
  if (!found || !branchAllowed(req.access!, found.class.branchId)) throw notFound('Registration not found');
  if (ownOnly(req) && found.class.trainerId !== req.auth!.userId) throw forbidden('Not your class');
  if (found.class.status === 'cancelled') throw conflict('CLASS_CANCELLED', 'Class was cancelled');
  const out = await prisma.$transaction(async (tx) => {
    await lockKey(tx, 'class:' + found.classId);
    const cur = await tx.groupRegistration.findUniqueOrThrow({ where: { id } });
    if (cur.status === 'cancelled') throw conflict('ALREADY_CANCELLED', 'Registration was cancelled');
    if (cur.status !== b.status) await tx.groupRegistration.update({ where: { id }, data: { status: b.status } });
    if (cur.contractId) await addEvent(tx, cur.contractId, b.status === 'attended' ? 'group_class_attended' : 'group_class_absent', req.auth!.userId, null, { registration_id: id });
    return tx.groupRegistration.findUniqueOrThrow({ where: { id }, include: regInclude });
  });
  await audit(req.auth!.userId, 'group_registration.' + b.status, { after: regToApi(out) }, req.ip, id);
  res.json({ data: regToApi(out) });
});

const trainerSchema = z.object({ trainer_id: z.string().uuid().nullable() });

classesRouter.post('/:id/trainer', authorize('pt_sessions.create'), async (req, res) => {
  const cls = await loadClass(req);
  const b = trainerSchema.parse(req.body);
  if (b.trainer_id) await assertTrainer(b.trainer_id, cls.branchId);
  const out = await prisma.groupClass.update({ where: { id: cls.id }, data: { trainerId: b.trainer_id }, include: classInclude });
  res.json({ data: classToApi(out) });
});

classesRouter.post('/:id/cancel', authorize('pt_sessions.cancel'), async (req, res) => {
  const cls = await loadClass(req);
  const out = await prisma.$transaction(async (tx) => {
    await lockKey(tx, 'class:' + cls.id);
    const flip = await tx.groupClass.updateMany({ where: { id: cls.id, status: 'scheduled' }, data: { status: 'cancelled' } });
    if (flip.count === 0) throw conflict('NOT_SCHEDULED', 'Class is not in scheduled state');
    const regs = await tx.groupRegistration.findMany({ where: { classId: cls.id, status: 'booked' } });
    for (const r of regs) await refund(tx, r, req.auth!.userId, 'class cancelled');
    return tx.groupClass.findUniqueOrThrow({ where: { id: cls.id }, include: classInclude });
  });
  await audit(req.auth!.userId, 'group_class.cancelled', { after: classToApi(out) }, req.ip, cls.id);
  res.json({ data: classToApi(out) });
});
