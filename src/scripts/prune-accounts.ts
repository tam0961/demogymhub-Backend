import { PrismaClient } from '@prisma/client';
import { hashPassword, randomToken } from '../lib/crypto';
import { invalidateAccess } from '../modules/rbac/service';

const apply = process.argv.includes('--apply');
const keepBranch = process.argv.find((a) => a.startsWith('--receptionist-branch='))?.slice(22) ?? 'q7';
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({ include: { userRoles: { include: { role: true, branch: true } }, staffProfile: true }, orderBy: { createdAt: 'asc' } });
  const supers = users.filter((u) => u.userRoles.some((r) => r.role.key === 'super_admin' || r.role.key === 'owner'));
  if (supers.length === 0) throw new Error('No owner/super_admin account found, refusing to continue');
  console.log(apply ? 'APPLY' : 'DRY RUN (add --apply to execute)');
  for (const u of users) {
    const keys = u.userRoles.map((r) => `${r.role.key}${r.branch ? `@${r.branch.code}` : ''}`);
    const isOwner = u.userRoles.some((r) => r.role.key === 'super_admin' || r.role.key === 'owner');
    const isRecep = u.userRoles.some((r) => r.role.key === 'receptionist' && r.branch?.code === keepBranch);
    const isTrainer = u.userRoles.some((r) => r.role.key === 'trainer') || !!u.staffProfile;
    const isMember = u.userRoles.length > 0 && u.userRoles.every((r) => r.role.key === 'member');
    if (isOwner || isRecep || isMember) { console.log(`KEEP     ${u.email} [${keys.join(', ')}]`); continue; }
    if (isTrainer) {
      console.log(`LOCK     ${u.email} [${keys.join(', ')}] (kept for PT schedule, password scrambled)`);
      if (apply) await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(randomToken()), tokenVersion: { increment: 1 } } });
      continue;
    }
    console.log(`DELETE   ${u.email} [${keys.join(', ')}]`);
    if (!apply) continue;
    try {
      await prisma.user.delete({ where: { id: u.id } });
    } catch {
      console.log(`  has linked data, disabling instead: ${u.email}`);
      await prisma.user.update({ where: { id: u.id }, data: { status: 'disabled', tokenVersion: { increment: 1 } } });
    }
    await invalidateAccess(u.id);
  }
}

main().finally(() => prisma.$disconnect());
