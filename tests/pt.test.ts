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
    data: { code: `C${id}`, memberId, packageId: pkg.id, branchId: nb, status: 'active', totalAmount: 1000, sessionsTotal: 2, sessionsLeft: 2, ptUserId: trainerId },
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

    const future = await request(app).post(`/api/pt/sessions/${a.body.data.id}/complete`).set(h(trainerTok));
    expect(future.status).toBe(409);
    expect(future.body.error.code).toBe('FUTURE_SESSION');
    const now = new Date();
    await prisma.ptSession.update({ where: { id: a.body.data.id }, data: { startAt: now, endAt: new Date(now.getTime() + 3600000) } });
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

describe('quick pt sessions', () => {
  it('discards an unsigned quick session without deducting, refuses normal ones', async () => {
    await prisma.contract.update({ where: { id: contractId }, data: { sessionsLeft: 5 } });
    const before = (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).sessionsLeft;
    const q = await request(app).post('/api/pt/sessions').set(h(reception)).send({ member_id: memberId, trainer_id: trainerId, contract_id: contractId, start_at: at(21), duration_min: 60, quick: true });
    expect(q.status).toBe(201);
    expect((await request(app).post(`/api/pt/sessions/${q.body.data.id}/discard`).set(h(reception))).status).toBe(200);
    expect((await prisma.ptSession.findUniqueOrThrow({ where: { id: q.body.data.id } })).status).toBe('cancelled');
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).sessionsLeft).toBe(before);
    expect((await request(app).post(`/api/pt/sessions/${q.body.data.id}/discard`).set(h(reception))).status).toBe(409);
    const n = await request(app).post('/api/pt/sessions').set(h(reception)).send({ trainer_id: trainerId, start_at: at(22), duration_min: 60 });
    expect((await request(app).post(`/api/pt/sessions/${n.body.data.id}/discard`).set(h(reception))).status).toBe(409);
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
    expect((await request(app).post(`/api/pt/classes/${cls}/complete`).set(h(trainerTok))).status).toBe(409);
    await prisma.groupClass.update({ where: { id: cls }, data: { startAt: new Date() } });
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

describe('group class templates and rules', () => {
  it('generates a week from templates once, and lets staff edit muscle group', async () => {
    const t = await request(app).post('/api/pt/classes/templates').set(h(reception)).send({ weekday: 2, start_time: '06:30', end_time: '07:45', capacity: 3, muscle_group: 'Core + Cardio' });
    expect(t.status).toBe(201);
    const g1 = await request(app).post('/api/pt/classes/generate').set(h(reception)).send({ week_start: '2031-03-03' });
    expect(g1.status).toBe(200);
    expect(g1.body.data.created).toBeGreaterThanOrEqual(1);
    const g2 = await request(app).post('/api/pt/classes/generate').set(h(reception)).send({ week_start: '2031-03-03' });
    expect(g2.body.data.created).toBe(0);
    expect((await request(app).post('/api/pt/classes/generate').set(h(reception)).send({ week_start: '2031-03-04' })).status).toBe(400);
    const list = await request(app).get('/api/pt/classes').set(h(reception)).query({ from: '2031-03-04', to: '2031-03-04' });
    const cls = list.body.data.find((c: { muscle_group: string }) => c.muscle_group === 'Core + Cardio');
    expect(cls).toBeTruthy();
    const patched = await request(app).patch(`/api/pt/classes/${cls.id}`).set(h(reception)).send({ muscle_group: 'Lưng + Vai' });
    expect(patched.body.data.muscle_group).toBe('Lưng + Vai');
  });

  it('locks registration after 21:00 the day before, and counts cancels per member', async () => {
    const soon = await request(app).post('/api/pt/classes').set(h(reception)).send({ trainer_id: trainerId, start_at: new Date(Date.now() + 3600000).toISOString(), capacity: 3 });
    const locked = await request(app).post(`/api/pt/classes/${soon.body.data.id}/registrations`).set(h(reception)).send({ member_id: memberId });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('CLASS_LOCKED');

    const cls = await mkClass();
    const reg = await request(app).post(`/api/pt/classes/${cls}/registrations`).set(h(reception)).send({ member_id: memberId });
    await request(app).post(`/api/pt/classes/registrations/${reg.body.data.id}/cancel`).set(h(reception));
    const rows = await request(app).get('/api/pt/classes/registrations').set(h(reception)).query({ status: 'cancelled' });
    expect(rows.body.data.some((r: { cancel_count: number }) => r.cancel_count >= 1)).toBe(true);
  });

  it('monthly report lists completed classes per trainer', async () => {
    const r = await request(app).get('/api/pt/classes/report').set(h(reception)).query({ months: 12 });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });
});

describe('staff creation', () => {
  it('owner can create a trainer with a generated password; manager and receptionist cannot', async () => {
    const mgrEmail = `ow${u()}@t.local`;
    await makeUser(mgrEmail, 'owner', null);
    const mgr = await tokenFor(mgrEmail);
    const bmEmail = `bm${u()}@t.local`;
    await makeUser(bmEmail, 'branch_manager', 'nb');
    const bm = await tokenFor(bmEmail);
    const email = `new${u()}@t.local`;
    const ok = await request(app).post('/api/users').set(h(mgr)).send({ name: 'PT Moi', email, role: 'trainer', branch_id: nb });
    expect(ok.status).toBe(201);
    expect(ok.body.data.password).toBeTruthy();
    expect((await request(app).post('/api/users').set(h(mgr)).send({ name: 'Dup', email, role: 'trainer', branch_id: nb })).status).toBe(409);
    expect((await request(app).post('/api/users').set(h(mgr)).send({ name: 'No branch', email: `x${u()}@t.local`, role: 'trainer' })).status).toBe(400);
    expect((await request(app).post('/api/users').set(h(mgr)).send({ name: 'Too high', email: `y${u()}@t.local`, role: 'owner' })).status).toBe(403);
    expect((await request(app).post('/api/users').set(h(bm)).send({ name: 'Mgr', email: `w${u()}@t.local`, role: 'trainer', branch_id: nb })).status).toBe(403);
    expect((await request(app).post('/api/users').set(h(reception)).send({ name: 'Nope', email: `z${u()}@t.local`, role: 'trainer', branch_id: nb })).status).toBe(403);
    const list = await request(app).get('/api/pt/trainers').set(h(mgr));
    expect(list.body.data.some((t: { name: string }) => t.name === 'PT Moi')).toBe(true);
  });
});
