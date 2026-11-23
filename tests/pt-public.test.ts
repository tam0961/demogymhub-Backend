import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { parseShiftMessage } from '../src/modules/pt/zalo-shift';
import { visibleWeek } from '../src/modules/pt/public';
import { app, branchId, makeUser, tokenFor } from './helpers';

let nb: string;
let trainerId: string;
let memberId: string;
let memberPhone: string;
let contractId: string;
let classA: string;
let classFull: string;
let seq = 0;
const u = () => `${Date.now().toString(36)}${++seq}`;

async function mkMember(sessions: number | null) {
  const id = u();
  const phone = `08${String(10000000 + Math.floor(Math.random() * 8999999)).slice(0, 8)}`;
  const m = await prisma.member.create({ data: { code: `P${id}`, name: `Public ${id}`, phone, email: `public${id}@example.com`, branchId: nb } });
  const mpkg = await prisma.package.create({ data: { name: `Mem ${id}`, type: 'month', durationDays: 30, price: 1, branchId: nb } });
  await prisma.contract.create({ data: { code: `CM${id}`, memberId: m.id, packageId: mpkg.id, branchId: nb, status: 'active', totalAmount: 1 } });
  let contract = null;
  if (sessions !== null) {
    const gpkg = await prisma.package.create({ data: { name: `Grp ${id}`, type: 'session', category: 'pt_group', sessions, price: 1, branchId: nb } });
    contract = await prisma.contract.create({ data: { code: `CG${id}`, memberId: m.id, packageId: gpkg.id, branchId: nb, status: 'active', totalAmount: 1, sessionsTotal: sessions, sessionsLeft: sessions } });
  }
  return { member: m, contract };
}

const sundayEvening = (hour: number) => `${visibleWeek().to}T${String(hour).padStart(2, '0')}:00:00+07:00`;
const mkClass = (hour: number, capacity: number) =>
  prisma.groupClass.create({ data: { branchId: nb, startAt: new Date(sundayEvening(hour)), endAt: new Date(new Date(sundayEvening(hour)).getTime() + 3600000), capacity, muscleGroup: 'Core + Cardio' } });

beforeAll(async () => {
  nb = await branchId('nb');
  const t = await makeUser('khanhtest@t.local', 'trainer', 'nb');
  trainerId = t.id;
  const { member, contract } = await mkMember(3);
  memberId = member.id;
  memberPhone = member.phone;
  contractId = contract!.id;
  classA = (await mkClass(18, 3)).id;
  classFull = (await mkClass(19, 1)).id;
  const other = await mkMember(2);
  await prisma.groupRegistration.create({ data: { classId: classFull, memberId: other.member.id, name: 'x', phone: other.member.phone } });
});

const left = async () => (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).sessionsLeft;

