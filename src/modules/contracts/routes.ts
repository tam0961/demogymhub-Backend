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
import { notifyContract } from '../zalo/service';
import { nextContractCode } from './codes';
import { PAY_TERM_DAYS, addEvent, contractToApi, isPtCategory, lastPaymentDates, lastPaymentMethods, lockContract, nextDueDate, syncMemberStatus, type Tx } from './service';

export const contractsRouter = Router();
contractsRouter.use(authenticate);

const uuid = z.string().uuid();
const date = z.string().regex(DATE_RE).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');

const createSchema = z.object({
  member_id: uuid,
  package_id: uuid,
  discount: z.number().int().min(0).default(0),
  promo: z
    .object({ type: z.enum(['bonus_months', 'bonus_days', 'bonus_sessions', 'percent', 'amount']), value: z.number().int().min(1) })
    .nullish(),
  renewed_from_id: uuid.nullish(),
  sale_user_id: uuid.nullish(),
  pt_user_id: uuid.nullish(),
  note: z.string().trim().max(500).nullish(),
});
const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  member_id: uuid.optional(),
  status: z.enum(['draft', 'signed', 'active', 'frozen', 'expired', 'cancelled']).optional(),
  branch_id: uuid.optional(),
  category: z.enum(['member', 'pt_1on1', 'pt_1on2', 'pt_group']).optional(),
  pt_user_id: uuid.optional(),
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

async function snapshot(memberId: string, packageId: string, discount: number) {
  const [member, pkg] = await Promise.all([
    prisma.member.findUnique({ where: { id: memberId } }),
    prisma.package.findUnique({ where: { id: packageId } }),
  ]);
  return { member, pkg, discount };
}

const grossOf = (pkg: { price: number; vatPercent: number }) => pkg.price + Math.round((pkg.price * pkg.vatPercent) / 100);

function applyPromo(
  pkg: { price: number; vatPercent: number; durationDays: number | null; sessions: number | null },
  discount: number,
  promo: { type: string; value: number } | null | undefined,
) {
  let d = discount;
  let duration = pkg.durationDays;
  let sessions = pkg.sessions;
  if (promo) {
    if (promo.type === 'percent') {
      if (promo.value > 100) throw badRequest('INVALID_PROMO', 'Percent must be 100 or less');
      d = Math.round((grossOf(pkg) * promo.value) / 100);
    } else if (promo.type === 'amount') {
      d = promo.value;
    } else if (promo.type === 'bonus_sessions') {
      if (sessions === null) throw badRequest('PROMO_NOT_APPLICABLE', 'Bonus sessions only apply to session packages');
      sessions += promo.value;
    } else {
      if (duration === null) throw badRequest('PROMO_NOT_APPLICABLE', 'Bonus time only applies to time packages');
      duration += promo.type === 'bonus_months' ? promo.value * 30 : promo.value;
    }
  }
  return { discount: d, durationDays: duration, sessions };
}

function priceOf(pkg: { price: number; vatPercent: number }, discount: number) {
  const gross = grossOf(pkg);
  if (discount > gross) throw badRequest('INVALID_DISCOUNT', 'Discount exceeds total');
  return gross - discount;
}


const SALE_ROLES = ['sales', 'receptionist', 'branch_manager', 'manager', 'trainer'];

