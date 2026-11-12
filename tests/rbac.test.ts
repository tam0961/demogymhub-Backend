import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { assignRole, revokeRole } from '../src/modules/rbac/service.js';
import { app, branchId, login, makeUser, tokenFor } from './helpers';

type Role = 'super_admin' | 'owner' | 'branch_manager' | 'receptionist' | 'sales' | 'trainer' | 'accountant' | 'member';
const ROLES: Role[] = ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'trainer', 'accountant', 'member'];

const tokens = {} as Record<Role, string>;
const ids = {} as Record<Role, string>;
let nb: string;
let q7: string;
let memberId: string;
let packageId: string;
let phoneSeq = 0;
const newPhone = () => `09${String(10000000 + ++phoneSeq)}`;

const auth = (r: Role) => ({ Authorization: `Bearer ${tokens[r]}`, 'X-Branch-Id': nb });

beforeAll(async () => {
  nb = await branchId('nb');
  q7 = await branchId('q7');
  for (const r of ROLES) {
    const email = `${r}@rbac.test`;
    if (r === 'super_admin') {
      const res = await login('admin@test.local', 'AdminPass!2345');
      tokens[r] = res.body.data.access_token;
      ids[r] = res.body.data.user.id;
      continue;
    }
    const global = r === 'owner' || r === 'accountant';
    const u = await makeUser(email, r, global ? null : 'nb');
    ids[r] = u.id;
    tokens[r] = await tokenFor(email);
  }
  const m = await prisma.member.create({ data: { code: 'SEED1', name: 'Seed Member', phone: '0900000001', branchId: nb } });
  memberId = m.id;
  const p = await prisma.package.create({ data: { name: 'Seed Pkg', type: 'month', durationDays: 30, price: 500000, branchId: nb } });
  packageId = p.id;
});

const matrix: { name: string; allowed: Role[]; call: (r: Role) => request.Test }[] = [
  {
    name: 'GET /members',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'accountant'],
    call: (r) => request(app).get('/api/members').set(auth(r)),
  },
  {
    name: 'GET /members/:id',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'accountant'],
    call: (r) => request(app).get(`/api/members/${memberId}`).set(auth(r)),
  },
  {
    name: 'POST /members',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales'],
    call: (r) => request(app).post('/api/members').set(auth(r)).send({ name: `M ${r}`, phone: newPhone() }),
  },
  {
    name: 'PATCH /members/:id',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist'],
    call: (r) => request(app).patch(`/api/members/${memberId}`).set(auth(r)).send({ name: `Renamed by ${r}` }),
  },
  {
    name: 'GET /packages',
    allowed: ['super_admin', 'owner', 'branch_manager', 'receptionist', 'sales', 'accountant', 'member'],
    call: (r) => request(app).get('/api/packages').set(auth(r)),
  },
  {
    name: 'POST /packages',
    allowed: ['super_admin', 'owner', 'branch_manager'],
    call: (r) => request(app).post('/api/packages').set(auth(r)).send({ name: `P ${r}`, type: 'day', duration_days: 1, price: 50000 }),
  },
  {
    name: 'PATCH /packages/:id',
    allowed: ['super_admin', 'owner', 'branch_manager'],
    call: (r) => request(app).patch(`/api/packages/${packageId}`).set(auth(r)).send({ price: 600000 }),
  },
];

describe('role x endpoint matrix', () => {
  for (const row of matrix) {
    describe(row.name, () => {
      for (const role of ROLES) {
        const allowed = row.allowed.includes(role);
        it(`${role} -> ${allowed ? '2xx' : '403'}`, async () => {
          const before = await prisma.accessAudit.count({ where: { actorId: ids[role], action: 'permission.checked.denied' } });
          const res = await row.call(role);
          if (allowed) {
            expect(res.status).toBeGreaterThanOrEqual(200);
            expect(res.status).toBeLessThan(300);
          } else {
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
            const after = await prisma.accessAudit.count({ where: { actorId: ids[role], action: 'permission.checked.denied' } });
            expect(after).toBe(before + 1);
          }
        });
      }
    });
  }

  it('unauthenticated writes get 401', async () => {
    expect((await request(app).post('/api/members').send({})).status).toBe(401);
    expect((await request(app).post('/api/packages').send({})).status).toBe(401);
  });
});

describe('permission cache invalidation', () => {
  it('role change takes effect immediately', async () => {
    const u = await makeUser('cache@rbac.test', 'receptionist', 'nb');
    const t = await tokenFor('cache@rbac.test');
    const h = { Authorization: `Bearer ${t}`, 'X-Branch-Id': nb };
    expect((await request(app).get('/api/members').set(h)).status).toBe(200);
    await revokeRole(u.id, 'receptionist');
    expect((await request(app).get('/api/members').set(h)).status).toBe(403);
    await assignRole(u.id, 'receptionist', nb);
    expect((await request(app).get('/api/members').set(h)).status).toBe(200);
  });
});

