import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { DATE_RE, addDays, dateOnly, todayVN } from '../../lib/dates';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchFilter } from '../rbac/scope';
import { branchAllowed, can } from '../rbac/service';
import { contractPdf } from './pdf';
import { addEvent, contractToApi, lastPaymentMethods, lockContract, syncMemberStatus, type Tx } from './service';

export const contractsRouter = Router();
contractsRouter.use(authenticate);

const uuid = z.string().uuid();
const date = z.string().regex(DATE_RE).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');

const createSchema = z.object({
  member_id: uuid,
  package_id: uuid,
  discount: z.number().int().min(0).default(0),
  note: z.string().trim().max(500).nullish(),
});
const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  member_id: uuid.optional(),
  status: z.enum(['draft', 'signed', 'active', 'frozen', 'expired', 'cancelled']).optional(),
  branch_id: uuid.optional(),
  expiring_within_days: z.coerce.number().int().min(0).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const reason = z.string().trim().min(1).max(500);

async function scoped(req: Request, id: string) {
  const c = await prisma.contract.findUnique({ where: { id } });
  if (!c || !branchAllowed(req.access!, c.branchId)) throw notFound('Contract not found');
  return c;
}

const invalid = (c: { status: string }, action: string) =>
  conflict('INVALID_STATE', `Cannot ${action} a contract in status ${c.status}`);

async function nextCode(tx: Tx) {
  const r = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('contract_code_seq') AS n`;
  return `CT${r[0].n}`;
}

async function snapshot(memberId: string, packageId: string, discount: number) {
  const [member, pkg] = await Promise.all([
    prisma.member.findUnique({ where: { id: memberId } }),
    prisma.package.findUnique({ where: { id: packageId } }),
  ]);
  return { member, pkg, discount };
}

function priceOf(pkg: { price: number; vatPercent: number }, discount: number) {
  const gross = pkg.price + Math.round((pkg.price * pkg.vatPercent) / 100);
  if (discount > gross) throw badRequest('INVALID_DISCOUNT', 'Discount exceeds total');
  return gross - discount;
}

contractsRouter.post('/', authorize('contracts.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const { member, pkg } = await snapshot(b.member_id, b.package_id, b.discount);
  if (!member || !branchAllowed(req.access!, member.branchId)) throw notFound('Member not found');
  if (!pkg || !branchAllowed(req.access!, pkg.branchId)) throw notFound('Package not found');
  if (pkg.branchId !== member.branchId) throw conflict('BRANCH_MISMATCH', 'Member and package belong to different branches');
  if (!pkg.active) throw conflict('PACKAGE_INACTIVE', 'Package is not active');
  const total = priceOf(pkg, b.discount);
  const userId = req.auth!.userId;
  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.contract.create({
      data: {
        code: await nextCode(tx),
        memberId: member.id,
        packageId: pkg.id,
        branchId: member.branchId,
        totalAmount: total,
        discount: b.discount,
        durationDays: pkg.durationDays,
        sessionsTotal: pkg.sessions,
        sessionsLeft: pkg.sessions,
        note: b.note ?? null,
        createdBy: userId,
      },
      include: { member: true, package: true },
    });
    await addEvent(tx, c.id, 'created', userId, null, { total_amount: total, discount: b.discount, package_id: pkg.id });
    return c;
  });
  await audit(userId, 'contract.created', { contract_id: created.id, code: created.code, total_amount: total }, req.ip, created.id);
  res.status(201).json({ data: contractToApi(created) });
});

contractsRouter.get('/', authorize('contracts.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.ContractWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.member_id) where.memberId = q.member_id;
  if (q.status) where.status = q.status;
  if (q.expiring_within_days !== undefined) {
    const today = dateOnly(todayVN());
    where.status = 'active';
    where.endDate = { gte: today, lte: addDays(today, q.expiring_within_days) };
  }
  if (q.q) {
    where.OR = [
      { code: { contains: q.q, mode: 'insensitive' } },
      { member: { name: { contains: q.q, mode: 'insensitive' } } },
      { member: { phone: { contains: q.q } } },
      { member: { code: { contains: q.q, mode: 'insensitive' } } },
    ];
  }
  const [total, rows] = await Promise.all([
    prisma.contract.count({ where }),
    prisma.contract.findMany({
      where,
      include: { member: true, package: true, branch: true },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
  ]);
  const lpm = await lastPaymentMethods(rows.map((r) => r.id));
  res.json({ data: rows.map((r) => contractToApi(r, { branch: r.branch, last_payment_method: lpm.get(r.id) ?? null })), meta: { page: q.page, limit: q.limit, total } });
});

contractsRouter.get('/:id', authorize('contracts.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const c = await prisma.contract.findUnique({
    where: { id },
    include: { member: true, package: true, branch: true, events: { orderBy: { createdAt: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } } },
  });
  if (!c || !branchAllowed(req.access!, c.branchId)) throw notFound('Contract not found');
  const lpm = await lastPaymentMethods([c.id]);
  res.json({ data: contractToApi(c, { branch: c.branch, last_payment_method: lpm.get(c.id) ?? null }) });
});

contractsRouter.get('/:id/pdf', authorize('contracts.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const c = await prisma.contract.findUnique({ where: { id }, include: { member: true, package: true } });
  if (!c || !branchAllowed(req.access!, c.branchId)) throw notFound('Contract not found');
  const buf = await contractPdf(c);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${c.code}.pdf"`);
  res.send(buf);
});

