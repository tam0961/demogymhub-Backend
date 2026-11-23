import { Router } from 'express';
import { z } from 'zod';
import type { DayTicket, Payment, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { DATE_RE, dateOnly, todayVN } from '../../lib/dates';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { newRef } from '../payments/service';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';

export const dayTicketsRouter = Router();
dayTicketsRouter.use(authenticate);

export const DAY_TICKET_PRICE = 100000;
const PRICE_KEY = 'day_ticket_price';

export async function dayTicketPrice() {
  const row = await prisma.setting.findUnique({ where: { key: PRICE_KEY } });
  const v = row?.value;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DAY_TICKET_PRICE;
}

const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s.\-()]/g, ''))
  .pipe(z.string().regex(/^\+?\d{9,15}$/, 'invalid phone'));

const METHOD = { cash: 'cash', transfer: 'transfer', card: 'card', momo: 'ewallet' } as const;

const saleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone,
  method: z.enum(['cash', 'transfer', 'card', 'momo']),
  branch_id: z.string().uuid().optional(),
  branch: z.string().uuid().optional(),
});
const listSchema = z.object({
  date: z.string().regex(DATE_RE).optional(),
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  branch_id: z.string().uuid().optional(),
});

type Row = DayTicket & { payment: Payment };

async function staffNames(ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

const toApi = (t: Row, names: Map<string, string>) => ({
  id: t.id,
  name: t.name,
  phone: t.phone,
  branch_id: t.branchId,
  issued_on: t.issuedOn.toISOString().slice(0, 10),
  amount: t.payment.amount,
  method: t.payment.method,
  payment_id: t.paymentId,
  payment_status: t.payment.status,
  checked_out_at: t.checkedOutAt,
  created_at: t.createdAt,
  created_by: t.createdBy,
  created_by_name: t.createdBy ? (names.get(t.createdBy) ?? null) : null,
});

dayTicketsRouter.get('/', authorize('day_tickets.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const from = q.from ?? q.date ?? todayVN();
  const to = q.to ?? q.date ?? from;
  const where: Prisma.DayTicketWhereInput = { ...branchFilter(req, q.branch_id), issuedOn: { gte: dateOnly(from), lte: dateOnly(to) } };
  const rows = await prisma.dayTicket.findMany({ where, orderBy: { createdAt: 'desc' }, include: { payment: true }, take: 500 });
  const names = await staffNames(rows.map((r) => r.createdBy));
  const live = rows.filter((r) => r.payment.status === 'confirmed');
  res.json({
    data: rows.map((r) => toApi(r, names)),
    meta: { from, to, count: live.length, total: live.reduce((s, r) => s + r.payment.amount, 0), price: await dayTicketPrice() },
  });
});

dayTicketsRouter.post('/', authorize('day_tickets.create'), async (req, res) => {
  const b = saleSchema.parse(req.body);
  const userId = req.auth!.userId;
  const branchId = writeBranch(req, b.branch_id ?? b.branch);
  const today = todayVN();

  const member = await prisma.member.findUnique({ where: { phone: b.phone }, select: { id: true, name: true } });
  if (member) {
    const live = await prisma.contract.findFirst({
      where: { memberId: member.id, status: 'active', package: { category: 'member' }, OR: [{ endDate: null }, { endDate: { gte: dateOnly(today) } }] },
      select: { id: true },
    });
    if (live) throw conflict('MEMBER_HAS_CONTRACT', `Số điện thoại thuộc hội viên ${member.name} đang còn hợp đồng, không bán vé lẻ`);
  }
  const inside = await prisma.dayTicket.findFirst({
    where: { phone: b.phone, issuedOn: dateOnly(today), checkedOutAt: null, payment: { status: 'confirmed' } },
    select: { id: true },
  });
  if (inside) throw conflict('TICKET_ACTIVE', 'Số điện thoại này đã có vé hôm nay và vẫn đang trong phòng tập');

  const shift = await prisma.shift.findFirst({ where: { userId, closedAt: null } });
  const amount = await dayTicketPrice();
  const now = new Date();
  const out = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        kind: 'retail',
        contractId: null,
        branchId,
        method: METHOD[b.method],
        amount,
        status: 'confirmed',
        ref: newRef(),
        shiftId: shift && shift.branchId === branchId ? shift.id : null,
        note: `Vé lẻ 1 ngày: ${b.name} ${b.phone}`,
        createdBy: userId,
        confirmedAt: now,
        confirmedBy: userId,
      },
    });
    const ticket = await tx.dayTicket.create({
      data: { paymentId: payment.id, branchId, name: b.name, phone: b.phone, issuedOn: dateOnly(today), createdBy: userId },
    });
    return { ...ticket, payment };
  });
  await audit(userId, 'day_ticket.sold', { ticket_id: out.id, payment_id: out.paymentId, phone: b.phone, amount, method: b.method, branch_id: branchId }, req.ip, out.id);
  res.status(201).json({ data: toApi(out, await staffNames([userId])) });
});

dayTicketsRouter.post('/:id/checkout', authorize('day_tickets.create'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const t = await prisma.dayTicket.findUnique({ where: { id }, include: { payment: true } });
  if (!t || !branchAllowed(req.access!, t.branchId)) throw notFound('Ticket not found');
  if (t.checkedOutAt) throw conflict('INVALID_STATE', 'Khách đã ra về');
  const u = await prisma.dayTicket.update({ where: { id }, data: { checkedOutAt: new Date() }, include: { payment: true } });
  await audit(req.auth!.userId, 'day_ticket.checkout', { ticket_id: id }, req.ip, id);
  res.json({ data: toApi(u, await staffNames([u.createdBy])) });
});
