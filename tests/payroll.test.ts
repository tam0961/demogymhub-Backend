import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { DEFAULT_SETTINGS, computeRow, flatRate, marginal } from '../src/modules/payroll/calc';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
const MONTH = '2031-05';
const at = (day: number) => new Date(`2031-05-${String(day).padStart(2, '0')}T10:00:00+07:00`);
let seq = 0;
let owner = '';
let recep = '';
let BR = '';
const ids: Record<string, string> = {};
let memberPkg = '';
let ptPkg = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function member() {
  seq += 1;
  const n = `${sfx}${seq}`;
  return prisma.member.create({ data: { code: `PY${n}`, name: `PM ${n}`, phone: `p${n}`, branchId: BR } });
}

async function contract(o: { pkg: string; sale?: string; pt?: string; total: number; sessions?: number; created?: Date }) {
  seq += 1;
  const m = await member();
  return prisma.contract.create({
    data: {
      code: `PC${sfx}${seq}`,
      memberId: m.id,
      packageId: o.pkg,
      branchId: BR,
      status: 'active',
      totalAmount: o.total,
      paidAmount: o.total,
      sessionsTotal: o.sessions ?? null,
      sessionsLeft: o.sessions ?? null,
      saleUserId: o.sale ?? null,
      ptUserId: o.pt ?? null,
      createdAt: o.created ?? at(2),
    },
  });
}

async function pay(contractId: string, amount: number, day = 10, extra: { status?: 'confirmed' | 'refunded'; refundedDay?: number } = {}) {
  seq += 1;
  return prisma.payment.create({
    data: {
      contractId,
      branchId: BR,
      method: 'cash',
      amount,
      status: extra.status ?? 'confirmed',
      ref: `PR${sfx}${seq}`,
      confirmedAt: at(day),
      refundedAt: extra.refundedDay ? at(extra.refundedDay) : null,
    },
  });
}

async function session(trainer: string, contractId: string, memberId: string, day: number) {
  return prisma.ptSession.create({
    data: { branchId: BR, trainerId: trainer, memberId, contractId, startAt: at(day), endAt: new Date(at(day).getTime() + 3600000), status: 'completed', completedAt: at(day) },
  });
}

const profile = (userId: string, body: object) => request(app).put(`/api/payroll/profiles/${userId}`).set(auth(owner)).send(body);
const row = async (key: string) => {
  const r = await request(app).get('/api/payroll/preview').query({ month: MONTH }).set(auth(owner));
  expect(r.status).toBe(200);
  return (r.body.data.rows as Record<string, number | string | boolean>[]).find((x) => x.user_id === ids[key])!;
};

