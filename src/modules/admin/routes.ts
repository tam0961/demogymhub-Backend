import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { DATE_RE, dayRange } from '../../lib/dates';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { ROLES } from '../rbac/permissions';
import { assignRole, invalidateAccess } from '../rbac/service';

export const adminRouter = Router();
const RANK: Record<string, number> = {
  super_admin: 100,
  owner: 80,
  branch_manager: 60,
  receptionist: 40,
  sales: 40,
  accountant: 40,
  trainer: 30,
  member: 10,
};
const GLOBAL = new Set(ROLES.filter((r) => r.global).map((r) => r.key));
const uuid = z.string().uuid();
const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };

async function guardRole(req: Request, roleKey: string, action: string) {
  const mine = req.access!.roles;
  const isSuper = mine.includes('super_admin');
  const ownRank = Math.max(0, ...mine.map((r) => RANK[r] ?? 0));
  const deny = async (msg: string) => {
    await audit(req.auth!.userId, 'permission.checked.denied', { permission: `roles.${action}`, role: roleKey, method: req.method, path: req.originalUrl }, req.ip);
    throw forbidden(msg);
  };
  if ((roleKey === 'super_admin' || roleKey === 'owner') && !isSuper) return deny('Only super_admin can manage super_admin or owner roles');
  if ((RANK[roleKey] ?? 0) > ownRank) return deny('Cannot manage a role higher than your own');
}

adminRouter.get('/roles', authenticate, authorize('roles.read'), async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { id: 'asc' }, include: { rolePermissions: { include: { permission: true } } } });
  res.json({
    data: roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      is_system: r.isSystem,
      global: GLOBAL.has(r.key),
      permissions: r.rolePermissions.map((rp) => rp.permission.key).sort(),
    })),
  });
});

adminRouter.get('/permissions', authenticate, authorize('roles.read'), async (_req, res) => {
  const rows = await prisma.permission.findMany({ orderBy: { key: 'asc' } });
  res.json({ data: rows.map((p) => ({ id: p.id, key: p.key, resource: p.resource, action: p.action })) });
});

adminRouter.get('/users', authenticate, authorize('roles.read'), async (req, res) => {
  const q = z.object({ q: z.string().trim().max(100).optional(), ...page }).parse(req.query);
  const where: Prisma.UserWhereInput = q.q
    ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }] }
    : {};
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { userRoles: { include: { role: true, branch: true } } },
    }),
  ]);
  res.json({
    data: rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      last_login_at: u.lastLoginAt,
      created_at: u.createdAt,
      roles: u.userRoles.map((ur) => ({
        id: ur.id,
        role: ur.role.key,
        branch_id: ur.branchId,
        branch_code: ur.branch?.code ?? null,
        expires_at: ur.expiresAt,
      })),
    })),
    meta: { page: q.page, limit: q.limit, total },
  });
});

adminRouter.post('/users/:id/roles', authenticate, authorize('roles.assign'), async (req, res) => {
  const userId = uuid.parse(req.params.id);
  const b = z.object({ role: z.string().min(1).max(50), branch_id: uuid.nullish() }).parse(req.body);
  const role = await prisma.role.findUnique({ where: { key: b.role } });
  if (!role) throw notFound('Role not found');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw notFound('User not found');
  await guardRole(req, b.role, 'assign');
  const global = GLOBAL.has(b.role);
  if (!global && !b.branch_id) throw badRequest('BRANCH_REQUIRED', `Role ${b.role} needs a branch_id`);
  if (b.branch_id && !(await prisma.branch.findUnique({ where: { id: b.branch_id }, select: { id: true } }))) throw notFound('Branch not found');
  const branchId = global ? null : (b.branch_id ?? null);
  await assignRole(userId, b.role, branchId, req.auth!.userId);
  await audit(req.auth!.userId, 'role.assigned', { role: b.role, branch_id: branchId }, req.ip, userId);
  const ur = await prisma.userRole.findFirstOrThrow({ where: { userId, roleId: role.id, branchId } });
  res.status(201).json({ data: { id: ur.id, user_id: userId, role: b.role, branch_id: ur.branchId } });
});

adminRouter.delete('/users/:id/roles/:userRoleId', authenticate, authorize('roles.assign'), async (req, res) => {
  const userId = uuid.parse(req.params.id);
  const urId = uuid.parse(req.params.userRoleId);
  const ur = await prisma.userRole.findFirst({ where: { id: urId, userId }, include: { role: true } });
  if (!ur) throw notFound('Role assignment not found');
  await guardRole(req, ur.role.key, 'revoke');
  await prisma.userRole.delete({ where: { id: urId } });
  await invalidateAccess(userId);
  await audit(req.auth!.userId, 'role.revoked', { role: ur.role.key, branch_id: ur.branchId }, req.ip, userId);
  res.json({ data: { id: urId } });
});

adminRouter.get('/audit-logs', authenticate, authorize('system.view_audit_log'), async (req, res) => {
  const q = z
    .object({
      actor: uuid.optional(),
      action: z.string().trim().max(100).optional(),
      from: z.string().regex(DATE_RE).optional(),
      to: z.string().regex(DATE_RE).optional(),
      ...page,
    })
    .parse(req.query);
  const where: Prisma.AccessAuditWhereInput = {};
  if (q.actor) where.actorId = q.actor;
  if (q.action) where.action = { contains: q.action };
  if (q.from || q.to) {
    where.createdAt = { ...(q.from && { gte: dayRange(q.from).gte }), ...(q.to && { lt: dayRange(q.to).lt }) };
  }
  const [total, rows] = await Promise.all([
    prisma.accessAudit.count({ where }),
    prisma.accessAudit.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  const actorIds = [...new Set(rows.map((a) => a.actorId).filter((x): x is string => !!x))];
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } }) : [];
  const emailOf = new Map(actors.map((u) => [u.id, u.email]));
  res.json({
    data: rows.map((a) => ({
      id: a.id.toString(),
      actor_id: a.actorId,
      actor_email: a.actorId ? (emailOf.get(a.actorId) ?? null) : null,
      target_id: a.targetId,
      action: a.action,
      metadata: a.metadata,
      ip: a.ip,
      created_at: a.createdAt,
    })),
    meta: { page: q.page, limit: q.limit, total },
  });
});
