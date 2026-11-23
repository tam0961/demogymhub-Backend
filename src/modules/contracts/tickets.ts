import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Contract, Member, Package, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { addDays, dateOnly, todayVN } from '../../lib/dates';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { newRef } from '../payments/service';
import { branchFilter } from '../rbac/scope';
import { branchAllowed, can, type Access } from '../rbac/service';
import { nextMemberCode } from './codes';
import { addEvent, contractToApi, lockContract, recalcPaid, syncMemberStatus } from './service';

/**
 * Contract tickets ("phieu") of the old app, section 5 of its logic document: upgrade, downgrade, convert,
 * transfer, branch change and cancel, with the owner-approval rule.
 *
 * Money: a positive fee raises the contract total and is collected as a positive Payment (cash is confirmed at once and
 * needs an open shift, other methods stay pending like every other payment); whatever is not collected stays as debt.
 * A negative fee (downgrade, cancel) is a refund recorded as a NEGATIVE confirmed Payment ("so am la hoan tien"), which
 * lowers paidAmount through recalcPaid and lowers the cash expected by the shift report. Refunds pay out immediately.
 */

export const TICKET_TYPES = ['upgrade', 'downgrade', 'convert', 'transfer', 'branch_change', 'cancel'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

const APPROVAL_TYPES: TicketType[] = ['downgrade', 'cancel', 'transfer'];
const TRANSFER_FEE = 500_000;
const CANCEL_KEEP = 0.9;
const DAY = 86_400_000;

const round1000 = (n: number) => Math.round(n / 1000) * 1000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);
const grossOf = (pkg: { price: number; vatPercent: number }) => pkg.price + Math.round((pkg.price * pkg.vatPercent) / 100);

const uuid = z.string().uuid();
const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s.\-()]/g, ''))
  .pipe(z.string().regex(/^\+?\d{9,15}$/, 'invalid phone'));

const METHODS = ['cash', 'transfer', 'card', 'ewallet', 'vietqr'] as const;

const bodySchema = z.object({
  type: z.enum(TICKET_TYPES),
  package_id: uuid.optional(),
  to_member: z.object({ member_id: uuid.optional(), name: z.string().trim().min(1).max(100).optional(), phone: phone.optional() }).optional(),
  branch_id: uuid.optional(),
  paid: z.number().int().min(0).optional(),
  method: z.enum(METHODS).optional(),
  reason: z.string().trim().max(500).optional(),
});
type TicketInput = z.infer<typeof bodySchema>;

type Db = Prisma.TransactionClient;
type Loaded = Contract & { package: Package; member: Member };

interface Plan {
  type: TicketType;
  fee: number;
  refund: number | null;
  note: string | null;
  data: Prisma.ContractUncheckedUpdateInput;
  endDate: Date | null;
  sessionsTotal: number | null;
  sessionsLeft: number | null;
  targetPackage?: Package;
  targetMemberId?: string;
  newMember?: { name: string; phone: string };
  targetBranchId?: string;
}

/** Remaining share of the contract: sessions left / total for session packages, days left / total days for time packages. */
export function remainingRatio(c: Pick<Contract, 'sessionsTotal' | 'sessionsLeft' | 'startDate' | 'endDate'>, packageType: string, today: Date): number {
  if (packageType === 'session') {
    if (!c.sessionsTotal) return 1;
    return clamp01((c.sessionsLeft ?? 0) / c.sessionsTotal);
  }
  if (!c.startDate || !c.endDate) return 1;
  const total = dayDiff(c.endDate, c.startDate);
  if (total <= 0) return 1;
  return clamp01(dayDiff(c.endDate, today) / total);
}

async function loadContract(db: Db, access: Access, id: string): Promise<Loaded> {
  const c = await db.contract.findUnique({ where: { id }, include: { package: true, member: true } });
  if (!c || !branchAllowed(access, c.branchId)) throw notFound('Contract not found');
  return c;
}

async function targetPackage(db: Db, access: Access, c: Loaded, input: TicketInput): Promise<Package> {
  if (!input.package_id) throw badRequest('PACKAGE_REQUIRED', 'package_id is required for this ticket type');
  const pkg = await db.package.findUnique({ where: { id: input.package_id } });
  if (!pkg || !branchAllowed(access, pkg.branchId)) throw notFound('Package not found');
  if (pkg.branchId !== c.branchId) throw conflict('BRANCH_MISMATCH', 'Package belongs to a different branch');
  if (!pkg.active) throw conflict('PACKAGE_INACTIVE', 'Package is not active');
  if (pkg.bundleOnly) throw conflict('BUNDLE_ONLY', 'This package is only given together with a PT package');
  if (pkg.id === c.packageId) throw conflict('SAME_PACKAGE', 'Choose a different package');
  if (pkg.category !== c.package.category) throw conflict('CATEGORY_MISMATCH', 'Package must be of the same category');
  return pkg;
}

