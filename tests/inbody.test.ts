import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let A = '';
let memberA = '';
let rec = '';
let rec2 = '';
let mgr = '';
let recB = '';
let sales = '';
const h = (t: string) => ({ Authorization: `Bearer ${t}` });
const body = { weight: 70.5, height: 172, body_fat: 18.2, muscle: 32.4 };

beforeAll(async () => {
  A = (await prisma.branch.create({ data: { code: `iba${sfx}`, name: 'IB A' } })).id;
  await prisma.branch.create({ data: { code: `ibb${sfx}`, name: 'IB B' } });
  memberA = (await prisma.member.create({ data: { code: `IB${sfx}`, name: 'IB Member', phone: `092${String(Date.now()).slice(-7)}`, branchId: A } })).id;
  const users = [['rec', 'receptionist', 'iba'], ['rec2', 'receptionist', 'iba'], ['mgr', 'branch_manager', 'iba'], ['recb', 'receptionist', 'ibb'], ['sales', 'sales', 'iba']] as const;
  for (const [mail, role, br] of users) await makeUser(`${mail}@ib${sfx}.test`, role, `${br}${sfx}`);
  rec = await tokenFor(`rec@ib${sfx}.test`);
  rec2 = await tokenFor(`rec2@ib${sfx}.test`);
  mgr = await tokenFor(`mgr@ib${sfx}.test`);
  recB = await tokenFor(`recb@ib${sfx}.test`);
  sales = await tokenFor(`sales@ib${sfx}.test`);
});

describe('inbody records', () => {
  it('creates, lists newest first and audits', async () => {
    const older = await request(app).post(`/api/members/${memberA}/inbody`).set(h(rec)).send({ ...body, measured_on: addDays(dateOnly(todayVN()), -30).toISOString().slice(0, 10) });
    expect(older.status).toBe(201);
    expect(older.body.data.weight).toBe(70.5);
    expect(older.body.data.source).toBe('manual');
    const newer = await request(app).post(`/api/members/${memberA}/inbody`).set(h(rec)).send({ ...body, weight: 69, note: 'sau 1 tháng' });
    expect(newer.status).toBe(201);
    const list = await request(app).get(`/api/members/${memberA}/inbody`).set(h(rec));
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: { weight: number }) => r.weight)).toEqual([69, 70.5]);
    expect(list.body.data[0].created_by_name).toBeTruthy();
    expect(await prisma.accessAudit.count({ where: { action: 'inbody.created', targetId: newer.body.data.id } })).toBe(1);
  });

  it('validates ranges', async () => {
    const bad = [{ weight: 19 }, { weight: 301 }, { height: 99 }, { height: 251 }, { body_fat: 0.5 }, { body_fat: 71 }, { muscle: 4 }, { muscle: 151 }, { measured_on: '2999-01-01' }];
    for (const b of bad) await request(app).post(`/api/members/${memberA}/inbody`).set(h(rec)).send({ ...body, ...b }).expect(400);
    await request(app).post(`/api/members/${memberA}/inbody`).set(h(rec)).send({ weight: 70 }).expect(400);
    await request(app).post(`/api/members/${memberA}/inbody`).set(h(rec)).send({ weight: 20, height: 100, body_fat: 1, muscle: 5 }).expect(201);
  });

  it('scopes by member branch and permission', async () => {
    await request(app).get(`/api/members/${memberA}/inbody`).set(h(recB)).expect(404);
    await request(app).post(`/api/members/${memberA}/inbody`).set(h(recB)).send(body).expect(404);
    await request(app).get(`/api/members/${memberA}/inbody`).set(h(sales)).expect(403);
    await request(app).get(`/api/members/${memberA}/inbody`).set(h(rec)).set('X-Branch-Id', A).expect(200);
  });

  it('deletes only own record unless inbody.delete', async () => {
    const r = await request(app).post(`/api/members/${memberA}/inbody`).set(h(rec)).send(body);
    const id = r.body.data.id;
    await request(app).delete(`/api/members/${memberA}/inbody/${id}`).set(h(rec2)).expect(403);
    await request(app).delete(`/api/members/${memberA}/inbody/${id}`).set(h(rec)).expect(204);
    await request(app).delete(`/api/members/${memberA}/inbody/${id}`).set(h(rec)).expect(404);
    const r2 = await request(app).post(`/api/members/${memberA}/inbody`).set(h(rec)).send(body);
    await request(app).delete(`/api/members/${memberA}/inbody/${r2.body.data.id}`).set(h(mgr)).expect(204);
    expect(await prisma.accessAudit.count({ where: { action: 'inbody.deleted', targetId: id } })).toBe(1);
  });
});
