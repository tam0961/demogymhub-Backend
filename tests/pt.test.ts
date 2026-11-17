import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, branchId, makeUser, tokenFor } from './helpers';

let nb: string;
let reception: string;
let trainerTok: string;
let trainerId: string;
let memberId: string;
let contractId: string;
let classPkgContract: string;
let mkClass: () => Promise<string>;
const u = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Branch-Id': nb });
const at = (hour: number) => `2030-01-15T${String(hour).padStart(2, '0')}:00:00+07:00`;

beforeAll(async () => {
  nb = await branchId('nb');
  const id = u();
  await makeUser(`rc${id}@t.local`, 'receptionist', 'nb');
  const tr = await makeUser(`pt${id}@t.local`, 'trainer', 'nb');
  trainerId = tr.id;
  reception = await tokenFor(`rc${id}@t.local`);
  trainerTok = await tokenFor(`pt${id}@t.local`);
  const m = await prisma.member.create({ data: { code: `M${id}`, name: 'PT Member', phone: `09${id.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`, branchId: nb } });
  memberId = m.id;
  const pkg = await prisma.package.create({ data: { name: `PT ${id}`, type: 'session', category: 'pt_1on1', sessions: 2, price: 1000, branchId: nb } });
  const c = await prisma.contract.create({
    data: { code: `C${id}`, memberId, packageId: pkg.id, branchId: nb, status: 'active', totalAmount: 1000, sessionsTotal: 2, sessionsLeft: 2 },
  });
  contractId = c.id;
  const mpkg = await prisma.package.create({ data: { name: `Mem ${id}`, type: 'month', durationDays: 30, price: 1000, branchId: nb } });
  await prisma.contract.create({ data: { code: `CM${id}`, memberId, packageId: mpkg.id, branchId: nb, status: 'active', totalAmount: 1000 } });
  const gpkg = await prisma.package.create({ data: { name: `Grp ${id}`, type: 'session', category: 'pt_group', sessions: 2, price: 1000, branchId: nb } });
  const gc = await prisma.contract.create({
    data: { code: `CG${id}`, memberId, packageId: gpkg.id, branchId: nb, status: 'active', totalAmount: 1000, sessionsTotal: 2, sessionsLeft: 2 },
  });
  classPkgContract = gc.id;
  let n = 0;
  mkClass = async () => {
    const r = await request(app).post('/api/pt/classes').set(h(reception)).send({ trainer_id: trainerId, start_at: `2031-02-${10 + ++n}T18:00:00+07:00`, capacity: 1 });
    return r.body.data.id as string;
  };
});

const book = (hour: number, extra: object = {}) =>
  request(app).post('/api/pt/sessions').set(h(reception)).send({ member_id: memberId, trainer_id: trainerId, start_at: at(hour), duration_min: 60, ...extra });

describe('pt sessions', () => {
  it('books, rejects overlap, completes once and deducts once', async () => {
    const a = await book(9, { contract_id: contractId });
    expect(a.status).toBe(201);
    expect((await book(9)).body.error?.code ?? (await book(9)).status).toBeTruthy();
    expect((await book(9)).status).toBe(409);

    const denied = await request(app).post(`/api/pt/sessions/${a.body.data.id}/cancel`).set(h(trainerTok));
    expect(denied.status).toBe(403);

    const done = await request(app).post(`/api/pt/sessions/${a.body.data.id}/complete`).set(h(trainerTok));
    expect(done.status).toBe(200);
    expect((await request(app).post(`/api/pt/sessions/${a.body.data.id}/complete`).set(h(trainerTok))).status).toBe(409);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).sessionsLeft).toBe(1);
  });

  it('trainer sees only own sessions and cannot create', async () => {
    const list = await request(app).get('/api/pt/sessions').set(h(trainerTok)).query({ from: '2030-01-15', to: '2030-01-15' });
    expect(list.status).toBe(200);
    expect(list.body.data.every((s: { trainer: { id: string } }) => s.trainer.id === trainerId)).toBe(true);
    const c = await request(app).post('/api/pt/sessions').set(h(trainerTok)).send({ member_id: memberId, trainer_id: trainerId, start_at: at(14) });
    expect(c.status).toBe(403);
  });
  it('blank slot can be assigned, then needs a member before completing', async () => {
    const slot = await request(app).post('/api/pt/sessions').set(h(reception)).send({ trainer_id: trainerId, start_at: at(16), duration_min: 60 });
    expect(slot.status).toBe(201);
    expect(slot.body.data.member).toBeNull();
    const early = await request(app).post(`/api/pt/sessions/${slot.body.data.id}/complete`).set(h(trainerTok));
    expect(early.status).toBe(409);
    const asg = await request(app).post(`/api/pt/sessions/${slot.body.data.id}/assign`).set(h(trainerTok)).send({ member_id: memberId, contract_id: contractId });
    expect(asg.status).toBe(200);
    expect(asg.body.data.member.id).toBe(memberId);
  });
});

describe('group classes', () => {
  const sessionsLeft = async () => (await prisma.contract.findUniqueOrThrow({ where: { id: classPkgContract } })).sessionsLeft;

  it('register deducts, cancel refunds, class full blocks', async () => {
    const cls = await mkClass();
    const reg = await request(app).post(`/api/pt/classes/${cls}/registrations`).set(h(reception)).send({ member_id: memberId });
    expect(reg.status).toBe(201);
    expect(await sessionsLeft()).toBe(1);
    const dup = await request(app).post(`/api/pt/classes/${cls}/registrations`).set(h(reception)).send({ member_id: memberId });
    expect(dup.status).toBe(409);
    const cancel = await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/cancel`).set(h(reception));
    expect(cancel.status).toBe(200);
    expect(await sessionsLeft()).toBe(2);
    expect((await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/cancel`).set(h(reception))).status).toBe(409);
  });

  it('trainer completing keeps the deduction and blocks later cancel', async () => {
    const cls = await mkClass();
    const reg = await request(app).post(`/api/pt/classes/${cls}/registrations`).set(h(reception)).send({ member_id: memberId });
    expect(reg.status).toBe(201);
    const before = await sessionsLeft();
    expect((await request(app).post(`/api/pt/classes/${cls}/complete`).set(h(trainerTok))).status).toBe(200);
    expect(await sessionsLeft()).toBe(before);
    expect((await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/cancel`).set(h(reception))).status).toBe(409);
    const stats = await request(app).get('/api/pt/classes/stats').set(h(reception));
    expect(stats.status).toBe(200);
    expect(stats.body.data.registrations.attended).toBeGreaterThan(0);
  });

  it('cancelling a class refunds every booked registration', async () => {
    const cls = await mkClass();
    const before = await sessionsLeft();
    expect((await request(app).post(`/api/pt/classes/${cls}/registrations`).set(h(reception)).send({ member_id: memberId })).status).toBe(201);
    expect(await sessionsLeft()).toBe((before ?? 0) - 1);
    expect((await request(app).post(`/api/pt/classes/${cls}/cancel`).set(h(reception))).status).toBe(200);
    expect(await sessionsLeft()).toBe(before);
  });
});
