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

  it('owner can grant branch revenue to the receptionist, seed keeps it', async () => {
    const ok = await request(app).put('/api/roles/receptionist/permissions').set(auth('owner')).send({ permissions: ['reports.view', 'reports.view_revenue'] });
    expect(ok.status).toBe(200);
    await seedRbac(prisma);
    const roles = await request(app).get('/api/roles').set(auth('owner'));
    expect(roles.body.data.find((r: { key: string }) => r.key === 'receptionist').permissions).toEqual(expect.arrayContaining(['reports.view', 'reports.view_revenue']));
    await request(app).put('/api/roles/receptionist/permissions').set(auth('owner')).send({ permissions: [] }).expect(200);
  });

  it('owner has full lead permissions, trainer has none', async () => {
    const roles = await request(app).get('/api/roles').set(auth('owner'));
    const perms = (k: string) => roles.body.data.find((r: { key: string }) => r.key === k).permissions as string[];
    expect(perms('owner')).toEqual(expect.arrayContaining(['leads.create', 'leads.read', 'leads.update', 'leads.delete']));
    expect(perms('trainer').some((p) => p.startsWith('leads.'))).toBe(false);
  });

  it('login scope lists only owner and receptionist accounts', async () => {
    const res = await request(app).get('/api/users').query({ scope: 'login', limit: 100 }).set(auth('owner'));
    expect(res.status).toBe(200);
    const mail = res.body.data.map((u: { email: string }) => u.email);
    expect(mail).toContain(emails.rec);
    expect(mail).not.toContain(emails.pt);
  });
});