describe('payroll calculation (pure)', () => {
  it('Bang 1 is marginal by slice', () => {
    expect(marginal(10_000_000, DEFAULT_SETTINGS.memberTiers)).toBe(150_000);
    expect(marginal(19_000_000, DEFAULT_SETTINGS.memberTiers)).toBe(325_000);
    expect(marginal(40_000_000, DEFAULT_SETTINGS.memberTiers)).toBe(1_050_000);
    expect(marginal(0, DEFAULT_SETTINGS.memberTiers)).toBe(0);
  });

  it('Bang 4 is marginal by slice', () => {
    expect(marginal(100_000_000, DEFAULT_SETTINGS.marketingTiers)).toBe(1_500_000);
    expect(marginal(200_000_000, DEFAULT_SETTINGS.marketingTiers)).toBe(4_275_000);
  });

  it('Bang 2 uses one rate for the whole month with exclusive upper bounds', () => {
    const t = DEFAULT_SETTINGS.ptTiers;
    expect([flatRate(0, t), flatRate(29_999_999, t), flatRate(30_000_000, t), flatRate(49_999_999, t), flatRate(50_000_000, t), flatRate(64_999_999, t), flatRate(65_000_000, t), flatRate(90_000_000, t)]).toEqual([0, 25, 27, 27, 30, 30, 35, 35]);
  });

  it('golden cases shared with the admin simulator (apps/admin/src/test/payroll.test.ts)', () => {
    const run = (position: 'pt_fulltime' | 'pt_parttime' | 'marketing', c: { base: number; member: number; gym: number; pt: number; total: number; taught: number; classes: number; penalty: number }) => {
      const fund = (flatRate(c.pt, DEFAULT_SETTINGS.ptTiers) / 100) * c.pt;
      const sessionPay = position === 'marketing' || c.total <= 0 ? 0 : Math.round(((DEFAULT_SETTINGS.ptSessionShare * fund) / c.total) * c.taught);
      const taxMode = position === 'pt_parttime' ? 'flat10' : 'progressive';
      return computeRow({ userId: 'u', name: 'U', profile: { position, baseSalary: c.base, hasInsurance: position !== 'pt_parttime', taxMode, dependents: 0 }, memberSales: c.member, gymMemberTotal: c.gym, ptSales: c.pt, ptSessionPay: sessionPay, ptSessionsTaught: c.taught, groupClasses: c.classes, penalty: c.penalty, adjustment: 0 }, DEFAULT_SETTINGS);
    };
    const a = run('pt_fulltime', { base: 5_500_000, member: 20_000_000, gym: 0, pt: 35_000_000, total: 10, taught: 4, classes: 3, penalty: 100_000 });
    expect([a.gross, a.insurance, a.tax, a.net]).toEqual([12_198_000, 577_500, 0, 11_520_500]);
    const b = run('pt_parttime', { base: 3_000_000, member: 4_000_000, gym: 0, pt: 20_000_000, total: 8, taught: 6, classes: 5, penalty: 0 });
    expect([b.gross, b.insurance, b.tax, b.net]).toEqual([7_810_000, 0, 781_000, 7_029_000]);
    const c = run('marketing', { base: 8_000_000, member: 31_000_000, gym: 200_000_000, pt: 5_000_000, total: 0, taught: 0, classes: 0, penalty: 50_000 });
    expect([c.gross, c.insurance, c.tax, c.net]).toEqual([13_460_000, 577_500, 0, 12_832_500]);
  });

  it('progressive mode without brackets deducts the fixed tax amount', () => {
    const s = { ...DEFAULT_SETTINGS, fixedTax: 300_000 };
    const r = computeRow({ userId: 'u', name: 'U', profile: { position: 'pt_fulltime', baseSalary: 5_500_000, hasInsurance: true, taxMode: 'progressive', dependents: 0 }, memberSales: 0, gymMemberTotal: 0, ptSales: 0, ptSessionPay: 0, ptSessionsTaught: 0, groupClasses: 0, penalty: 0, adjustment: 0 }, s);
    expect(r.insurance).toBe(577_500);
    expect(r.tax).toBe(300_000);
    expect(r.net).toBe(5_500_000 - 577_500 - 300_000);
  });

  it('progressive tax uses the configured brackets and deductions', () => {
    const s = { ...DEFAULT_SETTINGS, taxBrackets: [{ upTo: 5_000_000, rate: 5 }, { upTo: null, rate: 10 }], personalDeduction: 2_000_000, dependentDeduction: 1_000_000 };
    const r = computeRow({ userId: 'u', name: 'U', profile: { position: 'pt_fulltime', baseSalary: 10_000_000, hasInsurance: false, taxMode: 'progressive', dependents: 1 }, memberSales: 0, gymMemberTotal: 0, ptSales: 0, ptSessionPay: 0, ptSessionsTaught: 0, groupClasses: 0, penalty: 0, adjustment: 0 }, s);
    expect(r.tax).toBe(450_000);
    expect(r.tax_pending).toBe(false);
  });
});

