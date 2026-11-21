import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { getBotCfg } from '../src/modules/zalobot/config';
import { handleUpdate, parseOffMessage, runReminders } from '../src/modules/zalobot/service';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let A = '';
let ownerToken = '';
const group = `zgr-${sfx}`;
let n = 0;
const sent: { chat_id: string; text: string }[] = [];

const stubZalo = () =>
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    if (url.includes('/sendMessage')) sent.push(JSON.parse(init.body));
    return { status: 200, json: async () => ({ ok: true, result: {} }) };
  });

const upd = (text: string, chat = group) => ({
  event_name: 'message.text.received',
  message: { message_id: `m${sfx}${++n}`, text, date: Math.floor(Date.now() / 1000), from: { display_name: 'Khanh' }, chat: { id: chat, chat_type: 'GROUP' } },
});

beforeAll(async () => {
  const code = `zb${sfx}`;
  A = (await prisma.branch.create({ data: { code, name: 'ZB' } })).id;
  await makeUser(`owner@zb${sfx}.test`, 'owner', null);
  ownerToken = await tokenFor(`owner@zb${sfx}.test`);
  for (const name of ['Nguyen Khanh', 'Tran Trang', 'Le Thinh']) {
    const u = await makeUser(`${name.split(' ')[1].toLowerCase()}@zb${sfx}.test`, 'trainer', code);
    await prisma.user.update({ where: { id: u.id }, data: { name } });
  }
  const put = await request(app)
    .put('/api/zalo/bot/config')
    .set({ Authorization: `Bearer ${ownerToken}` })
    .send({ enabled: true, token: 'TOKEN', bot_name: 'Bot AI TH Gym', pt_group: group, branch_id: A, group_trainer: 'Thinh', group_windows: '06:30-07:45, 20:00-21:15' });
  expect(put.status).toBe(200);
  expect(JSON.stringify(put.body)).not.toContain('TOKEN');
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe('parseOffMessage', () => {
  it('reads weekly off lines and assigns Sunday message to next week', () => {
    const r = parseOffMessage('LỊCH OFF\n1/ Thịnh: off thứ 3\n2/ Trang: off chủ nhật, thứ 5\n3/ Khánh: không off', new Date('2030-01-06T20:30:00+07:00'));
    expect(r?.week).toBe('2030-01-07');
    expect(r?.items).toEqual([
      { name: 'Thịnh', days: [3], kind: 'days' },
      { name: 'Trang', days: [5, 8], kind: 'days' },
      { name: 'Khánh', days: [], kind: 'none' },
    ]);
    expect(parseOffMessage('hello', new Date())).toBeNull();
  });

  it('assigns a Saturday message to next week, reads "thứ 4,5" and marks a blank line as not reported', () => {
    const r = parseOffMessage('LỊCH OFF\n1/ Thịnh:\n2/ A. Khánh : off thứ 2\n3/ Trang: off thứ 4,5', new Date('2026-11-21T15:16:00+07:00'));
    expect(r?.week).toBe('2026-11-23');
    expect(r?.items).toEqual([
      { name: 'Thịnh', days: [], kind: 'empty' },
      { name: 'Khánh', days: [2], kind: 'days' },
      { name: 'Trang', days: [4, 5], kind: 'days' },
    ]);
    expect(parseOffMessage('LỊCH OFF\n1/ Trang: off thứ 4', new Date('2026-11-18T10:00:00+07:00'))?.week).toBe('2026-11-16');
  });
});

describe('zalo bot in the PT group', () => {
  it('keeps the saved branch when the form sends none, then stores secrets masked', async () => {
    const bad = await request(app)
      .put('/api/zalo/bot/config')
      .set({ Authorization: `Bearer ${ownerToken}` })
      .send({ enabled: true, bot_name: 'Bot AI TH Gym', pt_group: group, branch_id: '', group_trainer: 'Thinh', group_windows: '06:30-07:45, 20:00-21:15' });
    expect(bad.status).toBe(200);
    const get = await request(app).get('/api/zalo/bot/config').set({ Authorization: `Bearer ${ownerToken}` });
    expect(get.body.data.has_token).toBe(true);
    expect(get.body.data.branch_id).toBe(A);
  });

  it('writes shifts from a group message, skips class windows for the group PT, and replies', async () => {
    stubZalo();
    const cfg = await getBotCfg();
    const day = addDays(dateOnly(todayVN()), 1).toISOString().slice(0, 10);
    const dm = `${day.slice(8, 10)}/${day.slice(5, 7)}`;
    await handleUpdate(cfg, upd(`@Bot AI TH Gym CA DẠY ${dm}\n1/ A Khánh : 16h 17h\n2/ Trang : off\n3/ Thịnh : 6h30 7h 16h`));
    const khanh = await prisma.ptSession.findMany({ where: { branchId: A, trainer: { name: 'Nguyen Khanh' }, source: 'zalo' } });
    expect(khanh).toHaveLength(2);
    const thinh = await prisma.ptSession.findMany({ where: { branchId: A, trainer: { name: 'Le Thinh' }, source: 'zalo' } });
    expect(thinh).toHaveLength(1);
    expect(thinh[0].startAt.toISOString()).toBe(new Date(`${day}T16:00:00+07:00`).toISOString());
    expect(await prisma.ptDayOff.count({ where: { branchId: A, date: dateOnly(day) } })).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe(group);
    expect(sent[0].text).toContain(`Đã ghi nhận ca ngày ${dm}`);
  });

  it('ignores duplicates and other chats, and remembers the chats it saw', async () => {
    stubZalo();
    const cfg = await getBotCfg();
    const u = upd('CA DẠY 31/12\n1/ Trang : 10h');
    await handleUpdate(cfg, u);
    await handleUpdate(cfg, u);
    await handleUpdate(cfg, upd('CA DẠY 31/12\n1/ Trang : 10h', 'other-chat'));
    expect(sent.length).toBeLessThanOrEqual(1);
    const st = await request(app).get('/api/zalo/bot/config').set({ Authorization: `Bearer ${ownerToken}` });
    expect(st.body.data.state.chats.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['other-chat', group]));
  });

  it('uses edited reminder templates for the PT group', async () => {
    stubZalo();
    sent.length = 0;
    const put = await request(app)
      .put('/api/zalo/bot/config')
      .set({ Authorization: `Bearer ${ownerToken}` })
      .send({ enabled: true, bot_name: 'Bot AI TH Gym', pt_group: group, branch_id: A, group_trainer: 'Thinh', group_windows: '06:30-07:45, 20:00-21:15', pt_tpl: { off: 'OFF nhe {bot}', tomorrow: 'Mai {dow} {date}{NL}{list}' } });
    expect(put.status).toBe(200);
    expect(put.body.data.pt_tpl.off).toBe('OFF nhe {bot}');
    expect(put.body.data.pt_tpl.today).toContain('{list}');
    await runReminders(new Date('2030-02-03T20:00:00+07:00'));
    expect(sent[0].text).toBe('OFF nhe Bot AI TH Gym');
    await request(app).put('/api/zalo/bot/config').set({ Authorization: `Bearer ${ownerToken}` }).send({ enabled: true, bot_name: 'Bot AI TH Gym', pt_group: group, branch_id: A, group_trainer: 'Thinh', group_windows: '06:30-07:45, 20:00-21:15', pt_tpl: {} }).expect(200);
  });

  it('stops the PT group reminders when the PT bot is switched off', async () => {
    stubZalo();
    const base = { enabled: true, bot_name: 'Bot AI TH Gym', pt_group: group, branch_id: A, group_trainer: 'Thinh', group_windows: '06:30-07:45, 20:00-21:15' };
    const off = await request(app).put('/api/zalo/bot/config').set({ Authorization: `Bearer ${ownerToken}` }).send({ ...base, pt_on: false });
    expect(off.body.data.pt_on).toBe(false);
    sent.length = 0;
    await runReminders(new Date('2030-03-03T20:00:00+07:00'));
    expect(sent).toHaveLength(0);
    const on = await request(app).put('/api/zalo/bot/config').set({ Authorization: `Bearer ${ownerToken}` }).send({ ...base, pt_on: true });
    expect(on.body.data.pt_on).toBe(true);
    await runReminders(new Date('2030-03-10T20:00:00+07:00'));
    expect(sent[0].text).toContain('Nhắc lịch OFF');
  });

  it('reads the bot name from getMe when checking the connection', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, json: async () => ({ ok: true, result: { display_name: 'Bot Demo' } }) }));
    const chk = await request(app).post('/api/zalo/bot/check').set({ Authorization: `Bearer ${ownerToken}` });
    expect(chk.body.data.ok).toBe(true);
    const get = await request(app).get('/api/zalo/bot/config').set({ Authorization: `Bearer ${ownerToken}` });
    expect(get.body.data.bot_label).toBe('Bot Demo');
  });

  it('applies a weekly OFF message to the days of that week', async () => {
    stubZalo();
    const cfg = await getBotCfg();
    await handleUpdate(cfg, { ...upd('LỊCH OFF\n1/ Thịnh: off thứ 3'), message: { ...upd('').message, text: 'LỊCH OFF\n1/ Thịnh: off thứ 3', date: Math.floor(new Date('2030-01-06T20:30:00+07:00').getTime() / 1000) } });
    const offs = await prisma.ptDayOff.findMany({ where: { branchId: A, trainer: { name: 'Le Thinh' }, date: { gte: dateOnly('2030-01-07'), lte: dateOnly('2030-01-13') } } });
    expect(offs.map((o) => o.date.toISOString().slice(0, 10))).toEqual(['2030-01-08']);
    expect(sent[0].text).toContain('lịch OFF tuần 07/01 đến 13/01');
  });

  it('records a Saturday OFF message for next week, keeps a blank PT pending and reminds on Sunday evening', async () => {
    stubZalo();
    sent.length = 0;
    const cfg = await getBotCfg();
    const text = 'LỊCH OFF\n1/ Thịnh:\n2/ A. Khánh : off thứ 2\n3/ Trang: off thứ 4,5';
    await handleUpdate(cfg, { ...upd(text), message: { ...upd('').message, text, date: Math.floor(new Date('2031-03-01T15:16:00+07:00').getTime() / 1000) } });
    const days = async (n: string) => (await prisma.ptDayOff.findMany({ where: { branchId: A, trainer: { name: n }, date: { gte: dateOnly('2031-02-24'), lte: dateOnly('2031-03-09') } }, orderBy: { date: 'asc' } })).map((o) => o.date.toISOString().slice(0, 10));
    expect(await days('Nguyen Khanh')).toEqual(['2031-03-03']);
    expect(await days('Tran Trang')).toEqual(['2031-03-05', '2031-03-06']);
    expect(await days('Le Thinh')).toEqual([]);
    expect(sent[0].text).toContain('tuần 03/03 đến 09/03');
    expect(sent[0].text).toMatch(/Còn thiếu lịch OFF:.*@Thinh/);
    sent.length = 0;
    await runReminders(new Date('2031-03-02T21:00:00+07:00'));
    await runReminders(new Date('2031-03-02T21:02:00+07:00'));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/còn thiếu:.*@Thinh/);
    sent.length = 0;
    const t2 = 'LỊCH OFF\n1/ Thịnh: không off';
    await handleUpdate(cfg, { ...upd(t2), message: { ...upd('').message, text: t2, date: Math.floor(new Date('2031-03-02T21:10:00+07:00').getTime() / 1000) } });
    expect(sent[0].text).toContain('✅ Đã ghi nhận lịch OFF tuần 03/03 đến 09/03');
    expect(sent[0].text).not.toMatch(/Còn thiếu lịch OFF:.*@Thinh/);
  });

  it('sends hourly reminders once, including missing PT and tomorrow class summary', async () => {
    stubZalo();
    await runReminders(new Date('2030-01-07T07:00:00+07:00'));
    await runReminders(new Date('2030-01-07T07:02:00+07:00'));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('CA DẠY HÔM NAY');
    expect(sent[0].text).toContain('Le Thinh');
    sent.length = 0;
    await runReminders(new Date('2030-01-07T08:00:00+07:00'));
    expect(sent[0].text).toContain('@Khanh');
    expect(sent[0].text).toContain('@Thinh');
    sent.length = 0;
    const trainer = await prisma.user.findFirstOrThrow({ where: { name: 'Le Thinh' } });
    await prisma.groupClass.create({ data: { branchId: A, trainerId: trainer.id, muscleGroup: 'Chân', startAt: new Date('2030-01-08T06:30:00+07:00'), endAt: new Date('2030-01-08T07:30:00+07:00') } });
    await runReminders(new Date('2030-01-07T21:00:00+07:00'));
    expect(sent[0].text).toContain('CA LỚP NHÓM NGÀY MAI');
    expect(sent[0].text).toContain('06:30 Chân');
    sent.length = 0;
    await runReminders(new Date('2030-01-06T20:00:00+07:00'));
    expect(sent[0].text).toContain('Nhắc lịch OFF');
  });
});
