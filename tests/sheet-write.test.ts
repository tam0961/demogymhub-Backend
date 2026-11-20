import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { patchSheetSyncCfg } from '../src/modules/sheetsync/config';
import { _resetSheetMemberCache, enqueueSheetWrites, retrySheetWrites, sessionKey } from '../src/modules/sheetsync/write';
import { visibleWeek } from '../src/modules/pt/public';
import { app, branchId, makeUser, tokenFor } from './helpers';

const pull = vi.hoisted(() => ({
  upsert: vi.fn(async (_m: { name: string; phone: string; email: string | null }): Promise<{ ok: boolean; added?: boolean; error?: string; skipped?: 'no_email' | 'not_configured' }> => ({ ok: true })),
  approve: vi.fn(async (_p: string, _by: string | null) => ({ memberId: 'mem-1', code: 'HV1500' })),
}));
vi.mock('../src/modules/sheetsync/pull', () => ({
  pullNow: async () => ({ ok: true, counts: { classes: 2 }, unmatched: [] }),
  startSheetPullJob: () => undefined,
  upsertSheetMember: pull.upsert,
  getPendingMembers: async () => [{ name: 'Lê Vân', phone: '0399797922', email: 'levan@x.vn', expiry: '2026-06-05', learned: 10, remaining: 0, note: '', seenAt: '2026-11-20T10:00:00Z' }],
  approvePending: pull.approve,
}));

const BRIDGE = 'https://script.google.com/macros/s/AKfycbTESTbridge/exec';
const DUMP = 'https://script.google.com/macros/s/AKfycbTESTdump/exec';
let nb = '';
let owner = '';
let recep = '';
let seq = 0;
const sfx = Date.now().toString(36);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const calls: { url: string; body: { phone: string; keys: string[]; website: string } }[] = [];

const stub = (replies: object[]) => {
  let i = 0;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = replies[Math.min(i++, replies.length - 1)];
    if ((r as { throw?: boolean }).throw) throw new Error('offline');
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  });
};

async function mkMember(sessions = 3) {
  const id = `${sfx}${++seq}`;
  const phone = `07${String(10000000 + seq * 7919).slice(0, 8)}`;
  const m = await prisma.member.create({ data: { code: `SW${id}`, name: `SW ${id}`, phone, email: `sw${id}@example.com`, branchId: nb } });
  const mpkg = await prisma.package.create({ data: { name: `SWM ${id}`, type: 'month', durationDays: 30, price: 1, branchId: nb } });
  await prisma.contract.create({ data: { code: `SWC${id}`, memberId: m.id, packageId: mpkg.id, branchId: nb, status: 'active', totalAmount: 1 } });
  const gpkg = await prisma.package.create({ data: { name: `SWG ${id}`, type: 'session', category: 'pt_group', sessions, price: 1, branchId: nb } });
  await prisma.contract.create({ data: { code: `SWG${id}`, memberId: m.id, packageId: gpkg.id, branchId: nb, status: 'active', totalAmount: 1, sessionsTotal: sessions, sessionsLeft: sessions } });
  return m;
}

const day = () => visibleWeek().to;
const mkClass = (hour: number) => {
  const start = new Date(`${day()}T${String(hour).padStart(2, '0')}:00:00+07:00`);
  return prisma.groupClass.create({ data: { branchId: nb, startAt: start, endAt: new Date(start.getTime() + 3600000), capacity: 3, muscleGroup: 'Core + Cardio' } });
};
const reg = (classId: string, memberId: string, name: string, phone: string, extra: object = {}) =>
  prisma.groupRegistration.create({ data: { classId, memberId, name, phone, status: 'booked', ...extra } });
