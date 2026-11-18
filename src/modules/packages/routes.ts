import { Router } from 'express';
import { z } from 'zod';
import type { Package, Prisma } from '@prisma/client';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';
import { branchFilter, writeBranch } from '../rbac/scope';
import { branchAllowed } from '../rbac/service';
import { isPtCategory } from '../contracts/service';

export const packagesRouter = Router();
packagesRouter.use(authenticate);

const CATEGORIES = ['member', 'pt_1on1', 'pt_1on2', 'pt_group'] as const;
const PROMO_TYPES = ['bonus_months', 'bonus_days', 'bonus_sessions', 'percent', 'amount'] as const;
const uuid = z.string().uuid();

const base = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['day', 'month', 'session']),
  category: z.enum(CATEGORIES).default('member'),
  duration_days: z.number().int().min(1).max(3650).nullish(),
  sessions: z.number().int().min(1).max(10000).nullish(),
  price: z.number().int().min(0),
  vat_percent: z.number().int().min(0).max(100).default(0),
  branch_id: uuid.optional(),
  active: z.boolean().default(true),
  bundled_member_package_id: uuid.nullish(),
  bundle_only: z.boolean().default(false),
  display_group: z.enum(['pt_group']).nullish(),
  gift: z.string().trim().max(200).nullish(),
  checkin_before: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
  promo_type: z.enum(PROMO_TYPES).nullish(),
  promo_value: z.number().int().min(1).nullish(),
  promo_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  replaces_id: uuid.nullish(),
  deactivate_replaced: z.boolean().default(false),
});

const rule = (v: { type?: string; duration_days?: number | null; sessions?: number | null }) =>
  v.type === 'session' ? !!v.sessions : v.type ? !!v.duration_days : true;
const ruleMsg = { message: 'session packages need sessions; day/month packages need duration_days' };

const createSchema = base.refine(rule, ruleMsg);
// Written out (no .default()) because zod 4 applies defaults inside .partial(), which would silently reset omitted fields.
const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: z.enum(['day', 'month', 'session']).optional(),
  category: z.enum(CATEGORIES).optional(),
  duration_days: z.number().int().min(1).max(3650).nullish(),
  sessions: z.number().int().min(1).max(10000).nullish(),
  price: z.number().int().min(0).optional(),
  vat_percent: z.number().int().min(0).max(100).optional(),
  active: z.boolean().optional(),
  bundled_member_package_id: uuid.nullish(),
  bundle_only: z.boolean().optional(),
  display_group: z.enum(['pt_group']).nullish(),
  gift: z.string().trim().max(200).nullish(),
  checkin_before: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
  promo_type: z.enum(PROMO_TYPES).nullish(),
  promo_value: z.number().int().min(1).nullish(),
  promo_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(['day', 'month', 'session']).optional(),
  category: z.enum(CATEGORIES).optional(),
  active: z.enum(['true', 'false']).optional(),
  branch_id: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

type PackageRow = Package & {
  bundledMember?: { id: string; name: string; durationDays: number | null; price: number } | null;
  _count?: { contracts: number };
};

const include = {
  bundledMember: { select: { id: true, name: true, durationDays: true, price: true } },
  _count: { select: { contracts: true } },
} satisfies Prisma.PackageInclude;

const toApi = (p: PackageRow) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  category: p.category,
  duration_days: p.durationDays,
  sessions: p.sessions,
  price: p.price,
  vat_percent: p.vatPercent,
  branch_id: p.branchId,
  active: p.active,
  bundled_member_package: p.bundledMember
    ? { id: p.bundledMember.id, name: p.bundledMember.name, duration_days: p.bundledMember.durationDays, price: p.bundledMember.price }
    : null,
  bundle_only: p.bundleOnly,
  display_group: p.displayGroup,
  gift: p.gift,
  checkin_before: p.checkinBefore,
  promo_type: p.promoType,
  promo_value: p.promoValue,
  promo_until: p.promoUntil ? p.promoUntil.toISOString().slice(0, 10) : null,
  replaces_id: p.replacesId,
  ...(p._count && { contracts_count: p._count.contracts, in_use: p._count.contracts > 0 }),
});

/** A bundled member package must be an active member package of the same branch, and only PT packages may have one. */
async function checkBundle(category: string, bundledId: string | null | undefined, branchId: string) {
  if (!bundledId) return;
  if (!isPtCategory(category)) throw conflict('INVALID_BUNDLE', 'Only PT packages can include a member package');
  const m = await prisma.package.findUnique({ where: { id: bundledId } });
  if (!m || m.category !== 'member' || m.branchId !== branchId) {
    throw conflict('INVALID_BUNDLE', 'The included package must be a member package of the same branch');
  }
  if (!m.active) throw conflict('INVALID_BUNDLE', 'The included member package is not active');
}

