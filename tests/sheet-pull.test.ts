import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { dumpScriptCode } from '../src/modules/sheetsync/dump-script';
import { getSheetSyncCfg, patchSheetSyncCfg } from '../src/modules/sheetsync/config';
import { approvePending, getPendingMembers, parseDateAny, pullNow, upsertSheetMember } from '../src/modules/sheetsync/pull';
import { makeUser } from './helpers';

const sfx = Date.now().toString(36);
let BR = '';
let memberA = '';
let memberB = '';
let contractId = '';
let trangId = '';
const DUMP_URL = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const FUT1 = '2031-05-05';
const FUT2 = '2031-05-07';
const PAST = '2020-03-02';

const label = (dow: string, date: string, time: string, group: string) => `${dow} (${date.slice(8, 10)}/${date.slice(5, 7)}) – ${time} (${group})`;
const reg = (name: string, phone: string, email: string, lbl: string, date: string, status: string, pt: string, done = '') => ['01/01/2031 10:00:00', name, phone, email, lbl, date, '5', status, pt, done, '', ''];

const phoneA = () => `09${sfx.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`;
const phoneB = () => `08${sfx.replace(/\D/g, '').padEnd(8, '2').slice(0, 8)}`;

function dump() {
  const a = phoneA();
  const b = phoneB();
  const ghost = '0700000000';
  return {
    ok: true,
    members: [],
    schedule: [
      ['1', FUT1, '20:00', '21:15', 'Core + Cardio', '4', '0'],
      ['3', FUT2, '6:30', '7:45', 'Lưng + Vai + Tay sau', '3', '0'],
    ],
    classes: [
      ['1', label('T2', FUT1, '20:00–21:15', 'Core + Cardio'), '05-05-2031', '2', 'Trang'],
      ['2', label('T2', PAST.replace('03-02', '03-02'), '20:00–21:15', 'Mông + Đùi + Tổng hợp'), '02-03-2020', '1', 'Trang'],
    ],
    registrations: [
      reg('Hoi Vien A', a.slice(1), 'a@example.test', label('T2', FUT1, '20:00–21:15', 'Core + Cardio'), FUT1, 'Confirmed', 'Trang'),
      reg('Hoi Vien B', b, '', label('T2', FUT1, '20:00–21:15', 'Core + Cardio'), FUT1, 'Confirmed', 'Trang'),
      reg('Nguoi La', ghost, 'ghost@example.test', label('T2', FUT1, '20:00–21:15', 'Core + Cardio'), FUT1, 'Confirmed', 'Trang'),
      reg('Hoi Vien A', a, 'a@example.test', label('T2', PAST, '20:00–21:15', 'Mông + Đùi + Tổng hợp'), PAST, 'Confirmed', 'Trang', 'Đã học'),
      reg('Hoi Vien B', b, 'b@example.test', label('T4', FUT2, '6:30–7:45', 'Lưng + Vai + Tay sau'), FUT2, 'Cancelled', 'Trang'),
    ],
  };
}

const stub = (body: unknown, ok = true) =>
  vi.stubGlobal('fetch', async () => ({ ok, status: ok ? 200 : 500, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }));

beforeAll(async () => {
  BR = (await prisma.branch.create({ data: { code: `sp${sfx}`, name: 'SP' } })).id;
  const tr = await makeUser(`trang@sp${sfx}.test`, 'trainer', `sp${sfx}`);
  await prisma.user.update({ where: { id: tr.id }, data: { name: 'Nguyen Trang' } });
  trangId = tr.id;
  memberA = (await prisma.member.create({ data: { code: `SPA${sfx}`, name: 'Hoi Vien A', phone: phoneA(), branchId: BR } })).id;
  memberB = (await prisma.member.create({ data: { code: `SPB${sfx}`, name: 'Hoi Vien B', phone: phoneB(), branchId: BR, email: 'keep@example.test' } })).id;
  const pkg = await prisma.package.create({ data: { name: `SP ${sfx}`, type: 'session', category: 'pt_group', sessions: 10, price: 1000, branchId: BR } });
  contractId = (await prisma.contract.create({ data: { code: `SPC${sfx}`, memberId: memberA, packageId: pkg.id, branchId: BR, status: 'active', totalAmount: 1000, paidAmount: 1000, sessionsTotal: 10, sessionsLeft: 5 } })).id;
  await patchSheetSyncCfg({ pullOn: true, dumpUrl: DUMP_URL, secret: `secret${sfx}`, branchId: BR });
});

afterEach(() => vi.unstubAllGlobals());

