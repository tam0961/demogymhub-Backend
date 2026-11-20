import { Router, type Request } from 'express';
import { z } from 'zod';
import type { InbodyRecord } from '@prisma/client';
import { audit } from '../../lib/audit';
import { DATE_RE, dateOnly, todayVN } from '../../lib/dates';
import { forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchAllowed } from '../rbac/service';

export const inbodyRouter = Router();
inbodyRouter.use(authenticate);

const uuid = z.string().uuid();
const num = (min: number, max: number) => z.number().min(min).max(max);

const createSchema = z.object({
  measured_on: z.string().regex(DATE_RE).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date').refine((s) => s <= todayVN(), 'future date').optional(),
  weight: num(20, 300),
  height: num(100, 250),
  body_fat: num(1, 70),
  muscle: num(5, 150),
  source: z.string().trim().min(1).max(30).default('manual'),
  note: z.string().trim().max(500).nullish(),
});

const toApi = (r: InbodyRecord, byName: string | null) => ({
  id: r.id,
  member_id: r.memberId,
  measured_on: r.measuredOn.toISOString().slice(0, 10),
  weight: Number(r.weight),
  height: Number(r.height),
  body_fat: Number(r.bodyFat),
  muscle: Number(r.muscle),
  source: r.source,
  note: r.note,
  created_by: r.createdBy,
  created_by_name: byName,
  created_at: r.createdAt,
});

async function scopedMember(req: Request, id: string) {
  const m = await prisma.member.findUnique({ where: { id }, select: { id: true, branchId: true } });
  if (!m || !branchAllowed(req.access!, m.branchId)) throw notFound('Member not found');
  return m;
}

const names = async (ids: (string | null)[]) => {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
};

inbodyRouter.get('/:id/inbody', authorize('inbody.read'), async (req, res) => {
  const m = await scopedMember(req, uuid.parse(req.params.id));
  const rows = await prisma.inbodyRecord.findMany({ where: { memberId: m.id }, orderBy: [{ measuredOn: 'desc' }, { createdAt: 'desc' }] });
  const n = await names(rows.map((r) => r.createdBy));
  res.json({ data: rows.map((r) => toApi(r, r.createdBy ? (n.get(r.createdBy) ?? null) : null)), meta: { total: rows.length } });
});

inbodyRouter.post('/:id/inbody', authorize('inbody.create'), async (req, res) => {
  const m = await scopedMember(req, uuid.parse(req.params.id));
  const b = createSchema.parse(req.body);
  const userId = req.auth!.userId;
  const r = await prisma.inbodyRecord.create({
    data: {
      memberId: m.id,
      measuredOn: dateOnly(b.measured_on ?? todayVN()),
      weight: b.weight,
      height: b.height,
      bodyFat: b.body_fat,
      muscle: b.muscle,
      source: b.source,
      note: b.note ?? null,
      createdBy: userId,
    },
  });
  await audit(userId, 'inbody.created', { inbody_id: r.id, member_id: m.id, weight: b.weight, body_fat: b.body_fat, muscle: b.muscle }, req.ip, r.id);
  res.status(201).json({ data: toApi(r, (await names([userId])).get(userId) ?? null) });
});

inbodyRouter.delete('/:id/inbody/:recordId', authorize('inbody.create'), async (req, res) => {
  const m = await scopedMember(req, uuid.parse(req.params.id));
  const rid = uuid.parse(req.params.recordId);
  const r = await prisma.inbodyRecord.findUnique({ where: { id: rid } });
  if (!r || r.memberId !== m.id) throw notFound('Record not found');
  const userId = req.auth!.userId;
  if (r.createdBy !== userId && !req.access!.permissions.includes('inbody.delete')) throw forbidden('Chỉ người tạo hoặc người có quyền xóa mới được xóa bản ghi');
  await prisma.inbodyRecord.delete({ where: { id: rid } });
  await audit(userId, 'inbody.deleted', { inbody_id: rid, member_id: m.id }, req.ip, rid);
  res.status(204).end();
});
