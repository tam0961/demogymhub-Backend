import type { Contract, ContractEvent, Member, Package, Payment, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { addMonths, dateOnly, fmtDate, todayVN } from '../../lib/dates';
import { logger } from '../../lib/logger';

export type Tx = Prisma.TransactionClient;

/** Only the member package gives gym access. The three PT categories never do. */
export const MEMBER_CATEGORIES = ['member'] as const;
export const PT_CATEGORIES = ['pt_1on1', 'pt_1on2', 'pt_group'] as const;
export const isPtCategory = (c: string | null | undefined) => !!c && c.startsWith('pt_');
/** The usage deadline (HSD) exists only for 1:1 PT packages. */
export const hasUsageDeadline = (c: string | null | undefined) => c === 'pt_1on1';

/** 1:1 PT package usage deadline (HSD): contract end date + 3 months (30 sessions or fewer) or + 6 months (more than 30). */
export function ptUsageDeadline(endDate: Date | null | undefined, sessionsTotal: number | null | undefined): Date | null {
  if (!endDate) return null;
  return addMonths(endDate, (sessionsTotal ?? 0) > 30 ? 6 : 3);
}

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
  const rows = await tx.contract.findMany({
    where: { memberId, package: { category: { in: [...MEMBER_CATEGORIES] } } },
    select: { status: true, activatedAt: true },
  });
  let status: 'active' | 'frozen' | 'expired' | null = null;
  if (rows.some((r) => r.status === 'active')) status = 'active';
  else if (rows.some((r) => r.status === 'frozen')) status = 'frozen';
  else if (rows.some((r) => r.activatedAt)) status = 'expired';
  if (status) await tx.member.update({ where: { id: memberId }, data: { status } });
}

type Full = Contract & { member?: Member; package?: Package; events?: ContractEvent[]; payments?: Payment[] };

type PaymentWithContract = Payment & { contract?: { id: string; code: string; member?: { name: string } | null } | null };

export const paymentToApi = (p: PaymentWithContract) => ({
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
  refund_requested: !!p.refundRequestedAt && !p.refundedAt,
  ...(p.contract && { contract: { id: p.contract.id, code: p.contract.code, ...(p.contract.member && { member: { name: p.contract.member.name } }) } }),
});

type Extra = {
  branch?: { id: string; code: string; name: string } | null;
  last_payment_method?: string | null;
  user_names?: Map<string, string>;
  bundled?: (Contract & { package: Package })[];
};

export async function lastPaymentMethods(contractIds: string[]) {
  const out = new Map<string, string>();
  if (!contractIds.length) return out;
  const rows = await prisma.payment.findMany({
    where: { contractId: { in: contractIds }, status: 'confirmed' },
    orderBy: [{ confirmedAt: 'desc' }, { createdAt: 'desc' }],
    select: { contractId: true, method: true },
  });
  for (const r of rows) if (!out.has(r.contractId)) out.set(r.contractId, r.method);
  return out;
}

const CUR_RANK: Record<string, number> = { active: 1, frozen: 1, signed: 2, draft: 3 };
const dayKey = (d: Date | null) => (d ? d.getTime() : -Infinity);

type CurRow = {
  id: string;
  code: string;
  status: string;
  memberId: string;
  startDate: Date | null;
  endDate: Date | null;
  sessionsLeft: number | null;
  createdAt: Date;
  sessionsTotal: number | null;
  packageName: string | null;
  package: { name: string; type: string; category: string };
};

function currentToApi(r: CurRow) {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    package_name: r.packageName ?? r.package.name,
    package_type: r.package.type,
    start_date: fmtDate(r.startDate),
    end_date: fmtDate(r.endDate),
    sessions_left: r.sessionsLeft,
  };
}

export type CurrentContract = ReturnType<typeof currentToApi>;

/** Is this PT contract still usable today? 1:1 uses the HSD window; 1:2 and group are usable until their own end date. */
function ptUsable(r: { status: string; endDate: Date | null; sessionsTotal: number | null; category: string }, today: Date) {
  if (hasUsageDeadline(r.category)) {
    const d = ptUsageDeadline(r.endDate, r.sessionsTotal);
    return (r.status === 'active' || r.status === 'expired') && (d === null || d >= today);
  }
  return r.status === 'active' && (!r.endDate || r.endDate >= today);
}

