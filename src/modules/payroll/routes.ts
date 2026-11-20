import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { POSITIONS, TAX_MODES, sumRows, type PayrollRow } from './calc';
import { computePreview, getPayrollSettings, savePayrollSettings } from './service';

export const payrollRouter = Router();
payrollRouter.use(authenticate);

const uuid = z.string().uuid();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const tiers = (allowEmpty: boolean) =>
  z
    .array(z.object({ upTo: z.number().int().positive().nullable(), rate: z.number().min(0).max(100) }))
    .min(allowEmpty ? 0 : 1)
    .max(10)
    .refine((t) => t.every((x, i) => (i === t.length - 1 ? x.upTo === null : x.upTo !== null && (i === 0 || x.upTo > (t[i - 1].upTo as number)))), 'Tiers must increase and the last tier must have upTo null');

const settingsSchema = z
  .object({
    memberTiers: tiers(false),
    ptTiers: tiers(false),
    marketingTiers: tiers(false),
    ptImmediateShare: z.number().min(0).max(1),
    ptSessionShare: z.number().min(0).max(1),
    classRate: z.number().int().min(0),
    insuranceRate: z.number().min(0).max(100),
    insuranceBase: z.number().int().min(0).nullable().default(5_500_000),
    fixedTax: z.number().int().min(0).default(0),
    partTimeTaxRate: z.number().min(0).max(100),
    taxBrackets: tiers(true),
    personalDeduction: z.number().int().min(0).nullable(),
    dependentDeduction: z.number().int().min(0).nullable(),
  })
  .refine((s) => Math.abs(s.ptImmediateShare + s.ptSessionShare - 1) < 1e-9, 'ptImmediateShare + ptSessionShare must equal 1');

const profileSchema = z.object({
  position: z.enum(POSITIONS),
  base_salary: z.number().int().min(0),
  has_insurance: z.boolean(),
  tax_mode: z.enum(TAX_MODES),
  dependents: z.number().int().min(0).max(20),
  active: z.boolean(),
});

payrollRouter.get('/settings', authorize('payroll.read'), async (_req, res) => {
  res.json({ data: await getPayrollSettings() });
});

payrollRouter.put('/settings', authorize('payroll.manage'), async (req, res) => {
  const b = settingsSchema.parse(req.body);
  const saved = await savePayrollSettings(b);
  await audit(req.auth!.userId, 'payroll.settings_updated', {}, req.ip);
  res.json({ data: saved });
});

payrollRouter.get('/profiles', authorize('payroll.read'), async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { status: 'active', OR: [{ staffProfile: null }, { staffProfile: { active: true } }], userRoles: { some: { role: { key: { not: 'member' } } } } },
    select: {
      id: true,
      name: true,
      email: true,
      payrollProfile: true,
      userRoles: { select: { role: { select: { key: true } }, branch: { select: { code: true } } } },
    },
    orderBy: { name: 'asc' },
  });
  res.json({
    data: users.map((u) => ({
      user_id: u.id,
      name: u.name,
      email: u.email,
      roles: [...new Set(u.userRoles.map((r) => r.role.key))],
      branch_codes: [...new Set(u.userRoles.map((r) => r.branch?.code).filter((c): c is string => !!c))],
      profile: u.payrollProfile
        ? {
            position: u.payrollProfile.position,
            base_salary: u.payrollProfile.baseSalary,
            has_insurance: u.payrollProfile.hasInsurance,
            tax_mode: u.payrollProfile.taxMode,
            dependents: u.payrollProfile.dependents,
            active: u.payrollProfile.active,
          }
        : null,
    })),
  });
});

payrollRouter.put('/profiles/:userId', authorize('payroll.manage'), async (req, res) => {
  const userId = uuid.parse(req.params.userId);
  const b = profileSchema.parse(req.body);
  if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw notFound('User not found');
  const data = { position: b.position, baseSalary: b.base_salary, hasInsurance: b.has_insurance, taxMode: b.tax_mode, dependents: b.dependents, active: b.active };
  const p = await prisma.payrollProfile.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  await audit(req.auth!.userId, 'payroll.profile_updated', { user_id: userId, position: b.position }, req.ip, userId);
  res.json({ data: { position: p.position, base_salary: p.baseSalary, has_insurance: p.hasInsurance, tax_mode: p.taxMode, dependents: p.dependents, active: p.active } });
});

