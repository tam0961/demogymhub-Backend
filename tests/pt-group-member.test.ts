import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, branchId, makeUser, tokenFor } from './helpers';

let nb: string;
let reception: string;
let trainerTok: string;
let managerTok: string;
let trainerId: string;
let memberId: string;
let contractId: string;
let n = 0;
const u = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Branch-Id': nb });
const left = async () => (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).sessionsLeft;
const mkClass = async () =>
  (await request(app).post('/api/pt/classes').set(h(reception)).send({ trainer_id: trainerId, start_at: `2032-03-${10 + ++n}T18:00:00+07:00`, capacity: 3 })).body.data.id as string;
const register = (cls: string) => request(app).post(`/api/pt/classes/${cls}/registrations`).set(h(reception)).send({ member_id: memberId });

beforeAll(async () => {
  nb = await branchId('nb');
  const id = u();
  await makeUser(`gr${id}@t.local`, 'receptionist', 'nb');
  trainerId = (await makeUser(`gt${id}@t.local`, 'trainer', 'nb')).id;
  await makeUser(`gm${id}@t.local`, 'branch_manager', 'nb');
  managerTok = await tokenFor(`gm${id}@t.local`);
  reception = await tokenFor(`gr${id}@t.local`);
  trainerTok = await tokenFor(`gt${id}@t.local`);
  memberId = (await prisma.member.create({ data: { code: `G${id}`, name: 'Group Member', phone: `08${id.replace(/\D/g, '').padEnd(8, '2').slice(0, 8)}`, branchId: nb } })).id;
  const pkg = await prisma.package.create({ data: { name: `PT Nhom ${id}`, type: 'month', category: 'member', displayGroup: 'pt_group', durationDays: 30, sessions: 2, price: 1000, branchId: nb } });
  const start = new Date(Date.now() - 86400000);
  contractId = (await prisma.contract.create({
    data: { code: `CGM${id}`, memberId, packageId: pkg.id, branchId: nb, status: 'active', totalAmount: 1000, sessionsTotal: 2, sessionsLeft: 2, startDate: start, endDate: new Date(Date.now() + 20 * 86400000) },
  })).id;
});

describe('PT group package that is a member package', () => {
  it('checks in without touching class sessions, then class registration holds and absent loses the session', async () => {
    const ci = await request(app).post('/api/checkins').set(h(reception)).send({ member_id: memberId });
    expect(ci.body.data.result).toBe('allowed');
    expect(await left()).toBe(2);

    const cls = await mkClass();
    const reg = await register(cls);
    expect(reg.status).toBe(201);
    expect(await left()).toBe(1);

    expect((await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/attendance`).set(h(trainerTok)).send({ status: 'absent' })).status).toBe(403);
    const absent = await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/attendance`).set(h(managerTok)).send({ status: 'absent' });
    expect(absent.status).toBe(200);
    expect(absent.body.data.status).toBe('absent');
    expect(await left()).toBe(1);
    expect((await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/cancel`).set(h(reception))).status).toBe(409);
    const back = await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/attendance`).set(h(managerTok)).send({ status: 'attended' });
    expect(back.body.data.status).toBe('attended');
    await prisma.groupClass.update({ where: { id: cls }, data: { startAt: new Date() } });
    expect((await request(app).post(`/api/pt/classes/${cls}/complete`).set(h(trainerTok))).status).toBe(200);
    const old = await mkClass();
    expect((await request(app).post(`/api/pt/classes/${old}/complete`).set(h(trainerTok))).body.error.code).toBe('NOT_TODAY');
  });

  it('cancelling before the class refunds the session; no sessions left blocks registration but not check-in', async () => {
    const before = (await left()) ?? 0;
    const cls = await mkClass();
    const reg = await register(cls);
    expect(await left()).toBe(before - 1);
    expect((await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/cancel`).set(h(reception))).status).toBe(200);
    expect(await left()).toBe(before);

    await prisma.contract.update({ where: { id: contractId }, data: { sessionsLeft: 0 } });
    const none = await register(await mkClass());
    expect(none.body.error.code).toBe('NO_SESSIONS');
    const ci = await request(app).post('/api/checkins').set(h(reception)).send({ member_id: memberId });
    expect(ci.body.data.result).toBe('allowed');
  });
});
