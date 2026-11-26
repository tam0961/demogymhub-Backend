import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { runFbTick } from '../src/modules/marketing/auto';
import { PT_ROTATION, mapLeadFields, wantsContact } from '../src/modules/leads/inbox';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let owner = '';
let recep = '';
let NB = '';
let Q7 = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const month = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

beforeAll(async () => {
  for (const code of ['nb', 'q7']) await prisma.branch.upsert({ where: { code }, create: { code, name: code.toUpperCase() }, update: {} });
  NB = (await prisma.branch.findUniqueOrThrow({ where: { code: 'nb' } })).id;
  Q7 = (await prisma.branch.findUniqueOrThrow({ where: { code: 'q7' } })).id;
  await makeUser(`owner@mk${sfx}.test`, 'owner', null);
  owner = await tokenFor(`owner@mk${sfx}.test`);
  await makeUser(`rec@mk${sfx}.test`, 'receptionist', 'q7');
  recep = await tokenFor(`rec@mk${sfx}.test`);
  await prisma.marketingDaily.deleteMany({});
  await prisma.marketingCampaign.deleteMany({});
  await prisma.setting.deleteMany({ where: { key: { in: ['marketing.auto', 'marketing.gbp', 'marketing.metrics'] } } });
});

afterEach(() => vi.unstubAllGlobals());

