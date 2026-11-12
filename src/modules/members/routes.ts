import { Router } from 'express';
import { z } from 'zod';
import type { Member, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { HttpError, badRequest, conflict, notFound } from '../../lib/errors';
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
  face_id: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, 'invalid face id')
    .nullish(),
});
const patchSchema = createSchema.omit({ branch_id: true }).partial();

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'expired', 'frozen']).optional(),
  branch_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const toApi = (m: Member, photoAt?: Date | null) => ({
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
  face_id: m.faceId,
  has_photo: !!photoAt,
  photo_version: photoAt ? photoAt.getTime() : null,
  created_at: m.createdAt,
});

async function photoTimes(ids: string[]) {
  if (!ids.length) return new Map<string, Date>();
  const rows = await prisma.memberPhoto.findMany({ where: { memberId: { in: ids } }, select: { memberId: true, updatedAt: true } });
  return new Map(rows.map((r) => [r.memberId, r.updatedAt]));
}

const withExtras = (m: Member, b: { id: string; code: string; name: string }, current_contract: CurrentContract | null, photoAt?: Date | null) => ({
  ...toApi(m, photoAt),
  branch: { id: b.id, code: b.code, name: b.name },
  current_contract,
});

async function assertUnique(phoneVal?: string, code?: string, exceptId?: string, faceId?: string | null) {
  const notSelf = exceptId ? { id: { not: exceptId } } : {};
  if (phoneVal && (await prisma.member.findFirst({ where: { phone: phoneVal, ...notSelf }, select: { id: true } }))) {
    throw conflict('DUPLICATE_PHONE', 'Phone number already exists');
  }
  if (code && (await prisma.member.findFirst({ where: { code, ...notSelf }, select: { id: true } }))) {
    throw conflict('DUPLICATE_CODE', 'Member code already exists');
  }
  if (faceId && (await prisma.member.findFirst({ where: { faceId, ...notSelf }, select: { id: true } }))) {
    throw conflict('DUPLICATE_FACE_ID', 'Face ID already registered to another member');
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
  const [cur, photos] = await Promise.all([currentContracts(rows.map((r) => r.id)), photoTimes(rows.map((r) => r.id))]);
  res.json({ data: rows.map((r) => withExtras(r, r.branch, cur.get(r.id) ?? null, photos.get(r.id))), meta: { page: q.page, limit: q.limit, total } });
});

membersRouter.get('/:id', authorize('members.read'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const m = await prisma.member.findUnique({ where: { id }, include: { branch: true } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  const [cur, photos] = await Promise.all([currentContracts([m.id]), photoTimes([m.id])]);
  res.json({ data: withExtras(m, m.branch, cur.get(m.id) ?? null, photos.get(m.id)) });
});

membersRouter.post('/', authorize('members.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  await assertUnique(b.phone, b.code, undefined, b.face_id);
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
      faceId: b.face_id ?? null,
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
  await assertUnique(b.phone, b.code, id, b.face_id);
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
      ...(b.face_id !== undefined && { faceId: b.face_id }),
    },
  });
  await audit(req.auth!.userId, 'member.updated', { before: toApi(cur), after: toApi(m) }, req.ip, m.id);
  res.json({ data: toApi(m, (await photoTimes([m.id])).get(m.id)) });
});

const MAX_PHOTO_BYTES = 200_000;
const photoSchema = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  image_base64: z.string().min(100).max(280_000),
});

function looksLike(type: string, b: Buffer) {
  if (type === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
}

membersRouter.put('/:id/photo', authorize('members.update'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = photoSchema.parse(req.body);
  const m = await prisma.member.findUnique({ where: { id } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  const data = Buffer.from(b.image_base64, 'base64');
  if (data.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'PHOTO_TOO_LARGE', 'Photo must be 200 KB or smaller');
  if (!looksLike(b.content_type, data)) throw badRequest('INVALID_IMAGE', 'File content does not match the image type');
  const photo = await prisma.memberPhoto.upsert({
    where: { memberId: id },
    create: { memberId: id, contentType: b.content_type, data, updatedAt: new Date() },
    update: { contentType: b.content_type, data, updatedAt: new Date() },
  });
  await audit(req.auth!.userId, 'member.photo_updated', { bytes: data.length }, req.ip, id);
  res.json({ data: toApi(m, photo.updatedAt) });
});

membersRouter.get('/:id/photo', authorize('members.read'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const m = await prisma.member.findUnique({ where: { id }, select: { branchId: true } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  const photo = await prisma.memberPhoto.findUnique({ where: { memberId: id } });
  if (!photo) throw notFound('Photo not found');
  res.setHeader('Content-Type', photo.contentType);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(photo.data));
});

membersRouter.delete('/:id/photo', authorize('members.update'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const m = await prisma.member.findUnique({ where: { id } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  await prisma.memberPhoto.deleteMany({ where: { memberId: id } });
  await audit(req.auth!.userId, 'member.photo_deleted', {}, req.ip, id);
  res.json({ data: toApi(m, null) });
});
