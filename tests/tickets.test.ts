import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let seq = 0;
const uniq = () => `${sfx}${++seq}`;
const today = dateOnly(todayVN());
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

let A = '';
let B = '';
let recId = '';
let rec = '';
let recB = '';
let own = '';
const pk: Record<string, string> = {};

const hA = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Branch-Id': A });
const hOwn = () => ({ Authorization: `Bearer ${own}` });
const phone = () => `09${String(Date.now() % 1e8).padStart(8, '0').slice(0, 5)}${String(++seq).padStart(3, '0')}`;

async function mkMember(branchId = A) {
  return prisma.member.create({ data: { code: `TM${uniq()}`, name: `Khach ${uniq()}`, phone: phone(), branchId } });
}

async function mkContract(over: {
  pkg: string;
  total: number;
  paid: number;
  startAgo?: number;
  days?: number;
  sessions?: [number, number];
  status?: 'active' | 'frozen' | 'draft' | 'signed';
  member?: string;
}) {
  const memberId = over.member ?? (await mkMember()).id;
  const start = addDays(today, -(over.startAgo ?? 0));
  const days = over.days ?? null;
  return prisma.contract.create({
    data: {
      code: `TK${uniq()}`,
      memberId,
      packageId: pk[over.pkg],
      branchId: A,
      status: over.status ?? 'active',
      totalAmount: over.total,
      paidAmount: over.paid,
      durationDays: days,
      startDate: start,
      endDate: days ? addDays(start, days) : null,
      sessionsTotal: over.sessions?.[0] ?? null,
      sessionsLeft: over.sessions?.[1] ?? null,
      activatedAt: new Date(),
    },
  });
}

async function mkPayment(contractId: string, amount: number) {
  await prisma.payment.create({ data: { contractId, branchId: A, method: 'cash', amount, status: 'confirmed', ref: `P${uniq()}`, confirmedAt: new Date() } });
}

const post = (t: string, contractId: string, body: object, h = hA) => request(app).post(`/api/contracts/${contractId}/tickets`).set(h(t)).send(body);

beforeAll(async () => {
  const codeA = `ta${sfx}`;
  const codeB = `tb${sfx}`;
  A = (await prisma.branch.create({ data: { code: codeA, name: 'TA' } })).id;
  B = (await prisma.branch.create({ data: { code: codeB, name: 'TB' } })).id;
  recId = (await makeUser(`rec@${codeA}.test`, 'receptionist', codeA)).id;
  await makeUser(`recb@${codeB}.test`, 'receptionist', codeB);
  await makeUser(`own@${codeA}.test`, 'owner', null);
  rec = await tokenFor(`rec@${codeA}.test`);
  recB = await tokenFor(`recb@${codeB}.test`);
  own = await tokenFor(`own@${codeA}.test`);
  await prisma.shift.create({ data: { userId: recId, branchId: A, openingCash: 0 } });

  const mk = async (name: string, data: object) => {
    pk[name] = (await prisma.package.create({ data: { name: `${name} ${sfx}`, branchId: A, ...data } as never })).id;
  };
  await mk('m3', { type: 'month', category: 'member', durationDays: 90, price: 3_000_000 });
  await mk('m6', { type: 'month', category: 'member', durationDays: 180, price: 5_000_000 });
  await mk('m2', { type: 'month', category: 'member', durationDays: 60, price: 2_000_000 });
  await mk('pt10', { type: 'session', category: 'pt_1on1', sessions: 10, durationDays: 30, price: 10_000_000 });
  await mk('pt20', { type: 'session', category: 'pt_1on1', sessions: 20, durationDays: 60, price: 15_000_000 });
  await mk('pt6', { type: 'session', category: 'pt_1on1', sessions: 6, durationDays: 30, price: 6_000_000 });
  await mk('grp', { type: 'session', category: 'pt_group', sessions: 10, durationDays: 30, price: 2_000_000 });
  await mk('bundle', { type: 'month', category: 'member', durationDays: 30, price: 0, bundleOnly: true });
});

