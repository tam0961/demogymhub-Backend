import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { app, branchId, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let tok = '';
let recTok = '';
let b: string;

beforeAll(async () => {
  b = await branchId('q7');
  await makeUser(`own${sfx}@bz.test`, 'owner', null);
  await makeUser(`rec${sfx}@bz.test`, 'receptionist', 'q7');
  tok = await tokenFor(`own${sfx}@bz.test`);
  recTok = await tokenFor(`rec${sfx}@bz.test`);
  const member = await prisma.member.create({ data: { code: `BZ${sfx}`, name: `BZ ${sfx}`, phone: `09${String(Date.now()).slice(-8)}`, branchId: b } });
  const today = dateOnly(todayVN());
  const mk = async (category: 'member' | 'pt_1on1', price: number, paid: number, endIn: number) => {
    const pkg = await prisma.package.create({ data: { name: `BZP ${category} ${sfx}`, type: 'month', category, durationDays: 30, price, branchId: b } });
    const c = await prisma.contract.create({
      data: { code: `BZ${category}${sfx}`, memberId: member.id, packageId: pkg.id, branchId: b, status: 'active', totalAmount: price, paidAmount: paid, durationDays: 30, startDate: addDays(today, -20), endDate: addDays(today, endIn) },
    });
    await prisma.payment.create({ data: { contractId: c.id, branchId: b, method: 'cash', amount: paid, status: 'confirmed', ref: `BZR${category}${sfx}`, confirmedAt: new Date() } });
  };
  await mk('member', 1000000, 1000000, 5);
  await mk('pt_1on1', 3000000, 2000000, 20);
});

describe('GET /reports/business', () => {
  it('returns chart rows, cards, health and alerts for the current month', async () => {
    const r = await request(app).get('/api/reports/business').query({ branch_id: b }).set({ Authorization: `Bearer ${tok}` });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.mode).toBe('month');
    expect(d.revenue.rows.length).toBeGreaterThanOrEqual(28);
    expect(d.revenue.total).toBeGreaterThanOrEqual(4000000);
    expect(d.collected.total).toBeGreaterThanOrEqual(3000000);
    const sumRow = (rows: { member: number; pt: number; group: number }[]) => rows.reduce((s, x) => s + x.member + x.pt + x.group, 0);
    expect(sumRow(d.revenue.rows)).toBe(d.revenue.total);
    expect(d.cards.expiring_7.total).toBeGreaterThanOrEqual(1);
    expect(d.cards.pt_active.total).toBeGreaterThanOrEqual(1);
    expect(d.cards.member_active.spark).toHaveLength(14);
    expect(d.health.parts).toHaveLength(4);
    expect(d.health.score).toBeLessThanOrEqual(100);
    expect(d.alerts.expiring_30.count).toBeGreaterThanOrEqual(1);
    expect(d.alerts.debt.impact).toBeGreaterThanOrEqual(1000000);
    expect(d.recent_contracts.length).toBeGreaterThan(0);
    expect(d.expiring_list.some((x: { days_left: number }) => x.days_left <= 7)).toBe(true);
  });

  it('year mode returns 12 buckets and bad input is rejected', async () => {
    const r = await request(app).get('/api/reports/business').query({ mode: 'year', branch_id: b }).set({ Authorization: `Bearer ${tok}` });
    expect(r.status).toBe(200);
    expect(r.body.data.revenue.rows).toHaveLength(12);
    await request(app).get('/api/reports/business').query({ month: 13 }).set({ Authorization: `Bearer ${tok}` }).expect(400);
  });

  it('is forbidden without the reports.view permission', async () => {
    const r = await request(app).get('/api/reports/business').set({ Authorization: `Bearer ${recTok}` });
    expect(r.status).toBe(403);
  });
});
