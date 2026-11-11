import { Router } from 'express';
import { z } from 'zod';
import type { Member, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { currentContracts, type CurrentContract } from '../contracts/service';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';

export const membersRouter = Router();
membersRouter.use(authenticate);

const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s.\-()]/g, ''))
  .pipe(z.string().regex(/^\+?\d{9,15}$/, 'invalid phone'));
const dob = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');

const createSchema = z.object({
  code: z.string().trim().min(1).max(32).optional(),
  name: z.string().trim().min(1).max(100),
  phone,
  email: z.string().trim().toLowerCase().email().nullish(),
  gender: z.enum(['male', 'female', 'other']).nullish(),
  dob: dob.nullish(),
  status: z.enum(['active', 'expired', 'frozen']).optional(),
  branch_id: z.string().uuid().optional(),
  avatar_url: z.string().url().max(500).nullish(),
});
const patchSchema = createSchema.omit({ branch_id: true }).partial();

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'expired', 'frozen']).optional(),
  branch_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const toApi = (m: Member) => ({
  id: m.id,
  code: m.code,
  name: m.name,
  phone: m.phone,
  email: m.email,
  gender: m.gender,
  dob: m.dob ? m.dob.toISOString().slice(0, 10) : null,
  status: m.status,
  branch_id: m.branchId,
  avatar_url: m.avatarUrl,
  created_at: m.createdAt,
});

const withExtras = (m: Member, b: { id: string; code: string; name: string }, current_contract: CurrentContract | null) => ({
  ...toApi(m),
  branch: { id: b.id, code: b.code, name: b.name },
  current_contract,
});

async function assertUnique(phoneVal?: string, code?: string, exceptId?: string) {
  const notSelf = exceptId ? { id: { not: exceptId } } : {};
  if (phoneVal && (await prisma.member.findFirst({ where: { phone: phoneVal, ...notSelf }, select: { id: true } }))) {
    throw conflict('DUPLICATE_PHONE', 'Phone number already exists');
  }
  if (code && (await prisma.member.findFirst({ where: { code, ...notSelf }, select: { id: true } }))) {
    throw conflict('DUPLICATE_CODE', 'Member code already exists');
  }
}

async function nextCode() {
  const r = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('member_code_seq') AS n`;
  return `GH${r[0].n}`;
}

membersRouter.get('/', authorize('members.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.MemberWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.status) where.status = q.status;
  if (q.q) {
    where.OR = [
      { name: { contains: q.q, mode: 'insensitive' } },
      { phone: { contains: q.q } },
      { code: { contains: q.q, mode: 'insensitive' } },
      { email: { contains: q.q, mode: 'insensitive' } },
    ];
  }
  const [total, rows] = await Promise.all([
    prisma.member.count({ where }),
    prisma.member.findMany({ where, include: { branch: true }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  const cur = await currentContracts(rows.map((r) => r.id));
  res.json({ data: rows.map((r) => withExtras(r, r.branch, cur.get(r.id) ?? null)), meta: { page: q.page, limit: q.limit, total } });
});

membersRouter.get('/:id', authorize('members.read'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const m = await prisma.member.findUnique({ where: { id }, include: { branch: true } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  const cur = await currentContracts([m.id]);
  res.json({ data: withExtras(m, m.branch, cur.get(m.id) ?? null) });
});

membersRouter.post('/', authorize('members.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  await assertUnique(b.phone, b.code);
  const m = await prisma.member.create({
    data: {
      code: b.code ?? (await nextCode()),
      name: b.name,
      phone: b.phone,
      email: b.email ?? null,
      gender: b.gender ?? null,
      dob: b.dob ? new Date(b.dob) : null,
      status: b.status ?? 'active',
      branchId,
      avatarUrl: b.avatar_url ?? null,
    },
  });
  await audit(req.auth!.userId, 'member.created', { after: toApi(m) }, req.ip, m.id);
  res.status(201).json({ data: toApi(m) });
});

membersRouter.patch('/:id', authorize('members.update'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = patchSchema.parse(req.body);
  const cur = await prisma.member.findUnique({ where: { id } });
  if (!cur || !branchAllowed(req.access!, cur.branchId)) throw notFound('Member not found');
  await assertUnique(b.phone, b.code, id);
  const m = await prisma.member.update({
    where: { id },
    data: {
      ...(b.code !== undefined && { code: b.code }),
      ...(b.name !== undefined && { name: b.name }),
      ...(b.phone !== undefined && { phone: b.phone }),
      ...(b.email !== undefined && { email: b.email }),
      ...(b.gender !== undefined && { gender: b.gender }),
      ...(b.dob !== undefined && { dob: b.dob ? new Date(b.dob) : null }),
      ...(b.status !== undefined && { status: b.status }),
      ...(b.avatar_url !== undefined && { avatarUrl: b.avatar_url }),
    },
  });
  await audit(req.auth!.userId, 'member.updated', { before: toApi(cur), after: toApi(m) }, req.ip, m.id);
  res.json({ data: toApi(m) });
});