describe('sheet pull', () => {
  it('parses the date formats of the Sheet', () => {
    expect(parseDateAny('2025-11-24')).toBe('2025-11-24');
    expect(parseDateAny('24-11-2025')).toBe('2025-11-24');
    expect(parseDateAny('16/11/26')).toBe('2026-11-16');
    expect(parseDateAny('2026-11-16 00:00:00')).toBe('2026-11-16');
    expect(parseDateAny('abc')).toBe('');
  });

  it('writes a small valid Apps Script with the secret', () => {
    const code = dumpScriptCode('SEC123');
    expect(code).toContain("const SECRET = 'SEC123';");
    expect(code).toContain('function doGet(e)');
    expect(code).toContain("'Thông tin lớp'");
    expect(code).not.toContain('\\n');
  });

  it('creates classes and registrations, fills email, reports unmatched and never touches contracts', async () => {
    stub(dump());
    const r = await pullNow();
    expect(r.ok).toBe(true);
    expect(r.counts).toMatchObject({ classes_created: 3, registrations_created: 3, emails_filled: 1, unmatched: 1 });
    expect(r.unmatched).toEqual([{ name: 'Nguoi La', phone: '0700000000' }]);

    const fut = await prisma.groupClass.findFirst({ where: { branchId: BR, startAt: new Date(`${FUT1}T20:00:00+07:00`) }, include: { registrations: true } });
    expect(fut).toMatchObject({ capacity: 4, muscleGroup: 'Core + Cardio', trainerId: trangId, status: 'scheduled' });
    expect(fut!.registrations).toHaveLength(2);
    expect(fut!.registrations.every((x) => x.source === 'sheet' && x.status === 'booked' && x.deducted === false)).toBe(true);

    const past = await prisma.groupClass.findFirst({ where: { branchId: BR, startAt: new Date(`${PAST}T20:00:00+07:00`) }, include: { registrations: true } });
    expect(past?.status).toBe('completed');
    expect(past!.registrations[0].status).toBe('attended');

    expect((await prisma.member.findUniqueOrThrow({ where: { id: memberA } })).email).toBe('a@example.test');
    expect((await prisma.member.findUniqueOrThrow({ where: { id: memberB } })).email).toBe('keep@example.test');
    expect(await prisma.groupRegistration.count({ where: { memberId: memberB, class: { startAt: new Date(`${FUT2}T06:30:00+07:00`) } } })).toBe(0);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).sessionsLeft).toBe(5);
    expect((await getSheetSyncCfg()).lastPullError).toBeNull();
    expect((await getSheetSyncCfg()).lastPullCounts).toMatchObject({ registrations_created: 3 });
  });

  it('is idempotent on the second pull', async () => {
    stub(dump());
    const r = await pullNow();
    expect(r.ok).toBe(true);
    expect(r.counts).toMatchObject({ classes_created: 0, registrations_created: 0, registrations_updated: 0 });
    expect(await prisma.groupRegistration.count({ where: { class: { branchId: BR } } })).toBe(3);
  });

  it('keeps app-created registrations unless the Sheet marks attended, absent or cancelled', async () => {
    const cls = await prisma.groupClass.findFirstOrThrow({ where: { branchId: BR, startAt: new Date(`${FUT1}T20:00:00+07:00`) } });
    const existing = await prisma.groupRegistration.findFirstOrThrow({ where: { classId: cls.id, memberId: memberA } });
    await prisma.groupRegistration.update({ where: { id: existing.id }, data: { source: 'public', deducted: true, status: 'cancelled' } });
    stub(dump());
    let r = await pullNow();
    expect(r.counts.registrations_updated).toBe(0);
    expect((await prisma.groupRegistration.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe('cancelled');

    await prisma.groupRegistration.update({ where: { id: existing.id }, data: { status: 'booked' } });
    const d = dump();
    d.registrations[0][9] = 'Đã học';
    stub(d);
    r = await pullNow();
    expect(r.counts.registrations_updated).toBe(1);
    const after = await prisma.groupRegistration.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after).toMatchObject({ status: 'attended', source: 'public', deducted: true });
  });

  it('reports a wrong secret, an HTML page and missing settings', async () => {
    stub({ ok: false, error: 'key' });
    let r = await pullNow();
    expect(r).toMatchObject({ ok: false, error: 'Sai mã bí mật của Apps Script' });
    expect((await getSheetSyncCfg()).lastPullError).toContain('Sai mã bí mật');
    stub('<html>Sign in</html>');
    r = await pullNow();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('không trả dữ liệu hợp lệ');
    await patchSheetSyncCfg({ dumpUrl: '' });
    r = await pullNow();
    expect(r.error).toContain('Chưa cấu hình');
    await patchSheetSyncCfg({ dumpUrl: DUMP_URL });
  });
});

const PEND1 = '0700000011';
const PEND2 = '0700000022';

function dumpWithMembers() {
  const d = dump();
  return {
    ...d,
    members: [
      ['Sheet Only Mot', '700000011', 'mot@example.test', '2031-03-01', '4', '6', '', '', 'ghi chu'],
      ['Sheet Only Hai', PEND2, '', '', '', '', '', '', ''],
      ['Hoi Vien A', phoneA().slice(1), 'a@example.test', '', '10', '0', '', '', ''],
    ],
  };
}

