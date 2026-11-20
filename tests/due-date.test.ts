import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, fmtDate, todayVN } from '../src/lib/dates';
import { recalcPaid, overdueDays } from '../src/modules/contracts/service';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let A: string;
let rec = '';
let key = '';
let memberId = '';
let pkgId = '';
const h = () => ({ Authorization: `Bearer ${rec}`, 'X-Branch-Id': A });
const scan = (no: string) =>
  request(app).post(`/api/public/attendance/hikvision/${key}`).send({ dateTime: new Date().toISOString(), AccessControllerEvent: { employeeNoString: no } });
const pay = (contractId: string, amount: number) =>
  prisma.$transaction(async (tx) => {
    await tx.payment.create({ data: { contractId, branchId: A, method: 'cash', amount, status: 'confirmed', ref: `DD${sfx}${Math.random().toString(36).slice(2, 8)}` } });
    return recalcPaid(tx, contractId, true);
  });

beforeAll(async () => {
  const code = `dd${sfx}`;
  A = (await prisma.branch.create({ data: { code, name: 'DD' } })).id;
  await makeUser(`rec@${code}.test`, 'receptionist', code);
  rec = await tokenFor(`rec@${code}.test`);
  await makeUser(`own@${code}.test`, 'owner', null);
  const own = await tokenFor(`own@${code}.test`);
  const dev = await request(app).post('/api/attendance/devices').set({ Authorization: `Bearer ${own}`, 'X-Branch-Id': A }).send({ name: 'DD dev', branch_id: A });
  key = dev.body.data.device_key;
  memberId = (await prisma.member.create({ data: { code: `DM${sfx}`, name: 'Khach No', phone: `06${sfx.replace(/\D/g, '').padEnd(8, '5').slice(0, 8)}`, branchId: A, faceId: `DF${sfx}` } })).id;
  pkgId = (await prisma.package.create({ data: { name: `DD ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: A } })).id;
});

describe('payment due date and deposit', () => {
  it('new contract gets due date created + 25 days and exposes it', async () => {
    const r = await request(app).post('/api/contracts').set(h()).send({ member_id: memberId, package_id: pkgId });
    expect(r.status).toBe(201);
    expect(r.body.data.due_date).toBe(fmtDate(addDays(dateOnly(todayVN()), 25)));
    expect(r.body.data).toMatchObject({ overdue_days: 0, is_deposit: true });
  });

  it('debt payment pushes due date, converts deposit at 50%, clears when paid', async () => {
    const c = await prisma.contract.create({ data: { code: `CD${sfx}`, memberId, packageId: pkgId, branchId: A, status: 'active', totalAmount: 1000, paymentDueDate: dateOnly(todayVN()) } });
    await pay(c.id, 300);
    let f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(fmtDate(f.paymentDueDate)).toBe(fmtDate(addDays(dateOnly(todayVN()), 25)));
    expect(await prisma.contractEvent.count({ where: { contractId: c.id, type: 'deposit_converted' } })).toBe(0);
    await pay(c.id, 200);
    expect(await prisma.contractEvent.count({ where: { contractId: c.id, type: 'deposit_converted' } })).toBe(1);
    await pay(c.id, 500);
    f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(f.paymentDueDate).toBeNull();
    expect(overdueDays(f)).toBe(0);
  });

  it('scan feed reports due date and overdue days', async () => {
    const m = await prisma.member.create({ data: { code: `DO${sfx}`, name: 'Khach Qua Han', phone: `04${sfx.replace(/\D/g, '').padEnd(8, '6').slice(0, 8)}`, branchId: A, faceId: `DO${sfx}` } });
    await prisma.contract.create({
      data: { code: `CO${sfx}`, memberId: m.id, packageId: pkgId, branchId: A, status: 'active', totalAmount: 1000, paidAmount: 600, endDate: addDays(new Date(), 10), paymentDueDate: addDays(dateOnly(todayVN()), -3) },
    });
    const since = new Date(Date.now() - 1000).toISOString();
    await scan(`DO${sfx}`);
    const r = await request(app).get('/api/attendance/scans').query({ since }).set(h());
    const it0 = r.body.data.items.find((x: { employee_no: string }) => x.employee_no === `DO${sfx}`);
    expect(it0.member.debt_contract).toMatchObject({ amount: 400, due_date: fmtDate(addDays(dateOnly(todayVN()), -3)), overdue_days: 3 });
  });
});