describe('marketing auto', () => {
  it('keeps keys and settings owner-only and generates ingest keys', async () => {
    expect((await request(app).get('/api/marketing/auto/config').set(auth(recep))).status).toBe(403);
    const r = await request(app).get('/api/marketing/auto/config').set(auth(owner));
    expect(r.status).toBe(200);
    expect(r.body.data.gg.key.length).toBeGreaterThanOrEqual(32);
    expect(r.body.data.gbp.key.length).toBeGreaterThanOrEqual(32);
    const again = await request(app).get('/api/marketing/auto/config').set(auth(owner));
    expect(again.body.data.gg.key).toBe(r.body.data.gg.key);
    const regen = await request(app).put('/api/marketing/auto/config').set(auth(owner)).send({ regen_gg: true });
    expect(regen.body.data.gg.key).not.toBe(r.body.data.gg.key);
    expect(regen.body.data.gbp.key).toBe(r.body.data.gbp.key);
  });

  it('pulls Facebook insights, maps campaigns to branches and never exposes the token', async () => {
    await request(app).put('/api/marketing/ads').set(auth(owner)).send({ platform: 'facebook', account_id: '123456', token: 'FB-SECRET-TOKEN' }).expect(200);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      let body: unknown = { data: [] };
      if (u.pathname.endsWith('/act_123456')) body = { name: 'TH Gym Ads', currency: 'VND' };
      else if (u.pathname.endsWith('/campaigns')) body = { data: [{ id: '11', name: 'Khai trương Nhà Bè', effective_status: 'ACTIVE', daily_budget: '200000' }, { id: '12', name: 'Quận 7 tháng 11', effective_status: 'PAUSED', daily_budget: '0' }] };
      else if (u.pathname.endsWith('/insights')) body = { data: [{ campaign_id: '11', date_start: today, spend: '150000.5', impressions: '1000', clicks: '40', actions: [{ action_type: 'lead', value: '3' }, { action_type: 'onsite_conversion.messaging_first_reply', value: '2' }] }, { campaign_id: '12', date_start: today, spend: '50000', impressions: '500', clicks: '10', actions: [] }] };
      return { ok: true, status: 200, json: async () => body };
    });
    const r = await request(app).post('/api/marketing/auto/fb-sync').set(auth(owner));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ok: true, name: 'TH Gym Ads', campaigns: 2, rows: 2 });
    expect(JSON.stringify(r.body)).not.toContain('FB-SECRET-TOKEN');
    expect(calls.every((u) => u.includes('access_token=FB-SECRET-TOKEN'))).toBe(true);
    const camps = await prisma.marketingCampaign.findMany({ orderBy: { id: 'asc' } });
    expect(camps.find((c) => c.id === 'fb11')).toMatchObject({ branchId: NB, status: 'active', budget: 200000 });
    expect(camps.find((c) => c.id === 'fb12')?.branchId).toBe(Q7);
    const cfg = await request(app).get('/api/marketing/auto/config').set(auth(owner));
    expect(JSON.stringify(cfg.body)).not.toContain('FB-SECRET-TOKEN');
    expect(cfg.body.data.fb).toMatchObject({ connected: true, name: 'TH Gym Ads' });

    const metrics = await request(app).get('/api/marketing/metrics').query({ month }).set(auth(owner));
    const fb = metrics.body.data.find((m: { channel: string }) => m.channel === 'facebook_ads');
    expect(fb).toMatchObject({ source: 'auto', spend: 200001, impressions: 1500, clicks: 50, leads: 5 });
  });

  it('reports a Facebook error and keeps the old data', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Token expired' } }) }));
    const r = await request(app).post('/api/marketing/auto/fb-sync').set(auth(owner));
    expect(r.body.data).toMatchObject({ ok: false, err: 'Facebook: Token expired' });
    expect(await prisma.marketingDaily.count()).toBe(2);
    const cfg = await request(app).get('/api/marketing/auto/config').set(auth(owner));
    expect(cfg.body.data.fb.err).toBe('Facebook: Token expired');
  });

  it('runs the 15 minute job once under a lock', async () => {
    await redis.del('mk:fb:lock');
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      return { ok: true, status: 200, json: async () => ({ data: [], name: 'x', currency: 'VND' }) };
    });
    await runFbTick(Date.UTC(2031, 0, 1, 0, 2));
    expect(n).toBeGreaterThan(0);
    const before = n;
    await runFbTick(Date.UTC(2031, 0, 1, 0, 2));
    await runFbTick(Date.UTC(2031, 0, 1, 0, 3));
    expect(n).toBe(before);
    await redis.del('mk:fb:lock');
  });

  it('takes Google Ads rows with the key only and builds the Maps channel from the Business Profile', async () => {
    const cfg = (await request(app).get('/api/marketing/auto/config').set(auth(owner))).body.data;
    const post = (path: string, key: string, body: object) => request(app).post(path).query({ key }).send(body);
    expect((await post('/api/mk/ads-in', 'wrong', {})).status).toBe(403);
    const ok = await post('/api/mk/ads-in', cfg.gg.key, {
      account: '999',
      name: 'Google TH Gym',
      campaigns: [
        { id: '77', name: 'Search Quận 7', status: 'ENABLED', budget: 100000, ch: 'SEARCH' },
        { id: '78', name: 'Maps Nhà Bè', status: 'ENABLED', budget: 50000, ch: 'LOCAL_MAP' },
      ],
      rows: [
        { date: today, id: '77', spend: 300000, impr: 2000, clicks: 80, conv: 4 },
        { date: today, id: '78', spend: 90000, impr: 900, clicks: 30, conv: 1.4 },
        { date: 'bad', id: '77', spend: 1 },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, campaigns: 2, rows: 2 });
    expect((await prisma.marketingCampaign.findUnique({ where: { id: 'gg78' } }))?.branchId).toBe(NB);
    const m = (await request(app).get('/api/marketing/metrics').query({ month }).set(auth(owner))).body.data;
    expect(m.find((x: { channel: string }) => x.channel === 'google_ads')).toMatchObject({ spend: 300000, clicks: 80, leads: 4 });
    expect(m.find((x: { channel: string }) => x.channel === 'google_maps')).toMatchObject({ spend: 90000, impressions: 900 });

    expect((await post('/api/mk/gbp-in', cfg.gg.key, {})).status).toBe(403);
    const gbp = await post('/api/mk/gbp-in', cfg.gbp.key, { name: 'TH Gym Maps', days: [{ date: today, views_maps: 100, views_search: 50, calls: 3, directions: 5, web: 7, msgs: 1, bookings: 0 }], reviews: { rating: 4.66, count: 20 }, debug: { series: 3, points: 9 } });
    expect(gbp.body).toEqual({ ok: true, days: 1 });
    const after = (await request(app).get('/api/marketing/metrics').query({ month }).set(auth(owner))).body.data.find((x: { channel: string }) => x.channel === 'google_maps');
    expect(after.note).toContain('150 lượt xem');
    expect(after.impressions).toBe(900);
  });

  it('keeps manual numbers for channels without synced data', async () => {
    await request(app).put('/api/marketing/metrics').set(auth(owner)).send({ month: '2020-05', channel: 'facebook_ads', spend: 5, impressions: 5, clicks: 5, leads: 5, note: 'tay' }).expect(200);
    const all = (await request(app).get('/api/marketing/metrics').set(auth(owner))).body.data;
    expect(all.find((x: { month: string }) => x.month === '2020-05')).toMatchObject({ source: 'manual', spend: 5 });
  });
});