describe('ticket quote', () => {
  it('previews fee and approval need without changing anything', async () => {
    const c = await mkContract({ pkg: 'm6', total: 5_000_000, paid: 5_000_000, startAgo: 60, days: 180 });
    const q = await request(app).get(`/api/contracts/${c.id}/ticket-quote`).query({ type: 'downgrade', package_id: pk.m2 }).set(hA(rec));
    expect(q.status).toBe(200);
    expect(q.body.data).toMatchObject({ type: 'downgrade', fee: -2_000_000, refund: 2_000_000, requires_approval: true, new_sessions_total: null });
    expect(q.body.data.new_end_date).toBe(iso(addDays(today, 60)));
    const asOwner = await request(app).get(`/api/contracts/${c.id}/ticket-quote`).query({ type: 'downgrade', package_id: pk.m2 }).set(hOwn());
    expect(asOwner.body.data.requires_approval).toBe(false);
    const up = await request(app).get(`/api/contracts/${c.id}/ticket-quote`).query({ type: 'transfer' }).set(hA(rec));
    expect(up.body.data).toMatchObject({ fee: 500_000, requires_approval: true });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).totalAmount).toBe(5_000_000);
  });

  it('rejects an unusable type with a clear 409 and hides contracts of other branches', async () => {
    const draft = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 0, days: 90, status: 'draft' });
    const r = await request(app).get(`/api/contracts/${draft.id}/ticket-quote`).query({ type: 'upgrade', package_id: pk.m6 }).set(hA(rec));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_STATE');
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 0, days: 90 });
    expect((await request(app).get(`/api/contracts/${c.id}/ticket-quote`).query({ type: 'cancel' }).set({ Authorization: `Bearer ${recB}`, 'X-Branch-Id': B })).status).toBe(404);
  });
});

