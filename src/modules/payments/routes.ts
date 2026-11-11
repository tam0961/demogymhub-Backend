import crypto from 'crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Payment, Prisma } from '@prisma/client';
import { config } from '../../config';
import { audit } from '../../lib/audit';
import { DATE_RE, dayRange } from '../../lib/dates';
import { badRequest, conflict, HttpError, notFound, unauthorized } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { addEvent, lockContract, paymentToApi, recalcPaid } from '../contracts/service';
import { branchFilter } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';
import { confirmPayment, newRef } from './service';

export const paymentsRouter = Router();

const uuid = z.string().uuid();

// Public webhook: HMAC-SHA256 over `${X-Timestamp}.${rawBody}` in X-Signature (hex).
paymentsRouter.post('/webhook', async (req, res) => {
  const body = (req.body ?? {}) as { ref?: unknown; amount?: unknown; status?: unknown };
  const log = (result: string, signatureOk: boolean) =>
    prisma.paymentWebhookDelivery
      .create({
        data: {
          ref: typeof body.ref === 'string' ? body.ref.slice(0, 100) : null,
          amount: Number.isInteger(body.amount) ? (body.amount as number) : null,
          statusIn: typeof body.status === 'string' ? body.status.slice(0, 30) : null,
          signatureOk,
          result,
          ip: req.ip ?? null,
        },
      })
      .catch(() => undefined);
  const reject = async (result: string, code: string) => {
    await log(result, false);
    throw unauthorized(code, 'Invalid webhook signature');
  };

  const secret = config.PAYMENT_WEBHOOK_SECRET;
  const raw = req.rawBody;
  const ts = Number(req.header('x-timestamp'));
  const sig = req.header('x-signature') ?? '';
  if (!secret) return reject('secret_not_configured', 'INVALID_SIGNATURE');
  if (!raw || !Number.isFinite(ts)) return reject('missing_timestamp_or_body', 'INVALID_SIGNATURE');
  if (Math.abs(Date.now() / 1000 - ts) > config.WEBHOOK_TOLERANCE_SEC) return reject('stale_timestamp', 'STALE_TIMESTAMP');
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.`).update(raw).digest();
  const given = /^[0-9a-f]{64}$/i.test(sig) ? Buffer.from(sig, 'hex') : Buffer.alloc(0);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return reject('bad_signature', 'INVALID_SIGNATURE');

  const parsed = z
    .object({ ref: z.string().min(1).max(100), amount: z.number().int().positive(), status: z.enum(['confirmed', 'paid', 'success', 'failed']) })
    .safeParse(req.body);
  if (!parsed.success) {
    await log('invalid_body', true);
    throw badRequest('VALIDATION_ERROR', 'ref, amount and status are required');
  }
  const b = parsed.data;
  const p = await prisma.payment.findUnique({ where: { ref: b.ref } });
  if (!p) {
    await log('unknown_ref', true);
    throw notFound('Payment not found');
  }
  if (p.amount !== b.amount) {
    await log('amount_mismatch', true);
    throw badRequest('AMOUNT_MISMATCH', 'Amount does not match the payment');
  }
  if (b.status === 'failed') {
    const r = await prisma.payment.updateMany({ where: { id: p.id, status: 'pending' }, data: { status: 'failed' } });
    await log(r.count ? 'failed' : 'ignored', true);
    if (r.count) await audit(null, 'payment.webhook_failed', { payment_id: p.id, ref: p.ref }, req.ip, p.id);
    return res.json({ data: { ref: p.ref, status: r.count ? 'failed' : p.status, replay: !r.count } });
  }
  try {
    const r = await confirmPayment(p.id, null, 'webhook', req.ip);
    await log(r.replay ? 'replay' : 'confirmed', true);
    return res.json({ data: { ref: p.ref, status: r.payment.status, replay: r.replay } });
  } catch (e) {
    await log(e instanceof HttpError ? e.code : 'error', true);
    throw e;
  }
});

paymentsRouter.use(authenticate);

const createSchema = z.object({
  contract_id: uuid,
  method: z.enum(['cash', 'transfer', 'vietqr', 'ewallet']),
  amount: z.number().int().positive(),
  ref: z.string().trim().regex(/^[A-Za-z0-9_-]{6,64}$/, 'ref must be 6-64 chars of A-Z a-z 0-9 _ -').optional(),
  note: z.string().trim().max(500).nullish(),
});
const listSchema = z.object({
  contract_id: uuid.optional(),
  shift_id: uuid.optional(),
  status: z.enum(['pending', 'confirmed', 'failed', 'refunded']).optional(),
  method: z.enum(['cash', 'transfer', 'vietqr', 'ewallet']).optional(),
  date: z.string().regex(DATE_RE).optional(),
  branch_id: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const reason = z.string().trim().min(1).max(500);

async function scopedPayment(req: Request, id: string) {
  const p = await prisma.payment.findUnique({ where: { id } });
  if (!p || !branchAllowed(req.access!, p.branchId)) throw notFound('Payment not found');
  return p;
}

const sameRequest = (p: Payment, b: z.infer<typeof createSchema>) => p.contractId === b.contract_id && p.method === b.method && p.amount === b.amount;

paymentsRouter.post('/', authorize('payments.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const userId = req.auth!.userId;
  const contract = await prisma.contract.findUnique({ where: { id: b.contract_id } });
  if (!contract || !branchAllowed(req.access!, contract.branchId)) throw notFound('Contract not found');

  const replay = async () => {
    const ex = b.ref ? await prisma.payment.findUnique({ where: { ref: b.ref } }) : null;
    if (!ex) return null;
    if (!sameRequest(ex, b)) throw conflict('DUPLICATE_PAYMENT', 'A different payment already uses this ref');
    return ex;
  };
  const existing = await replay();
  if (existing) return res.status(200).json({ data: paymentToApi(existing) });

  const shift = await prisma.shift.findFirst({ where: { userId, closedAt: null } });
  if (b.method === 'cash') {
    if (!shift) throw conflict('SHIFT_REQUIRED', 'Open a shift before taking cash');
    if (shift.branchId !== contract.branchId) throw conflict('SHIFT_BRANCH_MISMATCH', 'Open shift belongs to a different branch');
  }

  let payment: Payment;
  try {
    payment = await prisma.$transaction(async (tx) => {
      await lockContract(tx, contract.id);
      const c = await tx.contract.findUniqueOrThrow({ where: { id: contract.id } });
      if (['cancelled', 'expired'].includes(c.status)) throw conflict('INVALID_STATE', `Contract is ${c.status}`);
      if (b.amount > c.totalAmount - c.paidAmount) throw badRequest('AMOUNT_EXCEEDS_DEBT', 'Amount exceeds remaining debt');
      const cash = b.method === 'cash';
      const p = await tx.payment.create({
        data: {
          contractId: c.id,
          branchId: c.branchId,
          method: b.method,
          amount: b.amount,
          status: cash ? 'confirmed' : 'pending',
          ref: b.ref ?? newRef(),
          shiftId: shift && shift.branchId === c.branchId ? shift.id : null,
          note: b.note ?? null,
          createdBy: userId,
          confirmedAt: cash ? new Date() : null,
          confirmedBy: cash ? userId : null,
        },
      });
      if (cash) {
        const paid = await recalcPaid(tx, c.id);
        await addEvent(tx, c.id, 'payment_confirmed', userId, 'cash', { payment_id: p.id, amount: p.amount, method: 'cash', paid_amount: paid });
      } else {
        await addEvent(tx, c.id, 'payment_created', userId, null, { payment_id: p.id, amount: p.amount, method: p.method, ref: p.ref });
      }
      return p;
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      const again = await replay();
      if (again) return res.status(200).json({ data: paymentToApi(again) });
    }
    throw e;
  }
  await audit(userId, 'payment.created', { payment_id: payment.id, contract_id: contract.id, method: payment.method, amount: payment.amount, status: payment.status, ref: payment.ref }, req.ip, payment.id);
  res.status(201).json({ data: paymentToApi(payment) });
});

paymentsRouter.get('/', authorize('payments.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.PaymentWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.contract_id) where.contractId = q.contract_id;
  if (q.shift_id) where.shiftId = q.shift_id;
  if (q.status) where.status = q.status;
  if (q.method) where.method = q.method;
  if (q.date) where.createdAt = dayRange(q.date);
  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, include: { contract: { select: { id: true, code: true, member: { select: { name: true } } } } } }),
  ]);
  res.json({ data: rows.map(paymentToApi), meta: { page: q.page, limit: q.limit, total } });
});

paymentsRouter.get('/:id/qr', authorize('payments.read'), async (req, res) => {
  const p = await scopedPayment(req, uuid.parse(req.params.id));
  if (p.status !== 'pending') throw conflict('INVALID_STATE', `Payment is ${p.status}`);
  const { VIETQR_BANK_ID: bank, VIETQR_ACCOUNT_NO: acc, VIETQR_ACCOUNT_NAME: name } = config;
  if (!bank || !acc) throw new HttpError(503, 'QR_NOT_CONFIGURED', 'VietQR bank account is not configured');
  const qs = new URLSearchParams({ amount: String(p.amount), addInfo: p.ref, accountName: name });
  res.json({
    data: {
      payment_id: p.id,
      status: p.status,
      transfer_content: p.ref,
      bank: { bank_id: bank, account_no: acc, account_name: name },
      amount: p.amount,
      qr_url: `https://img.vietqr.io/image/${encodeURIComponent(bank)}-${encodeURIComponent(acc)}-compact2.png?${qs.toString()}`,
    },
  });
});

