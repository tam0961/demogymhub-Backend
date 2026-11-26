import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, branchId, makeUser, tokenFor } from './helpers';

let nb: string;
let t1: string;
let t2: string;
let t1Id: string;
let t2Id: string;
let reception: string;
let leadId: string;
const u = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const h = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Branch-Id': nb });

beforeAll(async () => {
  nb = await branchId('nb');
  const id = u();
  t1Id = (await makeUser(`pa1${id}@t.local`, 'trainer', 'nb')).id;
  t2Id = (await makeUser(`pa2${id}@t.local`, 'trainer', 'nb')).id;
  await makeUser(`par${id}@t.local`, 'receptionist', 'nb');
  t1 = await tokenFor(`pa1${id}@t.local`);
  t2 = await tokenFor(`pa2${id}@t.local`);
  reception = await tokenFor(`par${id}@t.local`);
  const member = await prisma.member.create({ data: { code: `PA${id}`, name: 'PA Member', phone: `07${id.replace(/\D/g, '').padEnd(8, '3').slice(0, 8)}`, branchId: nb } });
  const pkg = await prisma.package.create({ data: { name: `PT11 ${id}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 1000, branchId: nb } });
  const memberPkg = await prisma.package.create({ data: { name: `Grp ${id}`, type: 'month', category: 'member', displayGroup: 'pt_group', durationDays: 30, sessions: 8, price: 1000, branchId: nb } });
  const base = { memberId: member.id, branchId: nb, status: 'active' as const, totalAmount: 1000, sessionsTotal: 10, sessionsLeft: 10 };
  const c1 = await prisma.contract.create({ data: { ...base, code: `PAC1${id}`, packageId: pkg.id, ptUserId: t1Id } });
  await prisma.contract.create({ data: { ...base, code: `PAC2${id}`, packageId: pkg.id, ptUserId: t2Id } });
  await prisma.contract.create({ data: { ...base, code: `PAC3${id}`, packageId: memberPkg.id, ptUserId: t1Id } });
  await prisma.ptSession.create({ data: { branchId: nb, trainerId: t1Id, memberId: member.id, contractId: c1.id, startAt: new Date('2032-05-10T10:00:00+07:00'), endAt: new Date('2032-05-10T11:00:00+07:00') } });
  await prisma.ptSession.create({ data: { branchId: nb, trainerId: t2Id, startAt: new Date('2032-05-10T12:00:00+07:00'), endAt: new Date('2032-05-10T13:00:00+07:00') } });
  await prisma.groupClass.create({ data: { branchId: nb, trainerId: t2Id, title: 'Shared class', startAt: new Date('2032-05-10T18:00:00+07:00'), endAt: new Date('2032-05-10T19:00:00+07:00'), capacity: 10 } });
  leadId = (await prisma.lead.create({ data: { name: 'Lead A', phone: '0900000001', branchId: nb, assignedTo: t1Id } })).id;
  await prisma.lead.create({ data: { name: 'Lead B', phone: '0900000002', branchId: nb, assignedTo: t2Id } });
});

describe('PT app', () => {
  it('rejects non-trainers', async () => {
    expect((await request(app).get('/api/pt-app/contracts').set(h(reception))).status).toBe(403);
  });

  it('lists only my contracts, including pt group packages', async () => {
    const r = await request(app).get('/api/pt-app/contracts').set(h(t1));
    expect(r.status).toBe(200);
    const codes = r.body.data.map((c: { code: string }) => c.code);
    expect(codes.some((c: string) => c.startsWith('PAC1'))).toBe(true);
    expect(codes.some((c: string) => c.startsWith('PAC3'))).toBe(true);
    expect(codes.some((c: string) => c.startsWith('PAC2'))).toBe(false);
  });

  it('lists only my sessions', async () => {
    const r = await request(app).get('/api/pt-app/schedule?from=2032-05-10&to=2032-05-10').set(h(t1));
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].kind).toBe('pt_1on1');
  });

  it('shows group classes of every trainer', async () => {
    const r = await request(app).get('/api/pt-app/classes?from=2032-05-10&to=2032-05-10').set(h(t1));
    expect(r.body.data.some((c: { title: string; mine: boolean }) => c.title === 'Shared class' && !c.mine)).toBe(true);
  });

  it('shows and updates only my leads', async () => {
    const r = await request(app).get('/api/pt-app/leads').set(h(t1));
    expect(r.body.data.map((l: { name: string }) => l.name)).toEqual(['Lead A']);
    const ok = await request(app).patch(`/api/pt-app/leads/${leadId}`).set(h(t1)).send({ status: 'contacted', note: 'da goi' });
    expect(ok.status).toBe(200);
    expect((await request(app).patch(`/api/pt-app/leads/${leadId}`).set(h(t2)).send({ status: 'lost' })).status).toBe(404);
  });
});