describe('lead pt rotation', () => {
  it('cycles Trang, Thịnh, Trang, A Khánh', () => expect([...PT_ROTATION, ...PT_ROTATION]).toEqual(['Trang', 'Thịnh', 'Trang', 'A Khánh', 'Trang', 'Thịnh', 'Trang', 'A Khánh']))
  it('detects who wants a call', () => {
    expect(wantsContact('Tùy chọn: Tôi muốn PT liên hệ tư vấn')).toBe(true)
    expect(wantsContact('Cần PT tư vấn: Có')).toBe(true)
    expect(wantsContact('Tùy chọn: Tôi không muốn PT liên hệ')).toBe(false)
  })
})

describe('lead inbox', () => {
  let key = '';
  let mid = '';
  beforeAll(async () => {
    const r = await request(app).post('/api/marketing/auto/lead-keys').set(auth(owner)).send({ branch_id: Q7, label: 'KH Gym' });
    expect(r.status).toBe(201);
    key = r.body.data.key;
    mid = r.body.data.id;
  });

  it('maps sheet columns to lead fields', () => {
    expect(mapLeadFields({ 'Họ tên': 'Lan', SĐT: '0901 234 567', Email: 'L@x.vn', Nguồn: 'Facebook', 'Ghi chú': 'muốn tập', Tuổi: '25' })).toEqual({ name: 'Lan', phone: '0901 234 567', email: 'L@x.vn', source: 'Facebook', interest: '', note: ['muốn tập', 'Tuổi: 25'] });
  });
  it('maps the interest package column from the sheet', () => {
    expect(mapLeadFields({ 'Họ tên': 'Lan', SĐT: '0901234567', 'Gói quan tâm': 'PT 1:1 - 20b' }).interest).toBe('PT 1:1 - 20b');
  });

  it('creates a lead in the key branch once, rejects bad keys and rows without a phone', async () => {
    const row = { ext: 'r5', fields: { 'Họ tên': 'Lan', SĐT: '+84 901 234 567', Nguồn: 'Facebook' } };
    expect((await request(app).post('/api/leads/in').query({ key: 'x'.repeat(40) }).send(row)).status).toBe(403);
    const a = await request(app).post('/api/leads/in').query({ key }).send(row);
    expect(a.body.ok).toBe(true);
    const b = await request(app).post('/api/leads/in').query({ key }).send(row);
    expect(b.body).toEqual({ ok: true, dup: true });
    const lead = await prisma.lead.findFirstOrThrow({ where: { phone: '0901234567' } });
    expect(lead).toMatchObject({ name: 'Lan', branchId: Q7, source: 'Facebook' });
    expect((await request(app).post('/api/leads/in').query({ key }).send({ ext: 'r6', fields: { 'Họ tên': 'Không số' } })).status).toBe(422);
    expect((await request(app).get('/api/leads').set(auth(recep))).status).toBe(200);
  });

  it('answers which phones already signed a contract', async () => {
    const m = await prisma.member.create({ data: { code: `MK${sfx}`, name: 'Signed', phone: '0912345678', branchId: Q7 } });
    const pkg = await prisma.package.create({ data: { name: `MK ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: Q7 } });
    await prisma.contract.create({ data: { code: `MKC${sfx}`, memberId: m.id, packageId: pkg.id, branchId: Q7, status: 'active', totalAmount: 1, paidAmount: 1, signedAt: new Date('2031-02-10T03:00:00Z') } });
    const r = await request(app)
      .post('/api/leads/signed')
      .query({ key })
      .send({ rows: [{ phone: '0912345678', date: '2031-02-01' }, { phone: '0912345678', date: '2031-09-01' }, { phone: '0999999999', date: '2031-02-01' }] });
    expect(r.body).toEqual({ signed: { '0912345678': '2031-02-10' } });
    expect((await request(app).post('/api/leads/signed').query({ key: 'y'.repeat(40) }).send({ rows: [] })).status).toBe(403);
  });

  it('lists keys without the secret and revokes them', async () => {
    const list = await request(app).get('/api/marketing/auto/lead-keys').set(auth(owner));
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body.data[0]).toMatchObject({ id: mid, label: 'KH Gym', branch_id: Q7 });
    await request(app).delete(`/api/marketing/auto/lead-keys/${mid}`).set(auth(owner)).expect(200);
    expect((await request(app).post('/api/leads/in').query({ key }).send({ ext: 'r9', fields: { SĐT: '0988888888' } })).status).toBe(403);
  });
});