/** Pure-ish calculation of what a ticket does. `strict` also validates targets (member, branch) and is false for quotes. */
async function plan(db: Db, access: Access, c: Loaded, input: TicketInput, today: Date, strict: boolean): Promise<Plan> {
  if (!['active', 'frozen'].includes(c.status)) {
    throw conflict('INVALID_STATE', `Cannot create a ticket for a contract in status ${c.status}`);
  }
  const type = input.type;
  const ratio = remainingRatio(c, c.package.type, today);
  const base = { type, refund: null as number | null, note: null as string | null };
  const same = { endDate: c.endDate, sessionsTotal: c.sessionsTotal, sessionsLeft: c.sessionsLeft };

  if (type === 'upgrade' || type === 'downgrade' || type === 'convert') {
    const pkg = await targetPackage(db, access, c, input);
    const newPrice = grossOf(pkg);
    if ((type === 'upgrade' || type === 'downgrade') && pkg.type !== c.package.type) {
      throw conflict('UNIT_MISMATCH', 'Package must use the same unit (time or sessions)');
    }
    let fee: number;
    let start: Date | null = c.startDate;
    let endDate: Date | null = c.endDate;
    let sessionsTotal: number | null = pkg.sessions;
    let sessionsLeft: number | null = pkg.sessions;
    let status: 'active' | 'frozen' = c.status as 'active' | 'frozen';
    let frozenUntil: Date | null = c.frozenUntil;
    let note: string | null = null;
    const frozenDays = c.status === 'frozen' && c.frozenUntil && c.frozenUntil > today ? dayDiff(c.frozenUntil, today) : 0;

    if (type === 'upgrade') {
      if (newPrice <= c.totalAmount) throw conflict('NOT_AN_UPGRADE', 'The new package must cost more than the current contract');
      fee = newPrice - c.totalAmount;
      start = c.startDate ?? today;
      endDate = pkg.durationDays != null ? addDays(start, pkg.durationDays + frozenDays) : c.endDate;
      sessionsLeft = pkg.sessions != null ? Math.max(0, (c.sessionsLeft ?? 0) + (pkg.sessions - (c.sessionsTotal ?? 0))) : null;
    } else if (type === 'downgrade') {
      if (newPrice >= c.totalAmount) throw conflict('NOT_A_DOWNGRADE', 'The new package must cost less than the current contract');
      fee = -round1000((c.totalAmount - newPrice) * ratio);
      const daysLeft = c.endDate ? Math.max(0, dayDiff(c.endDate, today)) : null;
      endDate = pkg.durationDays != null && daysLeft != null ? addDays(today, Math.min(daysLeft, pkg.durationDays)) : c.endDate;
      sessionsLeft = pkg.sessions != null ? Math.min(c.sessionsLeft ?? pkg.sessions, pkg.sessions) : null;
      note = fee === 0 ? 'Nothing to refund' : null;
    } else {
      fee = Math.max(0, newPrice - round1000(c.totalAmount * ratio));
      start = today;
      endDate = pkg.durationDays != null ? addDays(today, pkg.durationDays) : null;
      status = 'active';
      frozenUntil = null;
    }
    const totalAmount = c.totalAmount + fee;
    return {
      ...base,
      fee,
      refund: fee < 0 ? -fee : null,
      note,
      endDate,
      sessionsTotal,
      sessionsLeft,
      targetPackage: pkg,
      data: {
        packageId: pkg.id,
        packageName: pkg.name,
        durationDays: pkg.durationDays,
        totalAmount,
        startDate: start,
        endDate,
        sessionsTotal,
        sessionsLeft,
        status,
        frozenUntil,
      },
    };
  }

  if (type === 'transfer') {
    const out: Plan = { ...base, ...same, fee: TRANSFER_FEE, data: { totalAmount: c.totalAmount + TRANSFER_FEE } };
    if (strict) {
      const tm = input.to_member;
      if (!tm || (!tm.member_id && !tm.phone)) throw badRequest('TARGET_MEMBER_REQUIRED', 'to_member needs a member_id or a phone');
      const found = tm.member_id
        ? await db.member.findUnique({ where: { id: tm.member_id } })
        : await db.member.findFirst({ where: { phone: tm.phone! } });
      if (tm.member_id && !found) throw notFound('Member not found');
      if (found) {
        if (found.id === c.memberId) throw conflict('SAME_MEMBER', 'The contract already belongs to this member');
        if (found.branchId !== c.branchId) throw conflict('BRANCH_MISMATCH', 'The new owner belongs to a different branch');
        out.targetMemberId = found.id;
        out.data = { ...out.data, memberId: found.id };
      } else {
        if (!tm.name) throw badRequest('NAME_REQUIRED', 'A name is required to create the new member');
        out.newMember = { name: tm.name, phone: tm.phone! };
      }
    }
    return out;
  }

  if (type === 'branch_change') {
    const out: Plan = { ...base, ...same, fee: 0, data: {} };
    if (strict) {
      if (!input.branch_id) throw badRequest('BRANCH_REQUIRED', 'branch_id is required');
      if (input.branch_id === c.branchId) throw conflict('SAME_BRANCH', 'The contract is already in this branch');
      const br = await db.branch.findUnique({ where: { id: input.branch_id }, select: { id: true } });
      if (!br || !branchAllowed(access, br.id)) throw notFound('Branch not found');
      out.targetBranchId = br.id;
      out.data = { branchId: br.id };
    }
    return out;
  }

  // cancel: refund 90% of the paid amount that is still unused, rounded to thousands
  const refund = round1000(c.paidAmount * ratio * CANCEL_KEEP);
  return {
    ...base,
    fee: refund > 0 ? -refund : 0,
    refund: refund > 0 ? refund : 0,
    note: null,
    endDate: null,
    sessionsTotal: c.sessionsTotal,
    sessionsLeft: c.sessionsLeft,
    data: { status: 'cancelled' },
  };
}

