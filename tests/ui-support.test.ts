import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, addMonths, dateOnly, todayVN } from '../src/lib/dates';
import { ptUsageDeadline } from '../src/modules/contracts/service';
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
async function mkPkg(branch: string, type: 'month' | 'session' = 'month', category: 'member' | 'pt_1on1' | 'pt_1on2' | 'pt_group' = 'member') {
  return prisma.package.create({
    data: { name: `UP ${uniq()}`, type, category, durationDays: type === 'month' ? 30 : null, sessions: type === 'session' ? 10 : null, price: 500000, branchId: branch },
  });
}
async function mkContract(
  memberId: string,
  branch: string,
  o: { status: 'draft' | 'signed' | 'active' | 'frozen' | 'expired' | 'cancelled'; end?: Date | null; total?: number; paid?: number; createdAt?: Date; type?: 'month' | 'session'; sessionsLeft?: number; sessionsTotal?: number; category?: 'member' | 'pt_1on1' | 'pt_1on2' | 'pt_group'; start?: Date | null },
) {
  const pkg = await mkPkg(branch, o.type, o.category);
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
      startDate: o.start === undefined ? today() : o.start,
      endDate: o.end === undefined ? addDays(today(), 30) : o.end,
      sessionsTotal: o.sessionsTotal ?? null,
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

describe('package category and PT rules', () => {
  const D = (s: string) => dateOnly(s);
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const days = (n: number) => addDays(today(), n);
  const elig = (id: string, role = 'receptionist') => request(app).get(`/api/members/${id}/pt-eligibility`).set(hA(role));

  it('ptUsageDeadline adds 3 months for 30 sessions or fewer and 6 months above, clamped to month end', () => {
    expect(iso(ptUsageDeadline(D('2026-11-30'), 30))).toBe('2027-02-28');
    expect(iso(ptUsageDeadline(D('2026-11-30'), 31))).toBe('2027-05-30');
    expect(iso(ptUsageDeadline(D('2026-08-31'), 10))).toBe('2026-11-30');
    expect(ptUsageDeadline(null, 10)).toBeNull();
    expect(iso(addMonths(D('2027-01-31'), 1))).toBe('2027-02-28');
  });

  it('packages API accepts, returns and filters by category', async () => {
    const mk = (name: string, category: string) =>
      request(app).post('/api/packages').set(hA('branch_manager')).send({ name, type: 'session', sessions: 10, price: 100, category });
    const pt = await mk(`PT only ${uniq()}`, 'pt_group');
    expect(pt.status).toBe(201);
    expect(pt.body.data.category).toBe('pt_group');
    const dflt = await request(app).post('/api/packages').set(hA('branch_manager')).send({ name: `Gym ${uniq()}`, type: 'month', duration_days: 30, price: 100 });
    expect(dflt.body.data.category).toBe('member');
    const only = await request(app).get('/api/packages?category=pt_group&limit=100').set(hA('branch_manager'));
    expect(only.body.data.every((p: { category: string }) => p.category === 'pt_group')).toBe(true);
    const upd = await request(app).patch(`/api/packages/${dflt.body.data.id}`).set(hA('branch_manager')).send({ category: 'pt_1on2' });
    expect(upd.body.data.category).toBe('pt_1on2');
  });

  it('contract API exposes package.category and usage_deadline for PT only', async () => {
    const m = await mkMember(A);
    const end = days(10);
    const pt = await mkContract(m.id, A, { status: 'active', type: 'session', category: 'pt_1on1', sessionsTotal: 20, sessionsLeft: 20, end });
    const gym = await mkContract(m.id, A, { status: 'active' });
    const a = await request(app).get(`/api/contracts/${pt.id}`).set(hA('receptionist'));
    expect(a.body.data.package.category).toBe('pt_1on1');
    expect(a.body.data.usage_deadline).toBe(iso(addMonths(end, 3)));
    const big = await mkContract(m.id, A, { status: 'active', type: 'session', category: 'pt_1on1', sessionsTotal: 40, sessionsLeft: 40, end });
    expect((await request(app).get(`/api/contracts/${big.id}`).set(hA('receptionist'))).body.data.usage_deadline).toBe(iso(addMonths(end, 6)));
    const g = await request(app).get(`/api/contracts/${gym.id}`).set(hA('receptionist'));
    expect(g.body.data).not.toHaveProperty('usage_deadline');
  });

  it('member list separates the member package from the PT package', async () => {
    const m = await mkMember(A);
    const gym = await mkContract(m.id, A, { status: 'active', end: days(20) });
    await mkContract(m.id, A, { status: 'active', type: 'session', category: 'pt_1on1', sessionsTotal: 10, sessionsLeft: 7, end: days(-10) });
    const list = await request(app).get(`/api/members?q=${m.code}`).set(hA('receptionist'));
    const row = list.body.data[0];
    expect(row.current_contract.code).toBe(gym.code);
    expect(row.pt_contract).toMatchObject({ sessions_total: 10, sessions_left: 7, usage_valid: true });
    expect(row.pt_contract.usage_deadline).toBe(iso(addMonths(days(-10), 3)));
    const onlyPt = await mkMember(A);
    await mkContract(onlyPt.id, A, { status: 'active', type: 'session', category: 'pt_1on1', sessionsTotal: 10, sessionsLeft: 10 });
    const r2 = (await request(app).get(`/api/members?q=${onlyPt.code}`).set(hA('receptionist'))).body.data[0];
    expect(r2.current_contract).toBeNull();
    expect(r2.pt_contract).not.toBeNull();
  });

  it('PT eligibility needs a valid member package AND a PT package inside its usage window', async () => {
    const mk = async (memberEnd: number | 'none', pt: { end: number; total: number } | 'none') => {
      const m = await mkMember(A);
      if (memberEnd !== 'none') {
        await mkContract(m.id, A, { status: memberEnd < 0 ? 'expired' : 'active', end: days(memberEnd) });
      }
      if (pt !== 'none') {
        await mkContract(m.id, A, { status: pt.end < 0 ? 'expired' : 'active', type: 'session', category: 'pt_1on1', sessionsTotal: pt.total, sessionsLeft: 5, end: days(pt.end) });
      }
      return m.id;
    };
    const ok = (await elig(await mk(30, { end: 30, total: 20 }))).body.data;
    expect(ok.eligible).toBe(true);
    expect(ok.member_package.ok && ok.pt_package.ok).toBe(true);

    const inWindow = (await elig(await mk(30, { end: -30, total: 20 }))).body.data;
    expect(inWindow.eligible).toBe(true);
    expect(inWindow.pt_package.usage_deadline).toBe(iso(addMonths(days(-30), 3)));

    const pastWindow = (await elig(await mk(30, { end: -100, total: 20 }))).body.data;
    expect(pastWindow.eligible).toBe(false);
    expect(pastWindow.reasons).toEqual(['PT_USAGE_EXPIRED']);

    const bigStillOk = (await elig(await mk(30, { end: -100, total: 40 }))).body.data;
    expect(bigStillOk.eligible).toBe(true);

    const memberExpired = (await elig(await mk(-5, { end: 30, total: 20 }))).body.data;
    expect(memberExpired.eligible).toBe(false);
    expect(memberExpired.reasons).toEqual(['MEMBER_PACKAGE_EXPIRED']);

    const noPt = (await elig(await mk(30, 'none'))).body.data;
    expect(noPt.reasons).toEqual(['NO_PT_PACKAGE']);
    const none = (await elig(await mk('none', 'none'))).body.data;
    expect(none.reasons).toEqual(['MEMBER_PACKAGE_EXPIRED', 'NO_PT_PACKAGE']);
  });

  it('PT eligibility is branch scoped and needs members.read', async () => {
    const other = await mkMember(B);
    expect((await elig(other.id)).status).toBe(404);
    const mine = await mkMember(A);
    expect((await elig(mine.id, 'trainer')).status).toBe(403);
  });

  it('check-in is granted by the member package only; a PT package never grants entry or loses sessions', async () => {
    const onlyPt = await mkMember(A);
    await mkContract(onlyPt.id, A, { status: 'active', type: 'session', category: 'pt_1on1', sessionsTotal: 10, sessionsLeft: 10 });
    const denied = await request(app).post('/api/checkins').set(hA('receptionist')).send({ member_id: onlyPt.id });
    expect(denied.status).toBe(200);
    expect(denied.body.data.result).toBe('denied');
    expect(denied.body.data.reason).toBe('NO_ACTIVE_CONTRACT');

    const both = await mkMember(A);
    const gym = await mkContract(both.id, A, { status: 'active' });
    const pt = await mkContract(both.id, A, { status: 'active', type: 'session', category: 'pt_1on1', sessionsTotal: 10, sessionsLeft: 10 });
    const ok = await request(app).post('/api/checkins').set(hA('receptionist')).send({ member_id: both.id });
    expect(ok.body.data.result).toBe('allowed');
    expect(ok.body.data.contract.code).toBe(gym.code);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: pt.id } })).sessionsLeft).toBe(10);
  });
});

