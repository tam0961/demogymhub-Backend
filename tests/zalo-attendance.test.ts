import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let seq = 0;
const uniq = () => `${sfx}${++seq}`;
let A: string;
const tokens: Record<string, string> = {};
const h = (r: string) => ({ Authorization: `Bearer ${tokens[r]}`, 'X-Branch-Id': A });

beforeAll(async () => {
  const code = `za${uniq()}`;
  A = (await prisma.branch.create({ data: { code, name: 'ZA' } })).id;
  for (const r of ['owner', 'receptionist']) {
    await makeUser(`${r}@za.test`, r, r === 'owner' ? null : code);
    tokens[r] = await tokenFor(`${r}@za.test`);
  }
});

afterEach(() => vi.unstubAllGlobals());

describe('zalo zns', () => {
  it('masks secrets and keeps them when omitted', async () => {
    const body = {
      app_id: 'app1', oa_id: 'oa1', test_phone: '0903000111', secret_key: 'sek', access_token: 'tok', refresh_token: 'ref',
      events: { expiring: { enabled: true, template_id: 'T1', days: [7, 30, 14], params: { name: 'customer_name', date: 'end_date' } } },
    };
    const put = await request(app).put('/api/zalo/config').set(h('owner')).send(body);
    expect(put.status).toBe(200);
    expect(put.body.data.has_secret_key).toBe(true);
    expect(put.body.data.events.expiring.days).toEqual([30, 14, 7]);
    expect(JSON.stringify(put.body)).not.toContain('sek');
    const again = await request(app).put('/api/zalo/config').set(h('owner')).send({ ...body, secret_key: undefined, access_token: undefined, refresh_token: undefined });
    expect(again.body.data.has_access_token).toBe(true);
    const deny = await request(app).get('/api/zalo/config').set(h('receptionist'));
    expect(deny.status).toBe(403);
  });

  it('sends a test message and reminders once per contract and day', async () => {
    const calls: { body: { phone: string; template_id: string; template_data: Record<string, string> } }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      calls.push({ body: JSON.parse(init.body) });
      return { status: 200, json: async () => ({ error: 0, message: 'Success' }) };
    });
    const test = await request(app).post('/api/zalo/test').set(h('owner')).send({ event: 'expiring' });
    expect(test.body.data.status).toBe('sent');
    expect(calls[0].body.phone).toBe('84903000111');
    expect(calls[0].body.template_data).toEqual({ name: 'Nguyen Van A', date: '31/12/2026' });

    const m = await prisma.member.create({ data: { code: `ZM${uniq()}`, name: 'Khach Z', phone: `09${String(50000000 + ++seq * 7)}`, branchId: A } });
    const pkg = await prisma.package.create({ data: { name: `ZP${uniq()}`, type: 'month', category: 'member', durationDays: 30, price: 1, branchId: A } });
    await prisma.contract.create({
      data: { code: `ZC${uniq()}`, memberId: m.id, packageId: pkg.id, branchId: A, status: 'active', totalAmount: 1, durationDays: 30, startDate: dateOnly(todayVN()), endDate: addDays(dateOnly(todayVN()), 7) },
    });
    calls.length = 0;
    const r1 = await request(app).post('/api/zalo/run-reminders').set(h('owner'));
    expect(r1.body.data.sent).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.body.template_data.name === 'Khach Z')).toBe(true);
    const n = calls.length;
    await request(app).post('/api/zalo/run-reminders').set(h('owner'));
    expect(calls.length).toBe(n);
  });

  it('records failures and does not mark them as sent', async () => {
    vi.stubGlobal('fetch', async () => ({ status: 200, json: async () => ({ error: -118, message: 'user not found' }) }));
    const r = await request(app).post('/api/zalo/test').set(h('owner')).send({ event: 'expiring' });
    expect(r.body.data.status).toBe('failed');
    const logs = await request(app).get('/api/zalo/logs').set(h('owner'));
    expect(logs.body.data[0].status).toBe('failed');
  });
});

describe('attendance (hikvision push)', () => {
  it('rejects unknown device keys', async () => {
    const r = await request(app).post('/api/public/attendance/hikvision/nope').send({});
    expect(r.status).toBe(404);
  });

  it('records json and multipart pushes, links staff, ignores duplicates', async () => {
    const dev = await request(app).post('/api/attendance/devices').set(h('owner')).send({ name: 'Cong chinh', branch_id: A });
    expect(dev.status).toBe(201);
    const url = `/api/public/attendance/hikvision/${dev.body.data.device_key}`;
    const staff = await makeUser(`nv${uniq()}@za.test`, 'trainer', null);
    const emp = `E${uniq()}`;
    const set = await request(app).put(`/api/attendance/staff/${staff.id}`).set(h('owner')).send({ employee_no: emp });
    expect(set.status).toBe(200);

    const ev = (t: string) => ({ ipAddress: '1.1.1.1', dateTime: t, eventType: 'AccessControllerEvent', AccessControllerEvent: { employeeNoString: emp, majorEventType: 5, subEventType: 75 } });
    const day = todayVN();
    expect((await request(app).post(url).send(ev(`${day}T08:00:00+07:00`))).status).toBe(200);
    expect((await request(app).post(url).send(ev(`${day}T08:00:10+07:00`))).status).toBe(200);
    const multipart = `--b\r\nContent-Disposition: form-data; name="event_log"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(ev(`${day}T17:30:00+07:00`))}\r\n--b--\r\n`;
    expect((await request(app).post(url).set('Content-Type', 'multipart/form-data; boundary=b').send(multipart)).status).toBe(200);
    expect((await request(app).post(url).send({ heartbeat: true })).status).toBe(200);

    const sum = await request(app).get(`/api/attendance/summary?month=${day.slice(0, 7)}`).set(h('owner'));
    const row = sum.body.data.find((r: { user_id: string }) => r.user_id === staff.id);
    expect(row.total_days).toBe(1);
    expect(row.days[0].count).toBe(2);
    expect(row.total_hours).toBe(9.5);

    const dup = await prisma.staffPunch.count({ where: { employeeNo: emp } });
    expect(dup).toBe(2);
  });

  it('keeps unmatched punches and links them once the employee number is set', async () => {
    const dev = await request(app).post('/api/attendance/devices').set(h('owner')).send({ name: 'Cua 2', branch_id: A });
    const url = `/api/public/attendance/hikvision/${dev.body.data.device_key}`;
    const emp = `U${uniq()}`;
    const day = todayVN();
    await request(app).post(url).send({ dateTime: `${day}T09:00:00+07:00`, AccessControllerEvent: { employeeNoString: emp } });
    const staff = await makeUser(`late${uniq()}@za.test`, 'trainer', null);
    await request(app).put(`/api/attendance/staff/${staff.id}`).set(h('owner')).send({ employee_no: emp });
    expect(await prisma.staffPunch.count({ where: { employeeNo: emp, userId: staff.id } })).toBe(1);
    const deny = await request(app).get('/api/attendance/devices').set(h('receptionist'));
    expect(deny.status).toBe(403);
  });
});
