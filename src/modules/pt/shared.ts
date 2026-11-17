import crypto from 'crypto';
import type { Request } from 'express';
import { config } from '../../config';
import { dayRange } from '../../lib/dates';
import { badRequest, unauthorized } from '../../lib/errors';
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

export function requireBotKey(req: Request) {
  const given = Buffer.from(req.header('x-bot-key') ?? '');
  const want = Buffer.from(config.PT_BOT_KEY);
  if (!config.PT_BOT_KEY || given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw unauthorized('BOT_KEY_INVALID', 'Invalid bot key');
}

/** Syncs the zalo-sourced 1:1 slots of one trainer on one day to the given HH:MM start times (one hour each). */
export async function syncZaloShifts(branchId: string, trainerId: string, date: string, hours: string[]) {
  const day = dayRange(date);
  const slots = [...new Set(hours)].map((h) => {
    const startAt = new Date(`${date}T${h}:00+07:00`);
    return { key: startAt.getTime(), startAt, endAt: new Date(startAt.getTime() + 3600000) };
  });
  return prisma.$transaction(async (tx) => {
    await lockKey(tx, 'pt:' + trainerId);
    const existing = await tx.ptSession.findMany({
      where: { branchId, trainerId, source: 'zalo', startAt: { gte: day.gte, lt: day.lt } },
    });
    const keep = new Set(slots.map((s) => s.key));
    let added = 0;
    let removed = 0;
    let reopened = 0;
    for (const e of existing) {
      if (keep.has(e.startAt.getTime())) {
        if (e.status === 'cancelled') {
          await tx.ptSession.update({ where: { id: e.id }, data: { status: 'scheduled' } });
          reopened++;
        }
      } else if (e.status === 'scheduled') {
        if (e.memberId) await tx.ptSession.update({ where: { id: e.id }, data: { status: 'cancelled' } });
        else await tx.ptSession.delete({ where: { id: e.id } });
        removed++;
      }
    }
    const have = new Set(existing.map((e) => e.startAt.getTime()));
    for (const s of slots.filter((x) => !have.has(x.key))) {
      const clash = await tx.ptSession.findFirst({
        where: { trainerId, status: { in: ['scheduled', 'completed'] }, startAt: { lt: s.endAt }, endAt: { gt: s.startAt } },
        select: { id: true },
      });
      if (clash) continue;
      await tx.ptSession.create({ data: { branchId, trainerId, startAt: s.startAt, endAt: s.endAt, source: 'zalo' } });
      added++;
    }
    return { added, removed, reopened };
  });
}