const requiresApproval = (type: TicketType, access: Access) => APPROVAL_TYPES.includes(type) && !can(access, 'contracts.approve');

interface Actor {
  id: string;
  access: Access;
  ip?: string;
}

async function openShift(userId: string) {
  return prisma.shift.findFirst({ where: { userId, closedAt: null } });
}

/** Applies a ticket inside a transaction and records the payment, events and audit data. */
async function applyTicket(tx: Db, actor: Actor, contractId: string, input: TicketInput, shiftId: string | null, requestedBy: string | null, approved: boolean, pendingTicketId: string | null = null) {
  await lockContract(tx, contractId);
  const c = await loadContract(tx, actor.access, contractId);
  const today = dateOnly(todayVN());
  const p = await plan(tx, actor.access, c, input, today, true);
  const type = input.type;
  const method = input.method ?? 'cash';
  const reason = input.reason ?? null;

  let newMemberId: string | undefined;
  if (p.newMember) {
    const dup = await tx.member.findFirst({ where: { phone: p.newMember.phone }, select: { id: true } });
    if (dup) throw conflict('DUPLICATE_PHONE', 'Phone number already exists');
    const m = await tx.member.create({ data: { code: await nextMemberCode(), name: p.newMember.name, phone: p.newMember.phone, branchId: c.branchId } });
    newMemberId = m.id;
  }
  const memberId = p.targetMemberId ?? newMemberId;
  if (memberId) p.data = { ...p.data, memberId };

  if (p.fee > 0) {
    const paid = input.paid ?? p.fee;
    if (paid > p.fee) throw badRequest('PAID_EXCEEDS_FEE', 'Paid amount exceeds the ticket fee');
  }

  await tx.contract.update({ where: { id: c.id }, data: p.data });
  const kids = await tx.contract.findMany({ where: { bundleOfId: c.id, status: { notIn: ['cancelled', 'expired'] } } });
  for (const k of kids) {
    await lockContract(tx, k.id);
    if (type === 'cancel') await tx.contract.update({ where: { id: k.id }, data: { status: 'cancelled' } });
    else if (type === 'transfer' && memberId) await tx.contract.update({ where: { id: k.id }, data: { memberId } });
    else if (type === 'branch_change' && p.targetBranchId) await tx.contract.update({ where: { id: k.id }, data: { branchId: p.targetBranchId } });
  }
  if (type === 'branch_change' && p.targetBranchId) await tx.member.update({ where: { id: c.memberId }, data: { branchId: p.targetBranchId } });

  const amount = p.fee > 0 ? (input.paid ?? p.fee) : p.fee;
  let paymentId: string | null = null;
  if (amount !== 0) {
    const collected = amount > 0;
    const pay = await tx.payment.create({
      data: {
        contractId: c.id,
        branchId: c.branchId,
        method,
        amount,
        status: !collected || method === 'cash' ? 'confirmed' : 'pending',
        ref: newRef(),
        shiftId,
        note: `Ticket ${type}`,
        createdBy: actor.id,
        confirmedAt: !collected || method === 'cash' ? new Date() : null,
        confirmedBy: !collected || method === 'cash' ? actor.id : null,
      },
    });
    paymentId = pay.id;
  }
  const paidAfter = await recalcPaid(tx, c.id);

  await syncMemberStatus(tx, c.memberId);
  if (memberId && memberId !== c.memberId) await syncMemberStatus(tx, memberId);

  await addEvent(tx, c.id, `ticket_${type}`, actor.id, reason, {
    fee: p.fee,
    payment_id: paymentId,
    paid_amount: paidAfter,
    approved,
    ...(p.targetPackage && { package: { from: c.packageId, to: p.targetPackage.id } }),
    ...(memberId && { member: { from: c.memberId, to: memberId } }),
    ...(p.targetBranchId && { branch: { from: c.branchId, to: p.targetBranchId } }),
    end_date: { from: iso(c.endDate), to: iso(p.endDate) },
  });

  const record = {
    status: 'applied',
    fee: p.fee,
    payload: { ...input, applied: { payment_id: paymentId, member_id: memberId ?? null } } as Prisma.InputJsonValue,
    decidedBy: approved ? actor.id : null,
    decidedAt: approved ? new Date() : null,
    reason,
  };
  const ticket = pendingTicketId
    ? await tx.contractTicket.update({ where: { id: pendingTicketId }, data: record })
    : await tx.contractTicket.create({ data: { ...record, contractId: c.id, type, requestedBy } });
  const fresh = await tx.contract.findUniqueOrThrow({ where: { id: c.id }, include: { member: true, package: true } });
  return { ticket, contract: fresh, paymentId, fee: p.fee };
}

