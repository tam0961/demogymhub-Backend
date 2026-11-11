import { Router } from 'express';
import { z } from 'zod';
import type { Shift } from '@prisma/client';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize, authorizeAny } from '../../middlewares/auth';
import { writeBranch } from '../rbac/scope';

export const shiftsRouter = Router();
shiftsRouter.use(authenticate);

const toApi = (s: Shift) => ({
  id: s.id,
  user_id: s.userId,
  branch_id: s.branchId,
  status: s.closedAt ? 'closed' : 'open',
  opened_at: s.openedAt,
  closed_at: s.closedAt,
  opening_cash: s.openingCash,
  expected_cash: s.expectedCash,
  counted_cash: s.countedCash,
  difference: s.difference,
  totals: s.totals,
});

shiftsRouter.post('/open', authorize('shifts.open'), async (req, res) => {
  const b = z.object({ opening_cash: z.number().int().min(0) }).parse(req.body);
  const userId = req.auth!.userId;
  const branchId = writeBranch(req);
  let s: Shift;
  try {
    s = await prisma.shift.create({ data: { userId, branchId, openingCash: b.opening_cash } });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw conflict('SHIFT_ALREADY_OPEN', 'You already have an open shift');
    throw e;
  }
  await audit(userId, 'shift.opened', { shift_id: s.id, opening_cash: b.opening_cash, branch_id: branchId }, req.ip, s.id);
  res.status(201).json({ data: toApi(s) });
});

shiftsRouter.get('/current', authorizeAny('shifts.open', 'shifts.close'), async (req, res) => {
  const s = await prisma.shift.findFirst({ where: { userId: req.auth!.userId, closedAt: null } });
  res.json({ data: s ? toApi(s) : null });
});

shiftsRouter.post('/:id/close', authorize('shifts.close'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = z.object({ counted_cash: z.number().int().min(0) }).parse(req.body);
  const userId = req.auth!.userId;
  const cur = await prisma.shift.findUnique({ where: { id } });
  if (!cur || cur.userId !== userId) throw notFound('Shift not found');
  if (cur.closedAt) throw conflict('INVALID_STATE', 'Shift is already closed');

  const closed = await prisma.$transaction(async (tx) => {
    const inShift = await tx.payment.groupBy({
      by: ['method'],
      where: { shiftId: id, status: 'confirmed' },
      _sum: { amount: true },
      _count: true,
    });
    const byMethod = { cash: 0, transfer: 0, vietqr: 0, ewallet: 0 };
    let count = 0;
    for (const g of inShift) {
      byMethod[g.method] = g._sum.amount ?? 0;
      count += g._count;
    }
    const cashIn = await tx.payment.aggregate({
      where: { shiftId: id, method: 'cash', confirmedAt: { not: null } },
      _sum: { amount: true },
    });
    const cashRefunds = await tx.payment.aggregate({
      where: { refundShiftId: id, method: 'cash', status: 'refunded' },
      _sum: { amount: true },
    });
    const refunds = cashRefunds._sum.amount ?? 0;
    const expected = cur.openingCash + (cashIn._sum.amount ?? 0) - refunds;
    const r = await tx.shift.updateMany({
      where: { id, closedAt: null },
      data: {
        closedAt: new Date(),
        countedCash: b.counted_cash,
        expectedCash: expected,
        difference: b.counted_cash - expected,
        totals: { by_method: byMethod, cash_refunds: refunds, payments_count: count },
      },
    });
    if (!r.count) throw conflict('INVALID_STATE', 'Shift is already closed');
    return tx.shift.findUniqueOrThrow({ where: { id } });
  });
  await audit(userId, 'shift.closed', { shift_id: id, expected_cash: closed.expectedCash, counted_cash: closed.countedCash, difference: closed.difference }, req.ip, id);
  const t = closed.totals as { by_method: Record<string, number>; cash_refunds: number };
  res.json({
    data: {
      ...toApi(closed),
      totals_by_method: t.by_method,
      cash_refunds: t.cash_refunds,
    },
  });
});
