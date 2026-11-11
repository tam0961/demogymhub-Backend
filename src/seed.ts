import type { PrismaClient } from '@prisma/client';
import { config } from './config';
import { hashPassword } from './lib/crypto';
import { PERMISSIONS, ROLES } from './modules/rbac/permissions';

const BRANCHES = [
  { code: 'q2', name: 'Chi nhánh Quận 2' },
  { code: 'nb', name: 'Chi nhánh Nhà Bè' },
  { code: 'q7', name: 'Chi nhánh Quận 7' },
];

const DEMO: { email: string; name: string; role: string; branch: string | null }[] = [
  { email: 'owner@gymhub.local', name: 'Demo Owner', role: 'owner', branch: null },
  { email: 'manager.nb@gymhub.local', name: 'Manager NB', role: 'branch_manager', branch: 'nb' },
  { email: 'manager.q7@gymhub.local', name: 'Manager Q7', role: 'branch_manager', branch: 'q7' },
  { email: 'reception.nb@gymhub.local', name: 'Reception NB', role: 'receptionist', branch: 'nb' },
  { email: 'reception.q7@gymhub.local', name: 'Reception Q7', role: 'receptionist', branch: 'q7' },
  { email: 'sales.nb@gymhub.local', name: 'Sales NB', role: 'sales', branch: 'nb' },
  { email: 'trainer.nb@gymhub.local', name: 'Trainer NB', role: 'trainer', branch: 'nb' },
  { email: 'accountant@gymhub.local', name: 'Demo Accountant', role: 'accountant', branch: null },
  { email: 'member@gymhub.local', name: 'Demo Member', role: 'member', branch: null },
];

export async function seedRbac(prisma: PrismaClient) {
  for (const key of PERMISSIONS) {
    const [resource, action] = key.split('.');
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key, resource, action } });
  }
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name },
      create: { key: r.key, name: r.name, isSystem: true },
    });
    const perms = await prisma.permission.findMany({ where: { key: { in: r.permissions } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
  }
}

export async function seedBranches(prisma: PrismaClient) {
  for (const b of BRANCHES) {
    await prisma.branch.upsert({ where: { code: b.code }, update: { name: b.name }, create: b });
  }
}

async function ensureUser(prisma: PrismaClient, email: string, name: string, password: string, roleKey: string, branchCode: string | null) {
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, name, passwordHash: await hashPassword(password), emailVerified: true },
    });
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const branch = branchCode ? await prisma.branch.findUniqueOrThrow({ where: { code: branchCode } }) : null;
  const has = await prisma.userRole.findFirst({ where: { userId: user.id, roleId: role.id, branchId: branch?.id ?? null } });
  if (!has) await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, branchId: branch?.id ?? null } });
}

export async function provisionOwner(
  prisma: PrismaClient,
  o: { email?: string; password?: string; name?: string },
): Promise<'created' | 'exists' | 'skipped'> {
  if (!o.email || !o.password) return 'skipped';
  const email = o.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) return 'exists';
  const user = await prisma.user.create({
    data: { email, name: o.name || 'Chủ phòng gym', passwordHash: await hashPassword(o.password), emailVerified: true },
  });
  for (const key of ['owner', 'super_admin']) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, branchId: null } });
  }
  return 'created';
}

export async function seedAll(prisma: PrismaClient) {
  await seedRbac(prisma);
  await seedBranches(prisma);
  if (config.SEED_ADMIN_PASSWORD) {
    await ensureUser(prisma, config.SEED_ADMIN_EMAIL.toLowerCase(), 'Super Admin', config.SEED_ADMIN_PASSWORD, 'super_admin', null);
  }
  await provisionOwner(prisma, { email: config.SEED_OWNER_EMAIL, password: config.SEED_OWNER_PASSWORD, name: config.SEED_OWNER_NAME });
  if (config.SEED_DEMO === 'true') {
    const pw = config.SEED_DEMO_PASSWORD ?? 'Demo@12345';
    for (const d of DEMO) await ensureUser(prisma, d.email, d.name, pw, d.role, d.branch);
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('./lib/prisma') as typeof import('./lib/prisma');
  seedAll(prisma)
    .then(() => console.log('seed done'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
