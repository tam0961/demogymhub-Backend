import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
const tok: Record<string, string> = {};
const h = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });

beforeAll(async () => {
  await makeUser(`own${sfx}@ads.test`, 'owner', null);
  await makeUser(`rec${sfx}@ads.test`, 'receptionist', 'q7');
  tok.owner = await tokenFor(`own${sfx}@ads.test`);
  tok.rec = await tokenFor(`rec${sfx}@ads.test`);
});

describe('marketing ads settings', () => {
  it('stores the account id, keeps the token write-only and keeps it when left blank', async () => {
    const put = await request(app).put('/api/marketing/ads').set(h('owner')).send({ platform: 'facebook', account_id: 'act_123', token: 'secret-token' });
    expect(put.status).toBe(200);
    expect(put.body.data.facebook).toEqual({ account_id: 'act_123', has_token: true });
    expect(JSON.stringify(put.body)).not.toContain('secret-token');

    const keep = await request(app).put('/api/marketing/ads').set(h('owner')).send({ platform: 'facebook', account_id: 'act_456' });
    expect(keep.body.data.facebook).toEqual({ account_id: 'act_456', has_token: true });

    const get = await request(app).get('/api/marketing/ads').set(h('owner'));
    expect(get.status).toBe(200);
    expect(get.body.data.google_ads).toEqual({ account_id: '', has_token: false });
    expect(JSON.stringify(get.body)).not.toContain('secret-token');
  });

  it('rejects writes without the settings permission and unknown platforms', async () => {
    await request(app).put('/api/marketing/ads').set(h('rec')).send({ platform: 'facebook', account_id: 'x' }).expect(403);
    await request(app).put('/api/marketing/ads').set(h('owner')).send({ platform: 'tiktok', account_id: 'x' }).expect(400);
  });
});
