export interface Tier {
  upTo: number | null;
  rate: number;
}

export interface PayrollSettings {
  memberTiers: Tier[];
  ptTiers: Tier[];
  marketingTiers: Tier[];
  ptImmediateShare: number;
  ptSessionShare: number;
  classRate: number;
  insuranceRate: number;
  insuranceBase: number | null;
  fixedTax: number;
  partTimeTaxRate: number;
  taxBrackets: Tier[];
  personalDeduction: number | null;
  dependentDeduction: number | null;
}

/** Owner's salary structure, phase 1. Rates are percent numbers. All of it is editable through the settings API. */
export const DEFAULT_SETTINGS: PayrollSettings = {
  memberTiers: [
    { upTo: 15_000_000, rate: 1.5 },
    { upTo: 25_000_000, rate: 2.5 },
    { upTo: 35_000_000, rate: 3.5 },
    { upTo: null, rate: 4.5 },
  ],
  // Bảng 2: one rate for the whole month, first tier whose upper bound is above the amount (upper bound exclusive).
  ptTiers: [
    { upTo: 30_000_000, rate: 25 },
    { upTo: 50_000_000, rate: 27 },
    { upTo: 65_000_000, rate: 30 },
    { upTo: null, rate: 35 },
  ],
  marketingTiers: [
    { upTo: 129_000_000, rate: 1.5 },
    { upTo: 179_000_000, rate: 3 },
    { upTo: null, rate: 4 },
  ],
  ptImmediateShare: 0.4,
  ptSessionShare: 0.6,
  classRate: 100_000,
  insuranceRate: 10.5,
  // Bảng 5: insurance is charged on a fixed base (5.5tr), not on the actual base salary. null = use the profile base salary.
  insuranceBase: 5_500_000,
  // Bảng 5: with no brackets, the 'progressive' tax mode deducts this fixed amount (default 0, no deductions).
  fixedTax: 0,
  partTimeTaxRate: 10,
  taxBrackets: [],
  personalDeduction: null,
  dependentDeduction: null,
};

