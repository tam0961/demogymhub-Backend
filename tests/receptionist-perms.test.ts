import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { seedRbac } from '../src/seed';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
const emails = { owner: `own${sfx}@perm.test`, rec: `rec${sfx}@perm.test`, pt: `pt${sfx}@perm.test` };
const tok: Record<string, string> = {};
const auth = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });

beforeAll(async () => {
  await makeUser(emails.owner, 'owner', null);
  await makeUser(emails.rec, 'receptionist', 'q7');
  await makeUser(emails.pt, 'trainer', 'q7');
  for (const k of Object.keys(emails) as (keyof typeof emails)[]) tok[k] = await tokenFor(emails[k]);
});

describe('receptionist permission toggles', () => {
  it('owner grants and revokes a toggle, receptionist cannot, seed keeps it', async () => {
    const denied = await request(app).put('/api/roles/receptionist/permissions').set(auth('rec')).send({ permissions: ['reports.view'] });
    expect(denied.status).toBe(403);

    const bad = await request(app).put('/api/roles/receptionist/permissions').set(auth('owner')).send({ permissions: ['roles.assign'] });
    expect(bad.status).toBe(400);

    const ok = await request(app).put('/api/roles/receptionist/permissions').set(auth('owner')).send({ permissions: ['reports.view'] });
    expect(ok.status).toBe(200);
    const roles = await request(app).get('/api/roles').set(auth('owner'));
    expect(roles.body.data.find((r: { key: string }) => r.key === 'receptionist').permissions).toContain('reports.view');

    await seedRbac(prisma);
    const again = await request(app).get('/api/roles').set(auth('owner'));
    expect(again.body.data.find((r: { key: string }) => r.key === 'receptionist').permissions).toContain('reports.view');

    await request(app).put('/api/roles/receptionist/permissions').set(auth('owner')).send({ permissions: [] }).expect(200);
    const off = await request(app).get('/api/roles').set(auth('owner'));
    expect(off.body.data.find((r: { key: string }) => r.key === 'receptionist').permissions).not.toContain('reports.view');
  });

  it('login scope lists only owner and receptionist accounts', async () => {
    const res = await request(app).get('/api/users').query({ scope: 'login', limit: 100 }).set(auth('owner'));
    expect(res.status).toBe(200);
    const mail = res.body.data.map((u: { email: string }) => u.email);
    expect(mail).toContain(emails.rec);
    expect(mail).not.toContain(emails.pt);
  });
});
