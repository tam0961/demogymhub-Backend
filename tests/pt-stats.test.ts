import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
const MONTH = '2031-06';
const at = (day: number, m = '06') => new Date(`2031-${m}-${String(day).padStart(2, '0')}T10:00:00+07:00`);
let seq = 0;
let BR = '';
let owner = '';
let recep = '';
const ids: Record<string, string> = {};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function contract(o: { pkg: string; sale?: string; pt?: string; total: number; sessions?: number; left?: number; status?: 'active' | 'expired' }) {
  seq += 1;
  const m = await prisma.member.create({ data: { code: `TS${sfx}${seq}`, name: `TSM ${seq}`, phone: `ts${sfx}${seq}`, branchId: BR } });
  return prisma.contract.create({
    data: { code: `TC${sfx}${seq}`, memberId: m.id, packageId: o.pkg, branchId: BR, status: o.status ?? 'active', totalAmount: o.total, paidAmount: o.total, sessionsTotal: o.sessions ?? null, sessionsLeft: o.left ?? o.sessions ?? null, saleUserId: o.sale ?? null, ptUserId: o.pt ?? null, createdAt: at(2) },
  });
}

async function pay(contractId: string, amount: number, day: number, month = '06') {
  seq += 1;
  return prisma.payment.create({ data: { contractId, branchId: BR, method: 'cash', amount, status: 'confirmed', ref: `TP${sfx}${seq}`, confirmedAt: at(day, month) } });
}

const stats = async (token = owner, q: Record<string, string> = {}) => request(app).get('/api/payroll/pt-stats').query({ month: MONTH, ...q }).set(auth(token));

describe('payroll pt-stats', () => {
  beforeAll(async () => {
    BR = (await prisma.branch.create({ data: { code: `ts${sfx}`, name: 'TS' } })).id;
    await makeUser(`owner@ts${sfx}.test`, 'owner', null);
    owner = await tokenFor(`owner@ts${sfx}.test`);
    await makeUser(`rec@ts${sfx}.test`, 'receptionist', `ts${sfx}`);
    recep = await tokenFor(`rec@ts${sfx}.test`);
    for (const k of ['ptFull', 'ptPart', 'sale']) ids[k] = (await makeUser(`${k}@ts${sfx}.test`, k.startsWith('pt') ? 'trainer' : 'sales', `ts${sfx}`)).id;
    const pos: Record<string, string> = { ptFull: 'pt_fulltime', ptPart: 'pt_parttime', sale: 'sale' };
    for (const k of Object.keys(pos)) await prisma.payrollProfile.create({ data: { userId: ids[k], position: pos[k], baseSalary: 0, hasInsurance: false, taxMode: 'none', dependents: 0, active: true } });
    const memberPkg = (await prisma.package.create({ data: { name: `TM ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: BR } })).id;
    const ptPkg = (await prisma.package.create({ data: { name: `TP ${sfx}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 1000, branchId: BR } })).id;

    const a = await contract({ pkg: ptPkg, pt: ids.ptFull, sale: ids.sale, total: 30_000_000, sessions: 10, left: 6 });
    await pay(a.id, 20_000_000, 5);
    await pay(a.id, 5_000_000, 6, '05');
    await contract({ pkg: ptPkg, pt: ids.ptFull, total: 1000, sessions: 10, status: 'expired' });
    for (const d of [10, 11, 12]) await prisma.ptSession.create({ data: { branchId: BR, trainerId: ids.ptFull, memberId: a.memberId, contractId: a.id, startAt: at(d), endAt: new Date(at(d).getTime() + 3600000), status: 'completed', completedAt: at(d) } });
    await prisma.ptSession.create({ data: { branchId: BR, trainerId: ids.ptFull, memberId: a.memberId, contractId: a.id, startAt: at(13), endAt: new Date(at(13).getTime() + 3600000), status: 'cancelled' } });
    for (const d of [15, 16]) await prisma.groupClass.create({ data: { branchId: BR, trainerId: ids.ptFull, title: `Lop ${d}`, startAt: at(d), endAt: new Date(at(d).getTime() + 3600000), status: 'completed', completedAt: at(d) } });
    const m = await contract({ pkg: memberPkg, sale: ids.ptPart, total: 4_000_000 });
    await pay(m.id, 4_000_000, 7);
  });

  it('is limited to payroll.read', async () => {
    expect((await stats(recep)).status).toBe(403);
    expect((await request(app).get('/api/payroll/pt-stats').query({ month: 'bad' }).set(auth(owner))).status).toBe(400);
  });

  it('lists only PT positions with clients, taught sessions, classes and sales matching payroll', async () => {
    const r = await stats(owner, { branch_id: BR });
    expect(r.status).toBe(200);
    const rows = r.body.data.rows as { user_id: string; clients: Record<string, unknown>[]; sessions_taught: number; group_classes: number; classes: unknown[]; member_sales: number; pt_sales: number; sales: Record<string, unknown>[] }[];
    expect(rows.map((x) => x.user_id).sort()).toEqual([ids.ptFull, ids.ptPart].sort());
    const full = rows.find((x) => x.user_id === ids.ptFull)!;
    expect(full.clients).toHaveLength(1);
    expect(full.clients[0]).toMatchObject({ sessions_total: 10, sessions_left: 6, taught_in_month: 3 });
    expect(full.sessions_taught).toBe(3);
    expect(full.group_classes).toBe(2);
    expect(full.classes).toHaveLength(2);
    expect(full.pt_sales).toBe(20_000_000);
    expect(full.member_sales).toBe(0);
    expect(full.sales).toHaveLength(1);
    const part = rows.find((x) => x.user_id === ids.ptPart)!;
    expect(part.clients).toHaveLength(0);
    expect(part.member_sales).toBe(4_000_000);

    const pv = await request(app).get('/api/payroll/preview').query({ month: MONTH }).set(auth(owner));
    const pf = pv.body.data.rows.find((x: { user_id: string }) => x.user_id === ids.ptFull);
    const pp = pv.body.data.rows.find((x: { user_id: string }) => x.user_id === ids.ptPart);
    expect(pf.pt_sales).toBe(full.pt_sales);
    expect((full as unknown as { session_pay: number }).session_pay).toBe(pf.pt_session_pay);
    expect((full as unknown as { group_pay: number }).group_pay).toBe(pf.group_pay);
    expect((full.clients[0] as { session_pay: number }).session_pay).toBe(pf.pt_session_pay);
    expect(pp.member_sales).toBe(part.member_sales);
  });

  it('filters by branch', async () => {
    const other = await prisma.branch.create({ data: { code: `tx${sfx}`, name: 'TX' } });
    const r = await stats(owner, { branch_id: other.id });
    expect(r.status).toBe(200);
    expect(r.body.data.rows.filter((x: { user_id: string }) => x.user_id === ids.ptFull)).toHaveLength(0);
  });
});
