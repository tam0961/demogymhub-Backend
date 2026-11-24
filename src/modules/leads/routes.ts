import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { Lead, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { nextMemberCode } from '../contracts/codes';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';

export const leadsRouter = Router();
leadsRouter.use(authenticate);

const STATUSES = ['new', 'contacted', 'trial_booked', 'converted', 'lost'] as const;
const uuid = z.string().uuid();
const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s.\-()]/g, ''))
  .pipe(z.string().regex(/^\+?\d{9,15}$/, 'invalid phone'));

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone,
  email: z.string().trim().toLowerCase().email().nullish(),
  source: z.string().trim().max(100).nullish(),
  interest: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(1000).nullish(),
  branch_id: uuid.optional(),
  assigned_to: uuid.nullish(),
  trial_at: z.string().datetime({ offset: true }).nullish(),
});
const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phone: phone.optional(),
  email: z.string().trim().toLowerCase().email().nullish(),
  source: z.string().trim().max(100).nullish(),
  interest: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(1000).nullish(),
  assigned_to: uuid.nullish(),
  trial_at: z.string().datetime({ offset: true }).nullish(),
});
const statusSchema = z.object({ status: z.enum(['new', 'contacted', 'trial_booked', 'lost']) });
const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(STATUSES).optional(),
  branch_id: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

const toApi = (l: Lead) => ({
  id: l.id,
  name: l.name,
  phone: l.phone,
  email: l.email,
  source: l.source,
  interest: l.interest,
  status: l.status,
  note: l.note,
  branch_id: l.branchId,
  assigned_to: l.assignedTo,
  trial_at: l.trialAt,
  member_id: l.memberId,
  created_at: l.createdAt,
  updated_at: l.updatedAt,
});

async function load(req: Request, id: string) {
  const l = await prisma.lead.findUnique({ where: { id } });
  if (!l || !branchAllowed(req.access!, l.branchId)) throw notFound('Lead not found');
  return l;
}

async function assertAssignee(id?: string | null) {
  if (id && !(await prisma.user.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Assignee not found');
}

leadsRouter.get('/', authorize('leads.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.LeadWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.status) where.status = q.status;
  if (q.q) where.OR = [{ name: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }, { email: { contains: q.q, mode: 'insensitive' } }];
  const [total, rows] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  res.json({ data: rows.map(toApi), meta: { page: q.page, limit: q.limit, total } });
});

leadsRouter.post('/', authorize('leads.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  await assertAssignee(b.assigned_to);
  const l = await prisma.lead.create({
    data: {
      name: b.name,
      phone: b.phone,
      email: b.email ?? null,
      source: b.source ?? null,
      interest: b.interest ?? null,
      note: b.note ?? null,
      branchId,
      assignedTo: b.assigned_to ?? null,
      trialAt: b.trial_at ? new Date(b.trial_at) : null,
    },
  });
  await audit(req.auth!.userId, 'lead.created', { after: toApi(l) }, req.ip, l.id);
  res.status(201).json({ data: toApi(l) });
});

leadsRouter.patch('/:id', authorize('leads.update'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = patchSchema.parse(req.body);
  const cur = await load(req, id);
  await assertAssignee(b.assigned_to);
  const l = await prisma.lead.update({
    where: { id },
    data: {
      ...(b.name !== undefined && { name: b.name }),
      ...(b.phone !== undefined && { phone: b.phone }),
      ...(b.email !== undefined && { email: b.email }),
      ...(b.source !== undefined && { source: b.source }),
      ...(b.interest !== undefined && { interest: b.interest }),
      ...(b.note !== undefined && { note: b.note }),
      ...(b.assigned_to !== undefined && { assignedTo: b.assigned_to }),
      ...(b.trial_at !== undefined && { trialAt: b.trial_at ? new Date(b.trial_at) : null }),
    },
  });
  await audit(req.auth!.userId, 'lead.updated', { before: toApi(cur), after: toApi(l) }, req.ip, id);
  res.json({ data: toApi(l) });
});

leadsRouter.post('/:id/status', authorize('leads.update'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { status } = statusSchema.parse(req.body);
  const cur = await load(req, id);
  if (cur.status === 'converted') throw conflict('ALREADY_CONVERTED', 'Lead already converted');
  const l = await prisma.lead.update({ where: { id }, data: { status } });
  await audit(req.auth!.userId, 'lead.status_changed', { from: cur.status, to: status }, req.ip, id);
  res.json({ data: toApi(l) });
});

leadsRouter.post('/:id/convert', authorize('leads.update'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const cur = await load(req, id);
  if (cur.status === 'converted') throw conflict('ALREADY_CONVERTED', 'Lead already converted');
  if (await prisma.member.findFirst({ where: { phone: cur.phone }, select: { id: true } })) {
    throw conflict('DUPLICATE_PHONE', 'Phone number already exists');
  }
  const memberCode = await nextMemberCode();
  const m = await prisma.member.create({
    data: { code: memberCode, name: cur.name, phone: cur.phone, email: cur.email, branchId: cur.branchId },
  });
  const l = await prisma.lead.update({ where: { id }, data: { status: 'converted', memberId: m.id } });
  await audit(req.auth!.userId, 'lead.converted', { member_id: m.id }, req.ip, id);
  await audit(req.auth!.userId, 'member.created', { after: { id: m.id, code: m.code, name: m.name, phone: m.phone, from_lead: id } }, req.ip, m.id);
  res.json({ data: { lead: toApi(l), member: { id: m.id, code: m.code, name: m.name, phone: m.phone, branch_id: m.branchId } } });
});