describe('pending Sheet members', () => {
  it('stores Sheet-only people (deduped, normalized) and drops them once they exist in the app', async () => {
    stub(dumpWithMembers());
    await pullNow();
    await pullNow();
    const list = await getPendingMembers();
    const one = list.find((x) => x.phone === PEND1);
    expect(one).toMatchObject({ name: 'Sheet Only Mot', email: 'mot@example.test', expiry: '2031-03-01', learned: 4, remaining: 6, note: 'ghi chu' });
    expect(typeof one!.seenAt).toBe('string');
    expect(list.filter((x) => x.phone === PEND1)).toHaveLength(1);
    expect(list.find((x) => x.phone === PEND2)).toMatchObject({ expiry: null, learned: null, remaining: null });
    expect(list.find((x) => x.phone === '0700000000')?.name).toBe('Nguoi La');
    expect(list.find((x) => x.phone === phoneA())).toBeUndefined();

    await prisma.member.create({ data: { code: `SPP${sfx}`, name: 'Da Co', phone: PEND2, branchId: BR } });
    stub(dumpWithMembers());
    await pullNow();
    expect((await getPendingMembers()).find((x) => x.phone === PEND2)).toBeUndefined();
  });

  it('approvePending creates exactly one member without contracts, then refuses a second approval', async () => {
    const before = await prisma.member.count();
    const r = await approvePending('700000011', null);
    expect(r.code).toMatch(/\S/);
    expect(await prisma.member.count()).toBe(before + 1);
    const m = await prisma.member.findUniqueOrThrow({ where: { id: r.memberId }, include: { contracts: true } });
    expect(m).toMatchObject({ phone: PEND1, name: 'Sheet Only Mot', email: 'mot@example.test', branchId: BR });
    expect(m.contracts).toHaveLength(0);
    expect((await getPendingMembers()).find((x) => x.phone === PEND1)).toBeUndefined();
    await expect(approvePending(PEND1, null)).rejects.toThrow('không nằm trong danh sách chờ');
    await expect(approvePending('0711111111', null)).rejects.toThrow('không nằm trong danh sách chờ');
  });

  it('refuses to approve a phone that already exists and clears it from the list', async () => {
    stub(dumpWithMembers());
    await pullNow();
    const pending = await getPendingMembers();
    expect(pending.some((x) => x.phone === '0700000000')).toBe(true);
    await prisma.member.create({ data: { code: `SPQ${sfx}`, name: 'Ra Sau', phone: '0700000000', branchId: BR } });
    await expect(approvePending('0700000000', null)).rejects.toThrow('đã có hội viên');
    expect((await getPendingMembers()).some((x) => x.phone === '0700000000')).toBe(false);
  });
});

describe('upsertSheetMember', () => {
  it('posts the upsert_member action with the secret and normalized phone', async () => {
    const seen: { url: string; body: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, added: true }) };
    });
    const r = await upsertSheetMember({ name: 'Hoi Vien Moi', phone: '+84 912 345 678', email: ' moi@example.test ' });
    expect(r).toEqual({ ok: true, added: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(DUMP_URL);
    expect(seen[0].body).toEqual({ key: (await getSheetSyncCfg()).secret, action: 'upsert_member', name: 'Hoi Vien Moi', phone: '0912345678', email: 'moi@example.test' });
  });

  it('skips without an email or without configuration and reports script errors', async () => {
    const calls = vi.fn();
    vi.stubGlobal('fetch', async () => {
      calls();
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'key' }) };
    });
    expect(await upsertSheetMember({ name: 'X', phone: '0912345678', email: null })).toEqual({ ok: false, skipped: 'no_email' });
    expect(await upsertSheetMember({ name: 'X', phone: '0912345678', email: 'not-an-email' })).toEqual({ ok: false, skipped: 'no_email' });
    expect(calls).not.toHaveBeenCalled();
    expect(await upsertSheetMember({ name: 'X', phone: '0912345678', email: 'x@example.test' })).toEqual({ ok: false, error: 'Sai mã bí mật của Apps Script' });
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '<html></html>' }));
    expect((await upsertSheetMember({ name: 'X', phone: '0912345678', email: 'x@example.test' })).ok).toBe(false);

    await patchSheetSyncCfg({ dumpUrl: '' });
    expect(await upsertSheetMember({ name: 'X', phone: '0912345678', email: 'x@example.test' })).toEqual({ ok: false, skipped: 'not_configured' });
    await patchSheetSyncCfg({ dumpUrl: DUMP_URL });
  });

  it('adds the upsert action to the Apps Script', () => {
    const code = dumpScriptCode('SEC');
    expect(code).toContain('function doPost(e)');
    expect(code).toContain("'upsert_member'");
    expect(code).toContain('function digits(x)');
  });
});
