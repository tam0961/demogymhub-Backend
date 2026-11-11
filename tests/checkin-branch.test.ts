import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { verifyPassword } from '../src/lib/crypto';
import { provisionOwner } from '../src/seed';
import { setUserRole } from '../src/scripts/set-user-role';
import { assignRole, invalidateAccess } from '../src/modules/rbac/service';
import { app, branchId, login, makeUser, tokenFor } from './helpers';

let q2: string;
let nb: string;
let q7: string;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${++seq}`;
const bearer = (t: string, branch?: string) => ({ Authorization: `Bearer ${t}`, ...(branch ? { 'X-Branch-Id': branch } : {}) });

async function activeMember(branch: string) {
  const m = await prisma.member.create({
    data: { code: `CB${uniq()}`, name: `CB ${uniq()}`, phone: `08${String(10000000 + ++seq * 7919 + Math.floor(Math.random() * 1000))}`, branchId: branch },
  });
  const pkg = await prisma.package.create({ data: { name: `P${uniq()}`, type: 'month', durationDays: 30, price: 1000, branchId: branch } });
  const today = dateOnly(todayVN());
  await prisma.contract.create({
    data: {
      code: `CBC${uniq()}`,
      memberId: m.id,
      packageId: pkg.id,
      branchId: branch,
      status: 'active',
      totalAmount: 1000,
      paidAmount: 1000,
      durationDays: 30,
      startDate: today,
      endDate: addDays(today, 30),
      signedAt: new Date(),
      signatureData: 'sig',
      activatedAt: new Date(),
    },
  });
  return m;
}

let ownerTok: string;
let adminTok: string;
let recQ7: string;

beforeAll(async () => {
  q2 = await branchId('q2');
  nb = await branchId('nb');
  q7 = await branchId('q7');
  await makeUser('cb.owner@cb.test', 'owner', null);
  ownerTok = await tokenFor('cb.owner@cb.test');
  adminTok = (await login('admin@test.local', 'AdminPass!2345')).body.data.access_token;
  await makeUser('cb.rec7@cb.test', 'receptionist', 'q7');
  recQ7 = await tokenFor('cb.rec7@cb.test');
});

describe('branches seed', () => {
  it('has the three named branches', async () => {
    const rows = await prisma.branch.findMany({ where: { code: { in: ['q2', 'nb', 'q7'] } }, orderBy: { code: 'asc' } });
    expect(rows.map((r) => [r.code, r.name])).toEqual([
      ['nb', 'Chi nhánh Nhà Bè'],
      ['q2', 'Chi nhánh Quận 2'],
      ['q7', 'Chi nhánh Quận 7'],
    ]);
  });

  it('owner role has no check-in write permissions', async () => {
    const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' }, include: { rolePermissions: { include: { permission: true } } } });
    const keys = owner.rolePermissions.map((r) => r.permission.key);
    for (const k of ['checkins.create', 'checkins.override', 'contracts.override_checkin']) expect(keys).not.toContain(k);
    expect(keys).toContain('checkins.read');
  });
});

describe('view-only admin accounts', () => {
  for (const [name, get] of [
    ['owner', () => ownerTok],
    ['super_admin', () => adminTok],
  ] as const) {
    it(`${name} gets VIEW_ONLY on all write endpoints but can read`, async () => {
      const t = get();
      const m = await activeMember(q7);
      const ci = await prisma.checkin.create({ data: { memberId: m.id, branchId: q7, result: 'allowed' } });
      const calls = [
        request(app).post('/api/checkins').set(bearer(t, q7)).send({ member_id: m.id }),
        request(app).post('/api/checkins/override').set(bearer(t, q7)).send({ member_id: m.id, reason: 'because' }),
        request(app).post(`/api/checkins/${ci.id}/checkout`).set(bearer(t, q7)).send({}),
      ];
      for (const r of await Promise.all(calls)) {
        expect(r.status).toBe(403);
        expect(r.body.error.code).toBe('VIEW_ONLY');
        expect(r.body.error.message).toBe('Tài khoản quản trị chỉ xem thống kê, không thực hiện check-in.');
      }
      expect((await prisma.checkin.findUniqueOrThrow({ where: { id: ci.id } })).checkedOutAt).toBeNull();
      for (const p of ['/api/checkins', '/api/checkins/live', '/api/reports/checkin-stats']) {
        expect((await request(app).get(p).set(bearer(t))).status, p).toBe(200);
      }
    });
  }
});

describe('branch-bound check-in', () => {
  it('receptionist q7 checks in only at q7 and ignores body branch_id / header', async () => {
    const m7 = await activeMember(q7);
    const m2 = await activeMember(q2);
    const ok = await request(app).post('/api/checkins').set(bearer(recQ7, q2)).send({ member_id: m7.id, branch_id: q2 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.result).toBe('allowed');
    expect(ok.body.data.branch).toMatchObject({ id: q7, code: 'q7', name: 'Chi nhánh Quận 7' });
    expect((await prisma.checkin.findUniqueOrThrow({ where: { id: ok.body.data.checkin_id } })).branchId).toBe(q7);
    const bad = await request(app).post('/api/checkins').set(bearer(recQ7)).send({ member_id: m2.id, branch_id: q2 });
    expect(bad.body.data).toMatchObject({ result: 'denied', reason: 'WRONG_BRANCH' });
    expect((await prisma.checkin.findUniqueOrThrow({ where: { id: bad.body.data.checkin_id } })).branchId).toBe(q7);
    const out = await request(app).post(`/api/checkins/${ok.body.data.checkin_id}/checkout`).set(bearer(recQ7)).send({});
    expect(out.status).toBe(200);
  });

  it('cannot check out a check-in from another branch', async () => {
    const m = await activeMember(q2);
    const ci = await prisma.checkin.create({ data: { memberId: m.id, branchId: q2, result: 'allowed' } });
    expect((await request(app).post(`/api/checkins/${ci.id}/checkout`).set(bearer(recQ7)).send({})).status).toBe(404);
  });

  it('multi-branch staff must send X-Branch-Id among their branches', async () => {
    const u = await makeUser('cb.multi@cb.test', 'receptionist', 'q2');
    await assignRole(u.id, 'receptionist', q7);
    const t = await tokenFor('cb.multi@cb.test');
    const m = await activeMember(q2);
    const none = await request(app).post('/api/checkins').set(bearer(t)).send({ member_id: m.id });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('BRANCH_REQUIRED');
    expect((await request(app).post('/api/checkins').set(bearer(t, nb)).send({ member_id: m.id })).body.error.code).toBe('BRANCH_REQUIRED');
    const ok = await request(app).post('/api/checkins').set(bearer(t, q2)).send({ member_id: m.id });
    expect(ok.body.data.result).toBe('allowed');
    expect(ok.body.data.branch.code).toBe('q2');
    const m7 = await activeMember(q7);
    const wrong = await request(app).post('/api/checkins').set(bearer(t, q2)).send({ member_id: m7.id });
    expect(wrong.body.data).toMatchObject({ result: 'denied', reason: 'WRONG_BRANCH' });
  });
});

describe('/api/me check-in flags', () => {
  it('reports can_checkin and checkin_branch', async () => {
    const me = async (t: string) => (await request(app).get('/api/me').set(bearer(t))).body.data;
    expect(await me(recQ7)).toMatchObject({ can_checkin: true, checkin_branch: { id: q7, code: 'q7', name: 'Chi nhánh Quận 7' } });
    expect(await me(ownerTok)).toMatchObject({ can_checkin: false, checkin_branch: null });
    expect(await me(adminTok)).toMatchObject({ can_checkin: false, checkin_branch: null });
    await makeUser('cb.sales@cb.test', 'sales', 'q7');
    expect(await me(await tokenFor('cb.sales@cb.test'))).toMatchObject({ can_checkin: false, checkin_branch: null });
    const mgr = await makeUser('cb.mgr@cb.test', 'branch_manager', 'q7');
    expect(await me(await tokenFor('cb.mgr@cb.test'))).toMatchObject({ can_checkin: true, checkin_branch: { code: 'q7' } });
    await assignRole(mgr.id, 'branch_manager', nb);
    expect(await me(await tokenFor('cb.mgr@cb.test'))).toMatchObject({ can_checkin: true, checkin_branch: null });
  });
});

describe('GET /reports/checkin-stats', () => {
  it('scopes staff to their branch and gives owner every branch', async () => {
    const m = await activeMember(q7);
    expect((await request(app).post('/api/checkins').set(bearer(recQ7)).send({ member_id: m.id })).body.data.result).toBe('allowed');
    const m2 = await activeMember(q2);
    await request(app).post('/api/checkins').set(bearer(recQ7)).send({ member_id: m2.id });

    const staff = (await request(app).get('/api/reports/checkin-stats').set(bearer(recQ7)).query({ date: todayVN() })).body.data;
    expect(staff.date).toBe(todayVN());
    expect(staff.branches).toHaveLength(1);
    const b = staff.branches[0];
    expect(b.branch).toMatchObject({ id: q7, code: 'q7' });
    expect(b.checkins_today).toBeGreaterThanOrEqual(1);
    expect(b.denied_today).toBeGreaterThanOrEqual(1);
    expect(b.inside_now).toBeGreaterThanOrEqual(1);
    expect(b.by_hour).toHaveLength(24);
    expect(b.by_hour.reduce((s: number, x: { count: number }) => s + x.count, 0)).toBe(b.checkins_today);
    expect(staff.totals).toEqual({ checkins_today: b.checkins_today, denied_today: b.denied_today, inside_now: b.inside_now });

    for (const t of [ownerTok, adminTok]) {
      const all = (await request(app).get('/api/reports/checkin-stats').set(bearer(t))).body.data;
      const codes = all.branches.map((x: { branch: { code: string } }) => x.branch.code);
      expect(codes).toEqual(expect.arrayContaining(['q2', 'nb', 'q7']));
      expect(all.branches.find((x: { branch: { code: string } }) => x.branch.code === 'q7').checkins_today).toBe(b.checkins_today);
    }
    const future = (await request(app).get('/api/reports/checkin-stats').set(bearer(ownerTok)).query({ date: '2031-01-01' })).body.data;
    expect(future.totals).toEqual({ checkins_today: 0, denied_today: 0, inside_now: 0 });
    expect(future.branches.length).toBeGreaterThanOrEqual(3);
    await makeUser('cb.trainer@cb.test', 'trainer', 'q7');
    expect((await request(app).get('/api/reports/checkin-stats').set(bearer(await tokenFor('cb.trainer@cb.test')))).status).toBe(403);
  });
});

describe('owner provisioning', () => {
  it('creates owner + super_admin once and never overwrites', async () => {
    expect(await provisionOwner(prisma, {})).toBe('skipped');
    expect(await provisionOwner(prisma, { email: 'Boss@Gym.Test', password: 'FirstPass!2345' })).toBe('created');
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'boss@gym.test' }, include: { userRoles: { include: { role: true } } } });
    expect(u).toMatchObject({ name: 'Chủ phòng gym', emailVerified: true });
    expect(u.userRoles.map((r) => [r.role.key, r.branchId]).sort()).toEqual([
      ['owner', null],
      ['super_admin', null],
    ]);
    expect(await provisionOwner(prisma, { email: 'boss@gym.test', password: 'OtherPass!9999' })).toBe('exists');
    const again = await prisma.user.findUniqueOrThrow({ where: { email: 'boss@gym.test' } });
    expect(await verifyPassword(again.passwordHash, 'FirstPass!2345')).toBe(true);
    expect(await prisma.userRole.count({ where: { userId: u.id } })).toBe(2);
    expect((await login('boss@gym.test', 'FirstPass!2345')).status).toBe(200);
  });
});

describe('set-user-role', () => {
  it('converts a user, bumps token version, revokes refresh tokens, audits, idempotent', async () => {
    const u = await makeUser('cb.conv@cb.test', 'owner', null);
    await assignRole(u.id, 'super_admin', null);
    const before = await tokenFor('cb.conv@cb.test');
    expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBeGreaterThan(0);
    const msg = await setUserRole(prisma, { email: 'CB.conv@cb.test', role: 'receptionist', branch: 'q7' });
    expect(msg).toContain('receptionist@q7');
    const rows = await prisma.userRole.findMany({ where: { userId: u.id }, include: { role: true } });
    expect(rows.map((r) => [r.role.key, r.branchId])).toEqual([['receptionist', q7]]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).tokenVersion).toBe(1);
    expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(0);
    expect((await request(app).get('/api/me').set(bearer(before))).status).toBe(401);
    expect(await prisma.accessAudit.count({ where: { targetId: u.id, action: 'role.converted' } })).toBe(1);
    await setUserRole(prisma, { email: 'cb.conv@cb.test', role: 'receptionist', branch: 'q7' });
    expect(await prisma.userRole.count({ where: { userId: u.id } })).toBe(1);
    const me = (await request(app).get('/api/me').set(bearer(await tokenFor('cb.conv@cb.test')))).body.data;
    expect(me).toMatchObject({ roles: ['receptionist'], can_checkin: true, checkin_branch: { code: 'q7' } });
  });

  it('validates input', async () => {
    await expect(setUserRole(prisma, { email: 'nobody@cb.test', role: 'owner' })).rejects.toThrow(/not found/);
    await expect(setUserRole(prisma, { email: 'cb.rec7@cb.test', role: 'receptionist' })).rejects.toThrow(/--branch/);
    await expect(setUserRole(prisma, { email: 'cb.rec7@cb.test', role: 'receptionist', branch: 'zz' })).rejects.toThrow(/Branch not found/);
    await expect(setUserRole(prisma, { email: 'cb.rec7@cb.test', role: 'wizard' })).rejects.toThrow(/Unknown role/);
  });

  it('refuses to demote the last super_admin unless forced', async () => {
    const supers = await prisma.userRole.findMany({ where: { role: { key: 'super_admin' } } });
    const target = await makeUser('cb.last@cb.test', 'super_admin', null);
    try {
      await prisma.userRole.deleteMany({ where: { id: { in: supers.map((s) => s.id) } } });
      await expect(setUserRole(prisma, { email: 'cb.last@cb.test', role: 'owner' })).rejects.toThrow(/last super_admin/);
      expect(await prisma.userRole.count({ where: { userId: target.id, role: { key: 'super_admin' } } })).toBe(1);
      await setUserRole(prisma, { email: 'cb.last@cb.test', role: 'owner', force: true });
      expect(await prisma.userRole.count({ where: { userId: target.id, role: { key: 'super_admin' } } })).toBe(0);
    } finally {
      await prisma.userRole.createMany({ data: supers });
      for (const s of supers) await invalidateAccess(s.userId);
    }
  });

  it('allows demoting a super_admin when another exists', async () => {
    await makeUser('cb.sa1@cb.test', 'super_admin', null);
    await setUserRole(prisma, { email: 'cb.sa1@cb.test', role: 'accountant' });
    expect(await prisma.userRole.count({ where: { user: { email: 'cb.sa1@cb.test' }, role: { key: 'accountant' } } })).toBe(1);
  });
});
