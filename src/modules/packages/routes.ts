import { Router } from 'express';
import { z } from 'zod';
import type { Package, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';

export const packagesRouter = Router();
packagesRouter.use(authenticate);

const base = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['day', 'month', 'session']),
  duration_days: z.number().int().min(1).max(3650).nullish(),
  sessions: z.number().int().min(1).max(10000).nullish(),
  price: z.number().int().min(0),
  vat_percent: z.number().int().min(0).max(100).default(0),
  branch_id: z.string().uuid().optional(),
  active: z.boolean().default(true),
});

const rule = (v: { type?: string; duration_days?: number | null; sessions?: number | null }) =>
  v.type === 'session' ? !!v.sessions : v.type ? !!v.duration_days : true;
const ruleMsg = { message: 'session packages need sessions; day/month packages need duration_days' };

const createSchema = base.refine(rule, ruleMsg);
const patchSchema = base.omit({ branch_id: true }).partial();

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(['day', 'month', 'session']).optional(),
  active: z.enum(['true', 'false']).optional(),
  branch_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const toApi = (p: Package) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  duration_days: p.durationDays,
  sessions: p.sessions,
  price: p.price,
  vat_percent: p.vatPercent,
  branch_id: p.branchId,
  active: p.active,
});

packagesRouter.get('/', authorize('packages.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.PackageWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.type) where.type = q.type;
  if (q.active) where.active = q.active === 'true';
  if (q.q) where.name = { contains: q.q, mode: 'insensitive' };
  const [total, rows] = await Promise.all([
    prisma.package.count({ where }),
    prisma.package.findMany({ where, orderBy: [{ branchId: 'asc' }, { price: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  res.json({ data: rows.map(toApi), meta: { page: q.page, limit: q.limit, total } });
});

packagesRouter.get('/:id', authorize('packages.read'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const p = await prisma.package.findUnique({ where: { id } });
  if (!p || !branchAllowed(req.access!, p.branchId)) throw notFound('Package not found');
  res.json({ data: toApi(p) });
});

packagesRouter.post('/', authorize('packages.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  const p = await prisma.package.create({
    data: {
      name: b.name,
      type: b.type,
      durationDays: b.duration_days ?? null,
      sessions: b.sessions ?? null,
      price: b.price,
      vatPercent: b.vat_percent,
      active: b.active,
      branchId,
    },
  });
  await audit(req.auth!.userId, 'package.created', { after: toApi(p) }, req.ip, p.id);
  res.status(201).json({ data: toApi(p) });
});

packagesRouter.patch('/:id', authorize('packages.update'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = patchSchema.parse(req.body);
  const cur = await prisma.package.findUnique({ where: { id } });
  if (!cur || !branchAllowed(req.access!, cur.branchId)) throw notFound('Package not found');
  const merged = {
    type: b.type ?? cur.type,
    duration_days: b.duration_days !== undefined ? b.duration_days : cur.durationDays,
    sessions: b.sessions !== undefined ? b.sessions : cur.sessions,
  };
  if (!rule(merged)) {
    const { ZodError } = await import('zod');
    throw new ZodError([{ code: 'custom', path: [], message: ruleMsg.message }]);
  }
  const p = await prisma.package.update({
    where: { id },
    data: {
      ...(b.name !== undefined && { name: b.name }),
      ...(b.type !== undefined && { type: b.type }),
      ...(b.duration_days !== undefined && { durationDays: b.duration_days }),
      ...(b.sessions !== undefined && { sessions: b.sessions }),
      ...(b.price !== undefined && { price: b.price }),
      ...(b.vat_percent !== undefined && { vatPercent: b.vat_percent }),
      ...(b.active !== undefined && { active: b.active }),
    },
  });
  await audit(req.auth!.userId, 'package.updated', { before: toApi(cur), after: toApi(p) }, req.ip, p.id);
  res.json({ data: toApi(p) });
});
