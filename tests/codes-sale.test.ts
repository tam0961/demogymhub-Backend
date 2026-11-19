import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let A: string;
let rec = '';
let saleId = '';
let otherId = '';
let ptId = '';
const h = () => ({ Authorization: `Bearer ${rec}`, 'X-Branch-Id': A });

beforeAll(async () => {
  const code = `cs${sfx}`;
  A = (await prisma.branch.create({ data: { code, name: 'CS' } })).id;
  await makeUser(`rec@${code}.test`, 'receptionist', code);
  rec = await tokenFor(`rec@${code}.test`);
  saleId = (await makeUser(`sale@${code}.test`, 'sales', code)).id;
  const other = await prisma.branch.create({ data: { code: `co${sfx}`, name: 'CO' } });
  otherId = (await makeUser(`oth@${code}.test`, 'sales', `co${sfx}`)).id;
  void other;
  ptId = (await makeUser(`pt@${code}.test`, 'trainer', code)).id;
  await prisma.member.create({ data: { code: 'HV1457', name: 'Cu', phone: `01${sfx.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`, branchId: A } });
});

describe('member and contract code rules', () => {
  it('numbers members HV + 4 digits after the highest HV code', async () => {
    const r = await request(app).post('/api/members').set(h()).send({ name: 'Khach Moi', phone: `02${sfx.replace(/\D/g, '').padEnd(8, '2').slice(0, 8)}` });
    expect(r.status).toBe(201);
    expect(r.body.data.code).toMatch(/^HV\d{4,}$/);
    const n = Number(r.body.data.code.slice(2));
    expect(n).toBeGreaterThan(1457);
  });

  it('numbers contracts GHD for member, GPT for PT packages (+5 digits), with the Sale on the contract', async () => {
    const m = await prisma.member.create({ data: { code: `HV9${sfx.slice(-3).replace(/\D/g, '1')}`, name: 'Khach HD', phone: `03${sfx.replace(/\D/g, '').padEnd(8, '3').slice(0, 8)}`, branchId: A } });
    const memPkg = await prisma.package.create({ data: { name: `M ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: A } });
    const ptPkg = await prisma.package.create({ data: { name: `P ${sfx}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 2000, branchId: A } });

    const c1 = await request(app).post('/api/contracts').set(h()).send({ member_id: m.id, package_id: memPkg.id, sale_user_id: saleId });
    expect(c1.status).toBe(201);
    expect(c1.body.data.code).toMatch(/^GHD\d{5}$/);
    expect(c1.body.data.sale.id).toBe(saleId);

    const c2 = await request(app).post('/api/contracts').set(h()).send({ member_id: m.id, package_id: ptPkg.id });
    expect(c2.status).toBe(201);
    expect(c2.body.data.code).toMatch(/^GPT\d{5}$/);
    expect(c2.body.data.sale).toBeNull();

    const c3 = await request(app).post('/api/contracts').set(h()).send({ member_id: m.id, package_id: memPkg.id });
    expect(Number(c3.body.data.code.slice(3))).toBe(Number(c1.body.data.code.slice(3)) + 1);
  });

  it('only accepts active staff of the contract branch as Sale and lists them', async () => {
    const m = await prisma.member.create({ data: { code: `HV8${sfx.slice(-3).replace(/\D/g, '2')}`, name: 'Khach Sale', phone: `04${sfx.replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`, branchId: A } });
    const pkg = await prisma.package.create({ data: { name: `S ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: A } });
    const bad = await request(app).post('/api/contracts').set(h()).send({ member_id: m.id, package_id: pkg.id, sale_user_id: otherId });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_SALE');
    const list = await request(app).get('/api/contracts/sale-staff').query({ branch_id: A }).set(h());
    expect(list.status).toBe(200);
    const ids = list.body.data.map((x: { id: string }) => x.id);
    expect(ids).toContain(saleId);
    expect(ids).not.toContain(otherId);
  });
});

describe('PT in charge on contracts and filters', () => {
  it('stores the PT, lists trainers, and filters contracts and members by PT', async () => {
    const m = await prisma.member.create({ data: { code: `HV7${sfx.slice(-3).replace(/\D/g, '3')}`, name: 'Khach PT', phone: `07${sfx.replace(/\D/g, '').padEnd(8, '5').slice(0, 8)}`, branchId: A } });
    const m2 = await prisma.member.create({ data: { code: `HV6${sfx.slice(-3).replace(/\D/g, '4')}`, name: 'Khach Khac', phone: `06${sfx.replace(/\D/g, '').padEnd(8, '6').slice(0, 8)}`, branchId: A } });
    const pkg = await prisma.package.create({ data: { name: `T ${sfx}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 2000, branchId: A } });
    const bad = await request(app).post('/api/contracts').set(h()).send({ member_id: m.id, package_id: pkg.id, pt_user_id: saleId });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PT');
    const ok = await request(app).post('/api/contracts').set(h()).send({ member_id: m.id, package_id: pkg.id, pt_user_id: ptId });
    expect(ok.status).toBe(201);
    expect(ok.body.data.pt.id).toBe(ptId);
    await request(app).post('/api/contracts').set(h()).send({ member_id: m2.id, package_id: pkg.id });
    await prisma.contract.update({ where: { id: ok.body.data.id }, data: { status: 'active' } });

    const staff = await request(app).get('/api/contracts/pt-staff').query({ branch_id: A }).set(h());
    expect(staff.body.data.map((x: { id: string }) => x.id)).toContain(ptId);

    const cl = await request(app).get('/api/contracts').query({ pt_user_id: ptId }).set(h());
    expect(cl.body.data.map((x: { id: string }) => x.id)).toEqual([ok.body.data.id]);
    const ml = await request(app).get('/api/members').query({ pt_user_id: ptId }).set(h());
    expect(ml.body.data.map((x: { id: string }) => x.id)).toEqual([m.id]);
  });
});

