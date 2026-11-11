import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { ROLES } from './permissions';

const GLOBAL_ROLES = new Set(ROLES.filter((r) => r.global).map((r) => r.key));

export interface Access {
  roles: string[];
  permissions: string[];
  branchIds: string[];
  allBranches: boolean;
}

const TTL = 300;
const key = (userId: string) => `perms:${userId}`;

export async function invalidateAccess(userId: string) {
  await redis.del(key(userId));
}

export async function loadAccess(userId: string): Promise<Access> {
  const cached = await redis.get(key(userId));
  if (cached) return JSON.parse(cached) as Access;

  const now = new Date();
  const rows = await prisma.userRole.findMany({
    where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
  });

  const roles = [...new Set(rows.map((r) => r.role.key))];
  const permissions = [...new Set(rows.flatMap((r) => r.role.rolePermissions.map((rp) => rp.permission.key)))].sort();
  const allBranches = rows.some((r) => r.branchId === null && GLOBAL_ROLES.has(r.role.key));
  const branchIds = [...new Set(rows.map((r) => r.branchId).filter((b): b is string => !!b))];

  const access: Access = { roles, permissions, branchIds, allBranches };
  await redis.set(key(userId), JSON.stringify(access), 'EX', TTL);
  return access;
}

export function can(access: Access, permission: string) {
  return access.roles.includes('super_admin') || access.permissions.includes(permission);
}

export function branchAllowed(access: Access, branchId: string) {
  return access.roles.includes('super_admin') || access.allBranches || access.branchIds.includes(branchId);
}

export async function assignRole(userId: string, roleKey: string, branchId: string | null, grantedBy?: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const exists = await prisma.userRole.findFirst({ where: { userId, roleId: role.id, branchId }, select: { id: true } });
  if (!exists) await prisma.userRole.create({ data: { userId, roleId: role.id, branchId, grantedBy: grantedBy ?? null } });
  await invalidateAccess(userId);
}

export async function revokeRole(userId: string, roleKey: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.userRole.deleteMany({ where: { userId, roleId: role.id } });
  await invalidateAccess(userId);
}