export const POSITIONS = ['pt_fulltime', 'pt_parttime', 'marketing', 'sale', 'other'] as const;
export type Position = (typeof POSITIONS)[number];
export const TAX_MODES = ['progressive', 'flat10', 'none'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export interface Profile {
  position: Position;
  baseSalary: number;
  hasInsurance: boolean;
  taxMode: TaxMode;
  dependents: number;
}

export interface RowInput {
  userId: string;
  name: string;
  profile: Profile;
  memberSales: number;
  gymMemberTotal: number;
  ptSales: number;
  ptSessionPay: number;
  ptSessionsTaught: number;
  groupClasses: number;
  penalty: number;
  adjustment: number;
  note?: string | null;
}

export interface PayrollRow {
  user_id: string;
  name: string;
  position: Position;
  base_salary: number;
  member_sales: number;
  member_commission: number;
  marketing_commission: number;
  pt_sales: number;
  pt_rate: number;
  pt_immediate: number;
  pt_session_pay: number;
  pt_sessions_taught: number;
  group_classes: number;
  group_pay: number;
  gross: number;
  insurance: number;
  tax: number;
  tax_pending: boolean;
  penalty: number;
  adjustment: number;
  net: number;
  note: string | null;
}

/** Progressive by slice: each slice of the amount is paid at its own rate (Bảng 1, Bảng 4, income tax). */
export function marginal(amount: number, tiers: Tier[]): number {
  if (amount <= 0) return 0;
  let prev = 0;
  let total = 0;
  for (const t of tiers) {
    const top = t.upTo ?? Number.POSITIVE_INFINITY;
    const slice = Math.min(amount, top) - prev;
    if (slice > 0) total += (slice * t.rate) / 100;
    if (amount <= top) break;
    prev = top;
  }
  return Math.round(total);
}

/** One rate for the whole amount (Bảng 2): the first tier whose upper bound is strictly above the amount. */
export function flatRate(amount: number, tiers: Tier[]): number {
  if (amount <= 0 || !tiers.length) return 0;
  for (const t of tiers) if (t.upTo === null || amount < t.upTo) return t.rate;
  return tiers[tiers.length - 1].rate;
}

export const isPtPosition = (p: Position) => p === 'pt_fulltime' || p === 'pt_parttime';
const earnsMemberCommission = (p: Position) => p === 'pt_fulltime' || p === 'pt_parttime' || p === 'marketing' || p === 'sale';
const earnsPtImmediate = (p: Position) => isPtPosition(p) || p === 'marketing';

export const EMPTY_TOTAL_KEYS = [
  'base_salary',
  'member_sales',
  'member_commission',
  'marketing_commission',
  'pt_sales',
  'pt_immediate',
  'pt_session_pay',
  'pt_sessions_taught',
  'group_classes',
  'group_pay',
  'gross',
  'insurance',
  'tax',
  'penalty',
  'adjustment',
  'net',
] as const;

export function computeRow(i: RowInput, s: PayrollSettings): PayrollRow {
  const pos = i.profile.position;
  const base = Math.max(0, Math.round(i.profile.baseSalary));
  const memberCommission = earnsMemberCommission(pos) ? marginal(i.memberSales, s.memberTiers) : 0;
  const marketingCommission = pos === 'marketing' ? marginal(i.gymMemberTotal, s.marketingTiers) : 0;

  const ptSales = earnsPtImmediate(pos) ? i.ptSales : 0;
  const ptRate = flatRate(ptSales, s.ptTiers);
  const ptImmediate = Math.round(s.ptImmediateShare * (ptRate / 100) * ptSales);
  const ptSessionPay = isPtPosition(pos) ? Math.round(i.ptSessionPay) : 0;
  const ptSessions = isPtPosition(pos) ? i.ptSessionsTaught : 0;
  const groupClasses = isPtPosition(pos) ? i.groupClasses : 0;
  const groupPay = groupClasses * s.classRate;

  const gross = base + memberCommission + marketingCommission + ptImmediate + ptSessionPay + groupPay;
  const insurance = i.profile.hasInsurance ? Math.round(((s.insuranceBase ?? base) * s.insuranceRate) / 100) : 0;

  let tax = 0;
  const taxPending = false;
  if (i.profile.taxMode === 'flat10') tax = Math.round((gross * s.partTimeTaxRate) / 100);
  else if (i.profile.taxMode === 'progressive') {
    if (!s.taxBrackets.length) tax = Math.max(0, Math.round(s.fixedTax));
    else {
      const taxable = Math.max(0, gross - insurance - (s.personalDeduction ?? 0) - i.profile.dependents * (s.dependentDeduction ?? 0));
      tax = marginal(taxable, s.taxBrackets);
    }
  }

  const net = gross - insurance - tax - i.penalty + i.adjustment;
  return {
    user_id: i.userId,
    name: i.name,
    position: pos,
    base_salary: base,
    member_sales: Math.round(i.memberSales),
    member_commission: memberCommission,
    marketing_commission: marketingCommission,
    pt_sales: Math.round(ptSales),
    pt_rate: ptRate,
    pt_immediate: ptImmediate,
    pt_session_pay: ptSessionPay,
    pt_sessions_taught: ptSessions,
    group_classes: groupClasses,
    group_pay: groupPay,
    gross,
    insurance,
    tax,
    tax_pending: taxPending,
    penalty: i.penalty,
    adjustment: i.adjustment,
    net,
    note: i.note ?? null,
  };
}

export function sumRows(rows: PayrollRow[]) {
  const t: Record<string, number> = {};
  for (const k of EMPTY_TOTAL_KEYS) t[k] = rows.reduce((a, r) => a + (r[k] as number), 0);
  return { ...t, pt_rate: 0, tax_pending: rows.some((r) => r.tax_pending) } as Record<string, number | boolean>;
}
