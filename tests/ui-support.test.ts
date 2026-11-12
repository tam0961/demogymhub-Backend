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
let codeA: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const today = () => dateOnly(todayVN());

const hA = (r: string) => ({ Authorization: `Bearer ${tokens[r]}`, 'X-Branch-Id': A });

async function mkMember(branch: string, name = `UI ${uniq()}`) {
  return prisma.member.create({ data: { code: `U${uniq()}`, name, phone: `08${String(10000000 + ++seq * 7 + Math.floor(Math.random() * 1e6))}`, branchId: branch } });
}
async function mkPkg(branch: string, type: 'month' | 'session' = 'month') {
  return prisma.package.create({
    data: { name: `UP ${uniq()}`, type, durationDays: type === 'month' ? 30 : null, sessions: type === 'session' ? 10 : null, price: 500000, branchId: branch },
  });
}
async function mkContract(
  memberId: string,
  branch: string,
  o: { status: 'draft' | 'signed' | 'active' | 'frozen' | 'expired' | 'cancelled'; end?: Date | null; total?: number; paid?: number; createdAt?: Date; type?: 'month' | 'session'; sessionsLeft?: number },
) {
  const pkg = await mkPkg(branch, o.type);
  return prisma.contract.create({
    data: {
      code: `UC${uniq()}`,
      memberId,
      packageId: pkg.id,
      branchId: branch,
      status: o.status,
      totalAmount: o.total ?? 500000,
      paidAmount: o.paid ?? 0,
      durationDays: 30,
      startDate: today(),
      endDate: o.end === undefined ? addDays(today(), 30) : o.end,
      sessionsLeft: o.sessionsLeft ?? null,
      ...(o.createdAt && { createdAt: o.createdAt }),
    },
  });
}

beforeAll(async () => {
  codeA = `uia${uniq()}`;
  A = (await prisma.branch.create({ data: { code: codeA, name: 'UI A' } })).id;
  B = (await prisma.branch.create({ data: { code: `uib${uniq()}`, name: 'UI B' } })).id;
  for (const r of ['receptionist', 'branch_manager', 'sales', 'trainer', 'member']) {
    const email = `${r}@ui.test`;
    const u = await makeUser(email, r, codeA);
    ids[r] = u.id;
    tokens[r] = await tokenFor(email);
  }
  for (const r of ['owner', 'accountant']) {
    const email = `${r}@ui.test`;
    ids[r] = (await makeUser(email, r, null)).id;
    tokens[r] = await tokenFor(email);
  }
  const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.local', password: 'AdminPass!2345' });
  tokens.super_admin = res.body.data.access_token;
  ids.super_admin = res.body.data.user.id;
});

describe('members current_contract and branch', () => {
  it('applies priority active > signed > draft > latest expired', async () => {
    const mActive = await mkMember(A);
    await mkContract(mActive.id, A, { status: 'expired', end: addDays(today(), -5) });
    await mkContract(mActive.id, A, { status: 'draft' });
    const early = await mkContract(mActive.id, A, { status: 'active', end: addDays(today(), 10) });
    const late = await mkContract(mActive.id, A, { status: 'frozen', end: addDays(today(), 40) });
    const mSigned = await mkMember(A);
    await mkContract(mSigned.id, A, { status: 'draft' });
    const signed = await mkContract(mSigned.id, A, { status: 'signed' });
    const mDraft = await mkMember(A);
    await mkContract(mDraft.id, A, { status: 'expired', end: addDays(today(), -9) });
    const draft = await mkContract(mDraft.id, A, { status: 'draft' });
    const mOld = await mkMember(A);
    await mkContract(mOld.id, A, { status: 'cancelled', createdAt: new Date(Date.now() - 86400000 * 3) });
    const newest = await mkContract(mOld.id, A, { status: 'expired', end: addDays(today(), -1) });
    const mNone = await mkMember(A);

    const res = await request(app).get('/api/members?limit=100').set(hA('owner'));
    expect(res.status).toBe(200);
    const by = (id: string) => res.body.data.find((m: { id: string }) => m.id === id);
    expect(by(mActive.id).current_contract.id).toBe(late.id);
    expect(by(mActive.id).current_contract.id).not.toBe(early.id);
    expect(by(mActive.id).current_contract).toMatchObject({ status: 'frozen', package_type: 'month' });
    expect(Object.keys(by(mActive.id).current_contract).sort()).toEqual(
      ['code', 'end_date', 'id', 'package_name', 'package_type', 'sessions_left', 'start_date', 'status'].sort(),
    );
    expect(by(mSigned.id).current_contract.id).toBe(signed.id);
    expect(by(mDraft.id).current_contract.id).toBe(draft.id);
    expect(by(mOld.id).current_contract.id).toBe(newest.id);
    expect(by(mNone.id).current_contract).toBeNull();
    expect(by(mNone.id).branch).toEqual({ id: A, code: codeA, name: 'UI A' });
    expect(by(mNone.id).branch_id).toBe(A);

    const one = await request(app).get(`/api/members/${mActive.id}`).set(hA('owner'));
    expect(one.body.data.current_contract.id).toBe(late.id);
    expect(one.body.data.branch.code).toBe(codeA);
    const none = await request(app).get(`/api/members/${mNone.id}`).set(hA('owner'));
    expect(none.body.data.current_contract).toBeNull();
  });
});

