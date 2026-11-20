import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { vnDayOf } from '../src/lib/dates';
import { app, login, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let seq = 0;
const uniq = () => `${sfx}${++seq}`;
let A = '';
let B = '';
let owner = '';
let manager = '';
let reception = '';
const ho = () => ({ Authorization: `Bearer ${owner}` });
const hm = () => ({ Authorization: `Bearer ${manager}`, 'X-Branch-Id': A });
const hr = () => ({ Authorization: `Bearer ${reception}`, 'X-Branch-Id': A });
const month = vnDayOf(new Date()).slice(0, 7);
const DAY = 86400000;

const createStaff = async (name: string, position: string, branch = A, extra: object = {}) => {
  const r = await request(app).post('/api/staff').set(ho()).send({ name, position, branch_id: branch, ...extra });
  expect(r.status).toBe(201);
  return r.body.data as { user_id: string };
};

beforeAll(async () => {
  const codeA = `sa${uniq()}`;
  const codeB = `sb${uniq()}`;
  A = (await prisma.branch.create({ data: { code: codeA, name: 'ST A' } })).id;
  B = (await prisma.branch.create({ data: { code: codeB, name: 'ST B' } })).id;
  await makeUser(`own@${codeA}.test`, 'owner', null);
  owner = await tokenFor(`own@${codeA}.test`);
  await makeUser(`mgr@${codeA}.test`, 'branch_manager', codeA);
  manager = await tokenFor(`mgr@${codeA}.test`);
  await makeUser(`rec@${codeA}.test`, 'receptionist', codeA);
  reception = await tokenFor(`rec@${codeA}.test`);
});

describe('staff profiles', () => {
  it('creates a staff member without a usable login, edits, syncs payroll position and deactivates', async () => {
    const emp = `E${uniq()}`;
    const s = await createStaff('PT Moi', 'pt_fulltime', A, { phone: '0900000001', employee_no: emp, hired_on: '2026-01-05', note: 'moi vao' });
    const row = (await request(app).get('/api/staff').set(ho()).query({ branch_id: A, month })).body.data.rows.find((x: { user_id: string }) => x.user_id === s.user_id);
    expect(row.position).toBe('pt_fulltime');
    expect(row.phone).toBe('0900000001');
    expect(row.hired_on).toBe('2026-01-05');
    expect(row.employee_no).toBe(emp);
    expect(row.branches.map((b: { id: string }) => b.id)).toEqual([A]);

    const u = await prisma.user.findUniqueOrThrow({ where: { id: s.user_id } });
    expect(u.email).toMatch(/^staff-[0-9a-f]{8}@thgym\.local$/);
    expect((await login(u.email, 'anything-at-all')).status).toBe(401);

    const dupEmp = await request(app).post('/api/staff').set(ho()).send({ name: 'X', position: 'sale', branch_id: A, employee_no: emp });
    expect(dupEmp.status).toBe(400);
    expect(dupEmp.body.error.code).toBe('EMPLOYEE_NO_TAKEN');

    await prisma.payrollProfile.create({ data: { userId: s.user_id, position: 'pt_fulltime', baseSalary: 1000000 } });
    const ed = await request(app).put(`/api/staff/${s.user_id}`).set(ho()).send({ name: 'PT Moi 2', phone: '0900000002', position: 'reception' });
    expect(ed.status).toBe(200);
    expect(ed.body.data.name).toBe('PT Moi 2');
    expect(ed.body.data.position).toBe('reception');
    expect((await prisma.payrollProfile.findUniqueOrThrow({ where: { userId: s.user_id } })).position).toBe('other');
    const back = await request(app).put(`/api/staff/${s.user_id}`).set(ho()).send({ position: 'pt_parttime' });
    expect(back.body.data.position).toBe('pt_parttime');
    expect((await prisma.payrollProfile.findUniqueOrThrow({ where: { userId: s.user_id } })).position).toBe('pt_parttime');

    const inPicker = async () => (await request(app).get('/api/contracts/pt-staff').set(ho()).query({ branch_id: A })).body.data.map((x: { id: string }) => x.id);
    const inSale = async () => (await request(app).get('/api/contracts/sale-staff').set(ho()).query({ branch_id: A })).body.data.map((x: { id: string }) => x.id);
    const inPayroll = async () => (await request(app).get('/api/payroll/profiles').set(ho())).body.data.map((x: { user_id: string }) => x.user_id);
    expect(await inPicker()).toContain(s.user_id);
    expect(await inSale()).toContain(s.user_id);
    expect(await inPayroll()).toContain(s.user_id);

    const off = await request(app).put(`/api/staff/${s.user_id}`).set(ho()).send({ active: false });
    expect(off.body.data.active).toBe(false);
    expect(off.body.data.left_on).toBe(vnDayOf(new Date()));
    expect(await inPicker()).not.toContain(s.user_id);
    expect(await inSale()).not.toContain(s.user_id);
    expect(await inPayroll()).not.toContain(s.user_id);

    const on = await request(app).put(`/api/staff/${s.user_id}`).set(ho()).send({ active: true });
    expect(on.body.data.active).toBe(true);
    expect(on.body.data.left_on).toBeNull();
    expect(await inPicker()).toContain(s.user_id);
  });

  it('keeps permissions and branch scope', async () => {
    const inB = await createStaff('PT Chi nhanh B', 'pt_fulltime', B);
    const inA = await createStaff('PT Chi nhanh A', 'pt_fulltime', A);

    expect((await request(app).get('/api/staff').set(hr())).status).toBe(403);
    const mine = await request(app).get('/api/staff').set(hm()).query({ month });
    expect(mine.status).toBe(200);
    const ids = mine.body.data.rows.map((x: { user_id: string }) => x.user_id);
    expect(ids).toContain(inA.user_id);
    expect(ids).not.toContain(inB.user_id);
    expect((await request(app).get(`/api/staff/${inB.user_id}`).set(hm())).status).toBe(404);
    expect((await request(app).get(`/api/staff/${inA.user_id}`).set(hm())).status).toBe(200);
    expect((await request(app).put(`/api/staff/${inA.user_id}`).set(hm()).send({ note: 'x' })).status).toBe(403);
    expect((await request(app).post('/api/staff').set(hm()).send({ name: 'Z', position: 'sale', branch_id: A })).status).toBe(403);

    const onlyB = await request(app).get('/api/staff').set(ho()).query({ month, branch_id: B });
    const bIds = onlyB.body.data.rows.map((x: { user_id: string }) => x.user_id);
    expect(bIds).toContain(inB.user_id);
    expect(bIds).not.toContain(inA.user_id);
  });
});

describe('staff KPIs', () => {
  it('computes contracts, customers, revenue, portfolio and teaching numbers, with rank, previous month and detail', async () => {
    const pt = await createStaff('PT KPI', 'pt_fulltime');
    const pt2 = await createStaff('PT Khac', 'pt_fulltime');
    const sale = await createStaff('Sale KPI', 'sale');
    const mk = (n: number) => prisma.member.create({ data: { code: `HV${uniq()}`, name: `Khach ${n}`, phone: `ph${uniq()}`, branchId: A } });
    const [m1, m2, m3, m4, m5, m6] = await Promise.all([1, 2, 3, 4, 5, 6].map(mk));
    const memPkg = await prisma.package.create({ data: { name: `KM ${sfx}`, type: 'month', durationDays: 30, price: 1000000, branchId: A } });
    const ptPkg = await prisma.package.create({ data: { name: `KP ${sfx}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 3000000, branchId: A } });
    const today = new Date(`${vnDayOf(new Date())}T00:00:00Z`);
    const dayPlus = (n: number) => new Date(today.getTime() + n * DAY);
    const code = () => `KC${uniq()}`;
    const mkC = (data: Record<string, unknown>) =>
      prisma.contract.create({ data: { code: code(), branchId: A, status: 'active', totalAmount: 0, paidAmount: 0, ...data } as never });

    const c1 = await mkC({ memberId: m1.id, packageId: memPkg.id, saleUserId: sale.user_id, totalAmount: 1000000, paidAmount: 600000 });
    const c2 = await mkC({ memberId: m2.id, packageId: ptPkg.id, saleUserId: sale.user_id, ptUserId: pt.user_id, totalAmount: 3000000, paidAmount: 3000000, sessionsTotal: 10, sessionsLeft: 6, endDate: dayPlus(10) });
    const c3 = await mkC({ memberId: m3.id, packageId: ptPkg.id, ptUserId: pt.user_id, totalAmount: 2000000, paidAmount: 500000, sessionsTotal: 10, sessionsLeft: 4, endDate: dayPlus(60) });
    await mkC({ memberId: m2.id, packageId: memPkg.id, saleUserId: sale.user_id, bundleOfId: c2.id });
    await mkC({ memberId: m1.id, packageId: memPkg.id, saleUserId: sale.user_id, status: 'cancelled', totalAmount: 999999 });

    const pay = (contractId: string, amount: number, at: Date = new Date()) =>
      prisma.payment.create({ data: { contractId, branchId: A, method: 'cash', amount, status: 'confirmed', ref: `KP${uniq()}`, confirmedAt: at } });
    await pay(c1.id, 600000);
    await pay(c2.id, 3000000);
    await pay(c3.id, 500000);
    await pay(c2.id, -200000);

    // renewals: two PT contracts ended in the last 90 days, one member bought another PT contract afterwards
    const old = new Date(Date.now() - 100 * DAY);
    const ptMk = (member: string, end: number, createdAt: Date, extra: object = {}) =>
      mkC({ memberId: member, packageId: ptPkg.id, ptUserId: pt.user_id, status: 'expired', endDate: dayPlus(end), createdAt, ...extra });
    await ptMk(m4.id, -30, old);
    await ptMk(m5.id, -10, old);
    await mkC({ memberId: m4.id, packageId: ptPkg.id, ptUserId: pt2.user_id, createdAt: new Date(Date.now() - 5 * DAY) });

    // teaching in the month
    const now = Date.now();
    const sess = (i: number, status: 'completed' | 'no_show' | 'cancelled') =>
      prisma.ptSession.create({ data: { branchId: A, trainerId: pt.user_id, memberId: m2.id, contractId: c2.id, startAt: new Date(now + i * 60000), endAt: new Date(now + i * 60000 + 3600000), status } });
    await sess(1, 'completed');
    await sess(2, 'completed');
    await sess(3, 'completed');
    await sess(4, 'no_show');
    await sess(5, 'cancelled');
    await prisma.groupClass.create({ data: { branchId: A, trainerId: pt.user_id, startAt: new Date(now + 10 * 60000), endAt: new Date(now + 70 * 60000), status: 'completed' } });

    // previous month
    const now0 = new Date();
    const prevMid = new Date(Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth() - 1, 15, 5));
    const c9 = await mkC({ memberId: m6.id, packageId: memPkg.id, saleUserId: sale.user_id, status: 'expired', totalAmount: 100000, paidAmount: 100000, createdAt: prevMid });
    await pay(c9.id, 100000, prevMid);

    const list = await request(app).get('/api/staff').set(ho()).query({ month, branch_id: A });
    expect(list.status).toBe(200);
    expect(list.body.data.month).toBe(month);
    const byId = (id: string) => list.body.data.rows.find((x: { user_id: string }) => x.user_id === id);

    const s = byId(sale.user_id);
    expect(s.kpi).toMatchObject({
      contracts_sold: 2,
      member_contracts: 1,
      pt_contracts: 1,
      new_customers: 2,
      revenue: 3400000,
      member_revenue: 600000,
      pt_revenue: 2800000,
      avg_contract_value: 1700000,
      debt_outstanding: 400000,
      active_clients: 0,
      sessions_taught: 0,
      group_classes: 0,
    });
    expect(s.prev).toEqual({ contracts_sold: 1, revenue: 100000, sessions_taught: 0, new_customers: 1 });

    const p = byId(pt.user_id);
    expect(p.kpi).toMatchObject({
      contracts_sold: 2,
      member_contracts: 0,
      pt_contracts: 2,
      new_customers: 2,
      revenue: 3300000,
      member_revenue: 0,
      pt_revenue: 3300000,
      avg_contract_value: 1650000,
      debt_outstanding: 1500000,
      active_clients: 2,
      sessions_left_total: 10,
      expiring_30: 1,
      sessions_taught: 3,
      group_classes: 1,
    });
    expect(p.kpi.session_done_rate).toBeCloseTo(0.6, 5);
    expect(p.kpi.no_show_rate).toBeCloseTo(0.2, 5);
    expect(p.kpi.renewal_rate).toBeCloseTo(0.5, 5);
    expect(p.rank.revenue).toBe(1);
    expect(byId(pt2.user_id).rank.revenue).toBe(2);
    expect(s.rank.revenue).toBe(1);

    const d = await request(app).get(`/api/staff/${pt.user_id}`).set(ho()).query({ month });
    expect(d.status).toBe(200);
    expect(d.body.data.trend).toHaveLength(6);
    expect(d.body.data.trend[5]).toMatchObject({ month, contracts_sold: 2, revenue: 3300000, sessions_taught: 3, new_customers: 2 });
    expect(d.body.data.clients.map((c: { member_id: string }) => c.member_id)).toEqual([m2.id, m3.id]);
    expect(d.body.data.clients[0]).toMatchObject({ contract_code: c2.code, sessions_left: 6, status: 'active' });
    const inMonth = d.body.data.contracts.map((c: { id: string; role: string }) => [c.id, c.role]);
    expect(inMonth).toEqual(expect.arrayContaining([[c2.id, 'pt'], [c3.id, 'pt']]));

    await createStaff('Le tan', 'reception');
    const rec = (await request(app).get('/api/staff').set(ho()).query({ month, branch_id: A })).body.data.rows.find((x: { position: string }) => x.position === 'reception');
    expect(rec.rank.revenue).toBeNull();
    expect(rec.kpi.contracts_sold).toBe(0);
  });
});
