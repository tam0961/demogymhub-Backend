import type { PrismaClient } from '@prisma/client';
import { invalidateTv } from '../middlewares/auth';
import { ROLES } from '../modules/rbac/permissions';
import { invalidateAccess } from '../modules/rbac/service';

export interface SetRoleOpts {
  email: string;
  role: string;
  branch?: string;
  force?: boolean;
}

export async function setUserRole(prisma: PrismaClient, o: SetRoleOpts): Promise<string> {
  const email = o.email.trim().toLowerCase();
  const def = ROLES.find((r) => r.key === o.role);
  if (!def) throw new Error(`Unknown role: ${o.role}`);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`User not found: ${email}`);
  let branchId: string | null = null;
  if (!def.global) {
    if (!o.branch) throw new Error(`Role ${o.role} requires --branch`);
    const b = await prisma.branch.findUnique({ where: { code: o.branch } });
    if (!b) throw new Error(`Branch not found: ${o.branch}`);
    branchId = b.id;
  }
  const now = new Date();
  const live = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const current = await prisma.userRole.findMany({ where: { userId: user.id }, include: { role: true, branch: true } });
  const wasSuper = current.some((r) => r.role.key === 'super_admin' && (!r.expiresAt || r.expiresAt > now));
  if (wasSuper && o.role !== 'super_admin' && !o.force) {
    const others = await prisma.user.count({
      where: { id: { not: user.id }, userRoles: { some: { role: { key: 'super_admin' }, ...live } } },
    });
    if (others === 0) throw new Error('Refusing: this is the last super_admin. Use --force to override.');
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { key: o.role } });
  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { userId: user.id } }),
    prisma.userRole.create({ data: { userId: user.id, roleId: role.id, branchId } }),
    prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } }),
    prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
  ]);
  await invalidateAccess(user.id);
  await invalidateTv(user.id);
  const before = current.map((r) => `${r.role.key}${r.branch ? `@${r.branch.code}` : ''}`);
  await prisma.accessAudit.create({
    data: {
      actorId: null,
      action: 'role.converted',
      targetId: user.id,
      metadata: { email, from: before, to: o.role, branch: o.branch ?? null, forced: !!o.force },
    },
  });
  return `${email}: [${before.join(', ') || 'none'}] -> ${o.role}${o.branch && !def.global ? `@${o.branch}` : ''}`;
}

function parseArgs(argv: string[]): SetRoleOpts {
  const m: Record<string, string> = {};
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a.startsWith('--')) m[a.slice(2)] = argv[++i];
  }
  if (!m.email || !m.role) throw new Error('Usage: set-user-role --email <email> --role <role> [--branch <code>] [--force]');
  return { email: m.email, role: m.role, branch: m.branch, force };
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('../lib/prisma') as typeof import('../lib/prisma');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { redis } = require('../lib/redis') as typeof import('../lib/redis');
  (async () => {
    console.log(await setUserRole(prisma, parseArgs(process.argv.slice(2))));
  })()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      redis.disconnect();
    });
}
