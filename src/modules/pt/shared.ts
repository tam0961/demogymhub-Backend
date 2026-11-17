import type { Request } from 'express';
import { badRequest } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { Tx } from '../contracts/service';
import { can } from '../rbac/service';

export const ownOnly = (req: Request) => !!req.access && req.access.roles.includes('trainer') && !can(req.access, 'pt_sessions.create');

export async function lockKey(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

export async function assertTrainer(trainerId: string, branchId: string) {
  const ok = await prisma.userRole.findFirst({
    where: { userId: trainerId, role: { key: 'trainer' }, user: { status: 'active' }, OR: [{ branchId }, { branchId: null }] },
    select: { id: true },
  });
  if (!ok) throw badRequest('TRAINER_INVALID', 'Trainer not found in this branch');
}
