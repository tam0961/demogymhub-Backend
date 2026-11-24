import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
const digits = String(Date.now()).slice(-7);
let A = '';
let B = '';
let rec = '';
let recB = '';
let owner = '';
const hr = () => ({ Authorization: `Bearer ${rec}`, 'X-Branch-Id': A });
const hb = () => ({ Authorization: `Bearer ${recB}`, 'X-Branch-Id': B });
const ho = (b: string) => ({ Authorization: `Bearer ${owner}`, 'X-Branch-Id': b });
const ph = (n: number) => `091${digits}${n}`;

beforeAll(async () => {
  A = (await prisma.branch.create({ data: { code: `dta${sfx}`, name: 'DT A' } })).id;
  B = (await prisma.branch.create({ data: { code: `dtb${sfx}`, name: 'DT B' } })).id;
  await makeUser(`rec@dta${sfx}.test`, 'receptionist', `dta${sfx}`);
  await makeUser(`recb@dtb${sfx}.test`, 'receptionist', `dtb${sfx}`);
  await makeUser(`own@dta${sfx}.test`, 'owner', null);
  rec = await tokenFor(`rec@dta${sfx}.test`);
  recB = await tokenFor(`recb@dtb${sfx}.test`);
  owner = await tokenFor(`own@dta${sfx}.test`);
  await request(app).post('/api/shifts/open').set(hr()).send({ opening_cash: 0 }).expect(201);
});

describe('day tickets', () => {
  it('sells a ticket for 100000 with no contract and records the collector', async () => {
    const r = await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Khách lẻ', phone: ph(1), method: 'cash' });
    expect(r.status).toBe(201);
    expect(r.body.data.amount).toBe(100000);
    expect(r.body.data.created_by_name).toBeTruthy();
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.data.payment_id } });
    expect(p.kind).toBe('retail');
    expect(p.contractId).toBeNull();
    expect(p.status).toBe('confirmed');
    expect(p.shiftId).toBeTruthy();
  });

  it('maps momo to ewallet and takes cash without an open shift', async () => {
    const r = await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Momo', phone: ph(2), method: 'momo' });
    expect(r.status).toBe(201);
    expect(r.body.data.method).toBe('ewallet');
    const noShift = await request(app).post('/api/day-tickets').set(hb()).send({ name: 'X', phone: ph(3), method: 'cash' });
    expect(noShift.status).toBe(201);
    expect(noShift.body.data.method).toBe('cash');
  });

  it('accepts the last 4 digits of the phone and blocks the same name and digits while inside', async () => {
    const a = await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Lan', phone: '4821', method: 'cash' });
    expect(a.status).toBe(201);
    expect(a.body.data.phone).toBe('4821');
    expect((await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Lan', phone: '4821', method: 'cash' })).status).toBe(409);
    expect((await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Mai', phone: '4821', method: 'cash' })).status).toBe(201);
    expect((await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Lan', phone: '482', method: 'cash' })).status).toBe(400);
  });

  it('blocks a phone that is still inside, allows it again after checkout', async () => {
    const first = await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Hai', phone: ph(4), method: 'card' });
    expect(first.status).toBe(201);
    const dup = await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Hai', phone: ph(4), method: 'card' });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).toContain('đã có vé hôm nay');
    await request(app).post(`/api/day-tickets/${first.body.data.id}/checkout`).set(hr()).expect(200);
    await request(app).post(`/api/day-tickets/${first.body.data.id}/checkout`).set(hr()).expect(409);
    await request(app).post('/api/day-tickets').set(hr()).send({ name: 'Hai', phone: ph(4), method: 'card' }).expect(201);
  });

  it('blocks a member with an active contract but not one with an expired contract', async () => {
    const today = dateOnly(todayVN());
    const pkg = await prisma.package.create({ data: { name: `DTP${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: A } });
    const mk = async (n: number, end: number, status: 'active' | 'expired') => {
      const m = await prisma.member.create({ data: { code: `DT${sfx}${n}`, name: `HV ${n}`, phone: ph(n), branchId: A } });
      await prisma.contract.create({ data: { code: `DTC${sfx}${n}`, memberId: m.id, packageId: pkg.id, branchId: A, status, totalAmount: 1000, paidAmount: 1000, durationDays: 30, startDate: addDays(today, -40), endDate: addDays(today, end) } });
    };
    await mk(5, 3, 'active');
    await mk(6, -5, 'expired');
    const blocked = await request(app).post('/api/day-tickets').set(hr()).send({ name: 'HV', phone: ph(5), method: 'cash' });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('đang còn hợp đồng');
    await request(app).post('/api/day-tickets').set(hr()).send({ name: 'HV', phone: ph(6), method: 'cash' }).expect(201);
  });

  it('validates input and scopes by branch', async () => {
    await request(app).post('/api/day-tickets').set(hr()).send({ name: '', phone: ph(7), method: 'cash' }).expect(400);
    await request(app).post('/api/day-tickets').set(hr()).send({ name: 'A', phone: '12', method: 'cash' }).expect(400);
    await request(app).post('/api/day-tickets').set(hr()).send({ name: 'A', phone: ph(7), method: 'vietqr' }).expect(400);
    await request(app).post('/api/day-tickets').set({ Authorization: `Bearer ${rec}`, 'X-Branch-Id': B }).send({ name: 'A', phone: ph(7), method: 'transfer' }).expect(403);
    const list = await request(app).get('/api/day-tickets').set(hr());
    expect(list.status).toBe(200);
    expect(list.body.data.every((t: { branch_id: string }) => t.branch_id === A)).toBe(true);
    expect(list.body.meta.total).toBe(list.body.data.reduce((s: number, t: { amount: number }) => s + t.amount, 0));
    expect(list.body.meta.price).toBe(100000);
    const own = await request(app).get('/api/day-tickets').set(ho(B));
    expect(own.body.data.every((t: { branch_id: string }) => t.branch_id === B)).toBe(true);
    await request(app).post('/api/day-tickets').set(ho(B)).send({ name: 'A', phone: ph(8), method: 'transfer' }).expect(403);
  });

  it('counts retail revenue under Vé lẻ without breaking reports or payment actions', async () => {
    const rs = await request(app).get('/api/reports/revenue-services').set(ho(A));
    expect(rs.status).toBe(200);
    const item = rs.body.data.items.find((i: { name: string }) => i.name === 'Vé lẻ');
    expect(item.revenue).toBeGreaterThanOrEqual(100000);
    const dash = await request(app).get('/api/reports/dashboard').set(ho(A));
    expect(dash.status).toBe(200);
    expect(dash.body.data.revenue_by_kind.retail).toBeGreaterThanOrEqual(100000);
    for (const path of ['/api/reports/daily-closing', '/api/reports/business', '/api/reports/today-tasks', '/api/payments']) {
      const r = await request(app).get(path).set(ho(A));
      expect(r.status, path).toBe(200);
    }
    const retail = await prisma.payment.findFirstOrThrow({ where: { kind: 'retail', branchId: A } });
    const conf = await request(app).post(`/api/payments/${retail.id}/confirm`).set(ho(A));
    expect(conf.status).toBe(409);
  });

  it('enforces payment constraints in the database', async () => {
    await expect(prisma.payment.create({ data: { branchId: A, method: 'cash', amount: 0, ref: `Z${sfx}`, kind: 'retail' } })).rejects.toThrow();
    await expect(prisma.payment.create({ data: { branchId: A, method: 'cash', amount: 5, ref: `Y${sfx}`, kind: 'contract' } })).rejects.toThrow();
  });
});