contractsRouter.post('/:id/sign', authorize('contracts.sign'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ signature: z.string().min(3).max(200000) }).parse(req.body);
  const cur = await scoped(req, id);
  const userId = req.auth!.userId;
  const c = await prisma.$transaction(async (tx) => {
    await lockContract(tx, id);
    const fresh = await tx.contract.findUniqueOrThrow({ where: { id } });
    if (fresh.status !== 'draft') throw invalid(fresh, 'sign');
    const u = await tx.contract.update({
      where: { id },
      data: { status: 'signed', signedAt: new Date(), signatureData: b.signature },
      include: { member: true, package: true },
    });
    await addEvent(tx, id, 'signed', userId, null, { status: { from: 'draft', to: 'signed' } });
    return u;
  });
  await audit(userId, 'contract.signed', { contract_id: cur.id, code: cur.code }, req.ip, cur.id);
  res.json({ data: contractToApi(c) });
});

contractsRouter.post('/:id/activate', authorize('contracts.activate'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ start_date: date.optional(), allow_debt: z.boolean().default(false) }).parse(req.body ?? {});
  const cur = await scoped(req, id);
  const userId = req.auth!.userId;
  if (b.allow_debt && !can(req.access!, 'contracts.approve')) {
    await audit(userId, 'permission.checked.denied', { permission: 'contracts.approve', method: req.method, path: req.originalUrl }, req.ip);
    throw forbidden('You do not have permission: contracts.approve');
  }
  const c = await prisma.$transaction(async (tx) => {
    await lockContract(tx, id);
    const f = await tx.contract.findUniqueOrThrow({ where: { id } });
    if (f.status !== 'signed') throw invalid(f, 'activate');
    if (f.paidAmount < f.totalAmount && !b.allow_debt) {
      throw conflict('PAYMENT_REQUIRED', `Contract is not fully paid (${f.paidAmount}/${f.totalAmount})`);
    }
    const start = b.start_date ? dateOnly(b.start_date) : (f.startDate ?? dateOnly(todayVN()));
    const end = f.durationDays ? addDays(start, f.durationDays) : null;
    const u = await tx.contract.update({
      where: { id },
      data: { status: 'active', startDate: start, endDate: end, activatedAt: new Date() },
      include: { member: true, package: true },
    });
    await addEvent(tx, id, 'activated', userId, b.allow_debt && f.paidAmount < f.totalAmount ? 'activated with debt' : null, {
      status: { from: 'signed', to: 'active' },
      start_date: start.toISOString().slice(0, 10),
      end_date: end ? end.toISOString().slice(0, 10) : null,
      paid_amount: f.paidAmount,
      total_amount: f.totalAmount,
      allow_debt: b.allow_debt,
    });
    await syncMemberStatus(tx, f.memberId);
    return u;
  });
  await audit(userId, 'contract.activated', { contract_id: cur.id, code: cur.code, allow_debt: b.allow_debt }, req.ip, cur.id);
  res.json({ data: contractToApi(c) });
});

