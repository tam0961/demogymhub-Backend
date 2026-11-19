import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { app, branchId, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let tok = '';
let b: string;

beforeAll(async () => {
  b = await branchId('q7');
  await makeUser(`own${sfx}@rs.test`, 'owner', null);
  tok = await tokenFor(`own${sfx}@rs.test`);
  const member = await prisma.member.create({ data: { code: `RS${sfx}`, name: `RS ${sfx}`, phone: `09${String(Date.now()).slice(-8)}`, branchId: b } });
  const mk = async (category: 'member' | 'pt_1on1', price: number) => {
    const pkg = await prisma.package.create({ data: { name: `RSP ${category} ${sfx}`, type: 'month', category, durationDays: 30, price, branchId: b } });
    const today = dateOnly(todayVN());
    const c = await prisma.contract.create({
      data: { code: `RSC${category}${sfx}`, memberId: member.id, packageId: pkg.id, branchId: b, status: 'active', totalAmount: price, paidAmount: price, durationDays: 30, startDate: addDays(today, -15), endDate: addDays(today, 15) },
    });
    await prisma.payment.create({ data: { contractId: c.id, branchId: b, method: 'cash', amount: price, status: 'confirmed', ref: `RSR${category}${sfx}`, confirmedAt: new Date() } });
  };
  await mk('member', 1000000);
  await mk('pt_1on1', 3000000);
});

describe('revenue by service and contract progress', () => {
  it('groups confirmed payments into gym and pt', async () => {
    const r = await request(app).get('/api/reports/revenue-services').query({ days: 30, branch_id: b }).set({ Authorization: `Bearer ${tok}` });
    expect(r.status).toBe(200);
    const names = r.body.data.items.map((i: { name: string }) => i.name);
    expect(names).toContain(`RSP member ${sfx}`);
    const gym = r.body.data.groups.find((g: { key: string }) => g.key === 'gym').revenue;
    const pt = r.body.data.groups.find((g: { key: string }) => g.key === 'pt').revenue;
    expect(gym).toBeGreaterThanOrEqual(1000000);
    expect(pt).toBeGreaterThanOrEqual(3000000);
    expect(r.body.data.total).toBe(gym + pt);
    await request(app).get('/api/reports/revenue-services').query({ days: 5 }).set({ Authorization: `Bearer ${tok}` }).expect(400);
  });

  it('reports progress about half way for a 30 day contract at day 15', async () => {
    const r = await request(app).get('/api/reports/contract-progress').query({ branch_id: b }).set({ Authorization: `Bearer ${tok}` });
    expect(r.status).toBe(200);
    const row = r.body.data.recent.find((x: { code: string }) => x.code === `RSCmember${sfx}`);
    expect(row.progress).toBeCloseTo(0.5, 1);
    expect(r.body.data.summary.running).toBeGreaterThanOrEqual(2);
    expect(r.body.data.buckets).toHaveLength(4);
  });
});