paymentsRouter.post('/:id/confirm', authorize('payments.confirm'), async (req, res) => {
  const p = await scopedPayment(req, uuid.parse(req.params.id));
  const r = await confirmPayment(p.id, req.auth!.userId, 'manual', req.ip);
  res.json({ data: paymentToApi(r.payment) });
});

paymentsRouter.post('/:id/refund-request', authorize('payments.refund_request'), async (req, res) => {
  const b = z.object({ reason }).parse(req.body);
  const p = await scopedPayment(req, uuid.parse(req.params.id));
  const userId = req.auth!.userId;
  const out = await prisma.$transaction(async (tx) => {
    await lockContract(tx, p.contractId);
    const cur = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    if (cur.status !== 'confirmed') throw conflict('INVALID_STATE', `Cannot request a refund for a ${cur.status} payment`);
    if (cur.refundRequestedAt) throw conflict('INVALID_STATE', 'Refund already requested');
    const u = await tx.payment.update({ where: { id: p.id }, data: { refundRequestedAt: new Date(), refundRequestedBy: userId, refundReason: b.reason } });
    await addEvent(tx, p.contractId, 'refund_requested', userId, b.reason, { payment_id: p.id, amount: p.amount });
    return u;
  });
  await audit(userId, 'payment.refund_requested', { payment_id: p.id, amount: p.amount, reason: b.reason }, req.ip, p.id);
  res.json({ data: paymentToApi(out) });
});