describe('fees and effects', () => {
  it('upgrade: fee is the price difference, keeps the start, recomputes the end, collects cash', async () => {
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, startAgo: 30, days: 90 });
    await mkPayment(c.id, 3_000_000);
    const r = await post(rec, c.id, { type: 'upgrade', package_id: pk.m6, paid: 2_000_000, method: 'cash' });
    expect(r.status).toBe(201);
    expect(r.body.data.ticket).toMatchObject({ type: 'upgrade', status: 'applied', fee: 2_000_000, contract_code: c.code });
    expect(r.body.data.contract).toMatchObject({ total_amount: 5_000_000, paid_amount: 5_000_000, debt_amount: 0 });
    const f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(f.packageId).toBe(pk.m6);
    expect(iso(f.startDate)).toBe(iso(addDays(today, -30)));
    expect(iso(f.endDate)).toBe(iso(addDays(today, -30 + 180)));
    const pay = await prisma.payment.findMany({ where: { contractId: c.id, amount: 2_000_000 } });
    expect(pay).toHaveLength(1);
    expect(pay[0].shiftId).toBeTruthy();
  });

  it('upgrade with partial payment leaves the rest as debt, and non-cash stays pending', async () => {
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, startAgo: 10, days: 90 });
    await mkPayment(c.id, 3_000_000);
    const r = await post(rec, c.id, { type: 'upgrade', package_id: pk.m6, paid: 500_000, method: 'transfer' });
    expect(r.status).toBe(201);
    expect(r.body.data.contract).toMatchObject({ total_amount: 5_000_000, paid_amount: 3_000_000, debt_amount: 2_000_000 });
    const pending = await prisma.payment.findFirstOrThrow({ where: { contractId: c.id, amount: 500_000 } });
    expect(pending.status).toBe('pending');
    const over = await post(rec, (await mkContract({ pkg: 'm3', total: 3_000_000, paid: 0, days: 90 })).id, { type: 'upgrade', package_id: pk.m6, paid: 9_000_000 });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('PAID_EXCEEDS_FEE');
  });

  it('upgrade of a session package adds the session difference', async () => {
    const c = await mkContract({ pkg: 'pt10', total: 10_000_000, paid: 10_000_000, startAgo: 5, days: 30, sessions: [10, 4] });
    await mkPayment(c.id, 10_000_000);
    const r = await post(rec, c.id, { type: 'upgrade', package_id: pk.pt20, paid: 5_000_000 });
    expect(r.status).toBe(201);
    const f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(f).toMatchObject({ totalAmount: 15_000_000, sessionsTotal: 20, sessionsLeft: 14 });
  });

  it('downgrade needs approval, changes nothing while pending, refunds the unused price difference once approved', async () => {
    const c = await mkContract({ pkg: 'm6', total: 5_000_000, paid: 5_000_000, startAgo: 60, days: 180 });
    await mkPayment(c.id, 5_000_000);
    const r = await post(rec, c.id, { type: 'downgrade', package_id: pk.m2, method: 'cash' });
    expect(r.status).toBe(201);
    expect(r.body.data.ticket).toMatchObject({ status: 'pending', fee: -2_000_000 });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).packageId).toBe(pk.m6);

    const denied = await request(app).post(`/api/tickets/${r.body.data.ticket.id}/approve`).set(hA(rec)).send({});
    expect(denied.status).toBe(403);

    const ok = await request(app).post(`/api/tickets/${r.body.data.ticket.id}/approve`).set(hOwn()).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.ticket).toMatchObject({ status: 'applied', fee: -2_000_000 });
    const f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(f).toMatchObject({ packageId: pk.m2, totalAmount: 3_000_000, paidAmount: 3_000_000 });
    expect(iso(f.endDate)).toBe(iso(addDays(today, 60)));
    const refund = await prisma.payment.findFirstOrThrow({ where: { contractId: c.id, amount: -2_000_000 } });
    expect(refund.status).toBe('confirmed');
    expect(await prisma.contractTicket.count({ where: { contractId: c.id } })).toBe(1);
  });

  it('downgrade of a session package uses sessions left / total', async () => {
    const c = await mkContract({ pkg: 'pt10', total: 10_000_000, paid: 10_000_000, startAgo: 5, days: 30, sessions: [10, 4] });
    await mkPayment(c.id, 10_000_000);
    const q = await request(app).get(`/api/contracts/${c.id}/ticket-quote`).query({ type: 'downgrade', package_id: pk.pt6 }).set(hOwn());
    expect(q.body.data).toMatchObject({ fee: -1_600_000, new_sessions_total: 6, new_sessions_left: 4 });
  });

  it('convert: credit for the unused part, restarts today and resets sessions', async () => {
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, startAgo: 45, days: 90 });
    await mkPayment(c.id, 3_000_000);
    const r = await post(rec, c.id, { type: 'convert', package_id: pk.m6, paid: 3_500_000 });
    expect(r.status).toBe(201);
    expect(r.body.data.ticket.fee).toBe(3_500_000);
    const f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(f).toMatchObject({ packageId: pk.m6, totalAmount: 6_500_000, paidAmount: 6_500_000 });
    expect(iso(f.startDate)).toBe(iso(today));
    expect(iso(f.endDate)).toBe(iso(addDays(today, 180)));
    const s = await mkContract({ pkg: 'pt10', total: 10_000_000, paid: 10_000_000, startAgo: 5, days: 30, sessions: [10, 4] });
    const q = await request(app).get(`/api/contracts/${s.id}/ticket-quote`).query({ type: 'convert', package_id: pk.pt20 }).set(hOwn());
    expect(q.body.data).toMatchObject({ fee: 11_000_000, new_sessions_total: 20, new_sessions_left: 20 });
  });

  it('transfer: fixed 500000 fee, creates the new member, needs approval from a receptionist', async () => {
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, startAgo: 10, days: 90 });
    const newPhone = phone();
    const r = await post(rec, c.id, { type: 'transfer', to_member: { phone: newPhone, name: 'Nguoi Nhan' }, paid: 500_000 });
    expect(r.status).toBe(201);
    expect(r.body.data.ticket).toMatchObject({ status: 'pending', fee: 500_000 });
    expect(await prisma.member.count({ where: { phone: newPhone } })).toBe(0);
    const ok = await request(app).post(`/api/tickets/${r.body.data.ticket.id}/approve`).set(hOwn()).send({});
    expect(ok.status).toBe(200);
    const m = await prisma.member.findFirstOrThrow({ where: { phone: newPhone } });
    expect(m.code).toMatch(/^HV\d{4,}$/);
    const f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(f).toMatchObject({ memberId: m.id, totalAmount: 3_500_000, paidAmount: 500_000 });
    const pay = await prisma.payment.findFirstOrThrow({ where: { contractId: c.id, amount: 500_000 } });
    expect(pay.shiftId).toBeNull();
  });

  it('transfer refuses the same member and a member of another branch', async () => {
    const m = await mkMember();
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, days: 90, member: m.id });
    const same = await post(own, c.id, { type: 'transfer', to_member: { member_id: m.id } }, hOwn as never);
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('SAME_MEMBER');
    const other = await mkMember(B);
    const wrong = await request(app).post(`/api/contracts/${c.id}/tickets`).set(hOwn()).send({ type: 'transfer', to_member: { member_id: other.id } });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('BRANCH_MISMATCH');
  });

  it('branch change moves the contract and the member, and a branch receptionist cannot target another branch', async () => {
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, days: 90 });
    const denied = await post(rec, c.id, { type: 'branch_change', branch_id: B });
    expect(denied.status).toBe(404);
    const r = await request(app).post(`/api/contracts/${c.id}/tickets`).set(hOwn()).send({ type: 'branch_change', branch_id: B });
    expect(r.status).toBe(201);
    expect(r.body.data.ticket).toMatchObject({ status: 'applied', fee: 0 });
    const f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id }, include: { member: true } });
    expect(f.branchId).toBe(B);
    expect(f.member.branchId).toBe(B);
  });

  it('cancel refunds 90% of the unused paid amount (rounded to 1000) after approval, and a reject changes nothing', async () => {
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, startAgo: 45, days: 90 });
    await mkPayment(c.id, 3_000_000);
    const r = await post(rec, c.id, { type: 'cancel', reason: 'khach chuyen nha' });
    expect(r.status).toBe(201);
    expect(r.body.data.ticket).toMatchObject({ status: 'pending', fee: -1_350_000 });
    const ok = await request(app).post(`/api/tickets/${r.body.data.ticket.id}/approve`).set(hOwn()).send({});
    expect(ok.status).toBe(200);
    const f = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(f.status).toBe('cancelled');
    expect(f.paidAmount).toBe(1_650_000);

    const c2 = await mkContract({ pkg: 'pt10', total: 10_000_000, paid: 10_000_000, startAgo: 5, days: 30, sessions: [10, 4] });
    await mkPayment(c2.id, 10_000_000);
    const q = await request(app).get(`/api/contracts/${c2.id}/ticket-quote`).query({ type: 'cancel' }).set(hOwn());
    expect(q.body.data).toMatchObject({ fee: -3_600_000, refund: 3_600_000 });

    const c3 = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, startAgo: 45, days: 90 });
    const p3 = await post(rec, c3.id, { type: 'cancel' });
    const noReason = await request(app).post(`/api/tickets/${p3.body.data.ticket.id}/reject`).set(hOwn()).send({});
    expect(noReason.status).toBe(400);
    const rej = await request(app).post(`/api/tickets/${p3.body.data.ticket.id}/reject`).set(hOwn()).send({ reason: 'khong dong y' });
    expect(rej.status).toBe(200);
    expect(rej.body.data.ticket).toMatchObject({ status: 'rejected', reason: 'khong dong y' });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c3.id } })).status).toBe('active');
    const again = await request(app).post(`/api/tickets/${p3.body.data.ticket.id}/approve`).set(hOwn()).send({});
    expect(again.status).toBe(409);
  });
});