describe('package bundles, versions and deactivation', () => {
  const asMgr = (m: 'post' | 'patch' | 'get', url: string, body?: object) => {
    const r = request(app)[m](url).set(hA('branch_manager'));
    return body ? r.send(body) : r;
  };
  const memberPkg = (name = `Member ${uniq()}`, extra: object = {}) =>
    asMgr('post', '/api/packages', { name, type: 'month', category: 'member', duration_days: 30, price: 700000, branch_id: A, ...extra });
  const ptPkg = (bundled: string | null, extra: object = {}) =>
    asMgr('post', '/api/packages', { name: `PT ${uniq()}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 3000000, branch_id: A, bundled_member_package_id: bundled, ...extra });
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  it('a PT package can include an active member package of the same branch, nothing else', async () => {
    const m = (await memberPkg()).body.data;
    const ok = await ptPkg(m.id);
    expect(ok.status).toBe(201);
    expect(ok.body.data.bundled_member_package).toMatchObject({ id: m.id, name: m.name, duration_days: 30 });
    const onMember = await memberPkg(`M2 ${uniq()}`, { bundled_member_package_id: m.id });
    expect(onMember.body.error.code).toBe('INVALID_BUNDLE');
    const ptAsBundle = await ptPkg(ok.body.data.id);
    expect(ptAsBundle.body.error.code).toBe('INVALID_BUNDLE');
    const off = (await memberPkg()).body.data;
    await asMgr('patch', `/api/packages/${off.id}`, { active: false });
    expect((await ptPkg(off.id)).body.error.code).toBe('INVALID_BUNDLE');
  });

  it('a package that already has contracts cannot be edited, only activated or deactivated', async () => {
    const pkg = (await memberPkg()).body.data;
    expect(pkg.contracts_count).toBe(0);
    const edit = await asMgr('patch', `/api/packages/${pkg.id}`, { price: 1 });
    expect(edit.status).toBe(200);
    const mem = await mkMember(A);
    expect((await asMgr('post', '/api/contracts', { member_id: mem.id, package_id: pkg.id })).status).toBe(201);
    const used = await asMgr('get', `/api/packages/${pkg.id}`);
    expect(used.body.data).toMatchObject({ contracts_count: 1, in_use: true });
    const blocked = await asMgr('patch', `/api/packages/${pkg.id}`, { price: 2 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PACKAGE_IN_USE');
    expect((await asMgr('patch', `/api/packages/${pkg.id}`, { name: 'Renamed' })).body.error.code).toBe('PACKAGE_IN_USE');
    const off = await asMgr('patch', `/api/packages/${pkg.id}`, { active: false });
    expect(off.status).toBe(200);
    expect(off.body.data.active).toBe(false);
    expect((await asMgr('post', '/api/contracts', { member_id: mem.id, package_id: pkg.id })).body.error.code).toBe('PACKAGE_INACTIVE');
    const on = await asMgr('patch', `/api/packages/${pkg.id}`, { active: true });
    expect(on.body.data.active).toBe(true);
  });

  it('a new version replaces the old package without changing it, and can deactivate the old one', async () => {
    const old = (await memberPkg(`Old ${uniq()}`)).body.data;
    const mem = await mkMember(A);
    await asMgr('post', '/api/contracts', { member_id: mem.id, package_id: old.id });
    const v2 = await memberPkg(`New ${uniq()}`, { price: 800000, replaces_id: old.id, deactivate_replaced: true });
    expect(v2.status).toBe(201);
    expect(v2.body.data.replaces_id).toBe(old.id);
    const oldNow = (await asMgr('get', `/api/packages/${old.id}`)).body.data;
    expect(oldNow).toMatchObject({ price: 700000, name: old.name, active: false });
    const v3 = await memberPkg(`Newer ${uniq()}`, { replaces_id: v2.body.data.id });
    expect((await asMgr('get', `/api/packages/${v2.body.data.id}`)).body.data.active).toBe(true);
    expect(v3.body.data.replaces_id).toBe(v2.body.data.id);
  });

  it('selling a PT package also creates the included member contract, signed, activated and cancelled with it', async () => {
    const m = (await memberPkg()).body.data;
    const p = (await ptPkg(m.id)).body.data;
    const mem = await mkMember(A);
    const created = await asMgr('post', '/api/contracts', { member_id: mem.id, package_id: p.id });
    expect(created.status).toBe(201);
    const pt = created.body.data;
    expect(pt.total_amount).toBe(3000000);
    expect(pt.bundled_contracts).toHaveLength(1);
    const childId = pt.bundled_contracts[0].id;
    expect(pt.bundled_contracts[0].package.category).toBe('member');

    const child0 = (await asMgr('get', `/api/contracts/${childId}`)).body.data;
    expect(child0).toMatchObject({ total_amount: 0, status: 'draft', bundle_of_id: pt.id, member_id: mem.id });

    await asMgr('post', `/api/contracts/${pt.id}/sign`, { signature: 'data:image/png;base64,AAAA' });
    expect((await asMgr('get', `/api/contracts/${childId}`)).body.data.status).toBe('signed');

    await prisma.contract.update({ where: { id: pt.id }, data: { paidAmount: 3000000 } });
    const act = await asMgr('post', `/api/contracts/${pt.id}/activate`, {});
    expect(act.status).toBe(200);
    const child1 = (await asMgr('get', `/api/contracts/${childId}`)).body.data;
    expect(child1.status).toBe('active');
    expect(child1.start_date).toBe(act.body.data.start_date);
    expect(child1.end_date).toBe(iso(addDays(dateOnly(child1.start_date), 30)));
    expect((await prisma.member.findUniqueOrThrow({ where: { id: mem.id } })).status).toBe('active');

    const ci = await request(app).post('/api/checkins').set(hA('receptionist')).send({ member_id: mem.id });
    expect(ci.body.data.result).toBe('allowed');
    expect(ci.body.data.contract.id).toBe(childId);

    const cancel = await asMgr('post', `/api/contracts/${pt.id}/cancel`, { reason: 'khach doi y' });
    expect(cancel.status).toBe(200);
    expect((await asMgr('get', `/api/contracts/${childId}`)).body.data.status).toBe('cancelled');
  });

  it('the included member package extends a member package that is still running', async () => {
    const m = (await memberPkg()).body.data;
    const p = (await ptPkg(m.id)).body.data;
    const mem = await mkMember(A);
    const running = await mkContract(mem.id, A, { status: 'active', end: addDays(today(), 10) });
    const pt = (await asMgr('post', '/api/contracts', { member_id: mem.id, package_id: p.id })).body.data;
    await asMgr('post', `/api/contracts/${pt.id}/sign`, { signature: 'data:image/png;base64,AAAA' });
    await prisma.contract.update({ where: { id: pt.id }, data: { paidAmount: 3000000 } });
    await asMgr('post', `/api/contracts/${pt.id}/activate`, {});
    const child = (await asMgr('get', `/api/contracts/${pt.bundled_contracts[0].id}`)).body.data;
    expect(child.start_date).toBe(iso(addDays(addDays(today(), 10), 1)));
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: child.id } })).renewedFromId).toBe(running.id);
  });

  it('a PT package without an included package creates one contract; an inactive included package blocks the sale', async () => {
    const p = (await ptPkg(null)).body.data;
    const mem = await mkMember(A);
    const one = await asMgr('post', '/api/contracts', { member_id: mem.id, package_id: p.id });
    expect(one.body.data.bundled_contracts).toBeUndefined();
    const m = (await memberPkg()).body.data;
    const withBundle = (await ptPkg(m.id)).body.data;
    await prisma.package.update({ where: { id: m.id }, data: { active: false } });
    const blocked = await asMgr('post', '/api/contracts', { member_id: mem.id, package_id: withBundle.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BUNDLED_PACKAGE_INACTIVE');
  });
});

describe('package PATCH keeps omitted fields', () => {
  it('editing one field does not reset VAT, category or active', async () => {
    const created = await request(app)
      .post('/api/packages')
      .set(hA('branch_manager'))
      .send({ name: `Keep ${uniq()}`, type: 'session', category: 'pt_1on2', sessions: 10, price: 100, vat_percent: 8, active: false, branch_id: A });
    expect(created.status).toBe(201);
    const r = await request(app).patch(`/api/packages/${created.body.data.id}`).set(hA('branch_manager')).send({ price: 500 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ price: 500, vat_percent: 8, category: 'pt_1on2', active: false });
  });
});

describe('contract keeps the package name from the time of sale', () => {
  it('snapshots the name at creation and signing; renaming the package in the database changes nothing', async () => {
    const pkg = await mkPkg(A);
    const original = pkg.name;
    const mem = await mkMember(A);
    const created = await request(app).post('/api/contracts').set(hA('branch_manager')).send({ member_id: mem.id, package_id: pkg.id });
    expect(created.body.data.package.name).toBe(original);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: created.body.data.id } })).packageName).toBe(original);

    await request(app).post(`/api/contracts/${created.body.data.id}/sign`).set(hA('branch_manager')).send({ signature: 'data:image/png;base64,AAAA' });
    await prisma.contract.update({ where: { id: created.body.data.id }, data: { status: 'active', startDate: today(), endDate: addDays(today(), 30) } });

    await prisma.package.update({ where: { id: pkg.id }, data: { name: 'Renamed later' } });
    const detail = await request(app).get(`/api/contracts/${created.body.data.id}`).set(hA('branch_manager'));
    expect(detail.body.data.package.name).toBe(original);
    const members = await request(app).get(`/api/members?q=${mem.code}`).set(hA('receptionist'));
    expect(members.body.data[0].current_contract.package_name).toBe(original);
    const list = await request(app).get(`/api/contracts?member_id=${mem.id}`).set(hA('branch_manager'));
    expect(list.body.data[0].package.name).toBe(original);
  });

  it('a contract without a snapshot falls back to the live package name', async () => {
    const mem = await mkMember(A);
    const c = await mkContract(mem.id, A, { status: 'active' });
    const pk = await prisma.package.findUniqueOrThrow({ where: { id: c.packageId } });
    const detail = await request(app).get(`/api/contracts/${c.id}`).set(hA('branch_manager'));
    expect(detail.body.data.package.name).toBe(pk.name);
  });
});

describe('HSD applies to PT 1:1 only', () => {
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const days = (n: number) => addDays(today(), n);
  const elig = (id: string) => request(app).get(`/api/members/${id}/pt-eligibility`).set(hA('receptionist'));
  const pt = (memberId: string, category: 'pt_1on1' | 'pt_1on2' | 'pt_group', endDays: number, total = 20) =>
    mkContract(memberId, A, { status: endDays < 0 ? 'expired' : 'active', type: 'session', category, sessionsTotal: total, sessionsLeft: 5, end: days(endDays) });

  it('only 1:1 contracts expose usage_deadline', async () => {
    const m = await mkMember(A);
    const one = await pt(m.id, 'pt_1on1', 10);
    const two = await pt(m.id, 'pt_1on2', 10);
    const grp = await pt(m.id, 'pt_group', 10);
    const get = async (id: string) => (await request(app).get(`/api/contracts/${id}`).set(hA('receptionist'))).body.data;
    expect((await get(one.id)).usage_deadline).toBe(iso(addMonths(days(10), 3)));
    expect(await get(two.id)).not.toHaveProperty('usage_deadline');
    expect(await get(grp.id)).not.toHaveProperty('usage_deadline');
  });

  it('member list: pt_contract has a deadline only for 1:1 and usable status follows each rule', async () => {
    const m1 = await mkMember(A);
    await pt(m1.id, 'pt_1on1', -20);
    const r1 = (await request(app).get(`/api/members?q=${m1.code}`).set(hA('receptionist'))).body.data[0].pt_contract;
    expect(r1).toMatchObject({ package_category: 'pt_1on1', usage_valid: true });
    expect(r1.usage_deadline).toBe(iso(addMonths(days(-20), 3)));

    const m2 = await mkMember(A);
    await pt(m2.id, 'pt_1on2', -20);
    const r2 = (await request(app).get(`/api/members?q=${m2.code}`).set(hA('receptionist'))).body.data[0].pt_contract;
    expect(r2).toMatchObject({ package_category: 'pt_1on2', usage_deadline: null, usage_valid: false });

    const m3 = await mkMember(A);
    await pt(m3.id, 'pt_group', 15);
    const r3 = (await request(app).get(`/api/members?q=${m3.code}`).set(hA('receptionist'))).body.data[0].pt_contract;
    expect(r3).toMatchObject({ package_category: 'pt_group', usage_deadline: null, usage_valid: true });
  });

  it('eligibility: 1:1 gets the HSD window, 1:2 and group must still be inside their own end date', async () => {
    const mk = async (category: 'pt_1on1' | 'pt_1on2' | 'pt_group', endDays: number, total = 20) => {
      const m = await mkMember(A);
      await mkContract(m.id, A, { status: 'active', end: days(30) });
      await pt(m.id, category, endDays, total);
      return m.id;
    };
    const oneInWindow = (await elig(await mk('pt_1on1', -30))).body.data;
    expect(oneInWindow.eligible).toBe(true);
    expect(oneInWindow.pt_package.category).toBe('pt_1on1');
    expect(oneInWindow.pt_package.usage_deadline).toBe(iso(addMonths(days(-30), 3)));

    const oneOut = (await elig(await mk('pt_1on1', -100))).body.data;
    expect(oneOut.reasons).toEqual(['PT_USAGE_EXPIRED']);
    const oneBig = (await elig(await mk('pt_1on1', -100, 40))).body.data;
    expect(oneBig.eligible).toBe(true);

    const twoActive = (await elig(await mk('pt_1on2', 10))).body.data;
    expect(twoActive.eligible).toBe(true);
    expect(twoActive.pt_package.usage_deadline).toBeNull();
    expect(twoActive.pt_package.category).toBe('pt_1on2');
    const twoEnded = (await elig(await mk('pt_1on2', -1))).body.data;
    expect(twoEnded.eligible).toBe(false);
    expect(twoEnded.reasons).toEqual(['PT_PACKAGE_EXPIRED']);
    const groupEnded = (await elig(await mk('pt_group', -30))).body.data;
    expect(groupEnded.reasons).toEqual(['PT_PACKAGE_EXPIRED']);
    const groupActive = (await elig(await mk('pt_group', 5))).body.data;
    expect(groupActive.eligible).toBe(true);
  });
});

describe('package options: bundle only, gift, check-in time limit', () => {
  const mgr = (m: 'post' | 'patch', url: string, body: object) => request(app)[m](url).set(hA('branch_manager')).send(body);

  it('a bundle-only package cannot be sold alone and keeps gift and time limit', async () => {
    const created = await mgr('post', '/api/packages', {
      name: `Gift ${uniq()}`, type: 'month', category: 'member', duration_days: 30, price: 0, branch_id: A,
      bundle_only: true, gift: 'Tui TH Gym', checkin_before: '14:00',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ bundle_only: true, gift: 'Tui TH Gym', checkin_before: '14:00' });
    const mem = await mkMember(A);
    const sale = await mgr('post', '/api/contracts', { member_id: mem.id, package_id: created.body.data.id });
    expect(sale.body.error.code).toBe('BUNDLE_ONLY');
    const pt = await mgr('post', '/api/packages', {
      name: `PT ${uniq()}`, type: 'session', category: 'pt_1on1', sessions: 10, price: 100, branch_id: A, bundled_member_package_id: created.body.data.id,
    });
    expect(pt.status).toBe(201);
    const sold = await mgr('post', '/api/contracts', { member_id: mem.id, package_id: pt.body.data.id });
    expect(sold.status).toBe(201);
    expect(sold.body.data.bundled_contracts).toHaveLength(1);
    const keep = await mgr('patch', `/api/packages/${created.body.data.id}`, { active: true });
    expect(keep.body.data).toMatchObject({ bundle_only: true, gift: 'Tui TH Gym', checkin_before: '14:00' });
  });

  it('check-in is denied from the limit hour on, and allowed before it', async () => {
    const run = async (limit: string) => {
      const m = await mkMember(A);
      const c = await mkContract(m.id, A, { status: 'active' });
      await prisma.package.update({ where: { id: c.packageId! }, data: { checkinBefore: limit } });
      return (await request(app).post('/api/checkins').set(hA('receptionist')).send({ member_id: m.id })).body.data;
    };
    const late = await run('00:00');
    expect(late).toMatchObject({ result: 'denied', reason: 'OUTSIDE_HOURS' });
    const ok = await run('23:59');
    expect(ok.result).toBe('allowed');
  });
});

describe('display group', () => {
  it('a member package can be listed under PT nhom and still checks in as member', async () => {
    const r = await request(app).post('/api/packages').set(hA('branch_manager')).send({
      name: `PTN ${uniq()}`, type: 'month', category: 'member', duration_days: 30, price: 1, branch_id: A, display_group: 'pt_group',
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ category: 'member', display_group: 'pt_group' });
    const keep = await request(app).patch(`/api/packages/${r.body.data.id}`).set(hA('branch_manager')).send({ active: true });
    expect(keep.body.data.display_group).toBe('pt_group');
  });
});

describe('contract list payment date', () => {
  it('returns last_paid_at from the latest confirmed payment', async () => {
    const m = await mkMember(A);
    const c = await mkContract(m.id, A, { status: 'active', total: 1000, paid: 500 });
    const when = new Date('2030-05-04T03:00:00Z');
    await prisma.payment.create({ data: { contractId: c.id, branchId: A, method: 'cash', amount: 500, status: 'confirmed', ref: `RF${uniq()}`, confirmedAt: when } });
    const r = await request(app).get(`/api/contracts?q=${c.code}`).set(hA('receptionist'));
    const row = r.body.data.find((x: { id: string }) => x.id === c.id);
    expect(new Date(row.last_paid_at).toISOString()).toBe(when.toISOString());
    const none = await mkContract(m.id, A, { status: 'active' });
    const r2 = await request(app).get(`/api/contracts?q=${none.code}`).set(hA('receptionist'));
    expect(r2.body.data.find((x: { id: string }) => x.id === none.id).last_paid_at).toBeNull();
  });
});
