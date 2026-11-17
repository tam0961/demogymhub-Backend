import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, branchId, makeUser, tokenFor } from './helpers';

let nb: string;
let reception: string;
let owner: string;
let trainerTok: string;
let trainerId: string;
const u = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Branch-Id': nb });
const inMin = (m: number) => new Date(Date.now() + m * 60000).toISOString();
let phoneSeq = 0;

async function mkMember(category: 'pt_1on1' | 'pt_group', sessions = 3) {
  const id = u();
  const phone = `07${String(Date.now() % 1000000).padStart(6, '0')}${String(++phoneSeq).padStart(2, '0')}`;
  const m = await prisma.member.create({ data: { code: `P${id}`, name: `Mem ${id}`, phone, branchId: nb } });
  const mpkg = await prisma.package.create({ data: { name: `Mem ${id}`, type: 'month', durationDays: 30, price: 1000, branchId: nb } });
  await prisma.contract.create({ data: { code: `CM${id}`, memberId: m.id, packageId: mpkg.id, branchId: nb, status: 'active', totalAmount: 1000 } });
  const pkg = await prisma.package.create({ data: { name: `PT ${id}`, type: 'session', category, sessions, price: 1000, branchId: nb } });
  const c = await prisma.contract.create({
    data: { code: `C${id}`, memberId: m.id, packageId: pkg.id, branchId: nb, status: 'active', totalAmount: 1000, sessionsTotal: sessions, sessionsLeft: sessions },
  });
  return { memberId: m.id, contractId: c.id };
}
const left = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).sessionsLeft;
const book = (memberId: string, contractId: string, startAt: string, extra: object = {}) =>
  request(app).post('/api/pt/sessions').set(h(reception)).send({ member_id: memberId, contract_id: contractId, trainer_id: trainerId, start_at: startAt, duration_min: 60, ...extra });

beforeAll(async () => {
  nb = await branchId('nb');
  const id = u();
  await makeUser(`ga${id}@t.local`, 'receptionist', 'nb');
  await makeUser(`go${id}@t.local`, 'owner', null);
  trainerId = (await makeUser(`gp${id}@t.local`, 'trainer', 'nb')).id;
  reception = await tokenFor(`ga${id}@t.local`);
  owner = await tokenFor(`go${id}@t.local`);
  trainerTok = await tokenFor(`gp${id}@t.local`);
});

describe('pt 1:1 no-show, edit and cancel rule', () => {
  it('no-show by trainer deducts once', async () => {
    const { memberId, contractId } = await mkMember('pt_1on1');
    const s = await book(memberId, contractId, '2033-01-10T09:00:00+07:00');
    expect(s.status).toBe(201);
    const r = await request(app).post(`/api/pt/sessions/${s.body.data.id}/no-show`).set(h(trainerTok));
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('no_show');
    expect(await left(contractId)).toBe(2);
    expect((await request(app).post(`/api/pt/sessions/${s.body.data.id}/no-show`).set(h(trainerTok))).status).toBe(409);
  });

  it('edits time, rejects trainer and member overlap', async () => {
    const { memberId, contractId } = await mkMember('pt_1on1');
    const a = await book(memberId, contractId, '2033-01-11T09:00:00+07:00');
    const b = await book(memberId, contractId, '2033-01-11T11:00:00+07:00');
    expect((await request(app).patch(`/api/pt/sessions/${b.body.data.id}`).set(h(reception)).send({ start_at: '2033-01-11T09:30:00+07:00' })).status).toBe(409);
    const ok = await request(app).patch(`/api/pt/sessions/${b.body.data.id}`).set(h(reception)).send({ start_at: '2033-01-11T14:00:00+07:00' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.start_at).toBe(new Date('2033-01-11T14:00:00+07:00').toISOString());
    const other = await mkMember('pt_1on1');
    const otherTrainer = (await makeUser(`gq${u()}@t.local`, 'trainer', 'nb')).id;
    const c = await book(other.memberId, other.contractId, '2033-01-11T16:00:00+07:00', { trainer_id: otherTrainer });
    expect((await request(app).patch(`/api/pt/sessions/${c.body.data.id}`).set(h(reception)).send({ trainer_id: trainerId, start_at: '2033-01-11T14:30:00+07:00' })).status).toBe(409);
    expect((await request(app).patch(`/api/pt/sessions/${a.body.data.id}`).set(h(trainerTok)).send({ start_at: '2033-01-11T10:00:00+07:00' })).status).toBe(403);
  });

  it('cancel is free at 90+ minutes, counts as used when later, owner can override', async () => {
    const { memberId, contractId } = await mkMember('pt_1on1', 5);
    const early = await book(memberId, contractId, inMin(180));
    expect((await request(app).post(`/api/pt/sessions/${early.body.data.id}/cancel`).set(h(reception))).body.data.status).toBe('cancelled');
    expect(await left(contractId)).toBe(5);

    const late = await book(memberId, contractId, inMin(30));
    expect(late.status).toBe(201);
    expect((await request(app).post(`/api/pt/sessions/${late.body.data.id}/cancel`).set(h(reception)).send({ cancel_free: true })).status).toBe(403);
    const r = await request(app).post(`/api/pt/sessions/${late.body.data.id}/cancel`).set(h(reception));
    expect(r.body.data.status).toBe('no_show');
    expect(await left(contractId)).toBe(4);

    const late2 = await book(memberId, contractId, inMin(20));
    const free = await request(app).post(`/api/pt/sessions/${late2.body.data.id}/cancel`).set(h(owner)).send({ cancel_free: true });
    expect(free.body.data.status).toBe('cancelled');
    expect(await left(contractId)).toBe(4);
  });
});

describe('group waitlist', () => {
  it('full class waitlists without deduction, cancel promotes the earliest eligible', async () => {
    const a = await mkMember('pt_group');
    const b = await mkMember('pt_group');
    const c = await mkMember('pt_group', 1);
    await prisma.contract.update({ where: { id: c.contractId }, data: { sessionsLeft: 0 } });
    const d = await mkMember('pt_group');
    const cls = (await request(app).post('/api/pt/classes').set(h(reception)).send({ trainer_id: trainerId, start_at: '2033-02-10T18:00:00+07:00', capacity: 1 })).body.data.id;
    const reg = (m: string) => request(app).post(`/api/pt/classes/${cls}/registrations`).set(h(reception)).send({ member_id: m });
    const ra = await reg(a.memberId);
    expect(ra.body.data.status).toBe('booked');
    const rb = await reg(b.memberId);
    expect(rb.status).toBe(201);
    expect(rb.body.data.status).toBe('waitlist');
    expect(await left(b.contractId)).toBe(3);
    await prisma.groupRegistration.create({ data: { classId: cls, memberId: c.memberId, name: 'c', phone: '1', status: 'waitlist' } });
    expect((await reg(b.memberId)).status).toBe(409);
    const rd = await reg(d.memberId);
    expect(rd.body.data.status).toBe('waitlist');
    expect((await request(app).post(`/api/pt/classes/registrations/${ra.body.data.id}/cancel`).set(h(reception))).status).toBe(200);
    const after = await prisma.groupRegistration.findUniqueOrThrow({ where: { id: rb.body.data.id } });
    expect(after.status).toBe('booked');
    expect(after.deducted).toBe(true);
    expect(await left(b.contractId)).toBe(2);
    expect((await prisma.groupRegistration.findUniqueOrThrow({ where: { id: rd.body.data.id } })).status).toBe('waitlist');
  });
});