paymentsRouter.post('/:id/refund', authorize('payments.refund'), async (req, res) => {
  const b = z.object({ reason: reason.optional() }).parse(req.body ?? {});
  const p = await scopedPayment(req, uuid.parse(req.params.id));
  const userId = req.auth!.userId;
  let refundShiftId: string | null = null;
  if (p.method === 'cash') {
    const shift = await prisma.shift.findFirst({ where: { userId, closedAt: null } });
    if (!shift) throw conflict('SHIFT_REQUIRED', 'Open a shift before refunding cash');
    refundShiftId = shift.id;
  }
  const out = await prisma.$transaction(async (tx) => {
    await lockContract(tx, p.contractId);
    const cur = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    if (cur.status !== 'confirmed') throw conflict('INVALID_STATE', `Cannot refund a ${cur.status} payment`);
    const u = await tx.payment.update({
      where: { id: p.id },
      data: { status: 'refunded', refundedAt: new Date(), refundedBy: userId, refundShiftId, refundReason: b.reason ?? cur.refundReason },
    });
    const paid = await recalcPaid(tx, p.contractId);
    await addEvent(tx, p.contractId, 'payment_refunded', userId, b.reason ?? cur.refundReason, { payment_id: p.id, amount: p.amount, method: p.method, paid_amount: paid });
    return u;
  });
  await audit(userId, 'payment.refunded', { payment_id: p.id, amount: p.amount, method: p.method, reason: b.reason ?? null }, req.ip, p.id);
  res.json({ data: paymentToApi(out) });
});