describe('contracts last_payment_method and branch', () => {
  it('list and detail expose last confirmed payment method, branch, member, package', async () => {
    const m = await mkMember(A);
    const c = await mkContract(m.id, A, { status: 'active' });
    const c2 = await mkContract(m.id, A, { status: 'signed' });
    const now = Date.now();
    const pay = (method: 'cash' | 'transfer', status: 'confirmed' | 'pending', at: number) =>
      prisma.payment.create({
        data: { contractId: c.id, branchId: A, method, amount: 1000, status, ref: `R${uniq()}`, confirmedAt: status === 'confirmed' ? new Date(at) : null },
      });
    await pay('cash', 'confirmed', now - 60000);
    await pay('transfer', 'confirmed', now - 1000);
    await pay('cash', 'pending', now);

    const list = await request(app).get(`/api/contracts?member_id=${m.id}`).set(hA('receptionist'));
    expect(list.status).toBe(200);
    const row = list.body.data.find((x: { id: string }) => x.id === c.id);
    expect(row.last_payment_method).toBe('transfer');
    expect(row.branch).toEqual({ id: A, code: codeA, name: 'UI A' });
    expect(row.member).toMatchObject({ id: m.id, name: m.name, phone: m.phone, code: m.code });
    expect(row.package).toHaveProperty('type');
    expect(row.package).toHaveProperty('name');
    expect(list.body.data.find((x: { id: string }) => x.id === c2.id).last_payment_method).toBeNull();

    const d = await request(app).get(`/api/contracts/${c.id}`).set(hA('receptionist'));
    expect(d.body.data.last_payment_method).toBe('transfer');
    expect(d.body.data.branch.id).toBe(A);
    expect(d.body.data.payments).toHaveLength(3);
  });
});

