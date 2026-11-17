import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let seq = 0;
const uniq = () => `${sfx}${++seq}`;
let A: string;
let B: string;
const tokens: Record<string, string> = {};
const hA = (r: string) => ({ Authorization: `Bearer ${tokens[r]}`, 'X-Branch-Id': A });
const today = () => dateOnly(todayVN());
const phoneN = () => `09${String(30000000 + ++seq * 13 + Math.floor(Math.random() * 1e6))}`;
type Row = { id: string };

async function mkMember(branch: string) {
  return prisma.member.create({ data: { code: `L${uniq()}`, name: `LM ${uniq()}`, phone: phoneN(), branchId: branch } });
}
async function mkActive(memberId: string, branch: string, endIn: number, category: 'member' | 'pt_1on1' = 'member') {
  const pkg = await prisma.package.create({ data: { name: `LP ${uniq()}`, type: 'month', category, durationDays: 30, price: 500000, branchId: branch } });
  return prisma.contract.create({
    data: { code: `LC${uniq()}`, memberId, packageId: pkg.id, branchId: branch, status: 'active', totalAmount: 500000, durationDays: 30, startDate: today(), endDate: addDays(today(), endIn) },
  });
}

beforeAll(async () => {
  const codeA = `lda${uniq()}`;
  A = (await prisma.branch.create({ data: { code: codeA, name: 'LD A' } })).id;
  B = (await prisma.branch.create({ data: { code: `ldb${uniq()}`, name: 'LD B' } })).id;
  for (const r of ['sales', 'receptionist', 'branch_manager', 'trainer']) {
    await makeUser(`${r}@lead.test`, r, codeA);
    tokens[r] = await tokenFor(`${r}@lead.test`);
  }
});

describe('leads', () => {
  it('creates, lists, filters, edits and changes status', async () => {
    const p = phoneN();
    const c = await request(app).post('/api/leads').set(hA('sales')).send({ name: 'Khach A', phone: ` ${p.slice(0, 4)} ${p.slice(4)} `, source: 'Facebook' });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ status: 'new', branch_id: A, phone: p, source: 'Facebook' });
    const id = c.body.data.id;
    expect((await request(app).post('/api/leads').set(hA('sales')).send({ name: 'X', phone: '12' })).status).toBe(400);
    const e = await request(app).patch(`/api/leads/${id}`).set(hA('sales')).send({ note: 'goi lai' });
    expect(e.body.data).toMatchObject({ note: 'goi lai', source: 'Facebook', status: 'new' });
    const s = await request(app).post(`/api/leads/${id}/status`).set(hA('sales')).send({ status: 'contacted' });
    expect(s.body.data.status).toBe('contacted');
    expect((await request(app).post(`/api/leads/${id}/status`).set(hA('sales')).send({ status: 'converted' })).status).toBe(400);
    const l = await request(app).get('/api/leads?status=contacted&q=Khach').set(hA('sales'));
    expect(l.body.data.map((x: Row) => x.id)).toContain(id);
    const l2 = await request(app).get('/api/leads?status=lost').set(hA('sales'));
    expect(l2.body.data.map((x: Row) => x.id)).not.toContain(id);
  });

  it('enforces permissions and branch scope', async () => {
    expect((await request(app).get('/api/leads').set(hA('trainer'))).status).toBe(403);
    expect((await request(app).post('/api/leads').set(hA('receptionist')).send({ name: 'Khach R', phone: phoneN() })).status).toBe(201);
    const other = await prisma.lead.create({ data: { name: 'OtherBranch', phone: phoneN(), branchId: B } });
    const r = await request(app).get('/api/leads?q=OtherBranch').set({ Authorization: `Bearer ${tokens.sales}` });
    expect(r.body.data.map((x: Row) => x.id)).not.toContain(other.id);
    expect((await request(app).patch(`/api/leads/${other.id}`).set(hA('sales')).send({ note: 'x' })).status).toBe(404);
  });

  it('converts to a member once and rejects duplicate phone', async () => {
    const p = phoneN();
    const lead = (await request(app).post('/api/leads').set(hA('sales')).send({ name: 'Convert Me', phone: p })).body.data;
    const ok = await request(app).post(`/api/leads/${lead.id}/convert`).set(hA('sales'));
    expect(ok.status).toBe(200);
    expect(ok.body.data.lead).toMatchObject({ status: 'converted', member_id: ok.body.data.member.id });
    expect(ok.body.data.member).toMatchObject({ name: 'Convert Me', phone: p, branch_id: A });
    expect((await request(app).post(`/api/leads/${lead.id}/convert`).set(hA('sales'))).status).toBe(409);
    expect((await request(app).post(`/api/leads/${lead.id}/status`).set(hA('sales')).send({ status: 'lost' })).status).toBe(409);

    const dup = (await request(app).post('/api/leads').set(hA('sales')).send({ name: 'Dup', phone: p })).body.data;
    const d = await request(app).post(`/api/leads/${dup.id}/convert`).set(hA('sales'));
    expect(d.status).toBe(409);
    expect(JSON.stringify(d.body)).toContain('DUPLICATE_PHONE');
    expect((await prisma.lead.findUnique({ where: { id: dup.id } }))!.status).toBe('new');
  });
});

describe('expiring report', () => {
  it('lists active member contracts ending within the window, scoped and deduped', async () => {
    const m7 = await mkMember(A);
    await mkActive(m7.id, A, 5);
    const m20 = await mkMember(A);
    await mkActive(m20.id, A, 20);
    const mFar = await mkMember(A);
    await mkActive(mFar.id, A, 90);
    const mRenew = await mkMember(A);
    await mkActive(mRenew.id, A, 3);
    await mkActive(mRenew.id, A, 60);
    const mPt = await mkMember(A);
    await mkActive(mPt.id, A, 2, 'pt_1on1');
    const mB = await mkMember(B);
    await mkActive(mB.id, B, 4);

    const r7 = await request(app).get('/api/reports/expiring?days=7').set(hA('branch_manager'));
    expect(r7.status).toBe(200);
    const ids7 = r7.body.data.map((x: { member_id: string }) => x.member_id);
    expect(ids7).toContain(m7.id);
    for (const x of [m20.id, mFar.id, mRenew.id, mPt.id, mB.id]) expect(ids7).not.toContain(x);
    const row = r7.body.data.find((x: { member_id: string }) => x.member_id === m7.id);
    expect(row).toMatchObject({ days_left: 5, phone: m7.phone, member_code: m7.code, branch: { id: A } });
    expect(Object.keys(row)).toEqual(expect.arrayContaining(['package_name', 'end_date', 'name']));

    const r30 = await request(app).get('/api/reports/expiring?days=30').set(hA('branch_manager'));
    expect(r30.body.data.map((x: { member_id: string }) => x.member_id)).toEqual(expect.arrayContaining([m7.id, m20.id]));
    expect((await request(app).get('/api/reports/expiring?days=9').set(hA('branch_manager'))).status).toBe(400);
    expect((await request(app).get('/api/reports/expiring').set(hA('sales'))).status).toBe(403);
  });
});
