import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, branchId, makeUser, tokenFor } from './helpers';

let nb: string;
let owner: string;
let ptA = '';
let ptB = '';
const sfx = Date.now().toString(36);
const h = () => ({ Authorization: `Bearer ${owner}`, 'X-Branch-Id': nb });

beforeAll(async () => {
  nb = await branchId('nb');
  await makeUser(`wo${sfx}@w.test`, 'owner', null);
  owner = await tokenFor(`wo${sfx}@w.test`);
  ptA = (await makeUser(`wa${sfx}@w.test`, 'trainer', 'nb')).id;
  ptB = (await makeUser(`wb${sfx}@w.test`, 'trainer', 'nb')).id;
  for (const id of [ptA, ptB]) await prisma.payrollProfile.create({ data: { userId: id, position: 'pt_fulltime' } });
  const member = await prisma.member.create({ data: { code: `WS${sfx}`, name: 'WS Member', phone: `05${sfx.replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`, branchId: nb } });
  const pkg = await prisma.package.create({ data: { name: `WS PT ${sfx}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 1000, branchId: nb } });
  const mk = async (code: string, saleUserId: string | null, ptUserId: string, amount: number) => {
    const c = await prisma.contract.create({ data: { memberId: member.id, branchId: nb, status: 'active', totalAmount: amount, code: `${code}${sfx}`, packageId: pkg.id, saleUserId, ptUserId } });
    await prisma.payment.create({ data: { contractId: c.id, branchId: nb, method: 'cash', amount, status: 'confirmed', ref: `ws-${code}-${sfx}`, confirmedAt: new Date() } });
  };
  await mk('S1', ptA, ptB, 800);
  await mk('S2', ptB, ptB, 300);
  await mk('S3', null, ptA, 9000);
});

describe('PT work report revenue', () => {
  it('credits revenue to the seller, not the teaching PT, and skips contracts without a seller', async () => {
    const now = new Date();
    const r = await request(app).get('/api/reports/work').query({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }).set(h());
    expect(r.status).toBe(200);
    const row = (id: string) => r.body.data.rows.find((x: { user_id: string }) => x.user_id === id);
    expect(row(ptA).total).toBe(800);
    expect(row(ptB).total).toBe(300);
  });
});