async function staffList(roles: string[], branchIds: string[] | null) {
  return prisma.user.findMany({
    where: {
      status: 'active',
      OR: [{ staffProfile: null }, { staffProfile: { active: true } }],
      userRoles: { some: { role: { key: { in: roles } }, ...(branchIds ? { OR: [{ branchId: { in: branchIds } }, { branchId: null }] } : {}) } },
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

const saleStaffList = (branchId: string) => staffList(SALE_ROLES, [branchId]);
const ptStaffList = (branchId: string) => staffList(['trainer'], [branchId]);

async function ptStaff(branchId: string, userId: string) {
  const u = (await ptStaffList(branchId)).find((x) => x.id === userId);
  if (!u) throw badRequest('INVALID_PT', 'PT must be an active trainer of the contract branch');
  return u;
}

async function saleStaff(branchId: string, userId: string) {
  const u = (await saleStaffList(branchId)).find((x) => x.id === userId);
  if (!u) throw badRequest('INVALID_SALE', 'Sale user must be an active staff member of the contract branch');
  return u;
}

const editSchema = z.object({
  package_id: uuid.optional(),
  start_date: date.nullish(),
  end_date: date.nullish(),
  total_amount: z.number().int().min(0).optional(),
  sessions_total: z.number().int().min(0).max(1000).nullish(),
  sessions_left: z.number().int().min(0).max(1000).nullish(),
  payment_due_date: date.nullish(),
  note: z.string().trim().max(500).nullish(),
  reason: z.string().trim().min(1).max(500),
});

contractsRouter.patch('/:id', authorize('contracts.edit'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = editSchema.parse(req.body);
  const cur = await scoped(req, id);
  const userId = req.auth!.userId;
  const out = await prisma.$transaction(async (tx) => {
    await lockContract(tx, id);
    const f = await tx.contract.findUniqueOrThrow({ where: { id } });
    if (f.status === 'cancelled') throw invalid(f, 'edit');
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    const toDate = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
    const data: Prisma.ContractUncheckedUpdateInput = {};
    const from: Record<string, unknown> = {};
    const to: Record<string, unknown> = {};
    const DATE_FIELDS = ['startDate', 'endDate', 'paymentDueDate'];
    const set = (key: string, field: keyof Prisma.ContractUncheckedUpdateInput, before: unknown, after: unknown) => {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      (data as Record<string, unknown>)[field as string] = DATE_FIELDS.includes(field as string) ? toDate(after as string | null) : after;
      from[key] = before;
      to[key] = after;
    };
    if (b.package_id !== undefined && b.package_id !== f.packageId) {
      const pkg = await tx.package.findUnique({ where: { id: b.package_id } });
      if (!pkg || (pkg.branchId && pkg.branchId !== f.branchId)) throw badRequest('PACKAGE_INVALID', 'Package not found for this branch');
      set('package_id', 'packageId', f.packageId, pkg.id);
      set('package_name', 'packageName', f.packageName, null);
    }
    if (b.start_date !== undefined) set('start_date', 'startDate', day(f.startDate), b.start_date ?? null);
    if (b.end_date !== undefined) set('end_date', 'endDate', day(f.endDate), b.end_date ?? null);
    if (b.payment_due_date !== undefined) set('payment_due_date', 'paymentDueDate', day(f.paymentDueDate), b.payment_due_date ?? null);
    if (b.total_amount !== undefined) {
      if (b.total_amount < f.paidAmount) throw badRequest('TOTAL_BELOW_PAID', 'Total amount cannot be lower than the amount already paid');
      set('total_amount', 'totalAmount', f.totalAmount, b.total_amount);
    }
    if (b.sessions_total !== undefined) set('sessions_total', 'sessionsTotal', f.sessionsTotal, b.sessions_total ?? null);
    if (b.sessions_left !== undefined) set('sessions_left', 'sessionsLeft', f.sessionsLeft, b.sessions_left ?? null);
    if (b.note !== undefined) set('note', 'note', f.note, b.note ?? null);
    const startD = 'startDate' in data ? (data.startDate as Date | null) : f.startDate;
    const endD = 'endDate' in data ? (data.endDate as Date | null) : f.endDate;
    if (startD && endD && endD < startD) throw badRequest('DATES_INVALID', 'End date cannot be before start date');
    const total = 'sessionsTotal' in data ? (data.sessionsTotal as number | null) : f.sessionsTotal;
    const left = 'sessionsLeft' in data ? (data.sessionsLeft as number | null) : f.sessionsLeft;
    if (total != null && left != null && left > total) throw badRequest('SESSIONS_INVALID', 'Sessions left cannot exceed total sessions');
    if (!Object.keys(data).length) throw badRequest('NOTHING_TO_UPDATE', 'No changes');
    const u = await tx.contract.update({ where: { id }, data, include: { member: true, package: true } });
    await addEvent(tx, id, 'edited', userId, b.reason, { from, to });
    await syncMemberStatus(tx, f.memberId);
    return u;
  });
  await audit(userId, 'contract.edited', { contract_id: cur.id, reason: b.reason }, req.ip, cur.id);
  res.json({ data: contractToApi(out) });
});

contractsRouter.patch('/:id/staff', authorize('contracts.create'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ sale_user_id: uuid.nullish(), pt_user_id: uuid.nullish() }).parse(req.body);
  const cur = await scoped(req, id);
  if (b.pt_user_id && b.pt_user_id === cur.ptUserId) throw conflict('PT_UNCHANGED', 'New PT must be different from the current PT');
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: cur.packageId }, select: { category: true } });
  if (b.pt_user_id === null && isPtCategory(pkg.category)) throw badRequest('PT_REQUIRED', 'PT in charge is required for PT packages');
  const data: { saleUserId?: string | null; saleName?: string | null; ptUserId?: string | null; ptName?: string | null } = {};
  if (b.sale_user_id !== undefined) {
    const u = b.sale_user_id ? await saleStaff(cur.branchId, b.sale_user_id) : null;
    data.saleUserId = u?.id ?? null;
    data.saleName = u?.name ?? null;
  }
  if (b.pt_user_id !== undefined) {
    const u = b.pt_user_id ? await ptStaff(cur.branchId, b.pt_user_id) : null;
    data.ptUserId = u?.id ?? null;
    data.ptName = u?.name ?? null;
  }
  if (!Object.keys(data).length) throw badRequest('NOTHING_TO_UPDATE', 'Provide sale_user_id or pt_user_id');
  const userId = req.auth!.userId;
  const out = await prisma.$transaction(async (tx) => {
    await tx.contract.updateMany({ where: { OR: [{ id }, { bundleOfId: id }] }, data });
    await addEvent(tx, id, 'staff_changed', userId, null, { from: { sale: cur.saleName, pt: cur.ptName }, to: { sale: data.saleName ?? cur.saleName, pt: data.ptName ?? cur.ptName } });
    return tx.contract.findUniqueOrThrow({ where: { id }, include: { member: true, package: true } });
  });
  await audit(userId, 'contract.staff_changed', { contract_id: id, ...data }, req.ip, id);
  res.json({ data: contractToApi(out) });
});