function ptToApi(r: CurRow, today: Date) {
  const deadline = hasUsageDeadline(r.package.category) ? ptUsageDeadline(r.endDate, r.sessionsTotal) : null;
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    package_name: r.packageName ?? r.package.name,
    package_category: r.package.category,
    start_date: fmtDate(r.startDate),
    end_date: fmtDate(r.endDate),
    sessions_total: r.sessionsTotal,
    sessions_left: r.sessionsLeft,
    usage_deadline: fmtDate(deadline),
    usage_valid: ptUsable({ status: r.status, endDate: r.endDate, sessionsTotal: r.sessionsTotal, category: r.package.category }, today),
  };
}

export type PtContract = ReturnType<typeof ptToApi>;

const PT_RANK = (r: CurRow, today: Date) => {
  const usable = ptUsable({ status: r.status, endDate: r.endDate, sessionsTotal: r.sessionsTotal, category: r.package.category }, today);
  if (usable && r.status !== 'expired') return 1;
  if (usable) return 2;
  if (r.status === 'signed' || r.status === 'draft') return 3;
  return 4;
};

export async function memberContractSummaries(memberIds: string[], now = new Date()) {
  const current = new Map<string, CurrentContract>();
  const pt = new Map<string, PtContract>();
  if (!memberIds.length) return { current, pt };
  const today = dateOnly(todayVN(now));
  const rows: CurRow[] = await prisma.contract.findMany({
    where: { memberId: { in: memberIds } },
    select: {
      id: true,
      code: true,
      status: true,
      memberId: true,
      startDate: true,
      endDate: true,
      sessionsLeft: true,
      sessionsTotal: true,
      packageName: true,
      createdAt: true,
      package: { select: { name: true, type: true, category: true } },
    },
  });
  const better = (a: CurRow, b: CurRow) => {
    const ra = CUR_RANK[a.status] ?? 4;
    const rb = CUR_RANK[b.status] ?? 4;
    if (ra !== rb) return ra < rb;
    if (ra === 1 && dayKey(a.endDate) !== dayKey(b.endDate)) return dayKey(a.endDate) > dayKey(b.endDate);
    return a.createdAt > b.createdAt;
  };
  const betterPt = (a: CurRow, b: CurRow) => {
    const ra = PT_RANK(a, today);
    const rb = PT_RANK(b, today);
    if (ra !== rb) return ra < rb;
    if (dayKey(a.endDate) !== dayKey(b.endDate)) return dayKey(a.endDate) > dayKey(b.endDate);
    return a.createdAt > b.createdAt;
  };
  const bestMember = new Map<string, CurRow>();
  const bestPt = new Map<string, CurRow>();
  for (const r of rows) {
    if (isPtCategory(r.package.category)) {
      const cur = bestPt.get(r.memberId);
      if (!cur || betterPt(r, cur)) bestPt.set(r.memberId, r);
    } else if ((MEMBER_CATEGORIES as readonly string[]).includes(r.package.category)) {
      const cur = bestMember.get(r.memberId);
      if (!cur || better(r, cur)) bestMember.set(r.memberId, r);
    }
  }
  for (const [m, r] of bestMember) current.set(m, currentToApi(r));
  for (const [m, r] of bestPt) pt.set(m, ptToApi(r, today));
  return { current, pt };
}

export async function currentContracts(memberIds: string[]) {
  return (await memberContractSummaries(memberIds)).current;
}

