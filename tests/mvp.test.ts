import crypto from 'crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { expireContracts } from '../src/modules/contracts/service';
import { assignRole } from '../src/modules/rbac/service';
import { app, branchId, login, makeUser, tokenFor } from './helpers';

type Role = 'super_admin' | 'owner' | 'branch_manager' | 'receptionist' | 'sales' | 'trainer' | 'accountant' | 'member';
const ROLES: Role[] = ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'trainer', 'accountant', 'member'];
const tokens = {} as Record<Role, string>;
const ids = {} as Record<Role, string>;
let nb: string;
let q7: string;
let iso: string;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${++seq}`;
const phone = () => `07${String(30000000 + ++seq + Math.floor(Math.random() * 1000) * 10000)}`;

const h = (r: Role, branch?: string) => ({ Authorization: `Bearer ${tokens[r]}`, 'X-Branch-Id': branch ?? nb });
const tok = (t: string, branch: string) => ({ Authorization: `Bearer ${t}`, 'X-Branch-Id': branch });
const today = () => dateOnly(todayVN());
const iso10 = (d: Date) => d.toISOString().slice(0, 10);

async function mkMember(branch = nb, status: 'active' | 'expired' | 'frozen' = 'active') {
  return prisma.member.create({ data: { code: `M${uniq()}`, name: `Member ${uniq()}`, phone: phone(), branchId: branch, status } });
}
async function mkPackage(branch = nb, o: { type?: 'month' | 'session'; price?: number; vat?: number; sessions?: number; days?: number } = {}) {
  const type = o.type ?? 'month';
  return prisma.package.create({
    data: {
      name: `Pkg ${uniq()}`,
      type,
      durationDays: type === 'month' ? (o.days ?? 30) : null,
      sessions: type === 'session' ? (o.sessions ?? 10) : null,
      price: o.price ?? 500000,
      vatPercent: o.vat ?? 0,
      branchId: branch,
    },
  });
}
async function seedContract(
  o: {
    status?: 'draft' | 'signed' | 'active' | 'frozen' | 'expired' | 'cancelled';
    total?: number;
    paid?: number;
    branch?: string;
    memberId?: string;
    type?: 'month' | 'session';
    sessions?: number;
    sessionsLeft?: number;
    end?: Date | null;
    start?: Date | null;
    frozenUntil?: Date | null;
  } = {},
) {
  const branch = o.branch ?? nb;
  const member = o.memberId ? await prisma.member.findUniqueOrThrow({ where: { id: o.memberId } }) : await mkMember(branch);
  const pkg = await mkPackage(branch, { type: o.type, sessions: o.sessions });
  const status = o.status ?? 'draft';
  const live = ['active', 'frozen', 'expired'].includes(status);
  const session = o.type === 'session';
  const c = await prisma.contract.create({
    data: {
      code: `T${uniq()}`,
      memberId: member.id,
      packageId: pkg.id,
      branchId: branch,
      status,
      totalAmount: o.total ?? 500000,
      paidAmount: o.paid ?? 0,
      durationDays: session ? null : 30,
      sessionsTotal: session ? (o.sessions ?? 10) : null,
      sessionsLeft: session ? (o.sessionsLeft ?? o.sessions ?? 10) : null,
      startDate: o.start !== undefined ? o.start : live ? today() : null,
      endDate: o.end !== undefined ? o.end : live && !session ? addDays(today(), 30) : null,
      frozenUntil: o.frozenUntil ?? null,
      signedAt: status === 'draft' ? null : new Date(),
      signatureData: status === 'draft' ? null : 'sig-text',
      activatedAt: live ? new Date() : null,
    },
  });
  return { contract: c, member, pkg };
}
async function seedPayment(contractId: string, o: { status?: 'pending' | 'confirmed'; amount?: number; method?: 'cash' | 'transfer' | 'vietqr' | 'ewallet'; branch?: string; ref?: string } = {}) {
  return prisma.payment.create({
    data: {
      contractId,
      branchId: o.branch ?? nb,
      method: o.method ?? 'transfer',
      amount: o.amount ?? 1000,
      status: o.status ?? 'pending',
      ref: o.ref ?? `REF${uniq()}`,
      confirmedAt: o.status === 'confirmed' ? new Date() : null,
    },
  });
}
async function closeOpenShifts(userId: string) {
  await prisma.shift.updateMany({ where: { userId, closedAt: null }, data: { closedAt: new Date(), openingCash: 0 } });
}
async function ensureShift(role: Role, branch = nb) {
  await closeOpenShifts(ids[role]);
  return prisma.shift.create({ data: { userId: ids[role], branchId: branch, openingCash: 100000 } });
}
const sign = (body: object, o: { ts?: number; secret?: string } = {}) => {
  const raw = JSON.stringify(body);
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', o.secret ?? 'test-webhook-secret').update(`${ts}.${raw}`).digest('hex');
  return request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('X-Timestamp', String(ts)).set('X-Signature', sig).send(raw);
};

beforeAll(async () => {
  nb = await branchId('nb');
  q7 = await branchId('q7');
  iso = (await prisma.branch.create({ data: { code: `iso${uniq()}`, name: 'Isolated' } })).id;
  for (const r of ROLES) {
    if (r === 'super_admin') {
      const res = await login('admin@test.local', 'AdminPass!2345');
      tokens[r] = res.body.data.access_token;
      ids[r] = res.body.data.user.id;
      continue;
    }
    const email = `${r}@mvp.test`;
    const u = await makeUser(email, r, r === 'owner' || r === 'accountant' ? null : 'nb');
    ids[r] = u.id;
    tokens[r] = await tokenFor(email);
  }
});

const matrix: { name: string; allowed: Role[]; viewOnly?: Role[]; call: (r: Role) => Promise<request.Response> }[] = [
  {
    name: 'POST /contracts',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales'],
    call: async (r) => {
      const m = await mkMember();
      const p = await mkPackage();
      return request(app).post('/api/contracts').set(h(r)).send({ member_id: m.id, package_id: p.id });
    },
  },
  { name: 'GET /contracts', allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'accountant'], call: async (r) => request(app).get('/api/contracts').set(h(r)) },
  {
    name: 'GET /contracts/:id',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'accountant'],
    call: async (r) => request(app).get(`/api/contracts/${(await seedContract()).contract.id}`).set(h(r)),
  },
  {
    name: 'GET /contracts/:id/pdf',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'accountant'],
    call: async (r) => request(app).get(`/api/contracts/${(await seedContract()).contract.id}/pdf`).set(h(r)),
  },
  {
    name: 'POST /contracts/:id/sign',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'],
    call: async (r) => request(app).post(`/api/contracts/${(await seedContract()).contract.id}/sign`).set(h(r)).send({ signature: 'abc-signature' }),
  },
  {
    name: 'POST /contracts/:id/activate',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'],
    call: async (r) => request(app).post(`/api/contracts/${(await seedContract({ status: 'signed', paid: 500000 })).contract.id}/activate`).set(h(r)).send({}),
  },
  {
    name: 'POST /contracts/:id/renew',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales'],
    call: async (r) => request(app).post(`/api/contracts/${(await seedContract({ status: 'active' })).contract.id}/renew`).set(h(r)).send({}),
  },
  {
    name: 'POST /contracts/:id/freeze',
    allowed: ['super_admin', 'owner', 'branch_manager'],
    call: async (r) => request(app).post(`/api/contracts/${(await seedContract({ status: 'active' })).contract.id}/freeze`).set(h(r)).send({ days: 5, reason: 'travel' }),
  },
  {
    name: 'POST /contracts/:id/unfreeze',
    allowed: ['super_admin', 'owner', 'branch_manager'],
    call: async (r) =>
      request(app).post(`/api/contracts/${(await seedContract({ status: 'frozen', frozenUntil: addDays(today(), 5) })).contract.id}/unfreeze`).set(h(r)).send({}),
  },
  {
    name: 'POST /contracts/:id/cancel',
    allowed: ['super_admin', 'owner', 'branch_manager'],
    call: async (r) => request(app).post(`/api/contracts/${(await seedContract({ status: 'active' })).contract.id}/cancel`).set(h(r)).send({ reason: 'customer request' }),
  },
  {
    name: 'POST /payments',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'],
    call: async (r) =>
      request(app).post('/api/payments').set(h(r)).send({ contract_id: (await seedContract({ status: 'signed' })).contract.id, method: 'transfer', amount: 1000 }),
  },
  { name: 'GET /payments', allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'accountant'], call: async (r) => request(app).get('/api/payments').set(h(r)) },
  {
    name: 'GET /payments/:id/qr',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'accountant'],
    call: async (r) => request(app).get(`/api/payments/${(await seedPayment((await seedContract({ status: 'signed' })).contract.id)).id}/qr`).set(h(r)),
  },
  {
    name: 'POST /payments/:id/confirm',
    allowed: ['super_admin', 'owner', 'branch_manager'],
    call: async (r) => request(app).post(`/api/payments/${(await seedPayment((await seedContract({ status: 'signed' })).contract.id)).id}/confirm`).set(h(r)).send({}),
  },
  {
    name: 'POST /payments/:id/refund-request',
    allowed: ['super_admin', 'owner', 'branch_manager'],
    call: async (r) => {
      const c = (await seedContract({ status: 'signed', paid: 1000 })).contract;
      return request(app).post(`/api/payments/${(await seedPayment(c.id, { status: 'confirmed' })).id}/refund-request`).set(h(r)).send({ reason: 'mistake' });
    },
  },
  {
    name: 'POST /payments/:id/refund',
    allowed: ['super_admin', 'owner'],
    call: async (r) => {
      const c = (await seedContract({ status: 'signed', paid: 1000 })).contract;
      return request(app).post(`/api/payments/${(await seedPayment(c.id, { status: 'confirmed' })).id}/refund`).set(h(r)).send({ reason: 'mistake' });
    },
  },
  {
    name: 'POST /shifts/open',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'],
    call: async (r) => {
      await closeOpenShifts(ids[r]);
      return request(app).post('/api/shifts/open').set(h(r)).send({ opening_cash: 100000 });
    },
  },
  {
    name: 'GET /shifts/current',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'],
    call: async (r) => request(app).get('/api/shifts/current').set(h(r)),
  },
  {
    name: 'POST /shifts/:id/close',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'],
    call: async (r) => {
      const s = (['super_admin', 'owner', 'branch_manager', 'receptionist'] as Role[]).includes(r) ? await ensureShift(r) : null;
      return request(app).post(`/api/shifts/${s?.id ?? crypto.randomUUID()}/close`).set(h(r)).send({ counted_cash: 100000 });
    },
  },
  {
    name: 'POST /checkins',
    allowed: ['branch_manager', 'receptionist'],
    viewOnly: ['super_admin', 'owner'],
    call: async (r) => request(app).post('/api/checkins').set(h(r)).send({ member_id: (await mkMember()).id }),
  },
  {
    name: 'POST /checkins/:id/checkout',
    allowed: ['branch_manager', 'receptionist'],
    viewOnly: ['super_admin', 'owner'],
    call: async (r) => {
      const m = await mkMember();
      const c = await prisma.checkin.create({ data: { memberId: m.id, branchId: nb, result: 'allowed' } });
      return request(app).post(`/api/checkins/${c.id}/checkout`).set(h(r)).send({});
    },
  },
  { name: 'GET /checkins', allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'], call: async (r) => request(app).get('/api/checkins').set(h(r)) },
  { name: 'GET /checkins/live', allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'], call: async (r) => request(app).get('/api/checkins/live').set(h(r)) },
  {
    name: 'POST /checkins/override',
    allowed: ['branch_manager'],
    viewOnly: ['super_admin', 'owner'],
    call: async (r) => request(app).post('/api/checkins/override').set(h(r)).send({ member_id: (await mkMember()).id, reason: 'manager approved' }),
  },
  { name: 'GET /reports/dashboard', allowed: ['super_admin', 'owner', 'branch_manager'], call: async (r) => request(app).get('/api/reports/dashboard').set(h(r)) },
  {
    name: 'GET /reports/daily-closing',
    allowed: ['super_admin', 'owner', 'branch_manager', 'accountant'],
    call: async (r) => request(app).get('/api/reports/daily-closing').set(h(r)),
  },
  { name: 'GET /roles', allowed: ['super_admin', 'owner'], call: async (r) => request(app).get('/api/roles').set(h(r)) },
  { name: 'GET /permissions', allowed: ['super_admin', 'owner'], call: async (r) => request(app).get('/api/permissions').set(h(r)) },
  { name: 'GET /users', allowed: ['super_admin', 'owner'], call: async (r) => request(app).get('/api/users').set(h(r)) },
  {
    name: 'POST /users/:id/roles',
    allowed: ['super_admin', 'owner'],
    call: async (r) => {
      const u = await makeUser(`tgt${uniq()}@mvp.test`, 'member', null);
      return request(app).post(`/api/users/${u.id}/roles`).set(h(r)).send({ role: 'receptionist', branch_id: nb });
    },
  },
  {
    name: 'DELETE /users/:id/roles/:urId',
    allowed: ['super_admin', 'owner'],
    call: async (r) => {
      const u = await makeUser(`del${uniq()}@mvp.test`, 'member', null);
      await assignRole(u.id, 'receptionist', nb);
      const ur = await prisma.userRole.findFirstOrThrow({ where: { userId: u.id, role: { key: 'receptionist' } } });
      return request(app).delete(`/api/users/${u.id}/roles/${ur.id}`).set(h(r));
    },
  },
  { name: 'GET /audit-logs', allowed: ['super_admin', 'owner'], call: async (r) => request(app).get('/api/audit-logs').set(h(r)) },
];

describe('role x endpoint matrix (MVP)', () => {
  for (const row of matrix) {
    describe(row.name, () => {
      for (const role of ROLES) {
        const allowed = row.allowed.includes(role);
        const viewOnly = row.viewOnly?.includes(role);
        it(`${role} -> ${allowed ? '2xx' : '403'}`, async () => {
          const before = await prisma.accessAudit.count({ where: { actorId: ids[role], action: 'permission.checked.denied' } });
          const res = await row.call(role);
          if (allowed) {
            expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
            expect(res.status).toBeLessThan(300);
          } else if (viewOnly) {
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('VIEW_ONLY');
          } else {
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
            expect(await prisma.accessAudit.count({ where: { actorId: ids[role], action: 'permission.checked.denied' } })).toBe(before + 1);
          }
        });
      }
    });
  }

  it('unauthenticated MVP writes get 401', async () => {
    for (const p of ['/api/contracts', '/api/payments', '/api/shifts/open', '/api/checkins']) {
      expect((await request(app).post(p).send({})).status).toBe(401);
    }
  });
});

describe('MVP journey', () => {
  it('member -> contract -> pay -> activate -> check-in -> close shift', async () => {
    const m = await request(app).post('/api/members').set(h('receptionist')).send({ name: 'Journey Member', phone: phone() });
    const pkg = await request(app)
      .post('/api/packages')
      .set(h('branch_manager'))
      .send({ name: 'Journey Pkg', type: 'month', duration_days: 30, price: 500000, vat_percent: 10 });
    expect(pkg.status).toBe(201);
    const created = await request(app).post('/api/contracts').set(h('receptionist')).send({ member_id: m.body.data.id, package_id: pkg.body.data.id, discount: 50000, note: 'x' });
    expect(created.status).toBe(201);
    const c = created.body.data;
    expect(c).toMatchObject({ status: 'draft', total_amount: 500000, discount: 50000, paid_amount: 0, debt_amount: 500000, branch_id: nb });
    expect(c.code).toMatch(/^CT\d+$/);

    expect((await request(app).post(`/api/contracts/${c.id}/activate`).set(h('receptionist')).send({})).body.error.code).toBe('INVALID_STATE');
    const signed = await request(app).post(`/api/contracts/${c.id}/sign`).set(h('receptionist')).send({ signature: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(signed.body.data.status).toBe('signed');
    expect((await request(app).post(`/api/contracts/${c.id}/sign`).set(h('receptionist')).send({ signature: 'again' })).status).toBe(409);

    const unpaid = await request(app).post(`/api/contracts/${c.id}/activate`).set(h('receptionist')).send({});
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.error.code).toBe('PAYMENT_REQUIRED');

    const noShift = await request(app).post('/api/payments').set(h('receptionist')).send({ contract_id: c.id, method: 'cash', amount: 200000 });
    expect(noShift.status).toBe(409);
    expect(noShift.body.error.code).toBe('SHIFT_REQUIRED');

    await closeOpenShifts(ids.receptionist);
    const shift = await request(app).post('/api/shifts/open').set(h('receptionist')).send({ opening_cash: 100000 });
    expect(shift.status).toBe(201);
    expect((await request(app).post('/api/shifts/open').set(h('receptionist')).send({ opening_cash: 1 })).body.error.code).toBe('SHIFT_ALREADY_OPEN');
    expect((await request(app).get('/api/shifts/current').set(h('receptionist'))).body.data.id).toBe(shift.body.data.id);

    const cash = await request(app).post('/api/payments').set(h('receptionist')).send({ contract_id: c.id, method: 'cash', amount: 200000 });
    expect(cash.status).toBe(201);
    expect(cash.body.data).toMatchObject({ status: 'confirmed', shift_id: shift.body.data.id });
    expect(Object.keys(cash.body.data)).toEqual(expect.arrayContaining(['id', 'contract_id', 'method', 'amount', 'status', 'ref', 'shift_id', 'note', 'created_by', 'created_at', 'confirmed_at']));

    const tooMuch = await request(app).post('/api/payments').set(h('receptionist')).send({ contract_id: c.id, method: 'transfer', amount: 300001 });
    expect(tooMuch.status).toBe(400);
    expect((await request(app).post('/api/payments').set(h('receptionist')).send({ contract_id: c.id, method: 'transfer', amount: 0 })).status).toBe(400);

    const qrPay = await request(app).post('/api/payments').set(h('receptionist')).send({ contract_id: c.id, method: 'vietqr', amount: 300000 });
    expect(qrPay.body.data.status).toBe('pending');
    expect(qrPay.body.data.ref).toMatch(/^GH[0-9A-F]{10}$/);
    const qr = await request(app).get(`/api/payments/${qrPay.body.data.id}/qr`).set(h('receptionist'));
    expect(qr.status).toBe(200);
    expect(qr.body.data).toMatchObject({ transfer_content: qrPay.body.data.ref, amount: 300000 });
    expect(qr.body.data.qr_url).toContain('https://img.vietqr.io/image/970436-0123456789-compact2.png?');
    expect(qr.body.data.qr_url).toContain(`addInfo=${qrPay.body.data.ref}`);

    const mid = await request(app).get(`/api/contracts/${c.id}`).set(h('receptionist'));
    expect(mid.body.data).toMatchObject({ paid_amount: 200000, debt_amount: 300000 });
    expect(mid.body.data.payments).toHaveLength(2);
    expect(mid.body.data.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['created', 'signed', 'payment_confirmed', 'payment_created']));
    expect(mid.body.data.member.name).toBe('Journey Member');
    expect((await request(app).post(`/api/contracts/${c.id}/activate`).set(h('receptionist')).send({})).body.error.code).toBe('PAYMENT_REQUIRED');

    expect((await request(app).post(`/api/payments/${qrPay.body.data.id}/confirm`).set(h('branch_manager')).send({})).body.data.status).toBe('confirmed');
    const act = await request(app).post(`/api/contracts/${c.id}/activate`).set(h('receptionist')).send({});
    expect(act.status).toBe(200);
    expect(act.body.data).toMatchObject({ status: 'active', paid_amount: 500000, debt_amount: 0, start_date: todayVN(), end_date: iso10(addDays(today(), 30)) });
    expect((await request(app).get(`/api/members/${m.body.data.id}`).set(h('receptionist'))).body.data.status).toBe('active');

    const ci = await request(app).post('/api/checkins').set(h('receptionist')).send({ member_code: m.body.data.code });
    expect(ci.status).toBe(200);
    expect(ci.body.data).toMatchObject({ result: 'allowed', reason: null });
    expect(ci.body.data.member.id).toBe(m.body.data.id);

    const pdf = await request(app).get(`/api/contracts/${c.id}/pdf`).set(h('receptionist')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const close = await request(app).post(`/api/shifts/${shift.body.data.id}/close`).set(h('receptionist')).send({ counted_cash: 290000 });
    expect(close.status).toBe(200);
    expect(close.body.data).toMatchObject({ opening_cash: 100000, expected_cash: 300000, counted_cash: 290000, difference: -10000, status: 'closed' });
    expect(close.body.data.totals_by_method).toMatchObject({ cash: 200000, vietqr: 300000 });
    expect((await request(app).post(`/api/shifts/${shift.body.data.id}/close`).set(h('receptionist')).send({ counted_cash: 1 })).status).toBe(409);
    await expect(prisma.shift.update({ where: { id: shift.body.data.id }, data: { countedCash: 1 } })).rejects.toThrow();

    const types = (await prisma.accessAudit.findMany({ where: { actorId: ids.receptionist } })).map((a) => a.action);
    expect(types).toEqual(expect.arrayContaining(['contract.created', 'contract.signed', 'contract.activated', 'payment.created', 'shift.opened', 'shift.closed']));
  });

  it('contract snapshot rules and validation', async () => {
    const m = await mkMember();
    const other = await mkPackage(q7);
    const p = await mkPackage();
    const bad = await request(app).post('/api/contracts').set(h('owner')).send({ member_id: m.id, package_id: other.id });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('BRANCH_MISMATCH');
    expect((await request(app).post('/api/contracts').set(h('owner')).send({ member_id: m.id, package_id: p.id, discount: 600000 })).status).toBe(400);
    const sp = await mkPackage(nb, { type: 'session', sessions: 12 });
    const s = await request(app).post('/api/contracts').set(h('owner')).send({ member_id: m.id, package_id: sp.id });
    expect(s.body.data).toMatchObject({ sessions_total: 12, sessions_left: 12 });
    expect((await request(app).post('/api/contracts').set(h('owner')).send({ member_id: crypto.randomUUID(), package_id: p.id })).status).toBe(404);
  });
});

describe('contract lifecycle', () => {
  it('allow_debt needs contracts.approve', async () => {
    const { contract } = await seedContract({ status: 'signed', paid: 100000 });
    const r = await request(app).post(`/api/contracts/${contract.id}/activate`).set(h('receptionist')).send({ allow_debt: true });
    expect(r.status).toBe(403);
    expect(await prisma.accessAudit.count({ where: { actorId: ids.receptionist, action: 'permission.checked.denied', metadata: { path: ['permission'], equals: 'contracts.approve' } } })).toBeGreaterThan(0);
    const ok = await request(app).post(`/api/contracts/${contract.id}/activate`).set(h('branch_manager')).send({ allow_debt: true, start_date: iso10(addDays(today(), 2)) });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'active', debt_amount: 400000, start_date: iso10(addDays(today(), 2)), end_date: iso10(addDays(today(), 32)) });
  });

  it('renew, freeze, unfreeze, cancel and invalid transitions', async () => {
    const { contract, member } = await seedContract({ status: 'active' });
    const renew = await request(app).post(`/api/contracts/${contract.id}/renew`).set(h('receptionist')).send({});
    expect(renew.status).toBe(201);
    expect(renew.body.data).toMatchObject({ status: 'draft', renewed_from_id: contract.id, start_date: iso10(contract.endDate!), member_id: member.id });
    expect((await request(app).post(`/api/contracts/${renew.body.data.id}/renew`).set(h('receptionist')).send({})).body.error.code).toBe('INVALID_STATE');

    const fr = await request(app).post(`/api/contracts/${contract.id}/freeze`).set(h('branch_manager')).send({ days: 10, reason: 'injury' });
    expect(fr.body.data).toMatchObject({ status: 'frozen', end_date: iso10(addDays(contract.endDate!, 10)), frozen_until: iso10(addDays(today(), 10)) });
    expect((await prisma.member.findUniqueOrThrow({ where: { id: member.id } })).status).toBe('frozen');
    expect((await request(app).post(`/api/contracts/${contract.id}/freeze`).set(h('branch_manager')).send({ days: 1, reason: 'x' })).status).toBe(409);
    const chk = await request(app).post('/api/checkins').set(h('receptionist')).send({ member_id: member.id });
    expect(chk.body.data).toMatchObject({ result: 'denied', reason: 'FROZEN' });

    const un = await request(app).post(`/api/contracts/${contract.id}/unfreeze`).set(h('branch_manager')).send({});
    expect(un.body.data).toMatchObject({ status: 'active', end_date: iso10(contract.endDate!), frozen_until: null });
    expect((await prisma.member.findUniqueOrThrow({ where: { id: member.id } })).status).toBe('active');
    expect((await request(app).post(`/api/contracts/${contract.id}/unfreeze`).set(h('branch_manager')).send({})).body.error.code).toBe('INVALID_STATE');

    expect((await request(app).post(`/api/contracts/${contract.id}/cancel`).set(h('branch_manager')).send({})).status).toBe(400);
    const cn = await request(app).post(`/api/contracts/${contract.id}/cancel`).set(h('branch_manager')).send({ reason: 'moved away' });
    expect(cn.body.data.status).toBe('cancelled');
    expect((await request(app).post(`/api/contracts/${contract.id}/cancel`).set(h('branch_manager')).send({ reason: 'again' })).body.error.code).toBe('INVALID_STATE');

    const detail = await request(app).get(`/api/contracts/${contract.id}`).set(h('branch_manager'));
    expect(detail.body.data.events.map((e: { type: string }) => e.type)).toEqual(['renewed', 'frozen', 'unfrozen', 'cancelled']);
    expect(detail.body.data.events[3]).toMatchObject({ reason: 'moved away' });
  });

  it('contract_events is append-only', async () => {
    const { contract } = await seedContract({ status: 'signed' });
    const ev = await prisma.contractEvent.create({ data: { contractId: contract.id, type: 'note' } });
    await expect(prisma.contractEvent.update({ where: { id: ev.id }, data: { type: 'x' } })).rejects.toThrow();
    await expect(prisma.contractEvent.delete({ where: { id: ev.id } })).rejects.toThrow();
  });

  it('expireContracts marks past-end contracts and syncs member status', async () => {
    const a = await seedContract({ status: 'active', end: addDays(today(), -1) });
    const b = await seedContract({ status: 'active', end: addDays(today(), -2) });
    await seedContract({ status: 'active', memberId: b.member.id });
    const r = await expireContracts();
    expect(r.expired).toBeGreaterThanOrEqual(2);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: a.contract.id } })).status).toBe('expired');
    expect((await prisma.member.findUniqueOrThrow({ where: { id: a.member.id } })).status).toBe('expired');
    expect((await prisma.member.findUniqueOrThrow({ where: { id: b.member.id } })).status).toBe('active');
    expect(await prisma.contractEvent.count({ where: { contractId: a.contract.id, type: 'expired' } })).toBe(1);
    expect((await expireContracts()).expired).toBe(0);
  });

  it('list filters: status, member, q and expiring_within_days', async () => {
    const soon = await seedContract({ status: 'active', end: addDays(today(), 3) });
    await seedContract({ status: 'active', end: addDays(today(), 40) });
    const exp = await request(app).get('/api/contracts').set(h('branch_manager')).query({ expiring_within_days: 7, limit: 100 });
    expect(exp.body.data.map((c: { id: string }) => c.id)).toContain(soon.contract.id);
    expect(exp.body.data.every((c: { status: string }) => c.status === 'active')).toBe(true);
    const byMember = await request(app).get('/api/contracts').set(h('branch_manager')).query({ member_id: soon.member.id });
    expect(byMember.body.data).toHaveLength(1);
    expect(byMember.body.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
    const byQ = await request(app).get('/api/contracts').set(h('branch_manager')).query({ q: soon.member.phone, status: 'active' });
    expect(byQ.body.data).toHaveLength(1);
    expect(byQ.body.data[0].member).toMatchObject({ id: soon.member.id, phone: soon.member.phone });
  });
});

describe('payments', () => {
  it('duplicate ref is idempotent for the same payload and 409 otherwise', async () => {
    const { contract } = await seedContract({ status: 'signed' });
    const ref = `IDEM${uniq()}`;
    const body = { contract_id: contract.id, method: 'transfer', amount: 10000, ref };
    const a = await request(app).post('/api/payments').set(h('receptionist')).send(body);
    expect(a.status).toBe(201);
    const b = await request(app).post('/api/payments').set(h('receptionist')).send(body);
    expect(b.status).toBe(200);
    expect(b.body.data.id).toBe(a.body.data.id);
    const c = await request(app).post('/api/payments').set(h('receptionist')).send({ ...body, amount: 20000 });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('DUPLICATE_PAYMENT');
    expect(await prisma.payment.count({ where: { ref } })).toBe(1);
    const race = await Promise.all([1, 2, 3].map(() => request(app).post('/api/payments').set(h('receptionist')).send({ ...body, ref: `${ref}R` })));
    expect(race.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await prisma.payment.count({ where: { ref: `${ref}R` } })).toBe(1);
  });

  it('concurrent confirms count a payment once', async () => {
    const { contract } = await seedContract({ status: 'signed' });
    const p = await seedPayment(contract.id, { amount: 123000 });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => request(app).post(`/api/payments/${p.id}/confirm`).set(h('branch_manager')).send({})));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(c.paidAmount).toBe(123000);
    expect(await prisma.contractEvent.count({ where: { contractId: contract.id, type: 'payment_confirmed' } })).toBe(1);
  });

  it('pending and failed payments never count as paid; confirm cannot overpay', async () => {
    const { contract } = await seedContract({ status: 'signed', total: 100000 });
    const a = await seedPayment(contract.id, { amount: 80000, method: 'vietqr' });
    const b = await seedPayment(contract.id, { amount: 80000, method: 'transfer' });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).paidAmount).toBe(0);
    expect((await request(app).post(`/api/contracts/${contract.id}/activate`).set(h('receptionist')).send({})).status).toBe(409);
    expect((await request(app).post(`/api/payments/${a.id}/confirm`).set(h('branch_manager')).send({})).status).toBe(200);
    const over = await request(app).post(`/api/payments/${b.id}/confirm`).set(h('branch_manager')).send({});
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('AMOUNT_EXCEEDS_DEBT');
    expect((await request(app).get(`/api/payments/${a.id}/qr`).set(h('receptionist'))).status).toBe(409);
  });

  it('refund request and refund flow updates paid_amount', async () => {
    const { contract } = await seedContract({ status: 'signed' });
    const created = await request(app).post('/api/payments').set(h('branch_manager')).send({ contract_id: contract.id, method: 'ewallet', amount: 50000 });
    await request(app).post(`/api/payments/${created.body.data.id}/confirm`).set(h('branch_manager')).send({});
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).paidAmount).toBe(50000);
    const rr = await request(app).post(`/api/payments/${created.body.data.id}/refund-request`).set(h('branch_manager')).send({ reason: 'double charge' });
    expect(rr.status).toBe(200);
    expect((await request(app).post(`/api/payments/${created.body.data.id}/refund-request`).set(h('branch_manager')).send({ reason: 'again' })).status).toBe(409);
    const rf = await request(app).post(`/api/payments/${created.body.data.id}/refund`).set(h('owner')).send({});
    expect(rf.body.data.status).toBe('refunded');
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).paidAmount).toBe(0);
    expect((await request(app).post(`/api/payments/${created.body.data.id}/refund`).set(h('owner')).send({})).status).toBe(409);
    const list = await request(app).get('/api/payments').set(h('accountant')).query({ contract_id: contract.id, status: 'refunded' });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.total).toBe(1);
  });
});

describe('payment webhook', () => {
  it('confirms once, ignores replays, rejects bad signatures and stale timestamps', async () => {
    const { contract } = await seedContract({ status: 'signed', total: 70000 });
    const p = await seedPayment(contract.id, { amount: 70000, method: 'vietqr', ref: `WH${uniq()}` });
    const body = { ref: p.ref, amount: 70000, status: 'paid' };
    const before = await prisma.paymentWebhookDelivery.count();

    expect((await request(app).post('/api/payments/webhook').send(body)).status).toBe(401);
    expect((await sign(body, { secret: 'wrong-secret' })).status).toBe(401);
    const stale = await sign(body, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('STALE_TIMESTAMP');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('pending');
    expect((await sign({ ...body, amount: 1 })).status).toBe(400);

    const ok = await sign(body);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ ref: p.ref, status: 'confirmed', replay: false });
    const replay = await sign(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.replay).toBe(true);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).paidAmount).toBe(70000);
    expect(await prisma.contractEvent.count({ where: { contractId: contract.id, type: 'payment_confirmed' } })).toBe(1);
    expect((await sign({ ref: 'NOPE-NOPE', amount: 1, status: 'paid' })).status).toBe(404);
    expect(await prisma.paymentWebhookDelivery.count()).toBeGreaterThanOrEqual(before + 7);
    expect(await prisma.paymentWebhookDelivery.count({ where: { ref: p.ref, signatureOk: true } })).toBe(3);
  });

  it('failed webhook marks pending payment failed and never counts it', async () => {
    const { contract } = await seedContract({ status: 'signed' });
    const p = await seedPayment(contract.id, { amount: 5000, method: 'transfer', ref: `WF${uniq()}` });
    const r = await sign({ ref: p.ref, amount: 5000, status: 'failed' });
    expect(r.body.data.status).toBe('failed');
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).paidAmount).toBe(0);
    expect((await request(app).post(`/api/payments/${p.id}/confirm`).set(h('branch_manager')).send({})).status).toBe(409);
  });
});

describe('check-in', () => {
  it('deducts a session once per day per contract', async () => {
    const { contract, member } = await seedContract({ status: 'active', type: 'session', sessions: 5 });
    const a = await request(app).post('/api/checkins').set(h('receptionist')).send({ member_id: member.id });
    expect(a.body.data.result).toBe('allowed');
    expect(a.body.data.contract.sessions_left).toBe(4);
    const again = await request(app).post('/api/checkins').set(h('receptionist')).send({ member_id: member.id });
    expect(again.body.data.checkin_id).toBe(a.body.data.checkin_id);
    await request(app).post(`/api/checkins/${a.body.data.checkin_id}/checkout`).set(h('receptionist')).send({});
    const second = await request(app).post('/api/checkins').set(h('receptionist')).send({ member_id: member.id });
    expect(second.body.data.result).toBe('allowed');
    expect(second.body.data.checkin_id).not.toBe(a.body.data.checkin_id);
    expect(second.body.data.contract.sessions_left).toBe(4);
    const par = await Promise.all([1, 2, 3].map(() => request(app).post('/api/checkins').set(h('receptionist')).send({ member_id: member.id })));
    expect(par.every((r) => r.body.data.result === 'allowed')).toBe(true);
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(c.sessionsLeft).toBe(4);
    expect(await prisma.checkin.count({ where: { contractId: contract.id, deducted: true } })).toBe(1);
  });

  it('denial reasons are returned as 200 and logged', async () => {
    const none = await mkMember();
    const expiredStatus = await seedContract({ status: 'expired', end: addDays(today(), -5) });
    const pastEnd = await seedContract({ status: 'active', end: addDays(today(), -1) });
    const frozen = await seedContract({ status: 'frozen', frozenUntil: addDays(today(), 5) });
    const empty = await seedContract({ status: 'active', type: 'session', sessions: 3, sessionsLeft: 0 });
    const foreign = await mkMember(q7);
    await seedContract({ status: 'active', branch: q7, memberId: foreign.id });
    const cases: [string, string][] = [
      [none.id, 'NO_ACTIVE_CONTRACT'],
      [expiredStatus.member.id, 'EXPIRED'],
      [pastEnd.member.id, 'EXPIRED'],
      [frozen.member.id, 'FROZEN'],
      [empty.member.id, 'NO_SESSIONS'],
      [foreign.id, 'WRONG_BRANCH'],
    ];
    for (const [memberId, reason] of cases) {
      const r = await request(app).post('/api/checkins').set(h('receptionist')).send({ member_id: memberId });
      expect(r.status, reason).toBe(200);
      expect(r.body.data).toMatchObject({ result: 'denied', reason });
      expect(await prisma.checkin.count({ where: { memberId, result: 'denied', reason } })).toBe(1);
    }
    const list = await request(app).get('/api/checkins').set(h('receptionist')).query({ result: 'denied', date: todayVN(), limit: 100 });
    expect(list.body.data.length).toBeGreaterThanOrEqual(5);
    expect(list.body.data.every((c: { result: string }) => c.result === 'denied')).toBe(true);
    expect((await request(app).post('/api/checkins').set(h('receptionist')).send({ member_code: 'NOPE-CODE' })).status).toBe(404);
    expect((await request(app).post('/api/checkins').set(h('receptionist')).send({})).status).toBe(400);
  });

  it('manual override records approver and reason; live list tracks who is inside', async () => {
    const m = await mkMember(iso);
    const mgr = await makeUser(`mgr${uniq()}@mvp.test`, 'branch_manager', null);
    await assignRole(mgr.id, 'branch_manager', iso);
    const t = await tokenFor((await prisma.user.findUniqueOrThrow({ where: { id: mgr.id } })).email);
    const rec = await makeUser(`rec${uniq()}@mvp.test`, 'receptionist', null);
    await assignRole(rec.id, 'receptionist', iso);
    const rt = await tokenFor(rec.email);
    expect((await request(app).post('/api/checkins').set(tok(rt, iso)).send({ member_id: m.id })).body.data.reason).toBe('NO_ACTIVE_CONTRACT');
    expect((await request(app).post('/api/checkins/override').set(tok(rt, iso)).send({ member_id: m.id, reason: 'boss said so' })).status).toBe(403);
    const ov = await request(app).post('/api/checkins/override').set(tok(t, iso)).send({ member_id: m.id, reason: 'forgot card, verified ID' });
    expect(ov.status).toBe(200);
    expect(ov.body.data).toMatchObject({ result: 'allowed', reason: 'forgot card, verified ID' });
    const row = await prisma.checkin.findUniqueOrThrow({ where: { id: ov.body.data.checkin_id } });
    expect(row).toMatchObject({ overrideBy: mgr.id, reason: 'forgot card, verified ID', result: 'allowed' });
    const live = await request(app).get('/api/checkins/live').set(tok(t, iso));
    expect(live.body.data.count).toBe(1);
    expect(live.body.data.items[0].member.id).toBe(m.id);
    await request(app).post(`/api/checkins/${ov.body.data.checkin_id}/checkout`).set(tok(rt, iso)).send({});
    expect((await request(app).get('/api/checkins/live').set(tok(t, iso))).body.data.count).toBe(0);
    expect(await prisma.accessAudit.count({ where: { actorId: mgr.id, action: 'checkin.override' } })).toBe(1);
  });
});

describe('shifts, daily closing and dashboard (isolated branch)', () => {
  let rt: string;
  let mt: string;
  let recId: string;
  let shiftId: string;
  const cashRefs: string[] = [];

  beforeAll(async () => {
    const rec = await makeUser(`isorec${uniq()}@mvp.test`, 'receptionist', null);
    await assignRole(rec.id, 'receptionist', iso);
    recId = rec.id;
    rt = await tokenFor(rec.email);
    const mgr = await makeUser(`isomgr${uniq()}@mvp.test`, 'branch_manager', null);
    await assignRole(mgr.id, 'branch_manager', iso);
    mt = await tokenFor(mgr.email);
  });

  it('close totals equal the sum of the shift payments', async () => {
    const open = await request(app).post('/api/shifts/open').set(tok(rt, iso)).send({ opening_cash: 100000 });
    expect(open.status).toBe(201);
    shiftId = open.body.data.id;
    const a = await seedContract({ status: 'signed', total: 200000, branch: iso });
    const b = await seedContract({ status: 'signed', total: 90000, branch: iso });
    const pay = async (cid: string, method: string, amount: number) => {
      const r = await request(app).post('/api/payments').set(tok(rt, iso)).send({ contract_id: cid, method, amount });
      expect(r.status).toBe(201);
      return r.body.data;
    };
    const c1 = await pay(a.contract.id, 'cash', 30000);
    cashRefs.push(c1.id);
    await pay(a.contract.id, 'cash', 45000);
    const t1 = await pay(b.contract.id, 'transfer', 20000);
    await pay(b.contract.id, 'vietqr', 7000);
    await request(app).post(`/api/payments/${t1.id}/confirm`).set(tok(mt, iso)).send({});

    const listed = await request(app).get('/api/payments').set(tok(rt, iso)).query({ shift_id: shiftId, status: 'confirmed', limit: 100 });
    const sum = (m: string) => listed.body.data.filter((p: { method: string }) => p.method === m).reduce((s: number, p: { amount: number }) => s + p.amount, 0);

    const close = await request(app).post(`/api/shifts/${shiftId}/close`).set(tok(rt, iso)).send({ counted_cash: 175000 });
    expect(close.status).toBe(200);
    expect(close.body.data.totals_by_method).toEqual({ cash: sum('cash'), transfer: sum('transfer'), vietqr: sum('vietqr'), ewallet: sum('ewallet') });
    expect(close.body.data).toMatchObject({ expected_cash: 100000 + 75000, difference: 0, counted_cash: 175000 });
    expect(close.body.data.totals_by_method).toMatchObject({ cash: 75000, transfer: 20000, vietqr: 0 });
    expect((await request(app).get('/api/shifts/current').set(tok(rt, iso))).body.data).toBeNull();
    expect((await request(app).post(`/api/shifts/${shiftId}/close`).set(tok(mt, iso)).send({ counted_cash: 1 })).status).toBe(404);
    expect(recId).toBeTruthy();
  });

  it('cash refunds reduce the refunding shift expected cash', async () => {
    const own = await request(app).post('/api/shifts/open').set(tok(mt, iso)).send({ opening_cash: 50000 });
    expect(own.status).toBe(201);
    const refundTarget = await prisma.payment.findUniqueOrThrow({ where: { id: cashRefs[0] } });
    const owner = await request(app).post(`/api/payments/${refundTarget.id}/refund`).set(tok(mt, iso)).send({});
    expect(owner.status).toBe(403);
    const ownerShift = await ensureShift('owner', iso);
    const rf = await request(app).post(`/api/payments/${refundTarget.id}/refund`).set(h('owner', iso)).send({ reason: 'customer left' });
    expect(rf.status).toBe(200);
    const close = await request(app).post(`/api/shifts/${ownerShift.id}/close`).set(h('owner', iso)).send({ counted_cash: 70000 });
    expect(close.body.data).toMatchObject({ opening_cash: 100000, expected_cash: 100000 - 30000, difference: 0, cash_refunds: 30000 });
  });

  it('daily closing equals the sum of listed transactions; dashboard matches', async () => {
    const dc = await request(app).get('/api/reports/daily-closing').set(tok(mt, iso)).query({ date: todayVN() });
    expect(dc.status).toBe(200);
    const d = dc.body.data;
    expect(d.transactions.every((t: { status: string }) => t.status === 'confirmed')).toBe(true);
    for (const m of ['cash', 'transfer', 'vietqr', 'ewallet']) {
      const s = d.transactions.filter((t: { method: string }) => t.method === m).reduce((x: number, t: { amount: number }) => x + t.amount, 0);
      expect(d.by_method[m], m).toBe(s);
    }
    expect(d.total).toBe(d.transactions.reduce((x: number, t: { amount: number }) => x + t.amount, 0));
    expect(d.by_method).toMatchObject({ cash: 45000, transfer: 20000 });
    expect(d.total).toBe(65000);

    const acc = await request(app).get('/api/reports/daily-closing').set(h('accountant', iso)).query({ date: todayVN() });
    expect(acc.body.data.total).toBe(65000);

    const dash = await request(app).get('/api/reports/dashboard').set(tok(mt, iso));
    expect(dash.status).toBe(200);
    const x = dash.body.data;
    expect(x.revenue_today).toBe(65000);
    expect(x.revenue_by_method).toEqual({ cash: 45000, transfer: 20000, vietqr: 0, ewallet: 0 });
    expect(x.revenue_7d).toHaveLength(7);
    expect(x.revenue_7d[6]).toEqual({ date: todayVN(), amount: 65000 });
    expect(x.new_contracts_today).toBe(2);
    expect(x.debt_total).toBe(200000 - 45000 + (90000 - 20000));
    for (const k of ['active_members', 'expiring_in_7_days', 'checkins_today', 'denied_today', 'inside_now']) expect(typeof x[k]).toBe('number');
    const past = await request(app).get('/api/reports/dashboard').set(tok(mt, iso)).query({ date: iso10(addDays(today(), -3)) });
    expect(past.body.data.revenue_today).toBe(0);
  });
});

describe('cross-branch isolation', () => {
  it('branch-bound staff cannot see or touch another branch', async () => {
    const { contract, member } = await seedContract({ status: 'active', branch: q7 });
    const pay = await seedPayment(contract.id, { branch: q7 });
    const t = { Authorization: `Bearer ${tokens.receptionist}` };
    expect((await request(app).get(`/api/contracts/${contract.id}`).set(t)).status).toBe(404);
    expect((await request(app).get(`/api/contracts/${contract.id}/pdf`).set(t)).status).toBe(404);
    expect((await request(app).get('/api/contracts').set(t).query({ member_id: member.id })).body.data).toHaveLength(0);
    expect((await request(app).get('/api/contracts').set({ ...t, 'X-Branch-Id': q7 })).status).toBe(403);
    expect((await request(app).post(`/api/contracts/${contract.id}/sign`).set(t).send({ signature: 'xxxx' })).status).toBe(404);
    expect((await request(app).post('/api/payments').set(t).send({ contract_id: contract.id, method: 'transfer', amount: 100 })).status).toBe(404);
    expect((await request(app).get(`/api/payments/${pay.id}/qr`).set(t)).status).toBe(404);
    expect((await request(app).post(`/api/payments/${pay.id}/confirm`).set(h('branch_manager'))).status).toBe(404);
    expect((await request(app).get('/api/payments').set(t).query({ contract_id: contract.id })).body.data).toHaveLength(0);
    expect((await request(app).post('/api/contracts').set(t).send({ member_id: member.id, package_id: contract.packageId })).status).toBe(404);
    expect((await request(app).post('/api/checkins/override').set(h('branch_manager')).send({ member_id: member.id, reason: 'nope nope' })).status).toBe(404);
    expect((await request(app).get('/api/reports/dashboard').set({ ...h('branch_manager'), 'X-Branch-Id': q7 })).status).toBe(403);
    const owner = await request(app).get(`/api/contracts/${contract.id}`).set({ Authorization: `Bearer ${tokens.owner}` });
    expect(owner.status).toBe(200);
  });
});

describe('admin endpoints', () => {
  it('lists roles, permissions, users and new permission keys are seeded', async () => {
    const roles = await request(app).get('/api/roles').set(h('owner'));
    const keys = roles.body.data.map((r: { key: string }) => r.key);
    expect(keys).toEqual(expect.arrayContaining(ROLES));
    const owner = roles.body.data.find((r: { key: string }) => r.key === 'owner');
    expect(owner.permissions).toEqual(expect.arrayContaining(['payments.refund', 'contracts.activate', 'contracts.freeze', 'payments.confirm', 'shifts.open']));
    expect(owner.permissions).not.toEqual(expect.arrayContaining(['checkins.create']));
    expect(owner.permissions).not.toContain('checkins.override');
    expect(owner.permissions).not.toContain('contracts.override_checkin');
    const mgr = roles.body.data.find((r: { key: string }) => r.key === 'branch_manager');
    expect(mgr.permissions).not.toContain('payments.refund');
    const rec = roles.body.data.find((r: { key: string }) => r.key === 'receptionist');
    expect(rec.permissions).toEqual(expect.arrayContaining(['contracts.activate', 'shifts.open']));
    expect(rec.permissions).not.toContain('payments.confirm');
    const perms = await request(app).get('/api/permissions').set(h('owner'));
    expect(perms.body.data.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(['contracts.activate', 'contracts.freeze', 'payments.confirm', 'shifts.open', 'checkins.override']));
    const users = await request(app).get('/api/users').set(h('owner')).query({ q: 'receptionist@mvp' });
    expect(users.body.data).toHaveLength(1);
    expect(users.body.data[0].roles[0]).toMatchObject({ role: 'receptionist', branch_id: nb });
  });

  it('role assignment guards', async () => {
    const u = await makeUser(`guard${uniq()}@mvp.test`, 'member', null);
    const before = await prisma.accessAudit.count({ where: { actorId: ids.owner, action: 'permission.checked.denied' } });
    expect((await request(app).post(`/api/users/${u.id}/roles`).set(h('owner')).send({ role: 'owner' })).status).toBe(403);
    expect((await request(app).post(`/api/users/${u.id}/roles`).set(h('owner')).send({ role: 'super_admin' })).status).toBe(403);
    expect(await prisma.accessAudit.count({ where: { actorId: ids.owner, action: 'permission.checked.denied' } })).toBe(before + 2);
    expect((await request(app).post(`/api/users/${u.id}/roles`).set(h('owner')).send({ role: 'receptionist' })).body.error.code).toBe('BRANCH_REQUIRED');
    expect((await request(app).post(`/api/users/${u.id}/roles`).set(h('owner')).send({ role: 'nope' })).status).toBe(404);
    const ok = await request(app).post(`/api/users/${u.id}/roles`).set(h('owner')).send({ role: 'branch_manager', branch_id: nb });
    expect(ok.status).toBe(201);
    const sa = await request(app).post(`/api/users/${u.id}/roles`).set(h('super_admin')).send({ role: 'owner' });
    expect(sa.status).toBe(201);
    expect(sa.body.data.branch_id).toBeNull();
    const asOwner = await request(app).delete(`/api/users/${u.id}/roles/${sa.body.data.id}`).set(h('owner'));
    expect(asOwner.status).toBe(403);
    expect((await request(app).delete(`/api/users/${u.id}/roles/${sa.body.data.id}`).set(h('super_admin'))).status).toBe(200);
    expect((await request(app).delete(`/api/users/${u.id}/roles/${ok.body.data.id}`).set(h('owner'))).status).toBe(200);
    expect((await request(app).delete(`/api/users/${u.id}/roles/${ok.body.data.id}`).set(h('owner'))).status).toBe(404);
  });

  it('audit log lists filtered entries and records member/package before and after', async () => {
    const mem = await request(app).post('/api/members').set(h('receptionist')).send({ name: 'Audited', phone: phone() });
    await request(app).patch(`/api/members/${mem.body.data.id}`).set(h('receptionist')).send({ name: 'Audited 2' });
    const pkg = await request(app).post('/api/packages').set(h('branch_manager')).send({ name: 'AuditPkg', type: 'day', duration_days: 1, price: 1000 });
    await request(app).patch(`/api/packages/${pkg.body.data.id}`).set(h('branch_manager')).send({ price: 2000 });
    const logs = await request(app).get('/api/audit-logs').set(h('owner')).query({ actor: ids.receptionist, action: 'member.updated', limit: 100 });
    expect(logs.status).toBe(200);
    const row = logs.body.data.find((a: { target_id: string }) => a.target_id === mem.body.data.id);
    expect(row.metadata.before.name).toBe('Audited');
    expect(row.metadata.after.name).toBe('Audited 2');
    expect(logs.body.meta.total).toBeGreaterThan(0);
    const pl = await request(app).get('/api/audit-logs').set(h('owner')).query({ action: 'package.updated', from: todayVN(), to: todayVN(), limit: 100 });
    const prow = pl.body.data.find((a: { target_id: string }) => a.target_id === pkg.body.data.id);
    expect(prow.metadata).toMatchObject({ before: { price: 1000 }, after: { price: 2000 } });
    const future = await request(app).get('/api/audit-logs').set(h('owner')).query({ from: iso10(addDays(today(), 5)) });
    expect(future.body.data).toHaveLength(0);
  });
});