describe('409 cases, scoping and money rules', () => {
  it('rejects wrong states and impossible package choices', async () => {
    const signed = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 0, days: 90, status: 'signed' });
    expect((await post(rec, signed.id, { type: 'upgrade', package_id: pk.m6 })).body.error.code).toBe('INVALID_STATE');
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, days: 90 });
    expect((await post(rec, c.id, { type: 'upgrade', package_id: pk.m2 })).body.error.code).toBe('NOT_AN_UPGRADE');
    expect((await post(rec, c.id, { type: 'downgrade', package_id: pk.m6 })).body.error.code).toBe('NOT_A_DOWNGRADE');
    expect((await post(rec, c.id, { type: 'upgrade', package_id: pk.pt20 })).body.error.code).toBe('CATEGORY_MISMATCH');
    expect((await post(rec, c.id, { type: 'upgrade', package_id: pk.m3 })).body.error.code).toBe('SAME_PACKAGE');
    expect((await post(rec, c.id, { type: 'upgrade', package_id: pk.bundle })).body.error.code).toBe('BUNDLE_ONLY');
    expect((await post(rec, c.id, { type: 'upgrade' })).body.error.code).toBe('PACKAGE_REQUIRED');
    const pt = await mkContract({ pkg: 'pt10', total: 10_000_000, paid: 10_000_000, days: 30, sessions: [10, 10] });
    expect((await post(rec, pt.id, { type: 'upgrade', package_id: pk.grp })).body.error.code).toBe('CATEGORY_MISMATCH');
  });

  it('takes cash without an open shift', async () => {
    await prisma.shift.updateMany({ where: { userId: recId, closedAt: null }, data: { closedAt: new Date() } });
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, startAgo: 5, days: 90 });
    const r = await post(rec, c.id, { type: 'upgrade', package_id: pk.m6, paid: 100_000, method: 'cash' });
    expect(r.status).toBe(201);
    await prisma.shift.create({ data: { userId: recId, branchId: A, openingCash: 0 } });
  });

  it('lists tickets scoped by branch with status filter and pagination meta', async () => {
    const c = await mkContract({ pkg: 'm3', total: 3_000_000, paid: 3_000_000, startAgo: 45, days: 90 });
    const made = await post(rec, c.id, { type: 'cancel' });
    const mine = await request(app).get('/api/tickets').query({ status: 'pending', limit: 100 }).set(hA(rec));
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((t: { id: string }) => t.id)).toContain(made.body.data.ticket.id);
    expect(mine.body.data.every((t: { status: string }) => t.status === 'pending')).toBe(true);
    expect(mine.body.meta).toMatchObject({ page: 1, limit: 100 });
    const other = await request(app).get('/api/tickets').query({ limit: 100 }).set({ Authorization: `Bearer ${recB}`, 'X-Branch-Id': B });
    expect(other.status).toBe(200);
    expect(other.body.data.map((t: { id: string }) => t.id)).not.toContain(made.body.data.ticket.id);
    const t0 = mine.body.data.find((t: { id: string }) => t.id === made.body.data.ticket.id);
    expect(t0).toMatchObject({ contract_code: c.code, type: 'cancel', requested_by: recId });
    expect((await request(app).post(`/api/tickets/${made.body.data.ticket.id}/approve`).set({ Authorization: `Bearer ${recB}`, 'X-Branch-Id': B }).send({})).status).toBe(403);
  });
});