async function branchUserIds(branchId: string): Promise<Set<string>> {
  const rows = await prisma.userRole.findMany({ where: { OR: [{ branchId }, { branchId: null }] }, select: { userId: true } });
  return new Set(rows.map((r) => r.userId));
}

payrollRouter.get('/preview', authorize('payroll.read'), async (req, res) => {
  const q = z.object({ month, branch_id: uuid.optional() }).parse(req.query);
  const period = await prisma.payrollPeriod.findUnique({ where: { month: q.month } });
  if (period?.status === 'closed' && period.snapshot) {
    let rows = (period.snapshot as unknown as { rows: PayrollRow[] }).rows;
    if (q.branch_id) {
      const ids = await branchUserIds(q.branch_id);
      rows = rows.filter((r) => ids.has(r.user_id));
    }
    return res.json({ data: { month: q.month, status: 'closed', rows, totals: sumRows(rows) } });
  }
  res.json({ data: await computePreview(q.month, q.branch_id) });
});

payrollRouter.put('/adjustments', authorize('payroll.manage'), async (req, res) => {
  const b = z.object({ user_id: uuid, month, penalty: z.number().int().min(0), adjustment: z.number().int(), note: z.string().trim().max(300).nullish() }).parse(req.body);
  const period = await prisma.payrollPeriod.findUnique({ where: { month: b.month } });
  if (period?.status === 'closed') throw conflict('PERIOD_CLOSED', 'This month is closed');
  if (!(await prisma.user.findUnique({ where: { id: b.user_id }, select: { id: true } }))) throw notFound('User not found');
  const a = await prisma.payrollAdjustment.upsert({
    where: { userId_month: { userId: b.user_id, month: b.month } },
    update: { penalty: b.penalty, adjustment: b.adjustment, note: b.note ?? null },
    create: { userId: b.user_id, month: b.month, penalty: b.penalty, adjustment: b.adjustment, note: b.note ?? null },
  });
  await audit(req.auth!.userId, 'payroll.adjustment_saved', { user_id: b.user_id, month: b.month, penalty: b.penalty, adjustment: b.adjustment }, req.ip, b.user_id);
  res.json({ data: { user_id: a.userId, month: a.month, penalty: a.penalty, adjustment: a.adjustment, note: a.note } });
});

payrollRouter.post('/close', authorize('payroll.manage'), async (req, res) => {
  const b = z.object({ month }).parse(req.body);
  const existing = await prisma.payrollPeriod.findUnique({ where: { month: b.month } });
  if (existing?.status === 'closed') throw conflict('PERIOD_CLOSED', 'This month is already closed');
  const preview = await computePreview(b.month);
  const closedAt = new Date();
  const snapshot = { rows: preview.rows, totals: preview.totals } as unknown as Prisma.InputJsonValue;
  await prisma.payrollPeriod.upsert({
    where: { month: b.month },
    update: { status: 'closed', snapshot, closedBy: req.auth!.userId, closedAt },
    create: { month: b.month, status: 'closed', snapshot, closedBy: req.auth!.userId, closedAt },
  });
  await audit(req.auth!.userId, 'payroll.period_closed', { month: b.month, rows: preview.rows.length }, req.ip);
  res.json({ data: { month: b.month, status: 'closed', closed_at: closedAt.toISOString() } });
});

payrollRouter.post('/reopen', authorize('payroll.manage'), async (req, res) => {
  const b = z.object({ month }).parse(req.body);
  const existing = await prisma.payrollPeriod.findUnique({ where: { month: b.month } });
  if (!existing || existing.status !== 'closed') throw conflict('NOT_CLOSED', 'This month is not closed');
  await prisma.payrollPeriod.update({ where: { month: b.month }, data: { status: 'open', snapshot: undefined, closedAt: null, closedBy: null } });
  await audit(req.auth!.userId, 'payroll.period_reopened', { month: b.month }, req.ip);
  res.json({ data: { month: b.month, status: 'open', closed_at: null } });
});

payrollRouter.get('/periods', authorize('payroll.read'), async (_req, res) => {
  const rows = await prisma.payrollPeriod.findMany({ orderBy: { month: 'desc' }, select: { month: true, status: true, closedAt: true } });
  res.json({ data: rows.map((r) => ({ month: r.month, status: r.status, closed_at: r.closedAt?.toISOString() ?? null })) });
});