contractsRouter.post('/:id/renew', authorize('contracts.create'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ package_id: uuid.optional() }).parse(req.body ?? {});
  const old = await scoped(req, id);
  if (!['active', 'expired', 'frozen'].includes(old.status)) throw invalid(old, 'renew');
  const pkg = await prisma.package.findUnique({ where: { id: b.package_id ?? old.packageId } });
  if (!pkg || !branchAllowed(req.access!, pkg.branchId)) throw notFound('Package not found');
  if (pkg.branchId !== old.branchId) throw conflict('BRANCH_MISMATCH', 'Package belongs to a different branch');
  if (!pkg.active) throw conflict('PACKAGE_INACTIVE', 'Package is not active');
  const today = dateOnly(todayVN());
  const start = old.endDate && old.endDate >= today ? old.endDate : today;
  const userId = req.auth!.userId;
  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.contract.create({
      data: {
        code: await nextCode(tx),
        memberId: old.memberId,
        packageId: pkg.id,
        branchId: old.branchId,
        totalAmount: priceOf(pkg, 0),
        discount: 0,
        durationDays: pkg.durationDays,
        sessionsTotal: pkg.sessions,
        sessionsLeft: pkg.sessions,
        startDate: start,
        renewedFromId: old.id,
        createdBy: userId,
      },
      include: { member: true, package: true },
    });
    await addEvent(tx, c.id, 'created', userId, 'renewal', { renewed_from_id: old.id, start_date: start.toISOString().slice(0, 10) });
    await addEvent(tx, old.id, 'renewed', userId, null, { new_contract_id: c.id });
    return c;
  });
  await audit(userId, 'contract.renewed', { contract_id: old.id, new_contract_id: created.id }, req.ip, old.id);
  res.status(201).json({ data: contractToApi(created) });
});

contractsRouter.post('/:id/freeze', authorize('contracts.freeze'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ days: z.number().int().min(1).max(365), reason }).parse(req.body);
  const cur = await scoped(req, id);
  const userId = req.auth!.userId;
  const c = await prisma.$transaction(async (tx) => {
    await lockContract(tx, id);
    const f = await tx.contract.findUniqueOrThrow({ where: { id } });
    if (f.status !== 'active') throw invalid(f, 'freeze');
    const today = dateOnly(todayVN());
    const newEnd = f.endDate ? addDays(f.endDate, b.days) : null;
    const u = await tx.contract.update({
      where: { id },
      data: { status: 'frozen', frozenUntil: addDays(today, b.days), endDate: newEnd },
      include: { member: true, package: true },
    });
    await addEvent(tx, id, 'frozen', userId, b.reason, {
      status: { from: 'active', to: 'frozen' },
      days: b.days,
      end_date: { from: f.endDate?.toISOString().slice(0, 10) ?? null, to: newEnd?.toISOString().slice(0, 10) ?? null },
    });
    await syncMemberStatus(tx, f.memberId);
    return u;
  });
  await audit(userId, 'contract.frozen', { contract_id: cur.id, days: b.days, reason: b.reason }, req.ip, cur.id);
  res.json({ data: contractToApi(c) });
});

contractsRouter.post('/:id/unfreeze', authorize('contracts.freeze'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const cur = await scoped(req, id);
  const userId = req.auth!.userId;
  const c = await prisma.$transaction(async (tx) => {
    await lockContract(tx, id);
    const f = await tx.contract.findUniqueOrThrow({ where: { id } });
    if (f.status !== 'frozen') throw invalid(f, 'unfreeze');
    const today = dateOnly(todayVN());
    const unused = f.frozenUntil && f.frozenUntil > today ? Math.round((f.frozenUntil.getTime() - today.getTime()) / 86400000) : 0;
    const newEnd = f.endDate ? addDays(f.endDate, -unused) : null;
    const u = await tx.contract.update({
      where: { id },
      data: { status: 'active', frozenUntil: null, endDate: newEnd },
      include: { member: true, package: true },
    });
    await addEvent(tx, id, 'unfrozen', userId, null, {
      status: { from: 'frozen', to: 'active' },
      unused_days: unused,
      end_date: { from: f.endDate?.toISOString().slice(0, 10) ?? null, to: newEnd?.toISOString().slice(0, 10) ?? null },
    });
    await syncMemberStatus(tx, f.memberId);
    return u;
  });
  await audit(userId, 'contract.unfrozen', { contract_id: cur.id }, req.ip, cur.id);
  res.json({ data: contractToApi(c) });
});

contractsRouter.post('/:id/cancel', authorize('contracts.cancel'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ reason }).parse(req.body);
  const cur = await scoped(req, id);
  const userId = req.auth!.userId;
  const c = await prisma.$transaction(async (tx) => {
    await lockContract(tx, id);
    const f = await tx.contract.findUniqueOrThrow({ where: { id } });
    if (['cancelled', 'expired'].includes(f.status)) throw invalid(f, 'cancel');
    const u = await tx.contract.update({ where: { id }, data: { status: 'cancelled' }, include: { member: true, package: true } });
    await addEvent(tx, id, 'cancelled', userId, b.reason, { status: { from: f.status, to: 'cancelled' } });
    await syncMemberStatus(tx, f.memberId);
    return u;
  });
  await audit(userId, 'contract.cancelled', { contract_id: cur.id, reason: b.reason }, req.ip, cur.id);
  res.json({ data: contractToApi(c) });
});