describe('GET /reports/today-tasks', () => {
  const url = '/api/reports/today-tasks';
  it('permission matrix with DENY audit', async () => {
    for (const r of ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'accountant']) {
      const res = await request(app).get(url).set(hA(r));
      expect(res.status, r).toBe(200);
    }
    for (const r of ['trainer', 'member']) {
      const before = await prisma.accessAudit.count({ where: { actorId: ids[r], action: 'permission.checked.denied' } });
      const res = await request(app).get(url).set(hA(r));
      expect(res.status, r).toBe(403);
      expect(await prisma.accessAudit.count({ where: { actorId: ids[r], action: 'permission.checked.denied' } })).toBe(before + 1);
    }
    expect((await request(app).get(url)).status).toBe(401);
  });

  it('counts, ordering, limits and branch isolation', async () => {
    const A = (await prisma.branch.create({ data: { code: `uic${uniq()}`, name: 'UI C' } })).id;
    const hA = (r: string) => ({ Authorization: `Bearer ${tokens[r]}`, 'X-Branch-Id': A });
    const aMember = async () => mkMember(A, `Alice ${uniq()}`);
    const d1 = await mkContract((await aMember()).id, A, { status: 'draft' });
    const d2 = await mkContract((await aMember()).id, A, { status: 'draft' });
    const bm = await mkMember(B, 'Other Branch');
    await mkContract(bm.id, B, { status: 'draft' });
    await mkContract(bm.id, B, { status: 'signed', total: 9000000 });

    const debts = [100000, 700000, 300000, 50000, 900000, 200000, 400000];
    for (const debt of debts) await mkContract((await aMember()).id, A, { status: 'active', total: debt + 100, paid: 100 });
    await mkContract((await aMember()).id, A, { status: 'signed', total: 500, paid: 500 });
    await mkContract((await aMember()).id, A, { status: 'expired', total: 500000, paid: 0 });

    const e0 = await mkContract((await aMember()).id, A, { status: 'active', end: today(), total: 1, paid: 1 });
    const e2 = await mkContract((await aMember()).id, A, { status: 'active', end: addDays(today(), 2), total: 1, paid: 1 });
    const e1 = await mkContract((await aMember()).id, A, { status: 'active', end: addDays(today(), 1), total: 1, paid: 1 });
    await mkContract((await aMember()).id, A, { status: 'active', end: addDays(today(), 3), total: 1, paid: 1 });
    await mkContract((await aMember()).id, A, { status: 'frozen', end: addDays(today(), 1), total: 1, paid: 1 });

    const payC = await mkContract((await aMember()).id, A, { status: 'active', total: 1, paid: 1 });
    const mkPay = (extra: object) =>
      prisma.payment.create({ data: { contractId: payC.id, branchId: A, method: 'cash', amount: 5000, status: 'confirmed', ref: `RF${uniq()}`, confirmedAt: new Date(), ...extra } });
    const p1 = await mkPay({ refundRequestedAt: new Date(), refundReason: 'x' });
    await mkPay({});
    await mkPay({ status: 'refunded', refundRequestedAt: new Date(), refundedAt: new Date() });
    const bc = await mkContract(bm.id, B, { status: 'active', total: 1, paid: 1 });
    await prisma.payment.create({ data: { contractId: bc.id, branchId: B, method: 'cash', amount: 7, status: 'confirmed', ref: `RF${uniq()}`, confirmedAt: new Date(), refundRequestedAt: new Date() } });

    const res = await request(app).get(url).set(hA('owner'));
    expect(res.status).toBe(200);
    const t = res.body.data;
    expect(t.awaiting_signature.count).toBe(2);
    expect(t.awaiting_signature.items.map((i: { id: string }) => i.id)).toEqual([d1.id, d2.id]);
    expect(t.awaiting_signature.items[0]).toHaveProperty('member_name');
    expect(t.unpaid.count).toBe(7);
    expect(t.unpaid.total_debt).toBe(debts.reduce((a, b) => a + b, 0));
    expect(t.unpaid.items).toHaveLength(5);
    expect(t.unpaid.items.map((i: { debt_amount: number }) => i.debt_amount)).toEqual([900000, 700000, 400000, 300000, 200000]);
    expect(t.expiring_in_2_days.count).toBe(3);
    expect(t.expiring_in_2_days.items.map((i: { id: string }) => i.id)).toEqual([e0.id, e1.id, e2.id]);
    expect(t.expiring_in_2_days.items[0].end_date).toBe(todayVN());
    expect(t.pending_refunds.count).toBe(1);
    expect(t.pending_refunds.items).toEqual([{ id: p1.id, contract_code: payC.code, amount: 5000 }]);

    const bt = await request(app).get(url).set({ Authorization: `Bearer ${tokens.owner}`, 'X-Branch-Id': B });
    expect(bt.body.data.awaiting_signature.count).toBe(1);
    expect(bt.body.data.unpaid.total_debt).toBe(9000000);
    expect(bt.body.data.pending_refunds.items[0].amount).toBe(7);

    const scoped = await request(app).get(url).set({ Authorization: `Bearer ${tokens.receptionist}` });
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.awaiting_signature.items.map((x: { id: string }) => x.id)).not.toContain(d1.id);
    expect(scoped.body.data.unpaid.items.map((x: { debt_amount: number }) => x.debt_amount)).not.toContain(900000);
    const cross = await request(app).get(`${url}?branch_id=${B}`).set({ Authorization: `Bearer ${tokens.receptionist}` });
    expect(cross.status).toBe(403);
  });
});