type TicketRow = Prisma.ContractTicketGetPayload<{ include: { contract: { include: { member: true } } } }>;

async function ticketsToApi(rows: TicketRow[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is string => !!x))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    contract_id: r.contractId,
    contract_code: r.contract.code,
    member_name: r.contract.member.name,
    member_code: r.contract.member.code,
    type: r.type,
    status: r.status,
    fee: r.fee,
    payload: r.payload,
    reason: r.reason,
    requested_by: r.requestedBy,
    requested_by_name: r.requestedBy ? names.get(r.requestedBy) ?? null : null,
    decided_by: r.decidedBy,
    decided_by_name: r.decidedBy ? names.get(r.decidedBy) ?? null : null,
    decided_at: r.decidedAt,
    created_at: r.createdAt,
  }));
}

const actorOf = (req: Request): Actor => ({ id: req.auth!.userId, access: req.access!, ip: req.ip });

async function pendingShiftFor(actor: Actor, c: { branchId: string }, input: TicketInput, fee: number, strictShift: boolean): Promise<string | null> {
  const method = input.method ?? 'cash';
  const money = fee > 0 ? (input.paid ?? fee) : fee;
  if (money === 0 || method !== 'cash') return null;
  const shift = await openShift(actor.id);
  return shift && shift.branchId === c.branchId ? shift.id : null;
}

// ---- routes under /api/contracts

export const contractTicketsRouter = Router();
contractTicketsRouter.use(authenticate);

contractTicketsRouter.get('/:id/ticket-quote', authorize('contracts.create'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const q = z.object({ type: z.enum(TICKET_TYPES), package_id: uuid.optional() }).parse(req.query);
  const actor = actorOf(req);
  const c = await loadContract(prisma as unknown as Db, actor.access, id);
  const p = await plan(prisma as unknown as Db, actor.access, c, { type: q.type, package_id: q.package_id }, dateOnly(todayVN()), false);
  res.json({
    data: {
      type: q.type,
      fee: p.fee,
      requires_approval: requiresApproval(q.type, actor.access),
      new_end_date: iso(p.endDate),
      new_sessions_total: p.sessionsTotal,
      new_sessions_left: p.sessionsLeft,
      refund: p.refund,
      note: p.note,
    },
  });
});

