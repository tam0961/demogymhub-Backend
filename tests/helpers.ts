import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/lib/crypto';
import { prisma } from '../src/lib/prisma';
import { assignRole } from '../src/modules/rbac/service';

export const app = createApp();
export const PW = 'Passw0rd!long';

export async function branchId(code: string) {
  return (await prisma.branch.findUniqueOrThrow({ where: { code } })).id;
}

export async function makeUser(email: string, role: string, branchCode: string | null, password = PW) {
  const user = await prisma.user.create({
    data: { email, name: email.split('@')[0], passwordHash: await hashPassword(password), emailVerified: true },
  });
  await assignRole(user.id, role, branchCode ? await branchId(branchCode) : null);
  return user;
}

export async function login(email: string, password = PW) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res;
}

export async function tokenFor(email: string) {
  const res = await login(email);
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.access_token as string;
}

export function refreshCookieOf(res: request.Response): string {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Secure-rt='));
  if (!raw) throw new Error('no refresh cookie');
  return raw.split(';')[0];
}
