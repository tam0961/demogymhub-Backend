import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, makeUser, tokenFor } from './helpers';
import { currentMonthVN } from '../src/modules/payroll/snapshot';

const sfx = Date.now().toString(36);
let owner = '';
let recep = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (path: string, t = owner) => request(app).get(`/api/payroll/${path}`).query({ month: currentMonthVN() }).set(auth(t));

describe('payroll snapshot for the current month', () => {
  beforeAll(async () => {
    await makeUser(`owner@sn${sfx}.test`, 'owner', null);
    owner = await tokenFor(`owner@sn${sfx}.test`);
    await makeUser(`rec@sn${sfx}.test`, 'receptionist', null);
    recep = await tokenFor(`rec@sn${sfx}.test`);
  });

  it('serves the same snapshot until refreshed', async () => {
    const a = await get('preview');
    expect(a.status).toBe(200);
    expect(typeof a.body.data.updated_at).toBe('string');
    const b = await get('preview');
    expect(b.body.data.updated_at).toBe(a.body.data.updated_at);
    const pa = await get('pt-stats');
    expect(pa.body.data.updated_at).toBeTruthy();

    await new Promise((r) => setTimeout(r, 15));
    const r = await request(app).post('/api/payroll/refresh').set(auth(owner)).send({ month: currentMonthVN() });
    expect(r.status).toBe(200);
    expect(r.body.data.refreshed).toBe(true);
    const c = await get('preview');
    expect(c.body.data.updated_at).not.toBe(a.body.data.updated_at);
  });

  it('other months stay live and refresh needs manage', async () => {
    const old = await request(app).get('/api/payroll/preview').query({ month: '2031-06' }).set(auth(owner));
    expect(old.body.data.updated_at).toBeUndefined();
    expect((await request(app).post('/api/payroll/refresh').set(auth(recep)).send({ month: currentMonthVN() })).status).toBe(403);
    const past = await request(app).post('/api/payroll/refresh').set(auth(owner)).send({ month: '2031-06' });
    expect(past.body.data.refreshed).toBe(false);
  });
});