describe('public class booking', () => {
  it('lists open sessions with slots left, no auth needed', async () => {
    const r = await request(app).get('/api/public/classes').query({ branch: 'nb' });
    expect(r.status).toBe(200);
    const full = r.body.data.sessions.find((s: { id: string }) => s.id === classFull);
    expect(full.left).toBe(0);
    expect(r.body.data.sessions.find((s: { id: string }) => s.id === classA).left).toBe(3);
  });

  it('looks up a member by phone with a masked email', async () => {
    const ok = await request(app).get('/api/public/member').query({ phone: memberPhone.slice(1) });
    expect(ok.body.data.found).toBe(true);
    expect(ok.body.data.email).toMatch(/^pu\*\*\*@example\.com$/);
    expect((await request(app).get('/api/public/member').query({ phone: '0999999999' })).body.data.found).toBe(false);
  });

  it('rejects non-members and ignores honeypot fills quietly', async () => {
    expect((await request(app).post('/api/public/book').send({ phone: '0999999998', class_ids: [classA] })).status).toBe(404);
    const bot = await request(app).post('/api/public/book').send({ phone: memberPhone, class_ids: [classA], website: 'spam' });
    expect(bot.status).toBe(200);
    expect(await left()).toBe(3);
  });

  it('is all or nothing: a full session blocks the whole booking', async () => {
    const r = await request(app).post('/api/public/book').send({ phone: memberPhone, class_ids: [classA, classFull] });
    expect(r.status).toBe(409);
    expect(r.body.error.failed).toEqual([{ class_id: classFull, reason: 'full' }]);
    expect(await left()).toBe(3);
    expect(await prisma.groupRegistration.count({ where: { classId: classA, memberId } })).toBe(0);
  });

  it('books, deducts temporarily and blocks an immediate repeat', async () => {
    const r = await request(app).post('/api/public/book').send({ phone: memberPhone, class_ids: [classA] });
    expect(r.status).toBe(201);
    expect(r.body.data.booked[0].start).toBe('18:00');
    expect(await left()).toBe(2);
    const again = await request(app).post('/api/public/book').send({ phone: memberPhone, class_ids: [classA] });
    expect(again.status).toBe(409);
    const reg = await prisma.groupRegistration.findFirstOrThrow({ where: { classId: classA, memberId } });
    expect(reg.source).toBe('web');
  });

  it('refuses sessions from two different weeks', async () => {
    const day = 86400000;
    const far = await prisma.groupClass.create({ data: { branchId: nb, startAt: new Date(new Date(sundayEvening(20)).getTime() + 3 * day), endAt: new Date(new Date(sundayEvening(21)).getTime() + 3 * day), capacity: 3 } });
    const r = await request(app).post('/api/public/book').send({ phone: memberPhone, class_ids: [classA, far.id] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('MIXED_WEEK');
  });

  it('refuses more than five sessions', async () => {
    const ids = [0, 1, 2, 3, 4, 5].map((i) => `00000000-0000-4000-8000-00000000000${i}`);
    expect((await request(app).post('/api/public/book').send({ phone: memberPhone, class_ids: ids })).status).toBe(400);
  });
});

describe('zalo shift messages', () => {
  const sentAt = new Date('2031-03-14T01:00:00Z');
  it('parses title date, ranges, half hours and off', () => {
    const p = parseShiftMessage('CA DẠY 15/03\n1/ A Khánh : 16h 17h\n2/ Trang : 6h 7h 18h30\n3/ Thịnh : 8-10\n4/ Tâm : off', sentAt)!;
    expect(p.date).toBe('2031-03-15');
    expect(p.entries).toEqual([
      { name: 'Khánh', hours: ['16:00', '17:00'], off: false },
      { name: 'Trang', hours: ['06:00', '07:00', '18:30'], off: false },
      { name: 'Thịnh', hours: ['08:00', '09:00'], off: false },
      { name: 'Tâm', hours: [], off: true },
    ]);
  });

  it('without a title: before noon is today, from noon tomorrow; ngày mai wins', () => {
    expect(parseShiftMessage('Trang : 6h', new Date('2031-03-14T01:00:00Z'))!.date).toBe('2031-03-14');
    expect(parseShiftMessage('Trang : 6h', new Date('2031-03-14T06:00:00Z'))!.date).toBe('2031-03-15');
    expect(parseShiftMessage('CA DẠY NGÀY MAI\nTrang : 6h', new Date('2031-03-14T01:00:00Z'))!.date).toBe('2031-03-15');
    expect(parseShiftMessage('xin chao moi nguoi', sentAt)).toBeNull();
  });

  it('bot endpoint writes slots, reports unknown PT and re-syncs on a newer message', async () => {
    const key = { 'X-Bot-Key': 'test-bot-key' };
    const text = 'CA DẠY 15/03/2031\n1/ Khanhtest : 16h 17h\n2/ Nobodyhere : 6h';
    expect((await request(app).post('/api/pt/bot/message').send({ branch_id: nb, text })).status).toBe(401);
    const r = await request(app).post('/api/pt/bot/message').set(key).send({ branch_id: nb, text, sent_at: '2031-03-14T01:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.body.data.results[0]).toMatchObject({ added: 2, removed: 0 });
    expect(r.body.data.errors[0]).toContain('Nobodyhere');
    expect(r.body.data.reply).toContain('Đã ghi nhận ca ngày 15/03');
    const r2 = await request(app).post('/api/pt/bot/message').set(key).send({ branch_id: nb, text: 'CA DẠY 15/03/2031\nKhanhtest : 16h', sent_at: '2031-03-14T01:00:00Z' });
    expect(r2.body.data.results[0]).toMatchObject({ added: 0, removed: 1 });
    const tok = await tokenFor('khanhtest@t.local');
    const list = await request(app).get('/api/pt/sessions').set({ Authorization: `Bearer ${tok}`, 'X-Branch-Id': nb }).query({ from: '2031-03-15', to: '2031-03-15' });
    expect(list.body.data.map((s: { source: string }) => s.source)).toEqual(['zalo']);
    const past = await request(app).post('/api/pt/bot/message').set(key).send({ branch_id: nb, text: 'CA DẠY 01/01/2020\nKhanhtest : 9h' });
    expect(past.body.data.reply).toContain('đã qua');
  });
});