describe('payments expose contract code and member name', () => {
  it('payments list and daily closing include contract.code and contract.member.name', async () => {
    const m = await mkMember(A, 'Nguyen Van Test');
    const c = await mkContract(m.id, A, { status: 'active' });
    const p = await prisma.payment.create({
      data: { contractId: c.id, branchId: A, method: 'cash', amount: 7000, status: 'confirmed', ref: `R${uniq()}`, confirmedAt: new Date() },
    });

    const list = await request(app).get(`/api/payments?contract_id=${c.id}`).set(hA('branch_manager'));
    expect(list.status).toBe(200);
    const row = list.body.data.find((x: { id: string }) => x.id === p.id);
    expect(row.contract).toEqual({ id: c.id, code: c.code, member: { name: 'Nguyen Van Test' } });
    expect(row.refund_requested).toBe(false);

    const closing = await request(app).get('/api/reports/daily-closing').set(hA('branch_manager'));
    expect(closing.status).toBe(200);
    const tx = closing.body.data.transactions.find((x: { id: string }) => x.id === p.id);
    expect(tx.contract.code).toBe(c.code);
    expect(tx.contract.member.name).toBe('Nguyen Van Test');
  });
});

describe('contract events expose actor name', () => {
  it('detail events include by_user_name', async () => {
    const m = await mkMember(A);
    const c = await mkContract(m.id, A, { status: 'signed' });
    await prisma.contractEvent.create({ data: { contractId: c.id, type: 'signed', byUser: ids.receptionist } });
    const who = await prisma.user.findUniqueOrThrow({ where: { id: ids.receptionist }, select: { name: true } });
    const d = await request(app).get(`/api/contracts/${c.id}`).set(hA('receptionist'));
    expect(d.status).toBe(200);
    expect(d.body.data.events[0].by_user).toBe(ids.receptionist);
    expect(d.body.data.events[0].by_user_name).toBe(who.name);
  });
});

describe('POST /contracts promo and renewal', () => {
  const create = (body: Record<string, unknown>) => request(app).post('/api/contracts').set(hA('branch_manager')).send(body);

  it('percent and amount promos reduce the total', async () => {
    const m = await mkMember(A);
    const pkg = await mkPkg(A);
    const p = await create({ member_id: m.id, package_id: pkg.id, promo: { type: 'percent', value: 10 } });
    expect(p.status).toBe(201);
    expect(p.body.data.discount).toBe(50000);
    expect(p.body.data.total_amount).toBe(450000);
    const a = await create({ member_id: m.id, package_id: pkg.id, promo: { type: 'amount', value: 120000 } });
    expect(a.body.data.discount).toBe(120000);
    expect(a.body.data.total_amount).toBe(380000);
    expect((await create({ member_id: m.id, package_id: pkg.id, promo: { type: 'percent', value: 101 } })).body.error.code).toBe('INVALID_PROMO');
    expect((await create({ member_id: m.id, package_id: pkg.id, promo: { type: 'amount', value: 999999 } })).body.error.code).toBe('INVALID_DISCOUNT');
  });

  it('bonus months, days and sessions extend the contract without changing the price', async () => {
    const m = await mkMember(A);
    const month = await mkPkg(A, 'month');
    const sess = await mkPkg(A, 'session');
    const dur = async (r: { body: { data: { id: string } } }) => (await prisma.contract.findUniqueOrThrow({ where: { id: r.body.data.id } }));
    const bm = await create({ member_id: m.id, package_id: month.id, promo: { type: 'bonus_months', value: 1 } });
    expect(bm.body.data.total_amount).toBe(500000);
    expect((await dur(bm)).durationDays).toBe(60);
    const bd = await create({ member_id: m.id, package_id: month.id, promo: { type: 'bonus_days', value: 5 } });
    expect((await dur(bd)).durationDays).toBe(35);
    const bs = await create({ member_id: m.id, package_id: sess.id, promo: { type: 'bonus_sessions', value: 2 } });
    const row = await dur(bs);
    expect(row.sessionsTotal).toBe(12);
    expect(row.sessionsLeft).toBe(12);
    expect((await create({ member_id: m.id, package_id: month.id, promo: { type: 'bonus_sessions', value: 2 } })).body.error.code).toBe('PROMO_NOT_APPLICABLE');
    expect((await create({ member_id: m.id, package_id: sess.id, promo: { type: 'bonus_months', value: 1 } })).body.error.code).toBe('PROMO_NOT_APPLICABLE');
  });

  it('renewed_from_id links a renewal and validates the old contract', async () => {
    const m = await mkMember(A);
    const other = await mkMember(A);
    const pkg = await mkPkg(A);
    const old = await mkContract(m.id, A, { status: 'active' });
    const draft = await mkContract(m.id, A, { status: 'draft' });
    const ok = await create({ member_id: m.id, package_id: pkg.id, renewed_from_id: old.id });
    expect(ok.status).toBe(201);
    expect(ok.body.data.renewed_from_id).toBe(old.id);
    expect((await create({ member_id: other.id, package_id: pkg.id, renewed_from_id: old.id })).body.error.code).toBe('MEMBER_MISMATCH');
    expect((await create({ member_id: m.id, package_id: pkg.id, renewed_from_id: draft.id })).body.error.code).toBe('INVALID_STATE');
  });
});