contractTicketsRouter.post('/:id/tickets', authorize('contracts.create'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const input = bodySchema.parse(req.body);
  const actor = actorOf(req);
  const db = prisma as unknown as Db;

  if (requiresApproval(input.type, actor.access)) {
    // Validate now so an impossible request never reaches the approver; nothing changes until it is approved.
    const c = await loadContract(db, actor.access, id);
    const p = await plan(db, actor.access, c, input, dateOnly(todayVN()), true);
    const created = await prisma.$transaction(async (tx) => {
      await lockContract(tx, id);
      const ticket = await tx.contractTicket.create({
        data: { contractId: id, type: input.type, status: 'pending', fee: p.fee, payload: input as Prisma.InputJsonValue, requestedBy: actor.id, reason: input.reason ?? null },
        include: { contract: { include: { member: true } } },
      });
      await addEvent(tx, id, 'ticket_requested', actor.id, input.reason ?? null, { ticket_id: ticket.id, type: input.type, fee: p.fee });
      return ticket;
    });
    await audit(actor.id, 'contract.ticket_requested', { ticket_id: created.id, type: input.type, fee: p.fee }, req.ip, id);
    const [json] = await ticketsToApi([created]);
    const full = await prisma.contract.findUniqueOrThrow({ where: { id }, include: { member: true, package: true } });
    return res.status(201).json({ data: { ticket: json, contract: contractToApi(full) } });
  }

  const c0 = await loadContract(db, actor.access, id);
  const p0 = await plan(db, actor.access, c0, input, dateOnly(todayVN()), true);
  const shiftId = await pendingShiftFor(actor, c0, input, p0.fee, true);
  const out = await prisma.$transaction((tx) => applyTicket(tx, actor, id, input, shiftId, actor.id, false));
  await audit(actor.id, `contract.ticket_${input.type}`, { ticket_id: out.ticket.id, fee: out.fee, payment_id: out.paymentId }, req.ip, id);
  const row = await prisma.contractTicket.findUniqueOrThrow({ where: { id: out.ticket.id }, include: { contract: { include: { member: true } } } });
  const [json] = await ticketsToApi([row]);
  res.status(201).json({ data: { ticket: json, contract: contractToApi(out.contract) } });
});

// ---- routes under /api/tickets

export const ticketsRouter = Router();
ticketsRouter.use(authenticate);

const listSchema = z.object({
  status: z.enum(['pending', 'applied', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

ticketsRouter.get('/', authorize('contracts.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.ContractTicketWhereInput = { contract: { ...branchFilter(req) } };
  if (q.status) where.status = q.status;
  const [total, rows] = await Promise.all([
    prisma.contractTicket.count({ where }),
    prisma.contractTicket.findMany({
      where,
      include: { contract: { include: { member: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
  ]);
  res.json({ data: await ticketsToApi(rows), meta: { total, page: q.page, limit: q.limit } });
});

async function scopedTicket(req: Request, id: string) {
  const t = await prisma.contractTicket.findUnique({ where: { id }, include: { contract: { include: { member: true } } } });
  if (!t || !branchAllowed(req.access!, t.contract.branchId)) throw notFound('Ticket not found');
  return t;
}

ticketsRouter.post('/:id/approve', authorize('contracts.approve'), async (req, res) => {
  const t = await scopedTicket(req, uuid.parse(req.params.id));
  if (t.status !== 'pending') throw conflict('INVALID_STATE', `Ticket is ${t.status}`);
  const actor = actorOf(req);
  const input = bodySchema.parse(t.payload);
  // The approver may have no open shift (owners never open one): cash is then recorded without a shift.
  const shiftId = await pendingShiftFor(actor, t.contract, input, t.fee, false);
  const out = await prisma.$transaction(async (tx) => {
    const done = await applyTicket(tx, actor, t.contractId, input, shiftId, t.requestedBy, true, t.id);
    const upd = await tx.contractTicket.findUniqueOrThrow({ where: { id: t.id }, include: { contract: { include: { member: true } } } });
    return { upd, contract: done.contract };
  });
  await audit(actor.id, 'contract.ticket_approved', { ticket_id: t.id, type: t.type, fee: out.upd.fee }, req.ip, t.contractId);
  const [json] = await ticketsToApi([out.upd]);
  res.json({ data: { ticket: json, contract: contractToApi(out.contract) } });
});

ticketsRouter.post('/:id/reject', authorize('contracts.approve'), async (req, res) => {
  const b = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
  const t = await scopedTicket(req, uuid.parse(req.params.id));
  if (t.status !== 'pending') throw conflict('INVALID_STATE', `Ticket is ${t.status}`);
  const actor = actorOf(req);
  const upd = await prisma.$transaction(async (tx) => {
    await lockContract(tx, t.contractId);
    const u = await tx.contractTicket.update({
      where: { id: t.id },
      data: { status: 'rejected', decidedBy: actor.id, decidedAt: new Date(), reason: b.reason },
      include: { contract: { include: { member: true } } },
    });
    await addEvent(tx, t.contractId, 'ticket_rejected', actor.id, b.reason, { ticket_id: t.id, type: t.type });
    return u;
  });
  await audit(actor.id, 'contract.ticket_rejected', { ticket_id: t.id, type: t.type, reason: b.reason }, req.ip, t.contractId);
  const [json] = await ticketsToApi([upd]);
  res.json({ data: { ticket: json } });
});
