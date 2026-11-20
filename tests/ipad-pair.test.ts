import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let BR = '';
let rec = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('ipad pairing', () => {
  beforeAll(async () => {
    BR = (await prisma.branch.create({ data: { code: `ip${sfx}`, name: 'IP' } })).id;
    await makeUser(`rec@ip${sfx}.test`, 'receptionist', `ip${sfx}`);
    rec = await tokenFor(`rec@ip${sfx}.test`);
  });

  it('pairs an ipad by code and routes branch signing to it', async () => {
    const p = await request(app).post('/api/public/ipad/pair');
    expect(p.status).toBe(201);
    const { token, code } = p.body.data as { token: string; code: string };
    expect(code).toMatch(/^\d{6}$/);

    expect((await request(app).get('/api/ipad/branch').query({ branch_id: BR }).set(auth(rec))).body.data.token).toBeNull();
    expect((await request(app).post('/api/ipad/pair').set(auth(rec)).send({ code: '000000', branch_id: BR })).status).toBe(404);

    const ok = await request(app).post('/api/ipad/pair').set(auth(rec)).send({ code, branch_id: BR });
    expect(ok.status).toBe(200);
    expect(ok.body.data.token).toBe(token);
    expect((await request(app).post('/api/ipad/pair').set(auth(rec)).send({ code, branch_id: BR })).status).toBe(404);

    const b = await request(app).get('/api/ipad/branch').query({ branch_id: BR }).set(auth(rec));
    expect(b.body.data.token).toBe(token);

    await request(app).put(`/api/ipad/sessions/${token}`).set(auth(rec)).send({ stage: 'sign', payload: { title: 'T', rows: [] } }).expect(200);
    const pub = await request(app).get(`/api/public/ipad/${token}`);
    expect(pub.body.data).toMatchObject({ stage: 'sign', paired: true, code: null });
    await request(app).post(`/api/public/ipad/${token}/sign`).send({ signature: 'data:image/png;base64,AAAA' }).expect(200);
    expect((await request(app).get(`/api/ipad/sessions/${token}`).set(auth(rec))).body.data.stage).toBe('signed');

    await request(app).delete('/api/ipad/branch').query({ branch_id: BR }).set(auth(rec)).expect(200);
    expect((await request(app).get('/api/ipad/branch').query({ branch_id: BR }).set(auth(rec))).body.data.token).toBeNull();
  });

  it('shows a fresh code for an unpaired ipad', async () => {
    const p = await request(app).post('/api/public/ipad/pair');
    const pub = await request(app).get(`/api/public/ipad/${p.body.data.token}`);
    expect(pub.body.data).toMatchObject({ paired: false, code: p.body.data.code });
  });
});
