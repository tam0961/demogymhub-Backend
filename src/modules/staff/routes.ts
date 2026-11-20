import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { hashPassword } from '../../lib/crypto';
import { DATE_RE, dateOnly, todayVN, vnDayOf } from '../../lib/dates';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchAllowed } from '../rbac/service';
import { STAFF_POSITIONS, buildRows, loadProfiles, payrollPositionOf, shiftMonth, staffDetail, type StaffPosition } from './service';

export const staffRouter = Router();
staffRouter.use(authenticate);

const uuid = z.string().uuid();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const date = z.string().regex(DATE_RE).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');
const position = z.enum(STAFF_POSITIONS);

const ROLE_BY_POSITION: Record<StaffPosition, string | null> = {
  pt_fulltime: 'trainer',
  pt_parttime: 'trainer',
  marketing: 'sales',
  sale: 'sales',
  reception: 'receptionist',
  other: null,
};
const STAFF_ROLE_KEYS = ['trainer', 'sales', 'receptionist'];

/** Branches the caller may see: the explicit branch (checked), or every branch for global users, or their own branches. */
function scopeOf(req: Request, branchId?: string): string[] | null {
  const a = req.access!;
  if (branchId) {
    if (!branchAllowed(a, branchId)) throw forbidden('Branch not permitted');
    return [branchId];
  }
  if (a.allBranches || a.roles.includes('super_admin')) return null;
  return a.branchIds;
}

const currentMonth = () => vnDayOf(new Date()).slice(0, 7);

async function profileInScope(req: Request, userId: string) {
  const [p] = await loadProfiles(scopeOf(req), userId);
  if (!p) throw notFound('Staff not found');
  return p;
}

staffRouter.get('/', authorize('staff.read'), async (req, res) => {
  const q = z.object({ month: month.optional(), branch_id: uuid.optional() }).parse(req.query);
  const m = q.month ?? currentMonth();
  const branchIds = scopeOf(req, q.branch_id);
  const rows = await buildRows(await loadProfiles(branchIds), m, branchIds);
  res.json({ data: { month: m, prev_month: shiftMonth(m, -1), rows } });
});

staffRouter.get('/:userId', authorize('staff.read'), async (req, res) => {
  const userId = uuid.parse(req.params.userId);
  const q = z.object({ month: month.optional() }).parse(req.query);
  const profile = await profileInScope(req, userId);
  res.json({ data: await staffDetail(profile, q.month ?? currentMonth(), scopeOf(req)) });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(20).nullish(),
  position,
  branch_id: uuid,
  hired_on: date.nullish(),
  employee_no: z.string().trim().min(1).max(30).nullish(),
  note: z.string().trim().max(500).nullish(),
});

async function assertEmployeeNoFree(employeeNo: string | null | undefined, selfId?: string) {
  if (!employeeNo) return;
  const taken = await prisma.user.findFirst({ where: { employeeNo, ...(selfId ? { id: { not: selfId } } : {}) }, select: { id: true } });
  if (taken) throw badRequest('EMPLOYEE_NO_TAKEN', 'Employee number already used by another user');
}

async function ensureRole(userId: string, position: StaffPosition, branchId: string, grantedBy: string) {
  const key = ROLE_BY_POSITION[position];
  if (!key) return;
  const role = await prisma.role.findUnique({ where: { key }, select: { id: true } });
  if (!role) return;
  const has = await prisma.userRole.findFirst({ where: { userId, roleId: role.id, branchId }, select: { id: true } });
  if (!has) await prisma.userRole.create({ data: { userId, roleId: role.id, branchId, grantedBy } });
}

async function rowOf(req: Request, userId: string, m = currentMonth()) {
  const branchIds = scopeOf(req);
  const [row] = await buildRows(await loadProfiles(branchIds, userId), m, branchIds);
  return row;
}

