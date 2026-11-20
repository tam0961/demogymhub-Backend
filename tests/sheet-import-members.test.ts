import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { importSheetMembers, packageFor, planImport, type SheetMemberRow } from '../src/modules/sheetsync/import-members';
import { patchSheetSyncCfg } from '../src/modules/sheetsync/config';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let BR = '';
let owner = '';
const auth = () => ({ Authorization: `Bearer ${owner}` });
const ph = (n: number) => `09${sfx.replace(/\D/g, '').padEnd(4, '1').slice(0, 4)}${String(n).padStart(4, '0')}`;
const row = (n: number, learned: string, remaining: string, over: Partial<SheetMemberRow> = {}): SheetMemberRow => ({
  name: `Hoi Vien ${sfx} ${n}`, phone: ph(n).slice(1), email: `hv${n}.${sfx}@example.test`, expiry: '31/12/2031', learned, remaining, lastReg: '01/12/2030 10:00', note: '', ...over,
});

beforeAll(async () => {
  BR = (await prisma.branch.create({ data: { code: `im${sfx}`, name: 'IM' } })).id;
  await makeUser(`owner@im${sfx}.test`, 'owner', null);
  owner = await tokenFor(`owner@im${sfx}.test`);
  await patchSheetSyncCfg({ branchId: BR });
});

afterEach(() => vi.unstubAllGlobals());

