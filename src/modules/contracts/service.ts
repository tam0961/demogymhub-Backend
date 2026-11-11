import type { Contract, ContractEvent, Member, Package, Payment, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { dateOnly, fmtDate, todayVN } from '../../lib/dates';
import { logger } from '../../lib/logger';

export type Tx = Prisma.TransactionClient;

export async function lockContract(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${id}::uuid FOR UPDATE`;
}

export async function addEvent(
  tx: Tx,
  contractId: string,
  type: string,
  byUser: string | null,
  reason?: string | null,
  diff?: Record<string, unknown>,
) {
  await tx.contractEvent.create({
    data: { contractId, type, byUser, reason: reason ?? null, diff: (diff ?? {}) as Prisma.InputJsonValue },
  });
}

export async function recalcPaid(tx: Tx, contractId: string) {
  const agg = await tx.payment.aggregate({ where: { contractId, status: 'confirmed' }, _sum: { amount: true } });
  const paid = agg._sum.amount ?? 0;
  await tx.contract.update({ where: { id: contractId }, data: { paidAmount: paid } });
  return paid;
}

export async function syncMemberStatus(tx: Tx, memberId: string) {
  const rows = await tx.contract.findMany({ where: { memberId }, select: { status: true, activatedAt: true } });
  let status: 'active' | 'frozen' | 'expired' | null = null;
  if (rows.some((r) => r.status === 'active')) status = 'active';
  else if (rows.some((r) => r.status === 'frozen')) status = 'frozen';
  else if (rows.some((r) => r.activatedAt)) status = 'expired';
  if (status) await tx.member.update({ where: { id: memberId }, data: { status } });
}

type Full = Contract & { member?: Member; package?: Package; events?: ContractEvent[]; payments?: Payment[] };

export const paymentToApi = (p: Payment) => ({
  id: p.id,
  contract_id: p.contractId,
  method: p.method,
  amount: p.amount,
  status: p.status,
  ref: p.ref,
  shift_id: p.shiftId,
  note: p.note,
  created_by: p.createdBy,
  created_at: p.createdAt,
  confirmed_at: p.confirmedAt,
  refund_requested_at: p.refundRequestedAt,
  refund_reason: p.refundReason,
  refunded_at: p.refundedAt,
});

export function contractToApi(c: Full) {
  return {
    id: c.id,
    code: c.code,
    member_id: c.memberId,
    package_id: c.packageId,
    branch_id: c.branchId,
    status: c.status,
    total_amount: c.totalAmount,
    discount: c.discount,
    paid_amount: c.paidAmount,
    debt_amount: Math.max(0, c.totalAmount - c.paidAmount),
    start_date: fmtDate(c.startDate),
    end_date: fmtDate(c.endDate),
    sessions_total: c.sessionsTotal,
    sessions_left: c.sessionsLeft,
    signed_at: c.signedAt,
    activated_at: c.activatedAt,
    frozen_until: fmtDate(c.frozenUntil),
    renewed_from_id: c.renewedFromId,
    note: c.note,
    created_at: c.createdAt,
    ...(c.member && { member: { id: c.member.id, code: c.member.code, name: c.member.name, phone: c.member.phone } }),
    ...(c.package && { package: { id: c.package.id, name: c.package.name, type: c.package.type } }),
    ...(c.events && {
      events: c.events.map((e) => ({ id: e.id, type: e.type, by_user: e.byUser, reason: e.reason, diff: e.diff, created_at: e.createdAt })),
    }),
    ...(c.payments && { payments: c.payments.map(paymentToApi) }),
  };
}

export async function expireContracts(now = new Date()) {
  const today = dateOnly(todayVN(now));
  const due = await prisma.contract.findMany({ where: { status: 'active', endDate: { lt: today } }, select: { id: true, memberId: true } });
  let expired = 0;
  for (const c of due) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.contract.updateMany({ where: { id: c.id, status: 'active' }, data: { status: 'expired' } });
      if (!r.count) return;
      expired++;
      await addEvent(tx, c.id, 'expired', null, 'past end_date');
      await syncMemberStatus(tx, c.memberId);
    });
  }
  const thaw = await prisma.contract.findMany({ where: { status: 'frozen', frozenUntil: { lt: today } }, select: { id: true, memberId: true } });
  let unfrozen = 0;
  for (const c of thaw) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.contract.updateMany({ where: { id: c.id, status: 'frozen' }, data: { status: 'active', frozenUntil: null } });
      if (!r.count) return;
      unfrozen++;
      await addEvent(tx, c.id, 'unfrozen', null, 'freeze period ended');
      await syncMemberStatus(tx, c.memberId);
    });
  }
  return { expired, unfrozen };
}

export function startExpireJob(everyMs = 3600_000) {
  const run = () => expireContracts().catch((e) => logger.error({ err: e }, 'expireContracts failed'));
  void run();
  const t = setInterval(run, everyMs);
  t.unref();
  return t;
}