contractsRouter.get('/pt-staff', authorize('contracts.read'), async (req, res) => {
  const q = z.object({ branch_id: uuid.optional() }).parse(req.query);
  if (q.branch_id) {
    if (!branchAllowed(req.access!, q.branch_id)) throw notFound('Branch not found');
    return res.json({ data: await ptStaffList(q.branch_id) });
  }
  const a = req.access!;
  res.json({ data: await staffList(['trainer'], a.allBranches ? null : a.branchIds) });
});

contractsRouter.get('/sale-staff', authorize('contracts.create'), async (req, res) => {
  const q = z.object({ branch_id: uuid }).parse(req.query);
  if (!branchAllowed(req.access!, q.branch_id)) throw notFound('Branch not found');
  res.json({ data: await saleStaffList(q.branch_id) });
});

contractsRouter.post('/', authorize('contracts.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const { member, pkg } = await snapshot(b.member_id, b.package_id, b.discount);
  if (!member || !branchAllowed(req.access!, member.branchId)) throw notFound('Member not found');
  if (!pkg || !branchAllowed(req.access!, pkg.branchId)) throw notFound('Package not found');
  if (pkg.branchId !== member.branchId) throw conflict('BRANCH_MISMATCH', 'Member and package belong to different branches');
  if (!pkg.active) throw conflict('PACKAGE_INACTIVE', 'Package is not active');
  if (pkg.bundleOnly) throw conflict('BUNDLE_ONLY', 'This package is only given together with a PT package');
  const bundledPkg = isPtCategory(pkg.category) && pkg.bundledMemberPackageId ? await prisma.package.findUnique({ where: { id: pkg.bundledMemberPackageId } }) : null;
  if (bundledPkg && !bundledPkg.active) throw conflict('BUNDLED_PACKAGE_INACTIVE', 'The member package included with this PT package is no longer active');
  const eff = applyPromo(pkg, b.discount, b.promo);
  const total = priceOf(pkg, eff.discount);
  const userId = req.auth!.userId;
  const sale = b.sale_user_id ? await saleStaff(member.branchId, b.sale_user_id) : null;
  if (isPtCategory(pkg.category) && !b.pt_user_id) throw badRequest('PT_REQUIRED', 'PT in charge is required for PT packages');
  const pt = b.pt_user_id ? await ptStaff(member.branchId, b.pt_user_id) : null;
  let renewedFromId: string | null = null;
  if (b.renewed_from_id) {
    const old = await scoped(req, b.renewed_from_id);
    if (old.memberId !== member.id) throw conflict('MEMBER_MISMATCH', 'Contract belongs to a different member');
    if (!['active', 'expired', 'frozen'].includes(old.status)) throw invalid(old, 'renew');
    renewedFromId = old.id;
  } else {
    const prev = await prisma.contract.findFirst({ where: { memberId: member.id, status: { in: ['active', 'expired', 'frozen'] } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    renewedFromId = prev?.id ?? null;
  }
  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.contract.create({
      data: {
        code: await nextContractCode(tx, isPtCategory(pkg.category)),
        saleUserId: sale?.id ?? null,
        saleName: sale?.name ?? null,
        ptUserId: pt?.id ?? null,
        ptName: pt?.name ?? null,
        memberId: member.id,
        packageId: pkg.id,
        packageName: pkg.name,
        branchId: member.branchId,
        totalAmount: total,
        discount: eff.discount,
        durationDays: eff.durationDays,
        sessionsTotal: eff.sessions,
        sessionsLeft: eff.sessions,
        renewedFromId,
        paymentDueDate: total > 0 ? nextDueDate() : null,
        note: b.note ?? null,
        createdBy: userId,
      },
      include: { member: true, package: true },
    });
    await addEvent(tx, c.id, 'created', userId, renewedFromId ? 'renewal' : null, {
      total_amount: total,
      discount: eff.discount,
      package_id: pkg.id,
      ...(b.promo && { promo: b.promo }),
      ...(renewedFromId && { renewed_from_id: renewedFromId }),
    });
    let child: (typeof c & { package: NonNullable<typeof c.package> }) | null = null;
    if (bundledPkg) {
      child = await tx.contract.create({
        data: {
          code: await nextContractCode(tx, false),
          saleUserId: sale?.id ?? null,
          saleName: sale?.name ?? null,
          ptUserId: pt?.id ?? null,
          ptName: pt?.name ?? null,
          memberId: member.id,
          packageId: bundledPkg.id,
          packageName: bundledPkg.name,
          branchId: member.branchId,
          totalAmount: 0,
          discount: grossOf(bundledPkg),
          durationDays: bundledPkg.durationDays,
          sessionsTotal: bundledPkg.sessions,
          sessionsLeft: bundledPkg.sessions,
          bundleOfId: c.id,
          note: `Kèm gói PT ${c.code}`,
          createdBy: userId,
        },
        include: { member: true, package: true },
      });
      await addEvent(tx, child.id, 'created', userId, 'bundle', { bundle_of: c.id, package_id: bundledPkg.id });
    }
    return { c, child };
  });
  await audit(userId, 'contract.created', { contract_id: created.c.id, code: created.c.code, total_amount: total, bundled: created.child?.code ?? null }, req.ip, created.c.id);
  res.status(201).json({ data: contractToApi(created.c, created.child ? { bundled: [created.child] } : {}) });
});

contractsRouter.get('/', authorize('contracts.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.ContractWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.member_id) where.memberId = q.member_id;
  if (q.status) where.status = q.status;
  if (q.category) where.package = { category: q.category };
  if (q.pt_user_id) where.ptUserId = q.pt_user_id;
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
  const lpd = await lastPaymentDates(rows.map((r) => r.id));
  res.json({ data: rows.map((r) => contractToApi(r, { branch: r.branch, last_payment_method: lpm.get(r.id) ?? null, last_paid_at: lpd.get(r.id) ?? null })), meta: { page: q.page, limit: q.limit, total } });
});

contractsRouter.get('/:id', authorize('contracts.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const c = await prisma.contract.findUnique({
    where: { id },
    include: {
      member: true,
      package: true,
      branch: true,
      events: { orderBy: { createdAt: 'asc' } },
      payments: { orderBy: { createdAt: 'asc' } },
      bundled: { include: { package: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!c || !branchAllowed(req.access!, c.branchId)) throw notFound('Contract not found');
  const lpm = await lastPaymentMethods([c.id]);
  const actorIds = [...new Set(c.events.map((e) => e.byUser).filter((x): x is string => !!x))];
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
  res.json({ data: contractToApi(c, { branch: c.branch, last_payment_method: lpm.get(c.id) ?? null, user_names: new Map(actors.map((u) => [u.id, u.name])), bundled: c.bundled }) });
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
    const sold = await tx.package.findUniqueOrThrow({ where: { id: fresh.packageId }, select: { name: true } });
    const u = await tx.contract.update({
      where: { id },
      data: { status: 'signed', signedAt: new Date(), signatureData: b.signature, packageName: fresh.packageName ?? sold.name },
      include: { member: true, package: true },
    });
    await addEvent(tx, id, 'signed', userId, null, { status: { from: 'draft', to: 'signed' } });
    const kids = await tx.contract.findMany({ where: { bundleOfId: id, status: 'draft' } });
    for (const k of kids) {
      await lockContract(tx, k.id);
      await tx.contract.update({ where: { id: k.id }, data: { status: 'signed', signedAt: new Date(), signatureData: b.signature } });
      await addEvent(tx, k.id, 'signed', userId, 'bundle', { status: { from: 'draft', to: 'signed' } });
    }
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
      data: { status: 'active', startDate: start, endDate: end, activatedAt: new Date(), ...(f.paidAmount < f.totalAmount && !f.paymentDueDate && { paymentDueDate: addDays(start, PAY_TERM_DAYS) }) },
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
    const kids = await tx.contract.findMany({ where: { bundleOfId: id, status: 'signed' } });
    for (const k of kids) {
      await lockContract(tx, k.id);
      const prev = await tx.contract.findFirst({
        where: { memberId: f.memberId, id: { not: k.id }, status: 'active', package: { category: 'member' }, endDate: { gte: start } },
        orderBy: { endDate: 'desc' },
      });
      const kStart = prev?.endDate ? addDays(prev.endDate, 1) : start;
      const kEnd = k.durationDays ? addDays(kStart, k.durationDays) : null;
      await tx.contract.update({
        where: { id: k.id },
        data: { status: 'active', startDate: kStart, endDate: kEnd, activatedAt: new Date(), renewedFromId: k.renewedFromId ?? prev?.id ?? null },
      });
      await addEvent(tx, k.id, 'activated', userId, 'bundle', {
        status: { from: 'signed', to: 'active' },
        start_date: kStart.toISOString().slice(0, 10),
        end_date: kEnd ? kEnd.toISOString().slice(0, 10) : null,
        bundle_of: id,
        extends_contract_id: prev?.id ?? null,
      });
    }
    await syncMemberStatus(tx, f.memberId);
    return u;
  });
  await audit(userId, 'contract.activated', { contract_id: cur.id, code: cur.code, allow_debt: b.allow_debt }, req.ip, cur.id);
  res.json({ data: contractToApi(c) });
  void notifyContract(cur.id);
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
        code: await nextContractCode(tx, isPtCategory(pkg.category)),
        saleUserId: old.saleUserId,
        saleName: old.saleName,
        ptUserId: old.ptUserId,
        ptName: old.ptName,
        memberId: old.memberId,
        packageId: pkg.id,
        packageName: pkg.name,
        branchId: old.branchId,
        totalAmount: priceOf(pkg, 0),
        discount: 0,
        durationDays: pkg.durationDays,
        sessionsTotal: pkg.sessions,
        sessionsLeft: pkg.sessions,
        startDate: start,
        renewedFromId: old.id,
        paymentDueDate: priceOf(pkg, 0) > 0 ? nextDueDate() : null,
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
    const kids = await tx.contract.findMany({ where: { bundleOfId: id, status: { notIn: ['cancelled', 'expired'] } } });
    for (const k of kids) {
      await lockContract(tx, k.id);
      await tx.contract.update({ where: { id: k.id }, data: { status: 'cancelled' } });
      await addEvent(tx, k.id, 'cancelled', userId, b.reason, { status: { from: k.status, to: 'cancelled' }, bundle_of: id });
    }
    await syncMemberStatus(tx, f.memberId);
    return u;
  });
  await audit(userId, 'contract.cancelled', { contract_id: cur.id, reason: b.reason }, req.ip, cur.id);
  res.json({ data: contractToApi(c) });
});
