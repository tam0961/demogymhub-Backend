import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { addDays, dateOnly, todayVN } from '../src/lib/dates';
import { app, makeUser, tokenFor } from './helpers';

const sfx = Date.now().toString(36);
let A = '';
let B = '';
let owner = '';
let rec = '';
const hdr = (t: string, b?: string) => ({ Authorization: `Bearer ${t}`, ...(b ? { 'X-Branch-Id': b } : {}) });

beforeAll(async () => {
  A = (await prisma.branch.create({ data: { code: `sta${sfx}`, name: 'ST A' } })).id;
  B = (await prisma.branch.create({ data: { code: `stb${sfx}`, name: 'ST B' } })).id;
  await makeUser(`own@st${sfx}.test`, 'owner', null);
  await makeUser(`rec@st${sfx}.test`, 'receptionist', `sta${sfx}`);
  owner = await tokenFor(`own@st${sfx}.test`);
  rec = await tokenFor(`rec@st${sfx}.test`);
  const today = dateOnly(todayVN());
  const phone = (n: number) => `092${String(Date.now()).slice(-7)}${n}`;
  const m1 = await prisma.member.create({ data: { code: `ST1${sfx}`, name: 'ST one', phone: phone(1), branchId: A } });
  const m2 = await prisma.member.create({ data: { code: `ST2${sfx}`, name: 'ST two', phone: phone(2), branchId: A } });
  const pkg = await prisma.package.create({ data: { name: `STP ${sfx}`, type: 'month', category: 'member', durationDays: 30, price: 1000000, branchId: A } });
  await prisma.contract.create({ data: { code: `STC1${sfx}`, memberId: m1.id, packageId: pkg.id, branchId: A, status: 'active', totalAmount: 1000000, paidAmount: 400000, durationDays: 30, startDate: addDays(today, -20), endDate: addDays(today, 10) } });
  await prisma.contract.create({ data: { code: `STC2${sfx}`, memberId: m2.id, packageId: pkg.id, branchId: A, status: 'draft', totalAmount: 500000, paidAmount: 0 } });
  // Wednesday-ish fixed instants: two check-ins at 18:xx and one at 19:xx VN time yesterday
  const y = addDays(today, -1).toISOString().slice(0, 10);
  for (const t of ['18:05', '18:40', '19:10']) await prisma.checkin.create({ data: { memberId: m1.id, branchId: A, result: 'allowed', checkedInAt: new Date(`${y}T${t}:00+07:00`) } });
  const trainer = await prisma.user.findFirstOrThrow({ where: { email: `own@st${sfx}.test` } });
  for (const [status, n] of [['completed', 3], ['no_show', 1], ['cancelled', 1]] as const) {
    for (let i = 0; i < n; i++) await prisma.ptSession.create({ data: { branchId: A, trainerId: trainer.id, memberId: m1.id, startAt: new Date(`${y}T0${i + 1}:00:00+07:00`), endAt: new Date(`${y}T0${i + 1}:50:00+07:00`), status } });
  }
});

describe('health, alerts and capacity stats', () => {
  it('computes health with the doc grade bands', async () => {
    const r = await request(app).get('/api/reports/health').set(hdr(owner, A));
    expect(r.status).toBe(200);
    const { score, grade, parts } = r.body.data;
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(p.score).toBeLessThanOrEqual(25);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(grade).toBe(score >= 80 ? 'Rất tốt' : score >= 65 ? 'Tốt' : score >= 50 ? 'Trung bình' : 'Cần cải thiện');
    expect(parts.find((p: { key: string }) => p.key === 'collection').score).toBeCloseTo(25 * (400000 / 1000000), 0);
    expect(r.body.data.renew_rate_used).toBe(0.6);
  });

  it('lists alerts sorted by revenue impact', async () => {
    const r = await request(app).get('/api/reports/alerts').set(hdr(owner, A));
    expect(r.status).toBe(200);
    const items = r.body.data as { key: string; count: number; impact: number; detail: string }[];
    const impacts = items.map((i) => i.impact);
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    expect(items.find((i) => i.key === 'expiring_30')?.count).toBe(1);
    expect(items.find((i) => i.key === 'expiring_30')?.detail).toContain('bỏ tập');
    expect(items.find((i) => i.key === 'unsigned')?.impact).toBe(500000);
    expect(items.find((i) => i.key === 'debt')?.impact).toBe(600000);
  });

  it('builds heatmap, peak pair, funnel and day tickets', async () => {
    const r = await request(app).get('/api/reports/capacity').set(hdr(owner, A));
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.total_checkins).toBe(3);
    expect(d.avg_per_day).toBeCloseTo(0.1, 1);
    expect(d.heatmap).toHaveLength(7);
    expect(d.heatmap[0]).toHaveLength(24);
    expect(d.heatmap.flat().reduce((s: number, x: number) => s + x, 0)).toBe(3);
    expect(d.peak).toEqual({ from_hour: 18, to_hour: 20, count: 3 });
    expect(d.pt_funnel).toMatchObject({ booked: 5, attended: 3, no_show: 1, cancelled: 1 });
    expect(d.pt_funnel.completion_rate).toBeCloseTo(0.6, 2);
    expect(d.day_tickets).toEqual({ count: 0, amount: 0 });
  });

  it('respects branch scope and permission', async () => {
    const other = await request(app).get('/api/reports/capacity').set(hdr(owner, B));
    expect(other.body.data.total_checkins).toBe(0);
    await request(app).get('/api/reports/health').set(hdr(rec, B)).expect(403);
    await request(app).get('/api/reports/capacity').set(hdr(rec, A)).expect(403);
  });
});