describe('payroll API', () => {
  beforeAll(async () => {
    BR = (await prisma.branch.create({ data: { code: `py${sfx}`, name: 'PY' } })).id;
    await makeUser(`owner@py${sfx}.test`, 'owner', null);
    owner = await tokenFor(`owner@py${sfx}.test`);
    await makeUser(`rec@py${sfx}.test`, 'receptionist', `py${sfx}`);
    recep = await tokenFor(`rec@py${sfx}.test`);
    for (const k of ['ptFull', 'ptPart', 'mkt', 'sale']) ids[k] = (await makeUser(`${k}@py${sfx}.test`, k.startsWith('pt') ? 'trainer' : 'sales', `py${sfx}`)).id;

    memberPkg = (await prisma.package.create({ data: { name: `PM ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: BR } })).id;
    ptPkg = (await prisma.package.create({ data: { name: `PP ${sfx}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 1000, branchId: BR } })).id;

    // member sales by `sale`: 12M + 8M, a -1M adjustment payment, and a 3M payment confirmed and refunded in the same month
    const m1 = await contract({ pkg: memberPkg, sale: ids.sale, total: 20_000_000 });
    await pay(m1.id, 12_000_000, 5);
    await pay(m1.id, 8_000_000, 6);
    await pay(m1.id, -1_000_000, 7);
    await pay(m1.id, 3_000_000, 8, { status: 'refunded', refundedDay: 9 });
    // member sale by marketing: 10M
    const m2 = await contract({ pkg: memberPkg, sale: ids.mkt, total: 10_000_000 });
    await pay(m2.id, 10_000_000, 11);
    // PT contract of the full-time PT: 35M, 10 sessions, 3 taught
    const a = await contract({ pkg: ptPkg, pt: ids.ptFull, sale: ids.sale, total: 35_000_000, sessions: 10 });
    await pay(a.id, 35_000_000, 12);
    for (const d of [13, 14, 15]) await session(ids.ptFull, a.id, a.memberId, d);
    // PT contract of the part-time PT: 20M, 10 sessions, 2 taught
    const b = await contract({ pkg: ptPkg, pt: ids.ptPart, total: 20_000_000, sessions: 10 });
    await pay(b.id, 20_000_000, 12);
    for (const d of [16, 17]) await session(ids.ptPart, b.id, b.memberId, d);
    // PT package sold by marketing without a PT in charge: 10M
    const c = await contract({ pkg: ptPkg, sale: ids.mkt, total: 10_000_000, sessions: 10 });
    await pay(c.id, 10_000_000, 18);
    // two completed group classes of the full-time PT
    for (const d of [19, 20]) await prisma.groupClass.create({ data: { branchId: BR, trainerId: ids.ptFull, startAt: at(d), endAt: new Date(at(d).getTime() + 3600000), status: 'completed', completedAt: at(d) } });

    expect((await profile(ids.ptFull, { position: 'pt_fulltime', base_salary: 10_000_000, has_insurance: true, tax_mode: 'progressive', dependents: 0, active: true })).status).toBe(200);
    expect((await profile(ids.ptPart, { position: 'pt_parttime', base_salary: 5_000_000, has_insurance: false, tax_mode: 'flat10', dependents: 0, active: true })).status).toBe(200);
    expect((await profile(ids.mkt, { position: 'marketing', base_salary: 8_000_000, has_insurance: true, tax_mode: 'progressive', dependents: 0, active: true })).status).toBe(200);
    expect((await profile(ids.sale, { position: 'sale', base_salary: 0, has_insurance: false, tax_mode: 'none', dependents: 0, active: true })).status).toBe(200);
  });

  it('only the owner can read or change payroll', async () => {
    expect((await request(app).get('/api/payroll/settings').set(auth(recep))).status).toBe(403);
    expect((await request(app).get('/api/payroll/preview').query({ month: MONTH }).set(auth(recep))).status).toBe(403);
    expect((await request(app).put(`/api/payroll/profiles/${ids.sale}`).set(auth(recep)).send({})).status).toBe(403);
  });

  it('settings default to the owner structure, round-trip and validate', async () => {
    const g = await request(app).get('/api/payroll/settings').set(auth(owner));
    expect(g.status).toBe(200);
    expect(g.body.data.classRate).toBe(100000);
    expect(g.body.data.taxBrackets).toEqual([]);
    expect(g.body.data.insuranceBase).toBe(5_500_000);
    expect(g.body.data.fixedTax).toBe(0);
    expect(g.body.data.memberTiers[0]).toEqual({ upTo: 15000000, rate: 1.5 });
    const same = await request(app).put('/api/payroll/settings').set(auth(owner)).send(g.body.data);
    expect(same.status).toBe(200);
    expect((await request(app).put('/api/payroll/settings').set(auth(owner)).send({ ...g.body.data, ptSessionShare: 0.5 })).status).toBe(400);
    expect((await request(app).put('/api/payroll/settings').set(auth(owner)).send({ ...g.body.data, memberTiers: [{ upTo: 100, rate: 1 }] })).status).toBe(400);
  });

  it('lists staff with their payroll profile', async () => {
    const r = await request(app).get('/api/payroll/profiles').set(auth(owner));
    expect(r.status).toBe(200);
    const mine = r.body.data.find((x: { user_id: string }) => x.user_id === ids.ptFull);
    expect(mine.profile.position).toBe('pt_fulltime');
    expect(mine.roles).toContain('trainer');
    expect(mine.branch_codes).toContain(`py${sfx}`);
    expect(r.body.data.some((x: { roles: string[] }) => x.roles.length === 1 && x.roles[0] === 'member')).toBe(false);
  });

  it('computes the full-time PT: 40% now, 60% per taught session, group classes, insurance on fixed base, fixed tax 0', async () => {
    const r = await row('ptFull');
    expect(r.pt_sales).toBe(35_000_000);
    expect(r.pt_rate).toBe(27);
    expect(r.pt_immediate).toBe(3_780_000);
    expect(r.pt_sessions_taught).toBe(3);
    expect(r.pt_session_pay).toBe(1_701_000);
    expect(r.group_classes).toBe(2);
    expect(r.group_pay).toBe(200_000);
    expect(r.member_commission).toBe(0);
    expect(r.gross).toBe(10_000_000 + 3_780_000 + 1_701_000 + 200_000);
    expect(r.insurance).toBe(577_500);
    expect(r.tax).toBe(0);
    expect(r.tax_pending).toBe(false);
    expect(r.net).toBe(15_681_000 - 577_500);
  });

  it('computes the part-time PT without insurance and with flat 10% tax', async () => {
    const r = await row('ptPart');
    expect(r.pt_sales).toBe(20_000_000);
    expect(r.pt_rate).toBe(25);
    expect(r.pt_immediate).toBe(2_000_000);
    expect(r.pt_session_pay).toBe(600_000);
    expect(r.gross).toBe(7_600_000);
    expect(r.insurance).toBe(0);
    expect(r.tax).toBe(760_000);
    expect(r.net).toBe(6_840_000);
  });

  it('computes marketing: Bang 1, Bang 4 on the whole gym, PT sale without a PT, no sessions or classes', async () => {
    const r = await row('mkt');
    expect(r.member_sales).toBe(10_000_000);
    expect(r.member_commission).toBe(150_000);
    expect(r.marketing_commission).toBe(435_000);
    expect(r.pt_sales).toBe(10_000_000);
    expect(r.pt_immediate).toBe(1_000_000);
    expect(r.pt_session_pay).toBe(0);
    expect(r.group_pay).toBe(0);
    expect(r.gross).toBe(8_000_000 + 150_000 + 435_000 + 1_000_000);
    expect(r.insurance).toBe(577_500);
    expect(r.tax_pending).toBe(false);
  });

  it('member commission uses thuc thu: payments minus refunds and negative payments', async () => {
    const r = await row('sale');
    expect(r.member_sales).toBe(19_000_000);
    expect(r.member_commission).toBe(325_000);
    expect(r.pt_sales).toBe(0);
    expect(r.gross).toBe(325_000);
  });

  it('applies penalties and adjustments, then closing freezes the month', async () => {
    const adj = await request(app).put('/api/payroll/adjustments').set(auth(owner)).send({ user_id: ids.ptFull, month: MONTH, penalty: 100_000, adjustment: 50_000, note: 'tre 2 buoi' });
    expect(adj.status).toBe(200);
    const r = await row('ptFull');
    expect(r.net).toBe(15_681_000 - 577_500 - 100_000 + 50_000);
    expect(r.note).toBe('tre 2 buoi');

    const close = await request(app).post('/api/payroll/close').set(auth(owner)).send({ month: MONTH });
    expect(close.status).toBe(200);
    expect(close.body.data.status).toBe('closed');
    expect((await request(app).post('/api/payroll/close').set(auth(owner)).send({ month: MONTH })).status).toBe(409);
    expect((await request(app).put('/api/payroll/adjustments').set(auth(owner)).send({ user_id: ids.ptFull, month: MONTH, penalty: 0, adjustment: 0 })).status).toBe(409);

    const before = await row('sale');
    const extra = await contract({ pkg: memberPkg, sale: ids.sale, total: 5_000_000 });
    await pay(extra.id, 5_000_000, 21);
    const after = await row('sale');
    expect(after.member_sales).toBe(before.member_sales);
    const list = await request(app).get('/api/payroll/periods').set(auth(owner));
    expect(list.body.data.find((p: { month: string }) => p.month === MONTH).status).toBe('closed');

    expect((await request(app).post('/api/payroll/reopen').set(auth(owner)).send({ month: MONTH })).status).toBe(200);
    const reopened = await row('sale');
    expect(reopened.member_sales).toBe(24_000_000);
    expect((await request(app).post('/api/payroll/reopen').set(auth(owner)).send({ month: MONTH })).status).toBe(409);
  });

  it('rejects an invalid month', async () => {
    expect((await request(app).get('/api/payroll/preview').query({ month: '2031-13' }).set(auth(owner))).status).toBe(400);
  });
});