staffRouter.post('/', authorize('staff.manage'), async (req, res) => {
  const b = createSchema.parse(req.body);
  if (!branchAllowed(req.access!, b.branch_id)) throw forbidden('Branch not permitted');
  if (!(await prisma.branch.findUnique({ where: { id: b.branch_id }, select: { id: true } }))) throw notFound('Branch not found');
  await assertEmployeeNoFree(b.employee_no);
  const actor = req.auth!.userId;
  const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
  const user = await prisma.user.create({
    data: {
      email: `staff-${randomBytes(4).toString('hex')}@thgym.local`,
      name: b.name,
      passwordHash,
      emailVerified: true,
      status: 'active',
      employeeNo: b.employee_no ?? null,
      staffProfile: { create: { phone: b.phone ?? null, position: b.position, hiredOn: b.hired_on ? dateOnly(b.hired_on) : null, note: b.note ?? null } },
    },
  });
  await ensureRole(user.id, b.position, b.branch_id, actor);
  if (b.employee_no) await prisma.staffPunch.updateMany({ where: { employeeNo: b.employee_no, userId: null }, data: { userId: user.id } });
  await audit(actor, 'staff.created', { user_id: user.id, position: b.position, branch_id: b.branch_id }, req.ip, user.id);
  res.status(201).json({ data: await rowOf(req, user.id) });
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(20).nullish(),
  position: position.optional(),
  branch_id: uuid.optional(),
  hired_on: date.nullish(),
  left_on: date.nullish(),
  employee_no: z.string().trim().min(1).max(30).nullish(),
  note: z.string().trim().max(500).nullish(),
  active: z.boolean().optional(),
});

staffRouter.put('/:userId', authorize('staff.manage'), async (req, res) => {
  const userId = uuid.parse(req.params.userId);
  const b = updateSchema.parse(req.body);
  const cur = await profileInScope(req, userId);
  if (b.branch_id && !branchAllowed(req.access!, b.branch_id)) throw forbidden('Branch not permitted');
  if (b.employee_no !== undefined) await assertEmployeeNoFree(b.employee_no, userId);
  const actor = req.auth!.userId;
  const newPosition = (b.position ?? cur.position) as StaffPosition;

  const profileData: Record<string, unknown> = {};
  if (b.phone !== undefined) profileData.phone = b.phone || null;
  if (b.position !== undefined) profileData.position = b.position;
  if (b.hired_on !== undefined) profileData.hiredOn = b.hired_on ? dateOnly(b.hired_on) : null;
  if (b.note !== undefined) profileData.note = b.note || null;
  if (b.active !== undefined) {
    profileData.active = b.active;
    if (!b.active && b.left_on === undefined && !cur.leftOn) profileData.leftOn = dateOnly(todayVN());
    if (b.active && b.left_on === undefined) profileData.leftOn = null;
  }
  if (b.left_on !== undefined) profileData.leftOn = b.left_on ? dateOnly(b.left_on) : null;

  await prisma.$transaction(async (tx) => {
    if (b.name !== undefined || b.employee_no !== undefined) {
      await tx.user.update({ where: { id: userId }, data: { ...(b.name !== undefined && { name: b.name }), ...(b.employee_no !== undefined && { employeeNo: b.employee_no || null }) } });
    }
    if (Object.keys(profileData).length) await tx.staffProfile.update({ where: { userId }, data: profileData });
    if (b.position !== undefined && cur.user.payrollProfile) {
      await tx.payrollProfile.update({ where: { userId }, data: { position: payrollPositionOf(newPosition) } });
    }
  });

  if (b.employee_no) await prisma.staffPunch.updateMany({ where: { employeeNo: b.employee_no, userId: null }, data: { userId } });

  // roles follow the position and the branch
  const existing = await prisma.userRole.findMany({ where: { userId, branchId: { not: null } }, select: { id: true, roleId: true, branchId: true, role: { select: { key: true } } } });
  const targetBranch = b.branch_id ?? existing[0]?.branchId ?? null;
  if (b.branch_id) {
    for (const r of existing) {
      if (!STAFF_ROLE_KEYS.includes(r.role.key) || r.branchId === b.branch_id) continue;
      const dup = await prisma.userRole.findFirst({ where: { userId, roleId: r.roleId, branchId: b.branch_id }, select: { id: true } });
      if (dup) await prisma.userRole.delete({ where: { id: r.id } });
      else await prisma.userRole.update({ where: { id: r.id }, data: { branchId: b.branch_id } });
    }
  }
  if ((b.position !== undefined || b.branch_id) && targetBranch) await ensureRole(userId, newPosition, targetBranch, actor);

  await audit(actor, 'staff.updated', { user_id: userId, ...(b.position && { position: b.position }), ...(b.active !== undefined && { active: b.active }) }, req.ip, userId);
  res.json({ data: await rowOf(req, userId) });
});
