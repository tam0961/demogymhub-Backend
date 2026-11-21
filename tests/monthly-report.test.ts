import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { buildReport, previousMonthVN } from '../src/modules/monthlyreport/data';
import { getReportCfg, saveReportCfg } from '../src/modules/monthlyreport/config';
import { runMonthlyReport } from '../src/modules/monthlyreport/service';
import { getBotCfg } from '../src/modules/zalobot/config';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
const MONTH = '2031-04';
let BR = '';
let owner = '';
const auth = () => ({ Authorization: `Bearer ${owner}` });
const sent: string[] = [];
const seen = new Set<string>();
const deps = {
  say: async (t: string) => {
    sent.push(t);
  },
  once: async (k: string) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  },
  release: async (k: string) => {
    seen.delete(k);
  },
};

const SCRIPT = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const stubScript = (log: { url: string; body: { key?: string; name?: string; share?: boolean; pdf?: string } }[], reply: object = { ok: true, url: 'https://drive.google.com/file/d/FILEID/view' }) =>
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    log.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  });

beforeAll(async () => {
  BR = (await prisma.branch.create({ data: { code: `mr${sfx}`, name: `MR ${sfx}` } })).id;
  await makeUser(`owner@mr${sfx}.test`, 'owner', null);
  owner = await tokenFor(`owner@mr${sfx}.test`);
  const sale = await makeUser(`sale@mr${sfx}.test`, 'sales', `mr${sfx}`);
  await prisma.user.update({ where: { id: sale.id }, data: { name: `Sale ${sfx}` } });
  const pt = await makeUser(`pt@mr${sfx}.test`, 'trainer', `mr${sfx}`);
  await prisma.user.update({ where: { id: pt.id }, data: { name: `PT ${sfx}` } });
  const member = await prisma.member.create({ data: { code: `MR${sfx}`, name: 'MR M', phone: `mr${sfx}`, branchId: BR, createdAt: new Date('2031-04-05T10:00:00+07:00') } });
  const pkg = await prisma.package.create({ data: { name: `MR ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: BR } });
  const c = await prisma.contract.create({ data: { code: `MRC${sfx}`, memberId: member.id, packageId: pkg.id, branchId: BR, status: 'active', totalAmount: 3_000_000, paidAmount: 2_000_000, saleUserId: sale.id, createdAt: new Date('2031-04-05T10:00:00+07:00') } });
  await prisma.payment.create({ data: { contractId: c.id, branchId: BR, method: 'cash', amount: 2_000_000, status: 'confirmed', ref: `MRP${sfx}`, confirmedAt: new Date('2031-04-06T10:00:00+07:00') } });
  await prisma.checkin.create({ data: { memberId: member.id, contractId: c.id, branchId: BR, result: 'allowed', checkedInAt: new Date('2031-04-07T10:00:00+07:00') } });
  await prisma.ptSession.create({ data: { branchId: BR, trainerId: pt.id, memberId: member.id, startAt: new Date('2031-04-08T10:00:00+07:00'), endAt: new Date('2031-04-08T11:00:00+07:00'), status: 'completed', completedAt: new Date('2031-04-08T11:00:00+07:00') } });
});

afterEach(() => vi.unstubAllGlobals());

describe('monthly report', () => {
  it('aggregates revenue, check-ins, sales and PT sessions for the month', async () => {
    const r = await buildReport(MONTH);
    const b = r.branches.find((x) => x.name === `MR ${sfx}`)!;
    expect(b).toMatchObject({ revenue: 2_000_000, contractsNew: 1, membersNew: 1, checkins: 1 });
    expect(r.sales.find((s) => s.name === `Sale ${sfx}`)?.revenue).toBe(2_000_000);
    expect(r.pts.find((p) => p.name === `PT ${sfx}`)).toMatchObject({ sessions: 1, classes: 0 });
    expect(r.ptKpi.find((p) => p.name === `PT ${sfx}`)).toMatchObject({ sessions: 1, completed: 1, cancelled: 0, booked: 1 });
    expect(r.byCategory.find((c) => c.label === 'Gói member')?.revenue).toBeGreaterThanOrEqual(2_000_000);
    expect(r.totals.debtCount).toBeGreaterThanOrEqual(1);
  });

  it('computes the previous month in Vietnam time', () => {
    expect(previousMonthVN(new Date('2031-05-01T00:30:00+07:00'))).toBe('2031-04');
    expect(previousMonthVN(new Date('2031-01-01T07:00:00+07:00'))).toBe('2030-12');
  });

  it('serves a real PDF preview', async () => {
    const r = await request(app)
      .post('/api/zalo/bot/report-preview')
      .set(auth())
      .send({ month: MONTH })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    const buf = r.body as Buffer;
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(5000);
  });

  it('refuses to turn the report on without a script URL, validates the URL and never returns the secret', async () => {
    const base = { enabled: false, bot_name: 'Bot AI TH Gym', pt_group: '', branch_id: '', group_trainer: 'Thinh', group_windows: '06:30-07:45, 20:00-21:15' };
    expect((await request(app).put('/api/zalo/bot/config').set(auth()).send({ ...base, report_on: true })).status).toBe(400);
    expect((await request(app).put('/api/zalo/bot/config').set(auth()).send({ ...base, report_script_url: 'https://evil.example/exec' })).status).toBe(400);
    const code = await request(app).get('/api/zalo/bot/report-script').set(auth());
    expect(code.status).toBe(200);
    expect(code.body.data.code).toContain('function doPost');
    const secret = (await getReportCfg()).secret;
    expect(secret.length).toBeGreaterThan(10);
    expect(code.body.data.code).toContain(secret);
    const again = await request(app).get('/api/zalo/bot/report-script').set(auth());
    expect(again.body.data.code).toBe(code.body.data.code);
    const put = await request(app).put('/api/zalo/bot/config').set(auth()).send({ ...base, report_on: true, report_script_url: SCRIPT });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ report_on: true, report_script_url: SCRIPT, report_ready: true });
    expect(JSON.stringify(put.body)).not.toContain(secret);
  });

  it('sends the PDF to the Apps Script, posts the link once at 07:00 on the 1st', async () => {
    const log: { url: string; body: { key?: string; name?: string; share?: boolean; pdf?: string } }[] = [];
    stubScript(log);
    const bot = { ...(await getBotCfg()), enabled: true, token: 'T', ptGroup: 'grp' };
    const at = new Date('2031-05-01T07:02:00+07:00');
    const now = { date: '2031-05-01', h: 7, mi: 2 };
    await runMonthlyReport(bot, deps, { ...now, h: 6 }, at);
    await runMonthlyReport(bot, deps, { ...now, date: '2031-05-02' }, at);
    expect(sent).toHaveLength(0);
    await runMonthlyReport(bot, deps, now, at);
    await runMonthlyReport(bot, deps, { ...now, mi: 3 }, at);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('BÁO CÁO TỔNG HỢP THÁNG 04/2031');
    expect(sent[0]).toContain('https://drive.google.com/file/d/FILEID/view');
    expect(log).toHaveLength(1);
    expect(log[0].url).toBe(SCRIPT);
    expect(log[0].body).toMatchObject({ key: (await getReportCfg()).secret, name: 'Bao-cao-thang-2031-04.pdf', share: true });
    expect(Buffer.from(log[0].body.pdf ?? '', 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect((await getReportCfg()).last).toMatchObject({ month: '2031-04', url: 'https://drive.google.com/file/d/FILEID/view' });
  });

  it('releases the slot when Drive fails so the next minute retries', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'Sai ma bi mat' }) }));
    const bot = { ...(await getBotCfg()), enabled: true, token: 'T', ptGroup: 'grp' };
    const at = new Date('2031-06-01T07:01:00+07:00');
    await expect(runMonthlyReport(bot, deps, { date: '2031-06-01', h: 7, mi: 1 }, at)).rejects.toThrow('Sai ma bi mat');
    expect(seen.has('monthly:2031-05')).toBe(false);
    const rc = await getReportCfg();
    await saveReportCfg({ ...rc, on: false });
    await runMonthlyReport(bot, deps, { date: '2031-06-01', h: 7, mi: 2 }, at);
    expect(sent.filter((t) => t.includes('05/2031'))).toHaveLength(0);
  });
});
