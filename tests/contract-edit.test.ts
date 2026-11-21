import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let BR = '';
let owner = '';
let recept = '';
let pkgA = '';
let pkgB = '';
let cid = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  BR = (await prisma.branch.create({ data: { code: `ce${sfx}`, name: 'CE' } })).id;
  await makeUser(`owner@ce${sfx}.test`, 'owner', null);
  owner = await tokenFor(`owner@ce${sfx}.test`);
  await makeUser(`rec@ce${sfx}.test`, 'receptionist', `ce${sfx}`);
  recept = await tokenFor(`rec@ce${sfx}.test`);
  pkgA = (await prisma.package.create({ data: { name: `A ${sfx}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 1000, branchId: BR } })).id;
  pkgB = (await prisma.package.create({ data: { name: `B ${sfx}`, type: 'month', category: 'member', durationDays: 30, price: 1000, branchId: BR } })).id;
  const m = await prisma.member.create({ data: { code: `CE${sfx}`, name: 'CE M', phone: `ce${sfx}`, branchId: BR } });
  const c = await prisma.contract.create({
    data: { code: `CEC${sfx}`, memberId: m.id, packageId: pkgA, branchId: BR, status: 'active', totalAmount: 5_000_000, paidAmount: 2_000_000, sessionsTotal: 10, sessionsLeft: 6, startDate: new Date('2031-01-01'), endDate: new Date('2031-03-01'), packageName: 'Old name' },
  });
  cid = c.id;
});

describe('PATCH /contracts/:id', () => {
  it('lets the owner fix package, dates, amount, sessions and note and records an event', async () => {
    const r = await request(app).patch(`/api/contracts/${cid}`).set(auth(owner)).send({ package_id: pkgB, end_date: '2031-04-01', total_amount: 4_000_000, sessions_total: null, sessions_left: null, note: 'Sửa theo GymMaster', reason: 'Nhập sai gói' });
    expect(r.status).toBe(200);
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: cid } });
    expect(c).toMatchObject({ packageId: pkgB, totalAmount: 4_000_000, sessionsTotal: null, sessionsLeft: null, note: 'Sửa theo GymMaster', packageName: null });
    expect(c.endDate!.toISOString().slice(0, 10)).toBe('2031-04-01');
    const ev = await prisma.contractEvent.findFirst({ where: { contractId: cid, type: 'edited' } });
    expect(ev).toBeTruthy();
  });

  it('rejects an amount below what was paid, bad dates and extra sessions left', async () => {
    const a = await request(app).patch(`/api/contracts/${cid}`).set(auth(owner)).send({ total_amount: 1_000_000, reason: 'x' });
    expect(a.status).toBe(400);
    const b = await request(app).patch(`/api/contracts/${cid}`).set(auth(owner)).send({ start_date: '2031-05-01', reason: 'x' });
    expect(b.status).toBe(400);
    const c = await request(app).patch(`/api/contracts/${cid}`).set(auth(owner)).send({ sessions_total: 5, sessions_left: 9, reason: 'x' });
    expect(c.status).toBe(400);
    const d = await request(app).patch(`/api/contracts/${cid}`).set(auth(owner)).send({ reason: 'x' });
    expect(d.status).toBe(400);
  });

  it('needs a reason and the contracts.edit permission', async () => {
    expect((await request(app).patch(`/api/contracts/${cid}`).set(auth(owner)).send({ note: 'a' })).status).toBe(400);
    expect((await request(app).patch(`/api/contracts/${cid}`).set(auth(recept)).send({ note: 'a', reason: 'x' })).status).toBe(403);
  });

  it('refuses a cancelled contract', async () => {
    await prisma.contract.update({ where: { id: cid }, data: { status: 'cancelled' } });
    const r = await request(app).patch(`/api/contracts/${cid}`).set(auth(owner)).send({ note: 'b', reason: 'x' });
    expect(r.status).toBe(409);
  });
});