export function contractToApi(c: Full, extra: Extra = {}) {
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
    bundle_of_id: c.bundleOfId,
    note: c.note,
    created_at: c.createdAt,
    ...(c.member && { member: { id: c.member.id, code: c.member.code, name: c.member.name, phone: c.member.phone } }),
    ...(c.package && { package: { id: c.package.id, name: c.packageName ?? c.package.name, type: c.package.type, category: c.package.category } }),
    ...(hasUsageDeadline(c.package?.category) && { usage_deadline: fmtDate(ptUsageDeadline(c.endDate, c.sessionsTotal)) }),
    ...(c.events && {
      events: c.events.map((e) => ({ id: e.id, type: e.type, by_user: e.byUser, by_user_name: (e.byUser && extra.user_names?.get(e.byUser)) || null, reason: e.reason, diff: e.diff, created_at: e.createdAt })),
    }),
    ...(c.payments && { payments: c.payments.map(paymentToApi) }),
    ...(extra.branch && { branch: { id: extra.branch.id, code: extra.branch.code, name: extra.branch.name } }),
    ...(extra.last_payment_method !== undefined && { last_payment_method: extra.last_payment_method }),
    ...(extra.bundled && {
      bundled_contracts: extra.bundled.map((b) => ({
        id: b.id,
        code: b.code,
        status: b.status,
        start_date: fmtDate(b.startDate),
        end_date: fmtDate(b.endDate),
        package: { id: b.package.id, name: b.packageName ?? b.package.name, type: b.package.type, category: b.package.category },
      })),
    }),
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

export type PtEligibility = {
  eligible: boolean;
  reasons: ('MEMBER_PACKAGE_EXPIRED' | 'NO_PT_PACKAGE' | 'PT_USAGE_EXPIRED' | 'PT_PACKAGE_EXPIRED')[];
  member_package: { ok: boolean; contract_code: string | null; end_date: string | null };
  pt_package: {
    ok: boolean;
    category: string | null;
    contract_code: string | null;
    end_date: string | null;
    usage_deadline: string | null;
    sessions_left: number | null;
  };
};

/**
 * A PT may assign the member to a session and complete it only when BOTH hold:
 * 1) the member package is currently valid, and
 * 2) the PT package is still usable: for 1:1 PT, today is not past the HSD (end date + 3 months for 30 sessions or fewer,
 *    + 6 months above); for PT 1:2 and PT group there is no HSD, the contract must be active and not past its end date.
 */
export async function ptEligibility(memberId: string, now = new Date()): Promise<PtEligibility> {
  const today = dateOnly(todayVN(now));
  const rows = await prisma.contract.findMany({
    where: { memberId, package: { category: { in: [...MEMBER_CATEGORIES, ...PT_CATEGORIES] } } },
    select: {
      code: true,
      status: true,
      startDate: true,
      endDate: true,
      sessionsLeft: true,
      sessionsTotal: true,
      createdAt: true,
      package: { select: { category: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const memberOk = rows
    .filter((r) => !isPtCategory(r.package.category) && r.status === 'active' && (!r.startDate || r.startDate <= today) && (!r.endDate || r.endDate >= today))
    .sort((a, b) => (b.endDate?.getTime() ?? Infinity) - (a.endDate?.getTime() ?? Infinity))[0];
  const ptRows = rows
    .filter((r) => isPtCategory(r.package.category) && ['active', 'expired'].includes(r.status))
    .map((r) => {
      const category = r.package.category;
      const deadline = hasUsageDeadline(category) ? ptUsageDeadline(r.endDate, r.sessionsTotal) : null;
      const usableNow = ptUsable({ status: r.status, endDate: r.endDate, sessionsTotal: r.sessionsTotal, category }, today);
      const horizon = deadline ?? r.endDate;
      return { r, category, deadline, usableNow, horizon };
    });
  const byHorizon = (a: { horizon: Date | null }, b: { horizon: Date | null }) =>
    (b.horizon?.getTime() ?? Infinity) - (a.horizon?.getTime() ?? Infinity);
  const usable = ptRows.filter((x) => x.usableNow).sort(byHorizon)[0];
  const anyPt = [...ptRows].sort((a, b) => (b.horizon?.getTime() ?? 0) - (a.horizon?.getTime() ?? 0))[0];
  const pick = usable ?? anyPt;
  const reasons: PtEligibility['reasons'] = [];
  if (!memberOk) reasons.push('MEMBER_PACKAGE_EXPIRED');
  if (!pick) reasons.push('NO_PT_PACKAGE');
  else if (!usable) reasons.push(hasUsageDeadline(pick.category) ? 'PT_USAGE_EXPIRED' : 'PT_PACKAGE_EXPIRED');
  return {
    eligible: reasons.length === 0,
    reasons,
    member_package: { ok: !!memberOk, contract_code: memberOk?.code ?? null, end_date: fmtDate(memberOk?.endDate) },
    pt_package: {
      ok: !!usable,
      category: pick?.category ?? null,
      contract_code: pick?.r.code ?? null,
      end_date: fmtDate(pick?.r.endDate),
      usage_deadline: fmtDate(pick?.deadline),
      sessions_left: pick?.r.sessionsLeft ?? null,
    },
  };
}