describe('member photo and Face ID', () => {
  const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
  const put = (id: string, body: unknown, role = 'receptionist') => request(app).put(`/api/members/${id}/photo`).set(hA(role)).send(body as object);

  it('stores, serves and lists a photo; validates type, size and permission', async () => {
    const m = await mkMember(A);
    const png = await put(m.id, { content_type: 'image/png', image_base64: jpeg(300).toString('base64') });
    expect(png.status).toBe(400);
    expect(png.body.error.code).toBe('INVALID_IMAGE');
    const big = await put(m.id, { content_type: 'image/jpeg', image_base64: jpeg(205000).toString('base64') });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PHOTO_TOO_LARGE');
    expect((await put(m.id, { content_type: 'image/jpeg', image_base64: jpeg(300).toString('base64') }, 'trainer')).status).toBe(403);

    const no = await request(app).get(`/api/members/${m.id}/photo`).set(hA('receptionist'));
    expect(no.status).toBe(404);

    const ok = await put(m.id, { content_type: 'image/jpeg', image_base64: jpeg(300).toString('base64') });
    expect(ok.status).toBe(200);
    expect(ok.body.data.has_photo).toBe(true);
    expect(typeof ok.body.data.photo_version).toBe('number');

    const img = await request(app).get(`/api/members/${m.id}/photo`).set(hA('receptionist')).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.isBuffer(img.body) && img.body.length).toBe(304);

    const list = await request(app).get(`/api/members?q=${m.code}`).set(hA('receptionist'));
    expect(list.body.data[0].has_photo).toBe(true);
    expect(list.body.data[0].photo_version).toBe(ok.body.data.photo_version);

    const del = await request(app).delete(`/api/members/${m.id}/photo`).set(hA('receptionist'));
    expect(del.body.data.has_photo).toBe(false);
    expect((await request(app).get(`/api/members/${m.id}/photo`).set(hA('receptionist'))).status).toBe(404);
  });

  it('does not expose photos of members in another branch', async () => {
    const other = await mkMember(B);
    const r = await put(other.id, { content_type: 'image/jpeg', image_base64: jpeg(300).toString('base64') });
    expect(r.status).toBe(404);
  });

  it('face_id is set on create and update, must be unique and well formed', async () => {
    const m1 = await mkMember(A);
    const m2 = await mkMember(A);
    const fid = `F${uniq()}`;
    const set = await request(app).patch(`/api/members/${m1.id}`).set(hA('receptionist')).send({ face_id: fid });
    expect(set.status).toBe(200);
    expect(set.body.data.face_id).toBe(fid);
    const dup = await request(app).patch(`/api/members/${m2.id}`).set(hA('receptionist')).send({ face_id: fid });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_FACE_ID');
    expect((await request(app).patch(`/api/members/${m2.id}`).set(hA('receptionist')).send({ face_id: 'bad id!' })).status).toBe(400);
    const clear = await request(app).patch(`/api/members/${m1.id}`).set(hA('receptionist')).send({ face_id: null });
    expect(clear.body.data.face_id).toBeNull();
    const created = await request(app).post('/api/members').set(hA('receptionist')).send({ name: 'Face New', phone: `09${String(10000000 + Math.floor(Math.random() * 8e7))}`, face_id: `N${uniq()}` });
    expect(created.status).toBe(201);
    expect(created.body.data.face_id).toMatch(/^N/);
  });
});