describe('import every Sheet member', () => {
  it('maps total sessions to packages and promo sessions', () => {
    expect(packageFor(10)).toEqual({ name: 'PT NHÓM 10 BUỔI', promo: 0, generic: false });
    expect(packageFor(11)).toEqual({ name: 'PT NHÓM 10 BUỔI', promo: 1, generic: false });
    expect(packageFor(20)).toEqual({ name: 'PT NHÓM 20 BUỔI', promo: 0, generic: false });
    expect(packageFor(22)).toEqual({ name: 'PT NHÓM 20 BUỔI', promo: 2, generic: false });
    expect(packageFor(42).generic).toBe(true);
  });

  it('plans exists, create, skip and the active or expired status', () => {
    const existing = new Set([ph(1)]);
    const items = planImport([row(1, '5', '5'), row(2, '5', '5'), row(3, '10', '0'), row(4, '0', '0'), row(5, '5', '5', { name: 'Tâm test' }), row(2, '1', '1'), row(6, '6', '5', { expiry: '01/01/2020' })], existing, '2031-06-01');
    expect(items.map((i) => i.action)).toEqual(['exists', 'create', 'create', 'create', 'skip', 'skip', 'create']);
    expect(items[1]).toMatchObject({ total: 10, remaining: 5, status: 'active', packageName: 'PT NHÓM 10 BUỔI', end: '2031-12-31', start: '2030-12-01' });
    expect(items[2]).toMatchObject({ total: 10, remaining: 0, status: 'expired' });
    expect(items[3]).toMatchObject({ total: 0, packageName: '' });
    expect(items[6]).toMatchObject({ total: 11, promo: 1, status: 'expired' });
  });

  it('dry run writes nothing, real run creates female members with contracts and leaves existing members alone', async () => {
    const existing = await prisma.member.create({ data: { code: `IMX${sfx}`, name: 'Da co', phone: ph(10), branchId: BR, gender: 'male' } });
    const rows = [row(10, '5', '5'), row(11, '6', '5'), row(12, '5', '17'), row(13, '9', '11'), row(14, '0', '0'), row(15, '22', '20')];
    const dry = await importSheetMembers(rows, { dryRun: true, createdBy: null });
    expect(dry.counts).toMatchObject({ exists: 1, created: 5, contracts: 4, other_packages: 1 });
    expect(await prisma.member.count({ where: { phone: { in: rows.map((r) => `0${r.phone.replace(/^0/, '')}`) } } })).toBe(1);

    const r = await importSheetMembers(rows, { dryRun: false, createdBy: null });
    expect(r.counts).toMatchObject({ exists: 1, created: 5, contracts: 4 });
    expect((await prisma.member.findUniqueOrThrow({ where: { id: existing.id } })).gender).toBe('male');
    expect(await prisma.contract.count({ where: { memberId: existing.id } })).toBe(0);

    const m11 = await prisma.member.findUniqueOrThrow({ where: { phone: ph(11) }, include: { contracts: { include: { package: true } } } });
    expect(m11.gender).toBe('female');
    expect(m11.contracts).toHaveLength(1);
    expect(m11.contracts[0]).toMatchObject({ sessionsTotal: 11, sessionsLeft: 5, totalAmount: 0, paidAmount: 0, status: 'active' });
    expect(m11.contracts[0].package.name).toBe('PT NHÓM 10 BUỔI');
    expect(m11.contracts[0].packageName).toBe('PT NHÓM 10 BUỔI + 1 buổi khuyến mãi');
    expect(m11.contracts[0].code).toMatch(/^HP\d{2}\d{4}$/);

    const m12 = await prisma.member.findUniqueOrThrow({ where: { phone: ph(12) }, include: { contracts: { include: { package: true } } } });
    expect(m12.contracts[0]).toMatchObject({ sessionsTotal: 22, sessionsLeft: 17 });
    expect(m12.contracts[0].package.name).toBe('PT NHÓM 20 BUỔI');
    expect(m12.contracts[0].packageName).toBe('PT NHÓM 20 BUỔI + 2 buổi khuyến mãi');

    const m14 = await prisma.member.findUniqueOrThrow({ where: { phone: ph(14) }, include: { contracts: true } });
    expect(m14.contracts).toHaveLength(0);

    const m15 = await prisma.member.findUniqueOrThrow({ where: { phone: ph(15) }, include: { contracts: { include: { package: true } } } });
    expect(m15.contracts[0].package.name).toBe('PT nhóm (nhập từ Sheet)');
    expect(m15.contracts[0].sessionsTotal).toBe(42);

    const again = await importSheetMembers(rows, { dryRun: false, createdBy: null });
    expect(again.counts).toMatchObject({ exists: 6, created: 0, contracts: 0 });
  });

  it('does not duplicate a member that exists under the same name with another phone', async () => {
    await prisma.member.create({ data: { code: `IMN${sfx}`, name: 'Cao Trần Nguyễn Tiên', phone: ph(30), branchId: BR, gender: 'female' } });
    const rows = [row(31, '6', '5', { name: 'CAO TRẦN NGUYỄN TIÊN' }), row(32, '10', '0', { name: `Khac ${sfx}` })];
    const r = await importSheetMembers(rows, { dryRun: true, createdBy: null });
    expect(r.items[0]).toMatchObject({ action: 'exists' });
    expect(r.items[0].reason).toContain('cùng tên');
    expect(r.items[1].action).toBe('create');
  });

  it('exposes the import through the API and reads the Sheet dump', async () => {
    await patchSheetSyncCfg({ dumpUrl: 'https://script.google.com/macros/s/AKfycbTEST/exec', secret: 'S3CRET', branchId: BR });
    const members = [[`Api ${sfx}`, ph(20).slice(1), `api.${sfx}@example.test`, '31/12/2031', '5', '5', '01/12/2030', '0', '']];
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, members, registrations: [], classes: [], schedule: [] }) }));
    const dry = await request(app).post('/api/sheetsync/import-members').set(auth()).send({});
    expect(dry.status).toBe(200);
    expect(dry.body.data.dryRun).toBe(true);
    expect(dry.body.data.items[0]).toMatchObject({ action: 'create', packageName: 'PT NHÓM 10 BUỔI' });
    const real = await request(app).post('/api/sheetsync/import-members').set(auth()).send({ dry_run: false });
    expect(real.body.data.counts).toMatchObject({ created: 1, contracts: 1 });
    expect(await prisma.member.count({ where: { phone: ph(20) } })).toBe(1);
  });
});
