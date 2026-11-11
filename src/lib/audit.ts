import { prisma } from './prisma';
import { logger } from './logger';

export async function audit(
  actorId: string | null,
  action: string,
  metadata?: Record<string, unknown>,
  ip?: string,
  targetId?: string,
) {
  try {
    await prisma.accessAudit.create({
      data: { actorId, action, metadata: (metadata ?? {}) as object, ip: ip ?? null, targetId: targetId ?? null },
    });
  } catch (e) {
    logger.error({ err: e }, 'audit write failed');
  }
}
