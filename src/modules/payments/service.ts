import crypto from 'crypto';
import type { Payment } from '@prisma/client';
import { audit } from '../../lib/audit';
import { conflict } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { addEvent, lockContract, recalcPaid } from '../contracts/service';

export const newRef = () => `GH${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

export async function confirmPayment(paymentId: string, byUser: string | null, source: 'manual' | 'webhook', ip?: string) {
  const first = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const result = await prisma.$transaction(async (tx) => {
    await lockContract(tx, first.contractId);
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.status === 'confirmed') return { payment: p, replay: true };
    if (p.status !== 'pending') throw conflict('INVALID_STATE', `Cannot confirm a payment in status ${p.status}`);
    const c = await tx.contract.findUniqueOrThrow({ where: { id: p.contractId } });
    if (['cancelled', 'expired'].includes(c.status)) throw conflict('INVALID_STATE', `Contract is ${c.status}`);
    if (c.paidAmount + p.amount > c.totalAmount) throw conflict('AMOUNT_EXCEEDS_DEBT', 'Confirming would overpay the contract');
    const r = await tx.payment.updateMany({
      where: { id: p.id, status: 'pending' },
      data: { status: 'confirmed', confirmedAt: new Date(), confirmedBy: byUser },
    });
    const fresh = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    if (!r.count) return { payment: fresh, replay: true };
    const paid = await recalcPaid(tx, p.contractId);
    await addEvent(tx, p.contractId, 'payment_confirmed', byUser, source, { payment_id: p.id, amount: p.amount, method: p.method, paid_amount: paid });
    return { payment: fresh, replay: false };
  });
  if (!result.replay) {
    await audit(byUser, source === 'webhook' ? 'payment.webhook_confirmed' : 'payment.confirmed', {
      payment_id: paymentId,
      ref: first.ref,
      amount: first.amount,
    }, ip, paymentId);
  }
  return result;
}

export type { Payment };