packagesRouter.get('/', authorize('packages.read'), async (req, res) => {
  const q = listSchema.parse(req.query);
  const where: Prisma.PackageWhereInput = { ...branchFilter(req, q.branch_id) };
  if (q.type) where.type = q.type;
  if (q.category) where.category = q.category;
  if (q.active) where.active = q.active === 'true';
  if (q.q) where.name = { contains: q.q, mode: 'insensitive' };
  const [total, rows] = await Promise.all([
    prisma.package.count({ where }),
    prisma.package.findMany({ where, include, orderBy: [{ branchId: 'asc' }, { category: 'asc' }, { price: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  res.json({ data: rows.map(toApi), meta: { page: q.page, limit: q.limit, total } });
});

packagesRouter.get('/:id', authorize('packages.read'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const p = await prisma.package.findUnique({ where: { id }, include });
  if (!p || !branchAllowed(req.access!, p.branchId)) throw notFound('Package not found');
  res.json({ data: toApi(p) });
});

packagesRouter.post('/', authorize('packages.create'), async (req, res) => {
  const b = createSchema.parse(req.body);
  const branchId = writeBranch(req, b.branch_id);
  await checkBundle(b.category, b.bundled_member_package_id, branchId);
  let old: Package | null = null;
  if (b.replaces_id) {
    old = await prisma.package.findUnique({ where: { id: b.replaces_id } });
    if (!old || !branchAllowed(req.access!, old.branchId)) throw notFound('Package to replace not found');
  }
  const p = await prisma.$transaction(async (tx) => {
    const created = await tx.package.create({
      data: {
        name: b.name,
        type: b.type,
        category: b.category,
        durationDays: b.duration_days ?? null,
        sessions: b.sessions ?? null,
        price: b.price,
        vatPercent: b.vat_percent,
        active: b.active,
        branchId,
        bundledMemberPackageId: b.bundled_member_package_id ?? null,
        bundleOnly: b.category === 'member' && b.bundle_only,
        displayGroup: b.category === 'member' ? b.display_group ?? null : null,
        gift: b.gift || null,
        checkinBefore: b.category === 'member' ? b.checkin_before ?? null : null,
        promoType: b.promo_type ?? null,
        promoValue: b.promo_type ? b.promo_value ?? null : null,
        promoUntil: b.promo_type && b.promo_until ? new Date(`${b.promo_until}T00:00:00Z`) : null,
        replacesId: old?.id ?? null,
      },
      include,
    });
    if (old && b.deactivate_replaced && old.active) {
      await tx.package.update({ where: { id: old.id }, data: { active: false } });
    }
    return created;
  });
  await audit(req.auth!.userId, 'package.created', { after: toApi(p), replaces: old?.id ?? null, deactivated_old: !!(old && b.deactivate_replaced) }, req.ip, p.id);
  res.status(201).json({ data: toApi(p) });
});

packagesRouter.patch('/:id', authorize('packages.update'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = patchSchema.parse(req.body);
  const cur = await prisma.package.findUnique({ where: { id }, include });
  if (!cur || !branchAllowed(req.access!, cur.branchId)) throw notFound('Package not found');

  const onlyActive = Object.keys(b).every((k) => k === 'active');
  if (cur._count.contracts > 0 && !onlyActive) {
    throw conflict(
      'PACKAGE_IN_USE',
      'This package already has contracts, so it cannot be edited. Deactivate it and create a new version instead.',
    );
  }

  const merged = {
    type: b.type ?? cur.type,
    duration_days: b.duration_days !== undefined ? b.duration_days : cur.durationDays,
    sessions: b.sessions !== undefined ? b.sessions : cur.sessions,
  };
  if (!rule(merged)) {
    const { ZodError } = await import('zod');
    throw new ZodError([{ code: 'custom', path: [], message: ruleMsg.message }]);
  }
  const nextCategory = b.category ?? cur.category;
  const nextBundle = b.bundled_member_package_id !== undefined ? b.bundled_member_package_id : cur.bundledMemberPackageId;
  await checkBundle(nextCategory, nextBundle, cur.branchId);
  const p = await prisma.package.update({
    where: { id },
    include,
    data: {
      ...(b.name !== undefined && { name: b.name }),
      ...(b.type !== undefined && { type: b.type }),
      ...(b.category !== undefined && { category: b.category }),
      ...(b.duration_days !== undefined && { durationDays: b.duration_days }),
      ...(b.sessions !== undefined && { sessions: b.sessions }),
      ...(b.price !== undefined && { price: b.price }),
      ...(b.vat_percent !== undefined && { vatPercent: b.vat_percent }),
      ...(b.active !== undefined && { active: b.active }),
      ...(b.bundled_member_package_id !== undefined && { bundledMemberPackageId: b.bundled_member_package_id }),
      ...(b.bundle_only !== undefined && { bundleOnly: b.bundle_only }),
      ...(b.display_group !== undefined && { displayGroup: b.display_group }),
      ...(b.gift !== undefined && { gift: b.gift || null }),
      ...(b.checkin_before !== undefined && { checkinBefore: b.checkin_before }),
      ...(b.promo_type !== undefined && { promoType: b.promo_type }),
      ...(b.promo_value !== undefined && { promoValue: b.promo_value }),
      ...(b.promo_until !== undefined && { promoUntil: b.promo_until ? new Date(`${b.promo_until}T00:00:00Z`) : null }),
      ...(!isPtCategory(nextCategory) && { bundledMemberPackageId: null }),
    },
  });
  await audit(req.auth!.userId, 'package.updated', { before: toApi(cur), after: toApi(p) }, req.ip, p.id);
  res.json({ data: toApi(p) });
});

packagesRouter.delete('/:id', authorize('packages.update'), async (req, res) => {
  const id = uuid.parse(req.params.id);
  const cur = await prisma.package.findUnique({ where: { id }, include });
  if (!cur || !branchAllowed(req.access!, cur.branchId)) throw notFound('Package not found');
  if ((cur._count?.contracts ?? 0) > 0) throw conflict('PACKAGE_IN_USE', 'This package already has contracts, so it cannot be deleted. Deactivate it by editing instead.');
  const usedAsBundle = await prisma.package.count({ where: { bundledMemberPackageId: id } });
  if (usedAsBundle > 0) throw conflict('PACKAGE_IS_BUNDLE', 'This member package is included in other packages, so it cannot be deleted.');
  await prisma.package.delete({ where: { id } });
  await audit(req.auth!.userId, 'package.deleted', { before: toApi(cur) }, req.ip, id);
  res.json({ data: { id } });
});