const log = (registrationId: string) => prisma.sheetWriteLog.findUnique({ where: { registrationId } });
const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>) => {
  for (let i = 0; i < 40; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
};

beforeAll(async () => {
  nb = await branchId('nb');
  await makeUser(`own@sw${sfx}.test`, 'owner', null);
  owner = await tokenFor(`own@sw${sfx}.test`);
  await makeUser(`rec@sw${sfx}.test`, 'receptionist', 'nb');
  recep = await tokenFor(`rec@sw${sfx}.test`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
  pull.upsert.mockClear();
  _resetSheetMemberCache();
});

describe('sheet write-through', () => {
  it('does nothing while the switch is off or for Sheet-sourced and waitlist rows', async () => {
    await patchSheetSyncCfg({ writeOn: false, bridgeUrl: BRIDGE });
    const c = await mkClass(17);
    const m = await mkMember();
    const a = await reg(c.id, m.id, m.name, m.phone);
    stub([{ ok: true }]);
    await enqueueSheetWrites([a.id]);
    expect(calls).toHaveLength(0);
    expect(await log(a.id)).toBeNull();

    await patchSheetSyncCfg({ writeOn: true });
    const m2 = await mkMember();
    const fromSheet = await reg(c.id, m2.id, m2.name, m2.phone, { source: 'sheet' });
    const m3 = await mkMember();
    const wait = await reg(c.id, m3.id, m3.name, m3.phone, { status: 'waitlist' });
    await enqueueSheetWrites([fromSheet.id, wait.id]);
    expect(calls).toHaveLength(0);
    expect(await log(fromSheet.id)).toBeNull();
    expect(await log(wait.id)).toBeNull();
  });

  it('sends one call per member with date|time keys and marks ok', async () => {
    await patchSheetSyncCfg({ writeOn: true, bridgeUrl: BRIDGE });
    const c1 = await mkClass(18);
    const c2 = await mkClass(19);
    const m = await mkMember();
    const r1 = await reg(c1.id, m.id, m.name, m.phone);
    const r2 = await reg(c2.id, m.id, m.name, m.phone);
    stub([{ ok: true, booked: [] }]);
    await enqueueSheetWrites([r1.id, r2.id]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(BRIDGE);
    expect(calls[0].body.phone).toBe(m.phone);
    expect(calls[0].body.website).toBe('');
    expect(calls[0].body.keys.sort()).toEqual([sessionKey(c1.startAt), sessionKey(c2.startAt)].sort());
    expect((await log(r1.id))?.status).toBe('ok');
    expect((await log(r2.id))?.status).toBe('ok');
  });

  it('skips with a Vietnamese reason when the member is not in the Sheet, without retrying', async () => {
    const c = await mkClass(20);
    const m = await mkMember();
    const r = await reg(c.id, m.id, m.name, m.phone);
    stub([{ ok: false, error: 'no_member' }]);
    await enqueueSheetWrites([r.id]);
    const l = await log(r.id);
    expect(l).toMatchObject({ status: 'skipped', attempts: 1 });
    expect(l?.error).toContain('Members');
    calls.length = 0;
    await retrySheetWrites();
    expect(calls).toHaveLength(0);
  });

  it('records failures, retries them and stops after 5 attempts', async () => {
    const c = await mkClass(21);
    const m = await mkMember();
    const r = await reg(c.id, m.id, m.name, m.phone);
    stub([{ throw: true }]);
    await enqueueSheetWrites([r.id]);
    expect(await log(r.id)).toMatchObject({ status: 'failed', attempts: 1 });
    stub([{ ok: true }]);
    await retrySheetWrites();
    expect(await log(r.id)).toMatchObject({ status: 'ok', attempts: 2 });

    const m2 = await mkMember();
    const r2 = await reg(c.id, m2.id, m2.name, m2.phone);
    stub([{ ok: false, error: 'server' }]);
    for (let i = 0; i < 7; i++) await (i === 0 ? enqueueSheetWrites([r2.id]) : retrySheetWrites());
    const l2 = await log(r2.id);
    expect(l2).toMatchObject({ status: 'failed', attempts: 5 });
    expect(calls.filter((x) => x.body.phone === m2.phone)).toHaveLength(5);
  });

  it('on a partial conflict skips the full session and re-sends the rest', async () => {
    const c1 = await mkClass(22);
    const c2 = await mkClass(23);
    const m = await mkMember();
    const r1 = await reg(c1.id, m.id, m.name, m.phone);
    const r2 = await reg(c2.id, m.id, m.name, m.phone);
    stub([{ ok: false, error: 'conflict', failed: [{ key: sessionKey(c1.startAt), reason: 'full' }] }, { ok: true }]);
    await enqueueSheetWrites([r1.id, r2.id]);
    expect((await log(r1.id))?.status).toBe('skipped');
    expect((await log(r2.id))?.status).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[1].body.keys).toEqual([sessionKey(c2.startAt)]);
  });

  it('is triggered by staff-side and public registrations without blocking them', async () => {
    const c = await mkClass(16);
    const m = await mkMember();
    stub([{ ok: true }]);
    const staff = await request(app).post(`/api/pt/classes/${c.id}/registrations`).set(auth(owner)).send({ member_id: m.id });
    expect(staff.status).toBe(201);
    const l = await waitFor(async () => {
      const x = await log(staff.body.data.id);
      return x?.status === 'ok' ? x : null;
    });
    expect(l.status).toBe('ok');

    const c2 = await mkClass(15);
    const m2 = await mkMember();
    const pub = await request(app).post('/api/public/book').send({ phone: m2.phone, class_ids: [c2.id] });
    expect(pub.status).toBe(201);
    const rr = await prisma.groupRegistration.findFirstOrThrow({ where: { classId: c2.id, memberId: m2.id } });
    await waitFor(async () => (await log(rr.id))?.status === 'ok');

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const c3 = await mkClass(14);
    const m3 = await mkMember();
    const down = await request(app).post(`/api/pt/classes/${c3.id}/registrations`).set(auth(owner)).send({ member_id: m3.id });
    expect(down.status).toBe(201);
    await waitFor(async () => (await log(down.body.data.id))?.status === 'failed');
  });
});

describe('member sync before the bridge call', () => {
  it('adds the member to the Sheet first and caches it per phone', async () => {
    const c1 = await mkClass(13);
    const c2 = await mkClass(12);
    const m = await mkMember();
    const r1 = await reg(c1.id, m.id, m.name, m.phone);
    stub([{ ok: true }]);
    await enqueueSheetWrites([r1.id]);
    expect(pull.upsert).toHaveBeenCalledWith({ name: m.name, phone: m.phone, email: m.email });
    const r2 = await reg(c2.id, m.id, m.name, m.phone);
    await enqueueSheetWrites([r2.id]);
    expect(pull.upsert).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('skips a member without email, and fails readably when the Sheet cannot be reached', async () => {
    const c = await mkClass(11);
    const m = await mkMember();
    const a = await reg(c.id, m.id, m.name, m.phone);
    pull.upsert.mockResolvedValueOnce({ ok: false, skipped: 'no_email' });
    stub([{ ok: true }]);
    await enqueueSheetWrites([a.id]);
    expect(calls).toHaveLength(0);
    const l = await log(a.id);
    expect(l?.status).toBe('skipped');
    expect(l?.error).toContain('chưa có email');

    const m2 = await mkMember();
    const b = await reg(c.id, m2.id, m2.name, m2.phone);
    pull.upsert.mockResolvedValueOnce({ ok: false, error: 'Apps Script lỗi' });
    await enqueueSheetWrites([b.id]);
    const l2 = await log(b.id);
    expect(l2?.status).toBe('failed');
    expect(l2?.error).toContain('Apps Script lỗi');
    expect(calls).toHaveLength(0);
    await retrySheetWrites();
    expect((await log(b.id))?.status).toBe('ok');
  });
});

describe('sheetsync routes', () => {
  it('is owner-only and validates URLs', async () => {
    expect((await request(app).get('/api/sheetsync/config').set(auth(recep))).status).toBe(403);
    const base = { write_on: true, bridge_url: BRIDGE, pull_on: false, dump_url: '', branch_id: '' };
    expect((await request(app).put('/api/sheetsync/config').set(auth(owner)).send({ ...base, bridge_url: 'https://evil.example/exec' })).status).toBe(400);
    expect((await request(app).put('/api/sheetsync/config').set(auth(owner)).send({ ...base, pull_on: true })).status).toBe(400);
    expect((await request(app).put('/api/sheetsync/config').set(auth(owner)).send({ ...base, dump_url: 'http://x' })).status).toBe(400);
    const ok = await request(app).put('/api/sheetsync/config').set(auth(owner)).send({ ...base, pull_on: true, dump_url: DUMP, branch_id: nb });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ write_on: true, pull_on: true, dump_url: DUMP, branch_id: nb });
    expect(ok.body.data.write_log.counts.ok).toBeGreaterThan(0);
  });

  it('shows failed and skipped rows, serves the script without leaking the secret and retries', async () => {
    const g = await request(app).get('/api/sheetsync/config').set(auth(owner));
    expect(g.body.data.write_log.problems.length).toBeGreaterThan(0);
    expect(g.body.data.write_log.problems[0]).toHaveProperty('member_name');
    expect(JSON.stringify(g.body)).not.toContain('secret');
    const s = await request(app).get('/api/sheetsync/script').set(auth(owner));
    expect(s.status).toBe(200);
    expect(typeof s.body.data.code).toBe('string');
    const again = await request(app).get('/api/sheetsync/script').set(auth(owner));
    expect(again.body.data.code).toBe(s.body.data.code);
    const p = await request(app).post('/api/sheetsync/pull-now').set(auth(owner));
    expect(p.body.data).toMatchObject({ ok: true });
    stub([{ ok: true }]);
    expect((await request(app).post('/api/sheetsync/retry').set(auth(owner))).status).toBe(200);
  });

  it('lists pending Sheet members and approves one person at a time', async () => {
    const list = await request(app).get('/api/sheetsync/pending-members').set(auth(owner));
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ name: 'Lê Vân', phone: '0399797922' });
    expect((await request(app).get('/api/sheetsync/pending-members').set(auth(recep))).status).toBe(403);
    const ok = await request(app).post('/api/sheetsync/pending-members/approve').set(auth(owner)).send({ phone: '0399797922' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toEqual({ member_id: 'mem-1', code: 'HV1500' });
    expect(pull.approve).toHaveBeenCalledWith('0399797922', expect.any(String));
    pull.approve.mockRejectedValueOnce(new Error('Số điện thoại đã có hội viên'));
    const bad = await request(app).post('/api/sheetsync/pending-members/approve').set(auth(owner)).send({ phone: '0399797922' });
    expect(bad.status).toBe(400);
    expect((await request(app).post('/api/sheetsync/pending-members/approve').set(auth(owner)).send({})).status).toBe(400);
  });
});