describe('members behavior', () => {
  it('rejects duplicate phone and code', async () => {
    const phone = newPhone();
    const a = await request(app).post('/api/members').set(auth('receptionist')).send({ name: 'Dup A', phone, code: 'DUPCODE' });
    expect(a.status).toBe(201);
    const bPhone = await request(app).post('/api/members').set(auth('receptionist')).send({ name: 'Dup B', phone: phone.replace(/^09/, '+849') });
    expect(bPhone.status).toBe(201);
    const dupPhone = await request(app).post('/api/members').set(auth('receptionist')).send({ name: 'Dup C', phone });
    expect(dupPhone.status).toBe(409);
    expect(dupPhone.body.error.code).toBe('DUPLICATE_PHONE');
    const dupCode = await request(app).post('/api/members').set(auth('receptionist')).send({ name: 'Dup D', phone: newPhone(), code: 'DUPCODE' });
    expect(dupCode.status).toBe(409);
    expect(dupCode.body.error.code).toBe('DUPLICATE_CODE');
    const patchDup = await request(app).patch(`/api/members/${a.body.data.id}`).set(auth('receptionist')).send({ phone: '0900000001' });
    expect(patchDup.body.error.code).toBe('DUPLICATE_PHONE');
  });

  it('returns contract fields, auto code, validation errors', async () => {
    const r = await request(app)
      .post('/api/members')
      .set(auth('receptionist'))
      .send({ name: 'Full Fields', phone: newPhone(), email: 'F@X.com', gender: 'female', dob: '1999-05-20' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.data).sort()).toEqual(
      ['avatar_url', 'branch_id', 'code', 'created_at', 'dob', 'email', 'face_id', 'gender', 'has_photo', 'id', 'name', 'phone', 'photo_version', 'status'].sort(),
    );
    expect(r.body.data).toMatchObject({ status: 'active', branch_id: nb, dob: '1999-05-20', email: 'f@x.com' });
    expect(r.body.data.code).toMatch(/^GH\d+$/);
    const bad = await request(app).post('/api/members').set(auth('receptionist')).send({ name: '', phone: 'abc' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('search, status filter and pagination meta', async () => {
    const phone = newPhone();
    await request(app).post('/api/members').set(auth('branch_manager')).send({ name: 'Zebra Searchable', phone, status: 'frozen' });
    const byName = await request(app).get('/api/members').set(auth('receptionist')).query({ q: 'zebra searchable' });
    expect(byName.body.data).toHaveLength(1);
    const byPhone = await request(app).get('/api/members').set(auth('receptionist')).query({ q: phone });
    expect(byPhone.body.data).toHaveLength(1);
    const frozen = await request(app).get('/api/members').set(auth('receptionist')).query({ status: 'frozen' });
    expect(frozen.body.data.every((m: { status: string }) => m.status === 'frozen')).toBe(true);
    const page = await request(app).get('/api/members').set(auth('receptionist')).query({ page: 1, limit: 2 });
    expect(page.body.meta).toMatchObject({ page: 1, limit: 2 });
    expect(page.body.meta.total).toBeGreaterThan(2);
    expect(page.body.data).toHaveLength(2);
  });
});

describe('branch scoping', () => {
  it('branch-bound staff cannot read or write another branch', async () => {
    const other = await prisma.member.create({ data: { code: 'Q7ONLY', name: 'Q7 Person', phone: '0911111111', branchId: q7 } });
    const t = { Authorization: `Bearer ${tokens.receptionist}` };
    const list = await request(app).get('/api/members').set(t).query({ q: 'Q7 Person' });
    expect(list.body.data).toHaveLength(0);
    expect((await request(app).get(`/api/members/${other.id}`).set(t)).status).toBe(404);
    expect((await request(app).patch(`/api/members/${other.id}`).set(t).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).get('/api/members').set({ ...t, 'X-Branch-Id': q7 })).status).toBe(403);
    expect((await request(app).post('/api/members').set(t).send({ name: 'X', phone: newPhone(), branch_id: q7 })).status).toBe(403);
  });

  it('owner and super_admin see all branches; X-Branch-Id narrows', async () => {
    const t = { Authorization: `Bearer ${tokens.owner}` };
    const all = await request(app).get('/api/members').set(t).query({ q: 'Q7 Person' });
    expect(all.body.data).toHaveLength(1);
    const narrowed = await request(app).get('/api/members').set({ ...t, 'X-Branch-Id': nb }).query({ q: 'Q7 Person' });
    expect(narrowed.body.data).toHaveLength(0);
    const created = await request(app).post('/api/members').set(t).send({ name: 'Owner Q7', phone: newPhone(), branch_id: q7 });
    expect(created.status).toBe(201);
    expect(created.body.data.branch_id).toBe(q7);
  });

  it('packages are priced per branch', async () => {
    const t = { Authorization: `Bearer ${tokens.owner}` };
    const a = await request(app).post('/api/packages').set(t).send({ name: 'Gold', type: 'month', duration_days: 30, price: 700000, branch_id: nb });
    const b = await request(app).post('/api/packages').set(t).send({ name: 'Gold', type: 'month', duration_days: 30, price: 900000, branch_id: q7 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const nbOnly = await request(app).get('/api/packages').set({ Authorization: `Bearer ${tokens.receptionist}` }).query({ q: 'Gold' });
    expect(nbOnly.body.data.map((p: { price: number }) => p.price)).toEqual([700000]);
    const invalid = await request(app).post('/api/packages').set(t).send({ name: 'Bad', type: 'session', price: 1, branch_id: nb });
    expect(invalid.status).toBe(400);
  });
});

describe('role scope', () => {
  it('member with null branch does not get all-branch access', async () => {
    const u = await makeUser(`scope-${Date.now()}@t.local`, 'member', null);
    const { loadAccess } = await import('../src/modules/rbac/service.js');
    expect((await loadAccess(u.id)).allBranches).toBe(false);
  });

  it('assignRole is idempotent', async () => {
    const u = await makeUser(`dup-${Date.now()}@t.local`, 'sales', 'nb');
    const { assignRole } = await import('../src/modules/rbac/service.js');
    await assignRole(u.id, 'sales', (await prisma.branch.findFirstOrThrow({ where: { code: 'nb' } })).id);
    expect(await prisma.userRole.count({ where: { userId: u.id } })).toBe(1);
  });
});
