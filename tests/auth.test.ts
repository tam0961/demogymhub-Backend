import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { outbox } from '../src/lib/mailer';
import { prisma } from '../src/lib/prisma';
import { app, login, makeUser, PW, refreshCookieOf } from './helpers';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const lastToken = (to: string, kind: string) => [...outbox].reverse().find((m) => m.to === to && m.kind === kind)!.token;

describe('health', () => {
  it('returns ok', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
  });
});

describe('register / verify / login', () => {
  const email = 'newuser@test.local';

  it('register is generic, blocks login until verified, verify enables it', async () => {
    const r1 = await request(app).post('/api/auth/register').send({ email, password: PW });
    expect(r1.status).toBe(202);
    const r2 = await request(app).post('/api/auth/register').send({ email, password: PW });
    expect(r2.body).toEqual(r1.body);

    const blocked = await login(email);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const bad = await request(app).get('/api/auth/verify').query({ token: 'x'.repeat(20) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_TOKEN');

    const ok = await request(app).get('/api/auth/verify').query({ token: lastToken(email, 'email_verify') });
    expect(ok.status).toBe(200);
    const again = await request(app).get('/api/auth/verify').query({ token: lastToken(email, 'email_verify') });
    expect(again.status).toBe(400);

    const l = await login(email);
    expect(l.status).toBe(200);
    expect(l.body.data.access_token).toBeTruthy();
    expect(l.body.data.user).toMatchObject({ email });
    const cookie = ([] as string[]).concat(l.headers['set-cookie'])[0];
    expect(cookie).toMatch(/^__Secure-rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);

    const me = await request(app).get('/api/me').set(bearer(l.body.data.access_token));
    expect(me.status).toBe(200);
    expect(me.body.data.roles).toEqual(['member']);
    expect(me.body.data.permissions).toContain('me.read');
  });

  it('wrong password and unknown email give identical 401', async () => {
    await makeUser('known@test.local', 'member', null);
    const a = await login('known@test.local', 'wrong-password');
    const b = await login('nobody@test.local', 'wrong-password');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks out after 5 failures', async () => {
    await makeUser('lock@test.local', 'member', null);
    for (let i = 0; i < 5; i++) expect((await login('lock@test.local', 'bad-password')).status).toBe(401);
    const locked = await login('lock@test.local');
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('LOCKED_OUT');
  });

  it('rejects missing, tampered and alg:none tokens', async () => {
    expect((await request(app).get('/api/me')).body.error.code).toBe('TOKEN_INVALID');
    const none = jwt.sign({ sub: 'x' }, '', { algorithm: 'none' as jwt.Algorithm });
    expect((await request(app).get('/api/me').set(bearer(none))).body.error.code).toBe('TOKEN_INVALID');
    const forged = jwt.sign({ sub: 'x', tv: 0 }, 'wrong-secret-wrong-secret-wrong-secret', { algorithm: 'HS256', keyid: 'k1' });
    expect((await request(app).get('/api/me').set(bearer(forged))).body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('renew rotation and reuse detection', () => {
  it('rotates, tolerates immediate double renew, and revokes family on late reuse', async () => {
    await makeUser('rot@test.local', 'member', null);
    const l = await login('rot@test.local');
    const c1 = refreshCookieOf(l);

    const r1 = await request(app).post('/api/auth/renew').set('Cookie', c1);
    expect(r1.status).toBe(200);
    expect(r1.body.data.access_token).toBeTruthy();
    const c2 = refreshCookieOf(r1);
    expect(c2).not.toBe(c1);

    const race = await request(app).post('/api/auth/renew').set('Cookie', c1);
    expect(race.status).toBe(409);
    expect(race.body.error.code).toBe('RENEW_CONFLICT');
    const stillValid = await request(app).post('/api/auth/renew').set('Cookie', c2);
    expect(stillValid.status).toBe(200);
    const c3 = refreshCookieOf(stillValid);

    await prisma.refreshToken.updateMany({ data: { usedAt: new Date(Date.now() - 60_000) }, where: { used: true } });
    const reuse = await request(app).post('/api/auth/renew').set('Cookie', c1);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REUSE_DETECTED');

    const dead = await request(app).post('/api/auth/renew').set('Cookie', c3);
    expect(dead.status).toBe(401);
    expect(dead.body.error.code).toBe('TOKEN_INVALID');
    const oldAccess = await request(app).get('/api/me').set(bearer(l.body.data.access_token));
    expect(oldAccess.status).toBe(401);
  });

  it('renew without cookie is TOKEN_INVALID', async () => {
    const r = await request(app).post('/api/auth/renew');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('logout, sessions, passwords', () => {
  it('logout blacklists the access token and deletes the refresh token', async () => {
    await makeUser('out@test.local', 'member', null);
    const l = await login('out@test.local');
    const cookie = refreshCookieOf(l);
    const t = l.body.data.access_token;
    const out = await request(app).post('/api/auth/logout').set(bearer(t)).set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect((await request(app).get('/api/me').set(bearer(t))).status).toBe(401);
    expect((await request(app).post('/api/auth/renew').set('Cookie', cookie)).status).toBe(401);
  });

  it('logout-all kills every device', async () => {
    await makeUser('all@test.local', 'member', null);
    const a = await login('all@test.local');
    const b = await login('all@test.local');
    expect((await request(app).post('/api/auth/logout-all').set(bearer(a.body.data.access_token))).status).toBe(200);
    expect((await request(app).get('/api/me').set(bearer(b.body.data.access_token))).status).toBe(401);
    expect((await request(app).post('/api/auth/renew').set('Cookie', refreshCookieOf(b))).status).toBe(401);
  });

  it('lists and revokes sessions', async () => {
    await makeUser('sess@test.local', 'member', null);
    const a = await login('sess@test.local');
    const b = await login('sess@test.local');
    const list = await request(app).get('/api/auth/sessions').set(bearer(a.body.data.access_token)).set('Cookie', refreshCookieOf(a));
    expect(list.body.data).toHaveLength(2);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const del = await request(app).delete(`/api/auth/sessions/${other.id}`).set(bearer(a.body.data.access_token));
    expect(del.status).toBe(200);
    expect((await request(app).get('/api/me').set(bearer(b.body.data.access_token))).status).toBe(401);
    expect((await request(app).get('/api/me').set(bearer(a.body.data.access_token))).status).toBe(200);
  });

  it('forgot/reset invalidates sessions and token is single-use', async () => {
    await makeUser('reset@test.local', 'member', null);
    const l = await login('reset@test.local');
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@test.local' });
    const known = await request(app).post('/api/auth/forgot-password').send({ email: 'reset@test.local' });
    expect(unknown.body).toEqual(known.body);
    const token = lastToken('reset@test.local', 'password_reset');

    const bad = await request(app).post('/api/auth/reset-password').send({ token: 'y'.repeat(30), new_password: 'NewPassw0rd!x' });
    expect(bad.body.error.code).toBe('INVALID_TOKEN');
    const ok = await request(app).post('/api/auth/reset-password').send({ token, new_password: 'NewPassw0rd!x' });
    expect(ok.status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token, new_password: 'NewPassw0rd!y' })).status).toBe(400);
    expect((await request(app).get('/api/me').set(bearer(l.body.data.access_token))).status).toBe(401);
    expect((await login('reset@test.local')).status).toBe(401);
    expect((await login('reset@test.local', 'NewPassw0rd!x')).status).toBe(200);
  });

  it('change-password keeps current session, drops others', async () => {
    await makeUser('chg@test.local', 'member', null);
    const a = await login('chg@test.local');
    const b = await login('chg@test.local');
    const wrong = await request(app)
      .post('/api/auth/change-password')
      .set(bearer(a.body.data.access_token))
      .send({ current: 'nope-nope-nope', new: 'BrandNewPass1!' });
    expect(wrong.status).toBe(401);

    const ok = await request(app)
      .post('/api/auth/change-password')
      .set(bearer(a.body.data.access_token))
      .set('Cookie', refreshCookieOf(a))
      .send({ current: PW, new: 'BrandNewPass1!' });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/me').set(bearer(ok.body.data.access_token))).status).toBe(200);
    expect((await request(app).get('/api/me').set(bearer(b.body.data.access_token))).status).toBe(401);
    expect((await request(app).post('/api/auth/renew').set('Cookie', refreshCookieOf(b))).status).toBe(401);
    expect((await request(app).post('/api/auth/renew').set('Cookie', refreshCookieOf(ok))).status).toBe(200);
  });
});
