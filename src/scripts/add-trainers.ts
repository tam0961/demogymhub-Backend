import { PrismaClient } from '@prisma/client';
import { hashPassword, randomToken } from '../lib/crypto';

const branchCode = process.argv.find((a) => a.startsWith('--branch='))?.slice(9) ?? 'q7';
const TRAINERS = [
  { name: 'Khánh', email: 'khanh@thgym.local' },
  { name: 'Trang', email: 'trang@thgym.local' },
  { name: 'Thịnh', email: 'thinh@thgym.local' },
];

const prisma = new PrismaClient();

async function main() {
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: branchCode } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'trainer' } });
  for (const t of TRAINERS) {
    let user = await prisma.user.findUnique({ where: { email: t.email } });
    let password: string | null = null;
    if (!user) {
      password = randomToken().slice(0, 14);
      user = await prisma.user.create({ data: { email: t.email, name: t.name, passwordHash: await hashPassword(password), emailVerified: true } });
    }
    const has = await prisma.userRole.findFirst({ where: { userId: user.id, roleId: role.id, branchId: branch.id }, select: { id: true } });
    if (!has) await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, branchId: branch.id } });
    console.log(`${t.name} <${t.email}> ${password ? `created, temp password: ${password}` : 'already exists'} (trainer @ ${branchCode})`);
  }
}

main().finally(() => prisma.$disconnect());
